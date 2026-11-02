import { D } from '../decimal.js';

/**
 * AD/CVD 三口径（BR-11/BR-12）：deposit → 现金；p50 final → 成本；delta → 或有。
 * 默认 p50 = depositRate，不得假设"保证金一定偏高"（会让 landedCost 系统性低估）。
 *
 * 计征方式（basis）必须区分，不能一律当从价：
 *   ad_valorem  按 CIF 百分比（绝大多数双反案）
 *   per_sqm     按平方米定额（土耳其对华光伏组件：20 / 25 美元/㎡）
 *   per_kg      按千克定额（印度对华太阳能铝边框：403–577 美元/吨）
 * 把定额税当从价率乘 CIF，数量级会差一到两个数量级，而且不报错。
 */
export function computeRemedy({ shipment, cif, params, areaSqm }) {
  const rule = (params?.raw?.remedies || []).find(
    (r) =>
      r.country === shipment.country &&
      String(shipment.hsDigits || '').startsWith(String(r.hsPrefix || '').replace(/\D/g, ''))
  );

  const userDeposit = shipment.adDepositRate;
  const userFinal = shipment.adFinalRate;
  const basis = rule?.basis || 'ad_valorem';

  // 用户手填保证金率 → 一律按从价处理（手填的是比例，不是定额）
  if (userDeposit != null) {
    return fromAdValorem({
      cif,
      depositRate: D.of(userDeposit),
      finalRate: userFinal != null ? D.of(userFinal) : D.of(userDeposit),
      rule,
      confidence: 'low',
      note: '保证金率由用户手填，未取得案号一手来源，标 low',
    });
  }

  if (!rule) return { applicable: false };

  if (basis === 'per_sqm' || basis === 'per_kg') {
    const unitRate = D.of(rule.unitRateUsd);
    const qty = basis === 'per_sqm' ? areaSqm : shipment.weightKg;
    const unitLabel = basis === 'per_sqm' ? '平方米' : '千克';

    // 缺计量单位时绝不能给 0：那会让 landedCost 静默偏低，肉眼还看不出来。
    if (qty == null || D.of(qty).lte(0)) {
      return {
        applicable: true,
        incomplete: true,
        type: rule.remedyType || 'AD',
        caseNo: rule.caseNo || '',
        basis,
        unitRateUsd: unitRate,
        unitLabel,
        missingField: basis === 'per_sqm' ? 'areaSqm' : 'weightKg',
        missingText: `本票命中按${unitLabel}定额计征的反倾销税（${unitRate.toFixed2()} 美元/${unitLabel}），但未填总面积`,
        depositRate: null,
        finalRate: null,
        deposit: D.of(0),
        final: D.of(0),
        delta: D.of(0),
        contingentLiability: D.of(0),
        potentialRefund: D.of(0),
        confidence: rule.confidence || 'medium',
        sourceUrl: rule.sourceUrl || '',
        note: '金额未计入真实成本与需备现金：缺计量数据，给了就是编的',
        refundClaimantNote: '退款请求权归登记进口商（IOR），非付款方；合同需前置约定退税归属',
      };
    }

    const total = D.of(qty).mul(unitRate);
    return {
      applicable: true,
      incomplete: false,
      type: rule.remedyType || 'AD',
      caseNo: rule.caseNo || '',
      basis,
      unitRateUsd: unitRate,
      unitLabel,
      quantity: D.of(qty),
      retrospective: rule.retrospective ?? true,
      depositRate: null,
      finalRate: null,
      deposit: total,
      final: total,
      delta: D.of(0),
      contingentLiability: D.of(0),
      potentialRefund: D.of(0),
      confidence: rule.confidence || 'medium',
      sourceUrl: rule.sourceUrl || '',
      note: `按定额计征：${unitRate.toFixed2()} 美元/${unitLabel} × ${D.of(qty).toFixed2()} ${unitLabel}。${rule.note || ''}`,
      refundClaimantNote: '退款请求权归登记进口商（IOR），非付款方；合同需前置约定退税归属',
    };
  }

  const depositRate = D.of(rule.depositRate);
  const finalRate = userFinal != null ? D.of(userFinal) : rule?.finalRateEstimate?.p50 != null ? D.of(rule.finalRateEstimate.p50) : depositRate;

  return fromAdValorem({ cif, depositRate, finalRate, rule });
}

function fromAdValorem({ cif, depositRate, finalRate, rule, confidence, note }) {
  const deposit = cif.mul(depositRate);
  const final = cif.mul(finalRate);
  const delta = final.sub(deposit);
  return {
    applicable: true,
    incomplete: false,
    type: rule?.remedyType || 'AD',
    caseNo: rule?.caseNo || '用户手填',
    basis: 'ad_valorem',
    retrospective: rule?.retrospective ?? true,
    depositRate,
    finalRate,
    deposit,
    final,
    delta,
    contingentLiability: delta.gt(0) ? delta : D.of(0),
    potentialRefund: delta.lt(0) ? delta.neg() : D.of(0),
    confidence: confidence || rule?.confidence || 'medium',
    sourceUrl: rule?.sourceUrl || '',
    note: note || rule?.note || '按参数库 AD 案号记录计算',
    refundClaimantNote: '退款请求权归登记进口商（IOR），非付款方；合同需前置约定退税归属',
  };
}
