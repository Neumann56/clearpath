// 单据读图 → 填表字段的"清洗 + 交叉核对"内核。
//
// 为什么需要这一层：模型读图会**编数字**。实测一张字太小的发票，模型报 fob=80,000
// 而图上印的是 48,000；换一张更糊的，两家模型给出的国家、HS 编码、数量全都不同。
// 对计税产品来说，读错一个货值就是把整份报告算错，所以：
//
//   1. 先清洗（白名单 / 类型 / 范围），模型给什么都不能直接信
//   2. 再交叉核对（两个模型独立读同一张图），不一致就**不填**，把候选摆出来让人选
//   3. 每个填进去的价值都要能在图上找到出处（evidence），找不到原文的降级为"待确认"
//
// 这一层是纯函数，不碰 DOM、不碰网络，所以可以拿真实模型输出来做回归测试。

import { FORM_FIELD_LABELS } from './assistant-prompt.js';

export { FORM_FIELD_LABELS };

/** 允许被识别的字段。表单里其余的（保险、金属含量等）单据上一般没有，不开放。 */
export const DOC_FIELDS = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate', 'entryDate'];

/** 金额类字段：走数值比较 */
const MONEY = new Set(['fob', 'freight', 'qty']);
/** 编码类字段：走"数字串连续包含"比较 */
const CODE = new Set(['hsCode']);
/** 日期类字段 */
const DATE = new Set(['declarationDate', 'entryDate']);

export const DOC_SYSTEM_PROMPT = `你是外贸单证识别助手。用户会给你一张外贸单据的图片（商业发票、装箱单、报关单、询价邮件截图等），你要把上面**明确写着**的填表字段抽出来。

【能填的字段】（只能填这些，别的不要编）
- country：目的国二字码（ISO 3166-1 alpha-2，如 DE / FR / US / HU）。要从收货人地址或目的港看出来，不要从发货地推断。填了参数库里没有的市场会被丢掉，所以拿不准就留空进 missing。
- hsCode：HS 编码，图上必须明确印着
- fob：货值（数字，美元）。图上如果是 FOB 总价就用它；如果只有单价，用单价 × 数量自己乘，并在 notes 里写清是乘出来的
- freight：运费（数字，美元）
- qty：数量（数字）
- channel：交易对象，只接受 B2B（买方是企业）或 B2C（买方是个人/电商零售）
- declarationDate：申报日 YYYY-MM-DD。图上写 Declaration / 报关日 / 申报日期 的那个
- entryDate：预计放行日 YYYY-MM-DD。图上写 Release / 放行 的那个

【最重要的规则】
- **图上没有的、看不清的，一律不要猜，放进 missing**。宁可少填一个字段，也不能填一个错的——这是算税用的，填错货值整份报告就错了。
- 数字必须逐位照读。看不清就承认看不清，不要给一个"看起来合理"的数。
- 发票上的 ETD/开船日不是放行日，Invoice Date 也不是申报日。对不上就不要填。
- 币种不是美元时换算成美元，并在 notes 里写明用的汇率；不确定汇率就不要填，进 missing。
- 明细表有几行，就把每一行的 HS 编码、数量、金额照抄进 lines（读不出某一项就留空，不要凑）。
- 如果 lines 里出现两个及以上**不同的** HS 编码：hsCode 和 qty 都不要填，放进 missing，并且必须在 notes 第一句写明"单据上有 N 行不同 HS 编码"。fob 可以填总价，因为总价是准的。

【evidence】
每个你填了的字段，必须**逐字照抄**图上让这个字段成立的那一句原文（保留原始数字、货币符号、千分位）。不要改写、不要翻译、不要自己编一句。找不到原句就不要填这个字段。

【seen】
这张图是什么：invoice（商业发票）/ packing_list（装箱单）/ customs（报关单）/ inquiry（询价或邮件）/ not_document（看不出是外贸单据）。

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何别的文字。
{"seen":"invoice","fields":{"country":"HU","hsCode":"8708.91","fob":48000,"freight":3200,"qty":500,"channel":"B2B","declarationDate":"2026-10-20"},"lines":[{"hsCode":"8708.91","qty":500,"amount":48000}],"missing":["entryDate"],"evidence":{"country":"Consignee: Budapest Trade Kft.","hsCode":"HS Code : 8708.91","fob":"Amount : USD 48,000.00","freight":"Freight : USD 3,200.00","qty":"Qty : 500 PCS","channel":"Consignee: Budapest Trade Kft.","declarationDate":"Declaration Date: 2026-10-20"},"notes":[],"say":"发票上的数我读出来了，放行日没有，你补一下。"}`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 去掉货币符号、千分位、单位，取出数字。取不到返回 null。 */
export function normNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').replace(/\s/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** HS 编码只留数字。 */
export function normHs(v) {
  if (v == null) return '';
  return String(v).replace(/\D/g, '');
}

