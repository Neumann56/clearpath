/**
 * 自然语言 → 结构化草稿。LLM 只在这一步出现，且只给候选、不落库、不生成任何税率（K5）。
 * MVP 未接模型时，用确定性规则 + 品名表兜底，能力边界写清楚：不确定就给候选让人选。
 */
/**
 * 国家识别：优先用参数库里的市场清单（中文名 + 二字码），不在代码里另抄一份。
 * 二字码必须按词边界匹配——裸子串会让 "insurance" 命中 IN、"item" 命中 IT。
 * 下面这组只是英文别名的补充，参数库只有中文名。
 */
const COUNTRY_ALIAS_EN = [
  ['united states', 'US'], ['usa', 'US'], ['america', 'US'],
  ['brazil', 'BR'], ['india', 'IN'], ['turkey', 'TR'], ['türkiye', 'TR'], ['turkiye', 'TR'],
];

const HTML_SAFE = /[\u4e00-\u9fa5]/;

/** 按"中文名 → 英文别名 → 二字码"的顺序找，先命中先算——中文名最不容易误伤 */
function matchCountry(raw, params) {
  const rows = (params?.raw?.countries || []).filter((c) => c.supported);

  for (const c of rows) {
    if (c.name && HTML_SAFE.test(c.name) && raw.includes(c.name)) return c.code;
  }
  const low = raw.toLowerCase();
  for (const [w, code] of COUNTRY_ALIAS_EN) {
    if (low.includes(w)) return code;
  }
  for (const c of rows) {
    const re = new RegExp(`(^|[^A-Za-z])${c.code}([^A-Za-z]|$)`);
    if (re.test(raw)) return c.code;
  }
  return null;
}

const GOODS = [
  { kw: ['散热器', '水箱', 'radiator'], hs: '8708.91', name: '机动车辆用散热器及其零件' },
  { kw: ['汽配', '汽车零件', '汽车配件', 'auto part'], hs: '8708.91', name: '机动车辆零件附件' },
  { kw: ['T恤', '针织衫', '服装'], hs: '6109.10', name: '针织 T 恤衫' },
];

/**
 * 品类识别得出、但参数库还没建税率的。
 * 不能直接删掉——删了用户说"车灯"就完全认不出，只能吃兜底的汽配示例；
 * 但也不能假装能算——认出来就要当场告诉他"这个品类还没入库"，
 * 而不是等他填完一屏再报 E_MFN_MISSING。
 */
const OFF_CATALOG = [
  { kw: ['灯具', '车灯', '前照灯'], hs: '8512.20', name: '机动车辆照明或信号装置' },
  { kw: ['锂电池', '电池', 'battery'], hs: '8507.60', name: '锂离子蓄电池' },
  { kw: ['玩具', 'toy'], hs: '9503.00', name: '玩具' },
  { kw: ['光学', '红外', '夜视'], hs: '9005.10', name: '双筒望远镜 / 光学仪器' },
];

/**
 * 品类目录的唯一来源是参数库 hsCatalog；老参数文件没有这个字段时退回内置表。
 * 这样"参数库能算哪几个品类"和"页面上说能算哪几个品类"不会各说各话。
 */
function catalogOf(params) {
  const cat = params?.raw?.hsCatalog;
  if (Array.isArray(cat) && cat.length) {
    return cat.map((c) => ({ hs: c.hs, name: c.name, kw: c.kw || [], inKb: true }));
  }
  return GOODS.map((g) => ({ ...g, inKb: true }));
}

const num = (s) => Number(String(s).replace(/,/g, ''));

