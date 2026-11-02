import { D } from '../decimal.js';
import { isInTransitExempt, inTransitText } from './dates.js';

export const PRIORITY = ['SECTION_232', 'SECTION_301_FL_2026', 'SECTION_301', 'SECTION_122'];

export const TIER232_RATE = {
  ANNEX_IA_50: '0.50',
  ANNEX_IB_25: '0.25',
  ANNEX_III_15: '0.15',
  US_METALS_10: '0.10',
  EXEMPT_ANNEX_II: '0',
  EXEMPT_BELOW_15: '0',
  NONE: '0',
};

/**
 * 232 判定必须拆成两步，顺序不能反（PRD §6.9.0）：
 * ① 查表得档位 ② 含量只用于"≤15% 豁免"的举证
 * 用含量比例去算税率，会和公告的分档清单不一致——档位是清单给的，不是函数给的。
 */
function compute232(m, cif, contentPct) {
  const tier = m.tier232 || 'NONE';
  if (tier.startsWith('EXEMPT')) return { amount: D.of(0), exemptionStatus: 'EXEMPT_BY_ANNEX', tier };
  const rate = D.of(TIER232_RATE[tier] ?? m.rate);
  const amount = cif.mul(rate);

  if (!m.allowBelow15) return { amount, exemptionStatus: 'NOT_APPLICABLE', tier, rate };
  if (contentPct === null || contentPct === undefined) {
    return { amount, exemptionStatus: 'UNPROVEN', tier, rate };
  }
  if (D.of(contentPct).lte('0.15')) {
    return { amount: D.of(0), exemptionStatus: 'CLAIMED', tier, rate };
  }
  return { amount, exemptionStatus: 'NOT_CLAIMED', tier, rate };
}

/**
 * 附加税（L2）计算 + 互斥求解。互斥只在这一层解（C2），不允许下层再判。
 * @param {object} p
 * @param {Array} p.measures 命中的 measure（允许含未生效）
 * @param {object} p.ctx { cif, dutyTotal }
 * @param {object} p.dates 已解析的四日期
 * @param {object} p.opts { include232, s301OldExcluded }
 */
