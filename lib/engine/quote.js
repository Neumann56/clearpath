import { D, money, pct as pctNum } from '../decimal.js';
import { runTaxChain, ParamError } from './taxchain.js';
import { resolveEntryDate, validateDates } from './dates.js';
import { computeSurtax, PRIORITY } from './measures.js';
import { computeRemedy } from './remedy.js';
import { ftaOptions } from './fta.js';
import { computeCompliance } from './compliance.js';
import { aggregateConfidence, weightedConfidence } from './confidence.js';
import { matchTariff, matchMeasures, matchCharges, matchDualUse, taxStepsFor, resolveHsInput } from '../params.js';

export const RATE_LABEL = (r) => {
  const n = D.of(r).toNumber() * 100;
  return (Math.round(n * 100) / 100).toString() + '%';
};

export function hsDisplay(digits) {
  const d = String(digits || '');
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  return parts.join('.');
}

export function normalizeShipment(input, params) {
  const errors = [];
  const assumptions = [];
  const country = String(input.country || '').toUpperCase();

  // 品名与编码走同一条路：录入页承诺"写品名也能认"，那这里就得真认。
  const hsRes = resolveHsInput(params, input.hsCode);
  const hsDigits = hsRes.digits;

  if (!hsDigits || hsDigits.length < 6 || hsDigits.length > 10) {
    const cats = (params.raw.hsCatalog || []).map((c) => c.name).join('、');
    let message;
    if (hsRes.matchedBy === 'ambiguous') {
      const list = hsRes.candidates.map((c) => `${c.name}（${hsDisplay(c.hs)}）`).join('、');
      message = `「${input.hsCode}」能对上不止一个品类：${list}。请写清是哪一个，或直接填 HS 编码——猜哪个都可能用错税目。`;
    } else if (hsRes.matchedBy === 'unknown') {
      message = `没认出「${input.hsCode}」是哪个品类。已入库：${cats}；也可以直接填 6–10 位 HS 编码。`;
    } else if (hsRes.matchedBy === 'partial_code') {
      message = `HS 编码只填了 ${hsDigits.length} 位，需要 6–10 位。`;
    } else {
      message = '请填写 HS 编码（6–10 位）或已入库的品名。';
    }
    errors.push({ code: 'E_HS_INVALID', http: 400, message });
  }
  // 品名归一必须留痕：关税、反倾销、认证全按这个编码走，它不能是个"系统默默定了"的结论
  if (hsRes.matchedBy === 'name') {
    assumptions.push({
      field: 'HS 编码',
      value: hsDisplay(hsRes.digits),
      note: `按品名「${input.hsCode}」归到 ${hsDisplay(hsRes.digits)}（${hsRes.matchedName}）；实际申报以报关行归类为准`,
      confidence: 'medium',
    });
  }
  const c = params.idx.country.get(country);
  if (!c || !c.supported) {
    // 支持的市场已有几十个，全量罗列会变成一堵墙；给几个代表 + 总数 + 下一步动作。
    const sup = (params.raw.countries || []).filter((x) => x.supported);
    const preview = sup.slice(0, 6).map((x) => x.code).join('/');
    const more = sup.length > 6 ? ` 等 ${sup.length} 个市场` : '';
    errors.push({
      code: 'E_COUNTRY_UNSUPPORTED',
      http: 400,
      message: `该市场参数库未建（${country || '未填国家'}）。已支持 ${preview}${more}；要开通请到「参数治理」提交申请`,
    });
  }

  const fob = D.of(input.fob ?? 0);
  if (fob.lte(0)) errors.push({ code: 'E_FOB_INVALID', http: 400, message: '货值必须是大于 0 的数字' });
  const freight = D.of(input.freight ?? 0);
  if (freight.lt(0)) errors.push({ code: 'E_FREIGHT_INVALID', http: 400, message: '运费不能为负' });
  const qty = Number(input.qty ?? 0);
  if (!(qty > 0)) errors.push({ code: 'E_QTY_INVALID', http: 400, message: '数量必须大于 0' });
  const channel = input.channel === 'B2C' ? 'B2C' : input.channel === 'B2B' ? 'B2B' : null;
  if (!channel) errors.push({ code: 'E_CHANNEL_REQUIRED', http: 400, message: '请选择渠道：B2B 或 B2C' });

  let insurance;
  let insuranceSource;
  const insRaw = input.insurance;
  if (insRaw !== undefined && insRaw !== null && String(insRaw).trim() !== '') {
    insurance = money(D.of(insRaw));
    insuranceSource = 'provided';
  } else {
    const rate = D.of(params.raw.insuranceDefaultRate);
    insurance = money(fob.mul(rate));
    insuranceSource = 'default_from_param';
    assumptions.push({
      field: 'insurance',
      value: insurance.toNumber(),
      note: `按参数默认 ${RATE_LABEL(rate)} 估算 ${insurance.toFixed2()}（insurance_default_rate），未填实际保费`,
      confidence: 'medium',
    });
  }

  const declarationDate = input.declarationDate || input.dates?.declarationDate || null;
  const dates = {
    exportDate: input.exportDate || input.dates?.exportDate || null,
    declarationDate,
    entryDate: input.entryDate || input.dates?.entryDate || null,
    liquidationDate: input.liquidationDate || input.dates?.liquidationDate || null,
    certificateIssueDate: input.certificateIssueDate || input.dates?.certificateIssueDate || null,
  };
  if (!declarationDate) errors.push({ code: 'E_DECLARATION_DATE_REQUIRED', http: 400, message: '请填写申报日期' });

  const resolved = resolveEntryDate(dates);
  const dateErr = validateDates({ ...dates, entryDate: resolved.entryDate }, resolved.entryDateSource);
  if (dateErr && dateErr.code === 'E_DATE_INVALID') errors.push(dateErr);

  if (resolved.entryDateSource === 'defaulted_from_declaration') {
    assumptions.push({
      field: 'entryDate',
      value: resolved.entryDate,
      note: '清关日按申报日推定',
      confidence: 'medium',
      warnBar: true,
    });
  }

  const shipment = {
    country,
    countryName: c?.name || country,
    hsCode: hsDisplay(hsDigits),
    hsDigits,
    hsVersion: params.raw.hsVersion,
    fob,
    freight,
    insurance,
    insuranceSource,
    cif: fob.add(freight).add(insurance),
    qty,
    unit: input.unit || 'pcs',
    channel,
    origin: (input.origin || 'CN').toUpperCase(),
    dates: { ...dates, entryDate: resolved.entryDate },
    entryDateSource: resolved.entryDateSource,
    metalContentPct: input.metalContentPct === '' || input.metalContentPct == null ? null : D.of(input.metalContentPct),
    shipmentsPerYear: input.shipmentsPerYear == null || input.shipmentsPerYear === '' ? null : Number(input.shipmentsPerYear),
    amortizationYears: Number(input.amortizationYears || 1),
    endUserType: input.endUserType || 'civil',
    enableCharges: !!input.enableCharges,
    enabledCharges: Array.isArray(input.enabledCharges) ? input.enabledCharges : null,
    adDepositRate: input.adDepositRate == null || input.adDepositRate === '' ? null : D.of(input.adDepositRate),
    adFinalRate: input.adFinalRate == null || input.adFinalRate === '' ? null : D.of(input.adFinalRate),
    adCaseNo: input.adCaseNo || null,
    // 按定额计征的反倾销税需要计量数据（土耳其对华光伏是美元/㎡）
    areaSqm: input.areaSqm == null || input.areaSqm === '' ? null : D.of(input.areaSqm),
    weightKg: input.weightKg == null || input.weightKg === '' ? null : D.of(input.weightKg),
  };

  return { errors, assumptions, shipment };
}