/** 各种写法统一成 YYYY-MM-DD；认不出来返回 ''。 */
export function normDate(v) {
  if (v == null) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // 20 Oct 2026 / Oct 20, 2026
  const t = s.toLowerCase().replace(/,/g, ' ');
  m = t.match(/^(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s-]+(\d{4})/);
  if (m) return iso(Number(m[3]), MONTHS.indexOf(m[2]) + 1, Number(m[1]));
  m = t.match(/^([a-z]{3})[a-z]*[\s-]+(\d{1,2})[\s-]+(\d{4})/);
  if (m) return iso(Number(m[3]), MONTHS.indexOf(m[1]) + 1, Number(m[2]));
  return '';
}

function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}

/**
 * 清洗一个模型的输出。
 * 返回 { fields, rejected }，rejected 里每条都带原因，前端要把它说出来。
 */
export function normalizeFields(raw, opts = {}) {
  const countries = opts.countries || COUNTRY_CODES;
  const fields = {};
  const rejected = [];
  const src = { ...(raw?.fields || {}) };

  // 模型有时把字段写在顶层，兜一下
  for (const k of DOC_FIELDS) if (src[k] === undefined && raw?.[k] !== undefined) src[k] = raw[k];

  const push = (field, why, got) => rejected.push({ field, why, got: got === undefined ? null : String(got).slice(0, 40) });
  const drop = (field) => {
    delete fields[field];
  };

  for (const k of Object.keys(src)) {
    if (!DOC_FIELDS.includes(k)) continue;
    const v = src[k];
    if (v === '' || v === null || v === undefined) continue;

    if (k === 'country') {
      const c = String(v).trim().toUpperCase().slice(0, 2);
      if (!countries.includes(c)) {
        push(k, 'unsupported_country', v);
        continue;
      }
      fields[k] = c;
    } else if (k === 'hsCode') {
      const d = normHs(v);
      if (d.length < 6 || d.length > 10) {
        push(k, 'bad_hs', v);
        continue;
      }
      fields[k] = d;
    } else if (k === 'channel') {
      const c = String(v).trim().toUpperCase();
      if (c !== 'B2B' && c !== 'B2C') {
        push(k, 'bad_channel', v);
        continue;
      }
      fields[k] = c;
    } else if (DATE.has(k)) {
      const d = normDate(v);
      if (!d) {
        push(k, 'bad_date', v);
        continue;
      }
      fields[k] = d;
    } else if (MONEY.has(k)) {
      const n = normNumber(v);
      if (n === null || n < 0 || (k !== 'freight' && n === 0)) {
        push(k, 'bad_number', v);
        continue;
      }
      fields[k] = n;
    }
  }
  // 三个金额字段的相互关系：运费不能大于货值（真出现多半是读错了）
  if (fields.freight != null && fields.fob != null && fields.freight > fields.fob) {
    push('freight', 'freight_gt_fob', fields.freight);
    drop('freight');
  }
  if (fields.qty != null && !Number.isInteger(fields.qty)) {
    // 数量允许小数（吨、千克），但要有意义；小于 0.001 基本是读错
    if (fields.qty < 0.001) {
      push('qty', 'bad_number', fields.qty);
      drop('qty');
    }
  }
  return { fields, rejected };
}

/** 从一段原文里抽出所有数字，用于判断"这个值在不在引文里"。 */
function numbersIn(text) {
  const s = String(text || '').replace(/,/g, '');
  const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  return out;
}

