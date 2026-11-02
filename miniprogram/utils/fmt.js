/** 数字与文本格式化。服务端已经算好金额，这里只负责显示，不做任何运算。 */

function money(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const s = Math.abs(n).toFixed(2);
  const parts = s.split('.');
  return (neg ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

/** 入参是 0–1 的小数：0.03 → "3.00%" */
function pct(v, digits) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(digits === undefined ? 2 : digits) + '%';
}

/** 870891 → 8708.91 */
function hsText(hs) {
  const s = String(hs || '').replace(/\D/g, '');
  if (s.length === 6) return s.slice(0, 4) + '.' + s.slice(4);
  if (s.length === 8) return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6);
  return s;
}

const STATE_TEXT = {
  complete: '已出数',
  complete_with_gaps: '已出数 · 有缺口',
  needs_confirmation: '待确认',
  blocked: '已阻断',
};

const STATE_CLASS = {
  complete: '',
  complete_with_gaps: 'gap',
  needs_confirmation: 'confirm',
  blocked: 'block',
};

function stateText(s) {
  return STATE_TEXT[s] || s || '—';
}
function stateClass(s) {
  return STATE_CLASS[s] === undefined ? '' : STATE_CLASS[s];
}

const CONF_TEXT = { high: '高', medium: '中', low: '低' };
function confText(c) {
  return CONF_TEXT[c] || c || '';
}

/** 参数库里混进过内部字段名，界面上不许出现。和 H5 版同一份规则。 */
const FIELD_PLAIN = [
  [/\s*\blandedCost\b/g, '真实成本'],
  [/\s*\bcashRequired\b/g, '需备现金'],
  [/\s*\bcashGap\b/g, '现金缺口'],
  [/\s*\btaxChain\b/g, '税链'],
  [/\s*\bdutyBreakdown\b/g, '关税明细'],
  [/\s*\bchargeLines\b/g, '规费明细'],
  [/\s*\bunresolved\b/g, '待核项'],
  [/\s*\bdataGaps\b/g, '数据缺口'],
];

function plain(s) {
  let out = String(s || '');
  for (let i = 0; i < FIELD_PLAIN.length; i += 1) out = out.replace(FIELD_PLAIN[i][0], FIELD_PLAIN[i][1]);
  return out;
}

module.exports = { money, pct, hsText, stateText, stateClass, confText, plain };