export function parseText(text, params) {
  const raw = String(text || '');
  const notes = [];
  const draft = {};

  // HS：优先 6–10 位数字（允许点分）
  const hsMatch = raw.match(/(\d{4}\s?[.\s]?\s?\d{2}(?:\s?[.\s]?\s?\d{2}){0,2})/);
  if (hsMatch) {
    const digits = hsMatch[1].replace(/\D/g, '');
    if (digits.length >= 6) draft.hsCode = digits;
  }

  const hitCountry = matchCountry(raw, params);
  if (hitCountry) draft.country = hitCountry;

  const fob = raw.match(/fob\s*[:：]?\s*([\d,]+(?:\.\d+)?)/i) || raw.match(/货值\s*[:：]?\s*([\d,]+(?:\.\d+)?)/i);
  if (fob) draft.fob = num(fob[1]);

  const freight = raw.match(/运费\s*[:：]?\s*([\d,]+(?:\.\d+)?)/);
  if (freight) draft.freight = num(freight[1]);

  const qty = raw.match(/([\d,]+)\s*(件|台|个|套|只|pcs)/i);
  if (qty) draft.qty = num(qty[1]);
  if (/b2c|个人|电商小包/i.test(raw)) draft.channel = 'B2C';
  else if (/b2b|企业|批发|批量/i.test(raw)) draft.channel = 'B2B';

  const md = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md) {
    const y = Number(params.asOf.slice(0, 4));
    const m = String(md[1]).padStart(2, '0');
    const d = String(md[2]).padStart(2, '0');
    draft.declarationDate = `${y}-${m}-${d}`;
  }

  // 品名 → HS 候选（只给候选）
  const candidates = [];
  const catalog = catalogOf(params);
  if (draft.hsCode) {
    const hit = catalog.find((g) => String(g.hs).replace('.', '') === draft.hsCode.slice(0, 6));
    candidates.push({
      hsCode: draft.hsCode,
      name: hit?.name || '用户提供的编码',
      inKb: Boolean(hit),
      source: 'user_input',
      confidence: 'high',
    });
  } else {
    for (const g of catalog) {
      if (g.kw.some((k) => raw.toLowerCase().includes(String(k).toLowerCase()))) {
        candidates.push({ hsCode: g.hs, name: g.name, inKb: true, source: 'rule_match', confidence: 'medium' });
      }
    }
    const off = OFF_CATALOG.filter((g) => g.kw.some((k) => raw.toLowerCase().includes(String(k).toLowerCase())));
    for (const g of off) {
      candidates.push({ hsCode: g.hs, name: g.name, inKb: false, source: 'rule_match', confidence: 'medium' });
    }
    if (off.length) {
      notes.push(
        `「${off[0].name}」这个品类参数库还没建税率，暂时算不了。已入库的是：${catalog
          .map((c) => c.name)
          .join('、')}。`
      );
    }
    if (!candidates.length) {
      candidates.push(
        { hsCode: '8708.91', name: '机动车辆用散热器及其零件（示例候选）', inKb: true, source: 'fallback', confidence: 'low' },
        { hsCode: '8708.99', name: '其他机动车辆零件（示例候选）', inKb: false, source: 'fallback', confidence: 'low' }
      );
      notes.push('未识别到编码与品名，按汽配示例给出候选；请人工确认后再预演。');
    } else if (!off.length) {
      notes.push('编码由品名规则匹配给出候选，只用于让你选，不落库、不参与税率生成。');
    }
    draft.hsCode = '';
  }

  if (!draft.fob) notes.push('未识别到 FOB 货值，请补填。');
  if (!draft.qty) notes.push('未识别到数量，请补填。');
  if (!draft.country) notes.push('未识别到目的国，请补填。');

  return {
    draft,
    candidates,
    confidence: draft.hsCode ? 'high' : candidates[0]?.confidence || 'low',
    notes,
    missing: ['country', 'hsCode', 'fob', 'qty', 'channel'].filter((k) => !draft[k]),
  };
}

export function hsMeta(params, q) {
  const query = String(q || '').replace(/\D/g, '');
  const out = [];
  const rows = [...catalogOf(params), ...OFF_CATALOG.map((g) => ({ ...g, inKb: false }))];
  for (const g of rows) {
    if (!query || String(g.hs).replace('.', '').startsWith(query) || g.kw.some((k) => String(q).includes(k))) {
      out.push({ hsCode: g.hs, name: g.name, inKb: g.inKb });
    }
  }
  for (const t of params.raw.tariffs) {
    const d = String(t.hsPrefix).replace(/\D/g, '');
    if (query && !d.startsWith(query)) continue;
    if (!out.some((o) => String(o.hsCode).replace('.', '').startsWith(d))) {
      out.push({ hsCode: d, name: '参数库已建税率行', inKb: true, country: t.country });
    }
  }
  return out.slice(0, 8);
}