/** 国家字段的引文核对要认两种写法：二字码（可能藏在 VAT 号里）和国家全名 */
const COUNTRY_NAMES = {
  HU: ['hungary', '匈牙利'],
  CZ: ['czech', 'czechia', '捷克'],
  US: ['united states', 'usa', 'america', '美国'],
  BR: ['brazil', '巴西'],
  IN: ['india', '印度'],
  TR: ['turkey', 'türkiye', 'turkiye', '土耳其'],
  // 欧盟其余成员国（2026-10 随参数库 kb-2026.10.24 接入）
  AT: ['austria', 'österreich', '奥地利'],
  BE: ['belgium', 'belgië', '比利时'],
  BG: ['bulgaria', '保加利亚'],
  CY: ['cyprus', '塞浦路斯'],
  DE: ['germany', 'deutschland', '德国'],
  DK: ['denmark', 'danmark', '丹麦'],
  EE: ['estonia', '爱沙尼亚'],
  GR: ['greece', 'hellas', '希腊'],
  ES: ['spain', 'españa', 'espana', '西班牙'],
  FI: ['finland', 'suomi', '芬兰'],
  FR: ['france', '法国'],
  HR: ['croatia', 'hrvatska', '克罗地亚'],
  IE: ['ireland', '爱尔兰'],
  IT: ['italy', 'italia', '意大利'],
  LT: ['lithuania', '立陶宛'],
  LU: ['luxembourg', '卢森堡'],
  LV: ['latvia', '拉脱维亚'],
  MT: ['malta', '马耳他'],
  NL: ['netherlands', 'holland', 'nederland', '荷兰'],
  PL: ['poland', 'polska', '波兰'],
  PT: ['portugal', '葡萄牙'],
  RO: ['romania', '罗马尼亚'],
  SE: ['sweden', 'sverige', '瑞典'],
  SI: ['slovenia', 'slovenija', '斯洛文尼亚'],
  SK: ['slovakia', 'slovensko', '斯洛伐克'],
  // 2026-10 随参数库 kb-2026.10.24-3 扩到 68 个市场
  // 别名要能覆盖发票上真实会印的写法：英文名、当地语言名、中文名。
  // 不写两字母缩写（GB/KR 这类），那是二字码匹配的活，混进来会误命中 struck、bulk 之类。
  GB: ['united kingdom', 'britain', 'england', 'uk.', '英国'],
  CH: ['switzerland', 'schweiz', 'suisse', 'svizzera', '瑞士'],
  NO: ['norway', 'norge', '挪威'],
  RS: ['serbia', 'srbija', '塞尔维亚'],
  UA: ['ukraine', 'ukraina', '乌克兰'],
  RU: ['russia', 'russian federation', '俄罗斯'],
  JP: ['japan', 'nihon', 'nippon', '日本'],
  KR: ['south korea', 'republic of korea', 'korea', '韩国'],
  SG: ['singapore', '新加坡'],
  TH: ['thailand', '泰国'],
  VN: ['vietnam', 'viet nam', '越南'],
  MY: ['malaysia', '马来西亚'],
  ID: ['indonesia', '印度尼西亚', '印尼'],
  PH: ['philippines', '菲律宾'],
  BD: ['bangladesh', '孟加拉国', '孟加拉'],
  PK: ['pakistan', '巴基斯坦'],
  AE: ['united arab emirates', 'uae', 'dubai', '阿联酋', '阿拉伯联合酋长国'],
  SA: ['saudi arabia', 'ksa', '沙特阿拉伯', '沙特'],
  QA: ['qatar', '卡塔尔'],
  KW: ['kuwait', '科威特'],
  IL: ['israel', '以色列'],
  CA: ['canada', '加拿大'],
  MX: ['mexico', 'méxico', '墨西哥'],
  CL: ['chile', '智利'],
  PE: ['peru', '秘鲁'],
  CO: ['colombia', '哥伦比亚'],
  AR: ['argentina', '阿根廷'],
  EC: ['ecuador', '厄瓜多尔'],
  PA: ['panama', 'panamá', '巴拿马'],
  DO: ['dominican republic', '多米尼加'],
  ZA: ['south africa', '南非'],
  EG: ['egypt', '埃及'],
  NG: ['nigeria', '尼日利亚'],
  KE: ['kenya', '肯尼亚'],
  MA: ['morocco', 'maroc', '摩洛哥'],
  AU: ['australia', '澳大利亚', '澳洲'],
  NZ: ['new zealand', '新西兰'],
};

