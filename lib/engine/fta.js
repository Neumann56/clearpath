import { D } from '../decimal.js';

/**
 * RVC 必须按协定成员累积，不按"是否中国"（BR-18）。
 * 错误写法：nonOriginating = comp.filter(c => c.origin !== "CN")
 * 后果：RCEP 里日本原产成分被当成非原产，RVC 判不过，FTA 优惠被白白放弃。
 */
export function nonOriginatingValue(components, agreement) {
  const members = agreement?.members || [];
  return components
    .filter((c) => !members.includes(c.origin))
    .reduce((a, c) => a.add(D.of(c.valueUsd)), D.of(0));
}

export function rvcRatio(components, agreement) {
  const totalValue = components.reduce((a, c) => a.add(D.of(c.valueUsd)), D.of(0));
  if (totalValue.isZero()) return D.of(0);
  const nonOrig = nonOriginatingValue(components, agreement);
  return D.of(1).sub(nonOrig.div(totalValue));
}

export function evaluateFta({ components, agreements, threshold = '0.40' }) {
  return (agreements || [])
    .map((ag) => {
      const ratio = rvcRatio(components, ag);
      return {
        code: ag.code,
        label: ag.label,
        members: ag.members,
        rvc: ratio,
        qualifies: ratio.gte(threshold),
        threshold: D.of(threshold),
        confidence: ag.confidence,
      };
    })
    .sort((a, b) => b.rvc.cmp(a.rvc));
}

const digits = (hs) => String(hs || '').replace(/\D/g, '');

/**
 * 协定优惠税率（并列口径，不进 landedCost）。
 *
 * 为什么不能自动套用：能不能享惠取决于用户手上有没有原产地证、以及 RVC 是否达标。
 * 系统不知道这两件事，把优惠税率直接算进真实成本，等于替用户编了一个他没拿到的好处。
 * 所以这里只回答"如果办证，关税能从 X 降到 Y，省多少"。
 *
 * @returns {Array} 按可节省关税从大到小
 */
export function ftaOptions({ shipment, params, dutiableCif, mfnRate }) {
  const list = params?.raw?.fta || [];
  const key = digits(shipment.hsDigits);
  const rows = [];

  for (const ag of list) {
    const members = ag.members || [];
    // 原产国与目的地必须都在协定成员内，否则这份协定与本票无关
    if (!members.includes(shipment.origin)) continue;
    if (!members.includes(shipment.country)) continue;

    const pref = (ag.preferentialRates || [])
      .filter((r) => key.startsWith(digits(r.hsPrefix)))
      // 同一协定里各成员国的优惠税率并不一样：ACFTA 下 870891 在印尼仍保留 5%，其余成员是 0。
      // 只按 hsPrefix 匹配，就会把印尼的 5% 当 0% 报出去——那 5 个点是用户拿着 Form E 也省不下来的钱。
      .filter((r) => !r.countries || r.countries.includes(shipment.country))
      .sort((a, b) => {
        const byLen = digits(b.hsPrefix).length - digits(a.hsPrefix).length;
        if (byLen !== 0) return byLen;
        // 同长度下，点了具体国家的那条优先于通用那条
        return (b.countries ? 1 : 0) - (a.countries ? 1 : 0);
      })[0];
    if (!pref) continue;

    const prefRate = D.of(pref.rate);
    // 优惠税率不低于 MFN 就没有决策价值，不占版面
    if (prefRate.gte(mfnRate)) continue;

    const saving = dutiableCif.mul(mfnRate.sub(prefRate));
    rows.push({
      code: ag.code,
      label: ag.label,
      hsPrefix: pref.hsPrefix,
      mfnRate,
      preferentialRate: prefRate,
      saving,
      // 这一档只对哪些成员国成立（空 = 全体成员同档）
      appliesTo: pref.countries || null,
      certificate: pref.certificate || ag.certificate || '原产地证书',
      leadTimeDays: pref.leadTimeDays || ag.leadTimeDays || null,
      rvcThreshold: pref.rvcThreshold || ag.rvcThreshold || null,
      conditions: pref.conditions || '',
      confidence: pref.confidence || ag.confidence || 'medium',
      sourceUrl: pref.sourceUrl || ag.sourceUrl || '',
      note: pref.note || '',
      // 永不自动套用：这里明确标出它是"待用户提供原产地证才成立"
      requiresUserEvidence: true,
    });
  }

  return rows.sort((a, b) => b.saving.cmp(a.saving));
}
