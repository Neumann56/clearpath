// 服务端预取：把用户问题里"能认出来的实体"，翻译成参数库里带出处的数字。
//
// 为什么不在前端做：浏览器只拿得到 /api/meta/* 那种清单，拿不到 tariffs/charges 明细；
// 也为什么不给模型 tools：这条链路只查不写、只读不推，做成预取最稳——数字 100% 来自
// data/params，模型没有机会编，也没有机会拿它去算金额。
//
// 三条硬约束：
// 1. partial_code 必须挡掉。"客户砍价 10% 怎么回"里那个 10 会被正则抠出来，
//    放过去就会拿 "10" 去套税目。
// 2. 查不到就说查不到。"参数库没这个组合"不等于免税，文案里写清楚。
// 3. 附加措施（232/301）只列不判。它们之间有互斥关系，适用与否由引擎按申报日算。
import { loadParams, matchTariff, matchCharges, matchMeasures, resolveHsInput } from './params.js';

const MAX_CHARGES = 6;
const MAX_MEASURES = 4;

/** 找国家名，长名优先：问句里出现"阿联酋"时不能被"阿联"截胡。 */
function findCountry(q, params) {
  const hits = (params.raw.countries || [])
    .filter((c) => c.name && q.includes(c.name))
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0] || null;
}

/**
 * 先按编码，再按品名——和录入页走同一套归一（lib/params.js: resolveHsInput）。
 * 只写品名的情况很常见："光伏组件发巴西要交什么税"，用户不会主动报编码。
 */
function findHs(q, params) {
  const m = q.match(/\d{4}(?:[\s.]?\d{2}){0,2}/);
  return resolveHsInput(params, m ? m[0] : q);
}

/** 0.025 → 2.5%；0.003464 → 0.346%。比率不是钱，只做展示，不参与任何运算。 */
function pctText(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '';
  return `${Number((n * 100).toFixed(3))}%`;
}

function tariffFacts(t, cat) {
  if (!t) {
    return `参数库里还没有「这个市场 × ${cat ? cat.name : '这个品类'}」的组合。这不代表免税，也不代表零关税——是没调研到，报告里会写明缺口。`;
  }
  const out = {
    值: pctText(t.rate) || '该品类不按货值百分比计征',
    置信度: t.confidence || '',
    出处: t.sourceUrl || '',
    说明: t.note || '',
    生效日: t.validFrom || '',
  };
  // 低置信度还给模型，它就敢当结论讲。0% 尤其危险——看起来像"免税"，实际是"待复核"。
  if (t.confidence === 'low' || t.confidence === 'unverified') {
    out.注意 = '这条只作定性提示，不要说成已确认，也不要据此断言零关税';
  }
  return out;
}

function chargeFacts(list) {
  if (!list.length) {
    return '该市场的清关规费还没入库。报告里会明说这一项缺失，不要当成零处理。';
  }
  return list.slice(0, MAX_CHARGES).map((c) => {
    const range = c.min && c.max ? `${c.min}–${c.max}` : '';
    return {
      名称: c.label || c.code || '',
      计法: c.rate ? `按货值 ${pctText(c.rate)}` : '按票计',
      金额区间: range,
      默认是否计入: c.enabledByDefault ? '默认计入' : '默认不计入，要用户确认',
      置信度: c.confidence || '',
      出处: c.sourceUrl || '',
    };
  });
}

function measureFacts(list) {
  if (!list.length) return '无';
  return list.slice(0, MAX_MEASURES).map((m) => ({
    名称: m.label || m.measureType || '',
    税率: pctText(m.rate),
    置信度: m.confidence || '',
    出处: m.sourceUrl || '',
    说明: m.note || '',
    是否适用: '要按申报日由引擎判定。这里只是列出来，不要自己判断加不加',
  }));
}

/**
 * @returns null | {kind:'none',reason} | {kind:'ambiguous',country,candidates} | {kind:'facts',facts}
 *   kind 不是 facts/ambiguous 时，调用方应当退化成纯常识回答（不报错、不提示用户）。
 */
export function prefetch(question, params = null) {
  const q = String(question || '').trim();
  if (!q) return null;

  const p = params || loadParams();
  const country = findCountry(q, p);
  const hsRes = findHs(q, p);

  // "10%"里的 10、门牌号、柜号…… 长度不够的一律不认（见文件头第 1 条）
  if (!hsRes || hsRes.matchedBy === 'partial_code') return { kind: 'none', reason: 'partial_code' };
  if (!country) return { kind: 'none', reason: 'no_country' };
  if (hsRes.matchedBy === 'ambiguous') {
    return {
      kind: 'ambiguous',
      country: { code: country.code, name: country.name },
      candidates: (hsRes.candidates || []).slice(0, 6),
    };
  }
  if (!hsRes.digits) return { kind: 'none', reason: 'no_hs' };

  const cat = (p.raw.hsCatalog || []).find((c) => hsRes.digits.startsWith(String(c.hs)));
  const tariff = matchTariff(p.idx, country.code, hsRes.digits);
  const charges = matchCharges(p.idx, country.code);
  const measures = matchMeasures(p.idx, country.code, hsRes.digits);

  return {
    kind: 'facts',
    facts: {
      编码: hsRes.digits,
      编码来源:
        hsRes.matchedBy === 'name'
          ? `按品名「${hsRes.matchedName || cat?.name || ''}」归到这一码`
          : '用户直接给的编码',
      品类: cat ? cat.name : '不在品类表内',
      市场: `${country.name}（${country.code}）`,
      参数版本: p.version || '',
      数据截止: p.asOf || '',
      最惠国税率: tariffFacts(tariff, cat),
      附加措施: measureFacts(measures),
      清关规费: chargeFacts(charges),
    },
  };
}