/**
 * 参数库当前支持的市场。真正的来源是参数库，页面上的国家下拉就是照着它生成的；
 * 这里只是给单测和"没有表单可读"的场景一个兜底清单，改参数库时同步这里。
 */
export const COUNTRY_CODES = Object.keys(COUNTRY_NAMES);

/**
 * 填进去的值能不能在引用的原文里找到出处。
 * 返回 true/false。这是防"编数字"的最后一道闸。
 */
export function evidenceMatches(field, value, evidence) {
  const text = String(evidence || '').trim();
  if (!text) return false;

  if (field === 'country') {
    const code = String(value || '').toUpperCase();
    // 二字码要按词边界找，否则 HU 会命中 HOUSE 之类
    if (new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`).test(text.toUpperCase())) return true;
    const low = text.toLowerCase();
    return (COUNTRY_NAMES[code] || []).some((n) => low.includes(n));
  }
  if (CODE.has(field)) {
    const d = normHs(value);
    return d.length >= 6 && normHs(text).includes(d);
  }
  if (DATE.has(field)) {
    const d = normDate(value);
    if (!d) return false;
    if (normDate(text) === d) return true;
    const p = d.split('-');
    const ymd = p.join('');
    return normHs(text).includes(ymd);
  }
  const n = normNumber(value);
  if (n === null) return false;
  const pool = numbersIn(text);
  // 引文里的数可能写成 48,000.00 或者是 96.00 × 500，所以只要有一个数等于它就算对得上
  return pool.some((x) => Math.abs(x - n) < 1e-6);
}

/**
 * 交叉核对两个模型的独立读图结果，决定每个字段填不填。
 *
 * 返回：
 *   fill     —— 可以放心填的（两边一致，且主模型给得出原文）
 *   confirm  —— 需要人点一下的（两边不一致 / 只有一边读出来 / 有值但找不到原文）
 *   missing  —— 两边都没读出来的
 *   rejected —— 被清洗挡掉的脏数据
 *   seen     —— 单据类型；两边都说不像单据时，整个功能就不该往下填
 */
export function adjudicate(primary, secondary, opts = {}) {
  const countries = opts.countries || COUNTRY_CODES;
  const A = normalizeFields(primary, { countries });
  // 只有一个模型能用时（第二家挂了 / 额度不够），退化为"单模型 + 严格引文"：
  // 不再有第二票来否决，所以只填引文能核实的那几个，其余一律交给人。
  const single = !secondary;
  const B = single ? { fields: {}, rejected: [] } : normalizeFields(secondary, { countries });
  const seenA = String(primary?.seen || '').trim();
  const seenB = String(secondary?.seen || '').trim();

  const notDoc = seenA === 'not_document' && seenB === 'not_document';
  const evidenceA = primary?.evidence || {};

  const fill = {};
  const fillEvidence = {};
  const confirm = [];
  const missing = [];
  const notes = [];

  for (const f of DOC_FIELDS) {
    if (notDoc) {
      missing.push(f);
      continue;
    }
    const va = A.fields[f];
    const vb = B.fields[f];
    const hasA = va !== undefined;
    const hasB = vb !== undefined;

    if (!hasA && !hasB) {
      missing.push(f);
      continue;
    }

    const ev = evidenceA[f];

    // 渠道是"看图推断"出来的，不是抄录 —— 发票上不会印 B2B 三个字。
    // 所以这一项永远不自动填，一律交给人点一下。
    if (f === 'channel') {
      const cands = [];
      if (hasA) cands.push(va);
      if (hasB && vb !== va) cands.push(vb);
      confirm.push({ field: 'channel', candidates: cands, reason: 'inferred' });
      continue;
    }

    if (single) {
      if (hasA && evidenceMatches(f, va, ev)) {
        fill[f] = va;
        fillEvidence[f] = String(ev).trim();
      } else {
        confirm.push({ field: f, candidates: hasA ? [va] : [], reason: hasA ? (ev ? 'weak_evidence' : 'no_evidence') : 'single', by: hasA ? 'primary' : 'secondary' });
      }
      continue;
    }

    // 只有一边读出来 → 不填，让人确认
    if (hasA !== hasB) {
      confirm.push({
        field: f,
        candidates: [hasA ? va : vb],
        reason: 'single',
        by: hasA ? 'primary' : 'secondary',
      });
      continue;
    }

    // 两边都有：先看是不是同一个意思（HS 编码允许 6 位 / 8 位这种粒度差异）
    const same = f === 'hsCode' ? hsCodeCompatible(va, vb) : String(va) === String(vb);
    if (!same) {
      confirm.push({ field: f, candidates: [va, vb], reason: 'conflict' });
      continue;
    }

    // HS 编码两边位数不同时，以"引文支持得住的那个"为准：
    // 图上只印了 6 位，就不该拿 8 位去填——多出来的两位没有出处。
    let value = va;
    if (f === 'hsCode' && va !== vb) {
      const longer = va.length >= vb.length ? va : vb;
      const shorter = va.length >= vb.length ? vb : va;
      value = evidenceMatches(f, longer, ev) ? longer : shorter;
      if (value === longer) notes.push('两个模型读出的 HS 编码位数不同，已按较长的那个填（原文里能找到）。');
    }

    if (evidenceMatches(f, value, ev)) {
      fill[f] = value;
      fillEvidence[f] = String(ev).trim();
    } else {
      // 数对上了但引文对不上：可能是模型改写了原文，也可能在编，交给用户拍板
      confirm.push({ field: f, candidates: [value], reason: ev ? 'weak_evidence' : 'no_evidence' });
    }
  }

  for (const r of A.rejected) {
    confirm.push({ field: r.field, candidates: B.fields[r.field] !== undefined ? [B.fields[r.field]] : [], reason: 'rejected', why: r.why, got: r.got });
  }

  // 一票多品名：跨 HS 编码的数量和编码本身对"单票试算"没有意义，一律不进表单。
  // 只要任意一家读出了两个及以上不同编码，就当多品名处理——宁可让用户拆票，也不给一个混算的价。
  const multiLine = detectMultiLine(primary, secondary);
  if (multiLine) {
    for (const f of ['hsCode', 'qty']) {
      if (fill[f] !== undefined) delete fill[f];
      if (fillEvidence[f] !== undefined) delete fillEvidence[f];
    }
    const i = confirm.findIndex((c) => c.field === 'hsCode' || c.field === 'qty');
    if (i >= 0) confirm.splice(i, 1);
    for (let j = confirm.length - 1; j >= 0; j--) {
      if (confirm[j].field === 'hsCode' || confirm[j].field === 'qty') confirm.splice(j, 1);
    }
    for (const f of ['hsCode', 'qty']) if (!missing.includes(f)) missing.push(f);
    notes.unshift(`单据上有 ${multiLine.count} 行、${multiLine.codes.length} 个不同的 HS 编码，编码和数量我不替你合。`);
  }

  return { seen: seenA || seenB, notDoc, single, multiLine, fill, fillEvidence, confirm, missing, notes };
}

/**
 * 从两家模型各自的明细行里判断是不是一票多品名。
 * 只认"不同 HS 编码"，同一编码多行（分批装运）不算。
 */
/**
 * 第二家的候选模型：必须把第一家**实际用上的**那个剔掉。
 *
 * 这一步不能省。第一家如果首选模型看不了图、降级到了备选，
 * 第二家再从备选开始，两家就是同一个模型——它当然同意自己。
 * 那种"一致"是假的，比只有一个模型更危险：它给了用户一个不该有的确信。
 */
export function peerCandidates(listB, usedPrimary) {
  return (Array.isArray(listB) ? listB : []).filter((m) => m && m !== usedPrimary);
}

export function detectMultiLine(primary, secondary) {
  const rows = [];
  for (const doc of [primary, secondary]) {
    for (const l of Array.isArray(doc?.lines) ? doc.lines : []) {
      const code = normHs(l?.hsCode);
      if (code) rows.push({ code, qty: normNumber(l?.qty), amount: normNumber(l?.amount) });
    }
  }
  if (!rows.length) return null;
  const codes = [...new Set(rows.map((r) => r.code))];
  if (codes.length < 2) return null;
  const count = Math.max(...[primary, secondary].map((d) => (Array.isArray(d?.lines) ? d.lines.length : 0)));
  return { count, codes, rows };
}

/** 6 位与 8/10 位是同一编码的不同粒度，前缀相同就算一致 */
function hsCodeCompatible(a, b) {
  const x = normHs(a);
  const y = normHs(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
