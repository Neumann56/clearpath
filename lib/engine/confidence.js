import { D } from '../decimal.js';

export const CONF_ORDER = { unverified: 0, low: 1, medium: 2, high: 3 };
export const CONF_LABEL = { high: 'high', medium: 'medium', low: 'low', unverified: 'unverified' };

/** min 法聚合 + unverified 一票否决（BR-16） */
export function aggregateConfidence(items) {
  const list = (items || []).map((i) => i.confidence || 'medium');
  if (!list.length) return 'high';
  return list.reduce((a, b) => (CONF_ORDER[a] <= CONF_ORDER[b] ? a : b));
}

/** 金额加权置信度：内部质量看板用，对外一律以 min 法为准 */
export function weightedConfidence(items) {
  let num = D.of(0);
  let den = D.of(0);
  for (const i of items || []) {
    const amt = D.of(i.amount ?? 0).abs();
    if (amt.isZero()) continue;
    const w = { high: 1, medium: 0.75, low: 0.4, unverified: 0 }[i.confidence || 'medium'];
    num = num.add(amt.mul(D.of(w)));
    den = den.add(amt);
  }
  if (den.isZero()) return D.of(1);
  return num.div(den);
}

export function unverifiedRatio(items) {
  const total = (items || []).length;
  if (!total) return 0;
  const bad = (items || []).filter((i) => i.confidence === 'unverified').length;
  return bad / total;
}
