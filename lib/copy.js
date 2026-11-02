export const DISCLAIMER =
  '本报告为基于公开参数与您提供输入的估算，不构成法律、税务或海关申报意见。标注“待核/未核实”的事项尚未取得一手来源，不得作为申报依据。最终税费以目的国海关与您的报关代理确认为准。';

export const T = {
  conclusion: (landedCost, rate, cashRequired) =>
    `预计真实成本 ${landedCost} 美元（有效税率 ${rate}%）；清关需备现金 ${cashRequired} 美元。`,
  dualBasis: () => '两个数永不相加。目的国无可退增值税且反倾销不追溯时，二者相等。',
  gap: (cashGap, ratio) => `现金缺口 ${cashGap} 美元（占真实成本 ${ratio}%），主要是可退增值税垫付。`,
  gapRed: (cashGap, ratio) => `这票货要先垫 ${cashGap} 美元（占 ${ratio}%），回款前资金链风险高。`,
  gapYellow: (cashGap, months) => `需备 ${cashGap} 美元周转，账期约 ${months} 个月。`,
  gapGreen: () => '资金占用正常。',
  skipped: (measure, reason) => `${measure} 未计入：${reason}。`,
  inTransit: (exportDate, shipBy, entryDate, enterBy) =>
    `因在途条款本条不适用（装船日 ${exportDate} ≤ ${shipBy}，申报日 ${entryDate} ≤ ${enterBy}）。`,
  t1: (title, defaultLabel, v1, altLabel, v2, delta) =>
    `${title}，我们无法确认。按 ${defaultLabel} 计算为 ${v1}；按 ${altLabel} 为 ${v2}。差额 ${delta} 美元。`,
  t2: (condition, impact, id) => `若 ${condition}，本票再 ${impact}（待核 ${id}）。`,
  t3: (title, current, conf) => `${title} 口径存在争议（本报告按 ${current} 计算，置信度 ${conf}）。`,
  t4: (title, who) => `${title} 尚未核实，本报告不作确定结论，建议向 ${who} 确认。`,
  assumption: (field, value, note) => `${field} 按 ${value} 估算（${note}）。`,
  nonRefundable: (taxName) => `${taxName} 不可抵扣/退还，计入真实成本。`,
  refundable: (taxName) => `${taxName} 可抵扣/退还，仅影响现金流，不计入真实成本。`,
  inclusive: (taxName, baseText) => `${taxName} 为价内税，已按 gross-up 计算（税基 ${baseText}）。`,
  adThree: (deposit, final, diff, kind) =>
    `保证金 ${deposit}；预计最终 ${final}；${diff}（${kind}）。退款请求权归登记进口商（IOR），非付款方。`,
  complianceAmortized: (cert, n, per) => `${cert} 年费按 ${n} 票/年摊销，每票 ${per}。`,
  overdue: (days) => `该结论已 ${days} 天未复核，仅供参考。`,
  footer: (engineVersion, paramsVersion, asOf, uuid) =>
    `引擎 ${engineVersion} / 参数 ${paramsVersion} / 截止 ${asOf} / 报告 ${uuid}`,
};

export const EMPTY_TEXT = {
  noReport: '还没有预演记录。算一票试试',
  countryMissing: (list) => `该市场参数库未建（已支持：${list}）。可申请开通`,
  engineError: '计算失败，请重试',
  offline: '离线演示模式：数据为预生成样例',
  unverifiedHeavy: '本报告有较多未核实参数，结论仅供内部评估，不建议直接对外报价',
};