/**
 * 单场景计算（同一票货算一遍）。所有口径在一个地方定死：
 *   landedCost   = CIF + duty + surtax + 不可退国内税 + charges + AD final + 合规
 *   cashRequired = CIF + duty + surtax + 全部国内税   + charges + AD deposit + 合规
 *   cashGap      = 可退国内税垫付 + (deposit - final)
 */
export function runScenario({ shipment, params, opts = {} }) {
  const dates = shipment.dates;
  const cifBase = shipment.cif;

  const tariff = matchTariff(params.idx, shipment.country, shipment.hsDigits);
  if (!tariff) {
    // 拒绝要给下一步，不能只说"没入库"——用户不知道该换成什么
    const cats = (params.raw.hsCatalog || []).map((c) => c.name).join('、');
    throw new ParamError(
      'E_MFN_MISSING',
      `这个市场 + 这个品类的税率还没入库。${cats ? `已入库品类：${cats}；换其中一个就能出数。` : '请换一个已入库的品类。'}`,
      { country: shipment.country, hs: shipment.hsCode }
    );
  }
  if (tariff.pending) {
    // 不是"忘了填"，是这个品类的税本来就不按货值百分比征（如瑞士纺织品按重量从量）。
    // 硬填一个从价百分比，等于用假的 2% 替掉真实的 CHF/kg——报出来的数看着像真的。
    throw new ParamError(
      'E_MFN_PENDING',
      tariff.note ||
        '这个市场对这个品类不是按货值百分比征税，需要按实际计量（重量/面积）核定后才能出数；请向报关行索取应缴税额。',
      { country: shipment.country, hs: shipment.hsCode }
    );
  }

  const measures = matchMeasures(params.idx, shipment.country, shipment.hsDigits);
  const chargeDefs = matchCharges(params.idx, shipment.country);

  // 规费（可进完税价格的部分，如巴西 AFRMM）——必须在算关税之前
  const chargeLines = [];
  let chargesTotal = D.of(0);
  let dutiableAdditions = D.of(0);
  for (const c of chargeDefs) {
    const included = Array.isArray(shipment.enabledCharges)
      ? shipment.enabledCharges.includes(c.code) || !!c.enabledByDefault
      : !!shipment.enableCharges || !!c.enabledByDefault;
    let amt;
    let base = cifBase;
    let baseText = c.base === 'freight' ? '运费' : c.fixedUsd ? '定额' : 'CIF';
    // 区间型规费（报关代理费、码头操作费这类）：参数给的是一段量级，不是一个确定值。
    // 报关行报价本来就是给区间，把它压成一个数就是编。这里按中值进合计，
    // 同时把上下限带出去——报告上必须能看出"这行是估的，估的是哪一段"。
    let amountMin = null;
    let amountMax = null;
    if (Array.isArray(c.rangeUsd) && c.rangeUsd.length === 2) {
      amountMin = money(D.of(c.rangeUsd[0]));
      amountMax = money(D.of(c.rangeUsd[1]));
      amt = money(amountMin.add(amountMax).div(2));
      base = D.of(0);
      baseText = '区间中值';
    } else if (c.fixedUsd) {
      amt = D.of(c.fixedUsd);
    } else if (c.base === 'freight') {
      base = shipment.freight;
      amt = base.mul(D.of(c.rate));
    } else {
      amt = base.mul(D.of(c.rate));
    }
    // 上下限只对"从价/定额"有意义；区间型本身就是上下限，再裁一次会把中值挤出去
    if (amountMin === null) {
      if (c.min) amt = amt.max(D.of(c.min));
      if (c.max) amt = amt.min(D.of(c.max));
    }
    amt = money(amt);
    if (included) {
      chargesTotal = chargesTotal.add(amt);
      if (c.entersDutyBase) dutiableAdditions = dutiableAdditions.add(amt);
    }
    chargeLines.push({
      lineCode: c.code,
      label: c.label,
      rate: D.of(c.rate || 0),
      base,
      baseText,
      amount: amt,
      amountMin,
      amountMax,
      localText: c.localText || '',
      included,
      confidence: c.confidence,
      sourceUrl: c.sourceUrl,
      note: c.note || '',
      entersDutyBase: !!c.entersDutyBase,
    });
  }

  const dutiableCif = cifBase.add(dutiableAdditions);
  const dutyRate = D.of(tariff.rate);
  const dutyAmount = money(dutiableCif.mul(dutyRate));
  const dutyLine = {
    lineCode: 'MFN',
    label: `最惠国关税 ${RATE_LABEL(dutyRate)}`,
    rate: dutyRate,
    base: dutiableCif,
    baseText: dutiableAdditions.isZero() ? 'CIF' : 'CIF + 计入完税价格的规费',
    amount: dutyAmount,
    layer: 'duty',
    confidence: tariff.confidence,
    sourceUrl: tariff.sourceUrl,
    note: tariff.note || '',
    skipped: false,
    skippedReason: '',
    pending: false,
    unresolvedIds: [],
  };
  const dutyTotal = dutyAmount;

  // 附加税 + 互斥（232 / 301 / 301FL / SWS）
  const surtax = computeSurtax({
    measures,
    ctx: { cif: dutiableCif, dutyTotal },
    dates,
    opts: {
      include232: !!opts.include232,
      s301OldExcluded: opts.s301OldExcluded !== false,
      metalContentPct: shipment.metalContentPct,
      ignoreTransitExempt: !!opts.ignoreTransitExempt,
    },
  });

  // 国内税链（C3）
  const taxSteps = taxStepsFor(params.idx, shipment.country);
  const taxLines = runTaxChain(taxSteps, {
    cif: dutiableCif,
    duty: dutyTotal,
    surtax: surtax.total,
    charges: chargesTotal,
    freight: shipment.freight,
  });

  let taxTotal = D.of(0);
  let refundableVat = D.of(0);
  let unrefundableTax = D.of(0);
  for (const l of taxLines) {
    taxTotal = taxTotal.add(l.amount);
    if (l.refundable) refundableVat = refundableVat.add(l.amount);
    else unrefundableTax = unrefundableTax.add(l.amount);
  }

  const remedy = computeRemedy({
    shipment,
    cif: dutiableCif,
    params,
    areaSqm: shipment.areaSqm,
  });
  const compliance = computeCompliance({
    country: shipment.country,
    channel: shipment.channel,
    params,
    shipment,
  });

  // 协定优惠税率：只作为并列口径输出，绝不并入 landedCost / cashRequired。
  // 享惠前提（原产地证 + RVC 举证）掌握在用户手里，系统不替他假设。
  const fta = ftaOptions({ shipment, params, dutiableCif, mfnRate: dutyRate });

  const adFinal = remedy.applicable && !remedy.incomplete ? money(remedy.final) : D.of(0);
  const adDeposit = remedy.applicable && !remedy.incomplete ? money(remedy.deposit) : D.of(0);

  const landedCost = money(
    cifBase.add(dutyTotal).add(surtax.total).add(unrefundableTax).add(chargesTotal).add(adFinal).add(compliance.total)
  );
  const cashRequired = money(
    cifBase.add(dutyTotal).add(surtax.total).add(taxTotal).add(chargesTotal).add(adDeposit).add(compliance.total)
  );
  const cashGap = money(cashRequired.sub(landedCost));
  const cashGapRatio = landedCost.isZero() ? D.of(0) : cashGap.div(landedCost);
  const addOnTotal = money(landedCost.sub(cifBase));
  const effectiveRate = cifBase.isZero() ? D.of(0) : addOnTotal.div(cifBase);

  return {
    cif: cifBase,
    dutiableCif,
    dutyLine,
    dutyTotal,
    surtax,
    surtaxTotal: surtax.total,
    dutyBreakdown: [dutyLine, ...surtax.lines],
    taxChain: taxLines,
    taxTotal,
    refundableVat,
    unrefundableTax,
    chargeLines,
    chargesTotal,
    compliance,
    remedy,
    adFinal,
    adDeposit,
    landedCost,
    cashRequired,
    cashGap,
    cashGapRatio,
    addOnTotal,
    effectiveRate,
    measures,
    fta,
  };
}

export function cashGapLevel(ratio) {
  const r = ratio.toNumber();
  if (r < 0.15) return 'green';
  if (r <= 0.4) return 'yellow';
  return 'red';
}
