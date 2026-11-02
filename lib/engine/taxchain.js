import { D } from '../decimal.js';

const LABEL = {
  cif: 'CIF',
  duty: '关税',
  surtax: '附加税',
  charges: '规费',
  freight: '运费',
};

export class ParamError extends Error {
  constructor(code, message, detail) {
    super(message ? `${code} ${message}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 依赖图找环。线性税链只允许"引用更小 seq"，一旦成环（如 PIS 基含 ICMS、ICMS 基含 PIS）
 * 线性模型在数学上表达不了 → E_TAX_REF_CYCLE，宁可不出数，不出错数（PRD §6.9.1）。
 */
function detectCycle(steps) {
  const byCode = new Map(steps.map((s) => [s.taxCode, s]));
  const state = new Map(); // 0=未访问 1=栈中 2=完成
  const stack = [];

  const visit = (code) => {
    const st = state.get(code) || 0;
    if (st === 2) return;
    if (st === 1) throw new ParamError('E_TAX_REF_CYCLE', `税链存在循环引用：${[...stack, code].join(' → ')}`, [...stack, code]);
    state.set(code, 1);
    stack.push(code);
    const s = byCode.get(code);
    if (s) {
      for (const c of s.baseComponents || []) {
        if (typeof c === 'object' && c.ref) visit(c.ref);
      }
    }
    stack.pop();
    state.set(code, 2);
  };

  for (const s of steps) visit(s.taxCode);
}

/**
 * 唯一实现，不得分叉（v2 §1.2）。
 * 约束：① ref 只能向前 ② inclusive 不得自引用 ③ 禁止逐步舍入 ④ inclusive 的 base 存未含自身的税基
 */
export function runTaxChain(steps, ctx) {
  detectCycle(steps);
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const seen = new Map();
  const lines = [];

  for (const s of ordered) {
    let base = D.of(0);
    const parts = [];
    for (const c of s.baseComponents || []) {
      if (typeof c === 'string') {
        if (ctx[c] === undefined) throw new ParamError('E_TAX_BASE_UNKNOWN', `未知税基成分 ${c}`);
        base = base.add(ctx[c]);
        parts.push(LABEL[c] || c);
      } else {
        const prev = seen.get(c.ref);
        if (prev === undefined) {
          throw new ParamError('E_TAX_REF_FORWARD', `${s.taxCode} 引用了未计算或不存在的 ${c.ref}`);
        }
        base = base.add(prev);
        parts.push(c.ref);
      }
    }

    const dppFactor = s.dppFactor ? D.of(s.dppFactor) : D.of(1);
    const taxable = base.mul(dppFactor);
    const rate = D.of(s.rate);
    // inclusive：base/(1-rate)*rate —— 价内税 gross-up（BR-03）
    const tax = s.inclusive ? taxable.div(D.of(1).sub(rate)).mul(rate) : taxable.mul(rate);

    seen.set(s.taxCode, tax);
    lines.push({
      seq: s.seq,
      taxCode: s.taxCode,
      name: s.taxNameZh,
      label: s.taxNameZh,
      rate,
      base: taxable,
      baseText: parts.join(' + '),
      amount: tax,
      inclusive: !!s.inclusive,
      refundable: !!s.refundable,
      dppFactor,
      payableAt: s.payableAt || 'import',
      confidence: s.confidence || 'medium',
      sourceUrl: s.sourceUrl || '',
      note: s.note || '',
      validFrom: s.validFrom || null,
    });
  }

  return lines;
}