export function computeSurtax({ measures, ctx, dates, opts = {} }) {
  const lines = [];
  const { include232 = false, s301OldExcluded = true } = opts;
  const contentPct = opts.metalContentPct;

  const mutual = [];
  const others = [];

  for (const m of measures) {
    const isMutual = PRIORITY.includes(m.measureType);
    (isMutual ? mutual : others).push(m);
  }

  // ---- 1) 生效日与豁免前置判定 ----
  const prelim = [];
  for (const m of mutual) {
    const line = baseLine(m);
    if (m.effectiveFrom && dates.entryDate < m.effectiveFrom) {
      line.skipped = true;
      line.skippedReason = `措施自 ${m.effectiveFrom} 起生效，本票放行日 ${dates.entryDate} 早于生效日`;
      prelim.push({ m, line, alive: false });
      continue;
    }
    if (m.confidence === 'unverified') {
      line.skipped = true;
      line.unverifiedExcluded = true;
      line.skippedReason = '参数未核实（unverified），按 K2 不进入任何对外金额';
      prelim.push({ m, line, alive: false });
      continue;
    }
    if (m.measureType === 'SECTION_232') {
      if (!include232) {
        line.skipped = true;
        line.pending = true;
        line.unresolvedIds = ['UF-01'];
        line.skippedReason =
          '8708.91 是否在 232 汽车零部件附件未确认，本次按不计入处理（见待核 UF-01）；若成立则本条生效并同时淘汰旧/新 301';
        prelim.push({ m, line, alive: false });
        continue;
      }
      const r = compute232(m, ctx.cif, contentPct);
      line.rate = r.rate ?? D.of(m.rate);
      line.amount = r.amount;
      line.exemptionStatus = r.exemptionStatus;
      line.tier232 = r.tier;
      if (r.exemptionStatus === 'UNPROVEN') {
        line.unresolvedIds = ['UF-01'];
        line.note = '金属含量缺失，未证明可享 ≤15% 免征，按档位照常出数（可能多算）';
      }
      prelim.push({ m, line, alive: true });
      continue;
    }
    if (m.inTransitRule) {
      const r = opts.ignoreTransitExempt ? false : isInTransitExempt(m.inTransitRule, dates);
      if (r === true) {
        line.skipped = true;
        line.transitExempt = true;
        line.skippedReason = `因在途条款本条不适用（${inTransitText(m.inTransitRule, dates)}）`;
        prelim.push({ m, line, alive: false });
        continue;
      }
      if (r === 'unknown') {
        line.skipped = true;
        line.pending = true;
        line.needsExportDate = true;
        line.skippedReason = '缺少装船日（on board），在途豁免无法判定，本条暂不计入；请在录入页补装船日';
        prelim.push({ m, line, alive: false });
        continue;
      }
    }
    prelim.push({ m, line, alive: true });
  }

  // ---- 2) 互斥求解：232 > 301FL > 301 > 122 ----
  prelim.sort((a, b) => PRIORITY.indexOf(a.m.measureType) - PRIORITY.indexOf(b.m.measureType));
  const applied = [];
  for (const item of prelim) {
    if (!item.alive) {
      lines.push(item.line);
      continue;
    }
    const winner = applied.find((a) => {
      const ex = a.m.excludes || [];
      if (!ex.includes(item.m.measureType)) return false;
      // UF-02 反事实：放开 232 对旧 301 的淘汰，用于"若旧 301 不被排除"的可达状态
      if (item.m.measureType === 'SECTION_301' && !s301OldExcluded) return false;
      return true;
    });
    if (winner) {
      item.line.skipped = true;
      item.line.skippedReason = `因 ${winner.m.measureType} 覆盖，${item.m.measureType} 不适用`;
      item.line.dominatedBy = winner.m.measureType;
      if (item.m.measureType === 'SECTION_301') item.line.unresolvedIds = ['UF-02'];
      lines.push(item.line);
      continue;
    }
    // 金额只在"确认存活"后计算一次（232 的金额已在档位分支算过，不覆盖）
    if (item.m.measureType !== 'SECTION_232') {
      item.line.base = item.m.basis === 'percent_of_duty' ? ctx.dutyTotal : ctx.cif;
      item.line.amount = item.line.base.mul(D.of(item.m.rate));
    }
    applied.push(item);
    lines.push(item.line);
  }

  // ---- 3) 非互斥附加税（SWS 等） ----
  for (const m of others) {
    const line = baseLine(m);
    if (m.confidence === 'unverified') {
      line.skipped = true;
      line.unverifiedExcluded = true;
      line.skippedReason = '参数未核实（unverified），不进入任何对外金额（UF-04 D5）';
      lines.push(line);
      continue;
    }
    line.amount = m.basis === 'percent_of_duty' ? ctx.dutyTotal.mul(D.of(m.rate)) : ctx.cif.mul(D.of(m.rate));
    line.base = m.basis === 'percent_of_duty' ? ctx.dutyTotal : ctx.cif;
    line.baseText = m.basis === 'percent_of_duty' ? '关税（BCD）' : 'CIF';
    applied.push({ m, line, alive: true });
    lines.push(line);
  }

  const total = lines.filter((l) => !l.skipped).reduce((a, l) => a.add(l.amount || D.of(0)), D.of(0));

  return {
    lines: lines.sort((a, b) => orderOf(a.lineCode) - orderOf(b.lineCode)),
    total,
    pendings: lines.filter((l) => l.pending),
    unverifiedExcluded: lines.filter((l) => l.unverifiedExcluded),
  };
}

function orderOf(code) {
  const order = ['MFN', 'SECTION_232', 'SECTION_301', 'SECTION_301_FL_2026', 'SECTION_122', 'SWS', 'TR_EV_SURCHARGE'];
  const i = order.indexOf(code);
  return i === -1 ? 99 : i;
}

function baseLine(m) {
  return {
    lineCode: m.measureType,
    label: m.label || m.measureType,
    listNo: m.listNo || null,
    rate: D.of(m.rate),
    base: D.of(0),
    baseText: m.basis === 'percent_of_duty' ? '关税（BCD）' : 'CIF',
    amount: D.of(0),
    layer: m.layer || 'surtax',
    confidence: m.confidence || 'medium',
    sourceUrl: m.sourceUrl || '',
    note: m.note || '',
    excludedBy: m.excludes || [],
    skipped: false,
    skippedReason: '',
    pending: false,
    unresolvedIds: [],
  };
}
