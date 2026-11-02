/**
 * 校准归因（M4 的核心）
 *
 * 旧的实现是拿"总差额"去撞某个待核项的影响金额（|diff - impact| < 1），
 * 真实税单上不可能精确命中，只在演示数据里成立。现在改成逐行对照：
 *
 *   1. 每一行（关税 / 不可退国内税 / 规费 / AD）单独比，各自给归因
 *   2. 归因靠"证据"而不是"接近"：
 *      - 实缴值构成的 landedCost 恰好等于某待核项的另一支 → 强证据
 *      - 某行 diff / 税基 ≈ 已知税率的差 → 疑似税率错
 *      - 只有一边口径对得上 → 口径理解错（这是产品要重点教的事）
 *   3. 参数错的结论写进 data/runtime/calib_queue.json，不再只 append 一行日志
 *
 * 铁律：校准只读报告，绝不回写历史金额（K4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { D, fmt } from './decimal.js';
import { RUNTIME_DIR } from './params.js';

const P = (v) => D.of(v ?? 0);
const EPS = D.of('0.01');

export const CAL_FILE = path.join(RUNTIME_DIR, 'calibrations.jsonl');
export const QUEUE_FILE = path.join(RUNTIME_DIR, 'calib_queue.json');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export function readCalibrations() {
  try {
    return fs
      .readFileSync(CAL_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function appendCalibration(record) {
  fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
  fs.appendFileSync(CAL_FILE, JSON.stringify(record) + '\n', 'utf8');
}

/** 归因为参数错的条目进"参数复核队列"。同一票同一行不重复入队。 */
export function enqueueParamReview({ reportId, line, diff, suspectParam, note }, { file = QUEUE_FILE } = {}) {
  let q = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) q = raw;
  } catch {
    q = [];
  }
  const dup = q.find((x) => x.reportId === reportId && x.line === line && x.status === 'pending');
  if (dup) return { added: false, id: dup.id, queue: q };
  const id = `CQ-${String(q.length + 1).padStart(4, '0')}`;
  const entry = {
    id,
    reportId,
    line,
    diff: Number(diff),
    suspectParam: suspectParam || null,
    note: note || '',
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  q.push(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(q, null, 2) + '\n', 'utf8');
  return { added: true, id, queue: q };
}

export function readQueue(file = QUEUE_FILE) {
  try {
    const q = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

/** 从参数库里捞出该国可能的税率，用来判断"差额是不是某条税率错了" */
function candidateRates(params, country) {
  const out = [];
  const push = (rate, label) => {
    const r = Number(rate);
    if (Number.isFinite(r) && r > 0 && r < 1) out.push({ rate: r, label });
  };
  for (const t of params?.tariffs || []) {
    if (t.country === country) push(t.rate, `${t.hsPrefix || t.hsCode || ''} 关税`);
  }
  for (const m of params?.measures || []) {
    if (m.country === country) push(m.rate ?? m.tiers?.[0]?.rate, m.label || m.measureType);
  }
  for (const s of params?.taxSteps || []) {
    if (s.country === country) push(s.rate, s.label || s.code);
  }
  return out;
}

const nearZero = (x) => D.of(x).abs().lt(EPS);

/**
 * @param report 完整报告（只读）
 * @param actual {actualDuty, actualTax, actualCharges, actualAd, actualVat, actualEntryDate}
 * @param opts {params, facts}
 */
export function calibrate(report, actual, { params, facts = [] } = {}) {
  const exp = report?.expected;
  if (!exp || exp.landedCost === null || exp.landedCost === undefined) {
    const e = new Error('E_REPORT_NOT_CALIBRABLE 这份报告没有出数（结论不足或不可达），无法校准');
    e.code = 'E_REPORT_NOT_CALIBRABLE';
    throw e;
  }

  const country = report.input?.country;
  const cif = P(exp.cif);
  const expDuty = P(exp.duty).add(P(exp.surtax)); // 税单上分不出基础关税与附加措施
  const expTax = P(exp.taxTotal);
  const expRefund = P(exp.refundableVat);
  const expNonRefund = expTax.sub(expRefund);
  const expCharges = P(exp.charges);
  const remedy = exp.remedy && exp.remedy.applicable ? exp.remedy : null;
  const adFinal = remedy ? P(remedy.final) : D.of(0);
  const adDeposit = remedy ? P(remedy.deposit) : D.of(0);
  const compliance = P(exp.complianceCost);
  const expLanded = P(exp.landedCost);
  const expCash = P(exp.cashRequired);

  const given = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const actDuty = given(actual.actualDuty) ? P(actual.actualDuty) : expDuty;
  const actTax = given(actual.actualTax) ? P(actual.actualTax) : expTax;
  const actCharges = given(actual.actualCharges) ? P(actual.actualCharges) : expCharges;
  const actAd = given(actual.actualAd) ? P(actual.actualAd) : adDeposit;
  const actVat = given(actual.actualVat) ? P(actual.actualVat) : actTax.sub(expNonRefund).max(D.of(0));

  // 真实成本口径：可退增值税不进成本；AD 按最终税率（实缴的是保证金，不是最终负担）
  const actNonRefund = actTax.sub(actVat);
  const actLanded = cif.add(actDuty).add(actNonRefund).add(actCharges).add(adFinal).add(compliance);
  // 现金口径：可退增值税要垫付；AD 按实缴保证金
  const actCash = cif.add(actDuty).add(actTax).add(actCharges).add(actAd).add(compliance);

  // 引擎内部的中间精度高于分项两位小数之和，直接相减会留 0.0004 这种残差。
  // 用户不该看到它，所以在半分以内一律归零（这不是舍入，是把"计算残差"当 0）。
  const clean = (x) => (nearZero(x) ? D.of(0) : x);
  const landedDiff = clean(actLanded.sub(expLanded));
  const cashDiff = clean(actCash.sub(expCash));

  const preDate = report.input?.dates?.entryDate || null;
  const actDate = actual.actualEntryDate || preDate || null;
  const dateChanged = !!actDate && !!preDate && actDate !== preDate;

  const openFacts = (facts || []).filter(
    (f) => f.status !== 'resolved' && f.status !== 'superseded' && (f.scope?.countries?.includes(country) || !f.scope)
  );
  const branchFacts = openFacts.filter((f) => (f.displayTier ?? f.tier) === 'T1_BRANCH' && f.counterValue);

  // ---- 行级 ----
  const mk = (key, label, predicted, actualV, basis) => ({
    key,
    label,
    predicted: predicted.toNumber(),
    predictedText: fmt(predicted),
    actual: actualV === null ? null : actualV.toNumber(),
    actualText: actualV === null ? '未填' : fmt(actualV),
    diff: actualV === null ? 0 : actualV.sub(predicted).toNumber(),
    basis,
    attribution: '无偏差',
    factId: null,
    note: '',
  });

  const lines = [
    mk('duty', '关税（含附加措施）', expDuty, actDuty, 'landed+cash'),
    mk('taxNonRefund', '不可退国内税', expNonRefund, actNonRefund, 'landed'),
    mk('vatRefund', '可退增值税（只影响现金）', expRefund, actVat, 'cash'),
    mk('charges', '规费', expCharges, actCharges, 'landed+cash'),
  ];
  if (remedy) {
    const adLine = mk('ad', '反倾销/反补贴保证金', adDeposit, actAd, 'cash');
    adLine.note = `真实成本里按最终税率 ${fmt(adFinal)} 计；实缴保证金与它的差是时点差，不是错误。`;
    lines.push(adLine);
  }

  // ---- 先判整体口径，因为"只有一边对上"是产品要重点教的错 ----
  const landedOk = nearZero(landedDiff);
  const cashOk = nearZero(cashDiff);

  // 强证据一：实缴算出来的真实成本恰好落在某条分叉的另一支上
  const hitBranch = branchFacts.find((f) => {
    const v = f.counterValue?.landedCost;
    return v !== null && v !== undefined && nearZero(actLanded.sub(P(v)));
  });
  // 强证据二：差额恰好等于某条待核项的影响金额（说明那条政策真的变了）
  const hitImpact = openFacts.find((f) => {
    const v = f.impactUsdCached ?? f.impactUsd;
    return v !== null && v !== undefined && !nearZero(v) && nearZero(D.of(landedDiff).abs().sub(P(v).abs()));
  });

  let primary = '无偏差';
  if (landedOk && cashOk) {
    primary = dateChanged ? '输入错' : '无偏差';
  } else if (landedOk !== cashOk) {
    // 只有一边对得上 —— 这是把两个口径混用了，不是参数错
    primary = '口径理解错';
  } else if (hitBranch) {
    primary = '参数错';
  } else if (dateChanged) {
    primary = '输入错';
  } else if (hitImpact) {
    primary = '政策变';
  } else {
    primary = '参数错';
  }

  // ---- 逐行归因（每行独立，和整体结论可能不同）----
  const rates = candidateRates(params, country);
  for (const line of lines) {
    if (line.actual === null) {
      line.attribution = '未填';
      continue;
    }
    if (nearZero(line.diff)) {
      line.attribution = '无偏差';
      continue;
    }
    const base = cif;
    const implied = base.isZero() ? D.of(0) : D.of(line.diff).div(base);
    const impliedAbs = implied.abs().toNumber();
    const rateHit = rates.find((r) => Math.abs(impliedAbs - r.rate) <= 0.0025);

    // 分支证据只对"关税"行有意义（232/301 都落在关税上）
    const branchHit =
      line.key === 'duty'
        ? branchFacts.find((f) => {
            const c = f.counterValue?.landedCost;
            const cur = f.currentValue?.landedCost;
            if (c === null || c === undefined || cur === null || cur === undefined) return false;
            return Math.abs(Math.abs(Number(c) - Number(cur)) - Math.abs(line.diff)) < 1;
          })
        : null;

    if (branchHit) {
      line.attribution = '参数错';
      line.factId = branchHit.id;
      line.note = `关税差 ${fmt(line.diff)} 与该分叉两支的差额一致，说明实际走的是「${branchHit.counterValue.label || '另一支'}」。先把 ${branchHit.id} 核掉，别急着改税率。`;
    } else if (rateHit) {
      line.attribution = '参数错';
      line.note = `差额占税基约 ${(impliedAbs * 100).toFixed(2)}%，接近「${rateHit.label}」的 ${(rateHit.rate * 100).toFixed(2)}%，疑似这条税率或税基口径有误。`;
    } else if (dateChanged) {
      line.attribution = '输入错';
      line.note = `清关日由 ${preDate} 改为 ${actDate}，适用措施与税率档位可能不同。`;
    } else {
      const impactLine = openFacts.find((f) => {
        const v = f.impactUsdCached ?? f.impactUsd;
        return v !== null && v !== undefined && !nearZero(v) && nearZero(D.of(line.diff).abs().sub(P(v).abs()));
      });
      if (impactLine) {
        line.attribution = '政策变';
        line.factId = impactLine.id;
        line.note = `差额恰好等于 ${impactLine.id} 的影响金额，说明这条事实对应的口径真的变了，应先开参数版本再改引擎。`;
      } else {
        line.attribution = '参数错';
        line.note = `差额 ${fmt(line.diff)} 无法用已知税率解释，建议按税单逐项拆开核对税基。`;
      }
    }
  }

  // 日期变了要单独列一行，否则用户会觉得"金额都对，为什么说输入错"
  if (dateChanged) {
    lines.push({
      key: 'entryDate',
      label: '清关日期',
      predicted: preDate,
      predictedText: preDate,
      actual: actDate,
      actualText: actDate,
      diff: 0,
      basis: 'input',
      attribution: '输入错',
      factId: null,
      note: '日期变了但金额没变，说明这次差异来自输入而不是参数。',
    });
  }

  const routedTo = [...new Set(lines.filter((l) => l.attribution === '参数错' && l.factId).map((l) => l.factId))];

  const noteOf = {
    口径理解错: `真实成本和需备现金是两个口径：可退增值税 ${fmt(expRefund)} 只垫付、不进成本。你填的实缴值让其中一边对上了、另一边没对上，说明比较时把两个口径混用了。`,
    输入错: '这次差异来自输入（日期或数量），不需要改参数库。',
    政策变: '金额对不上但该国还有未核事实，先核事实，再决定是否新开参数版本。',
    参数错: '差异落在参数上，已写入参数复核队列，由复核人决定是否开新版本。',
    无偏差: '逐行都对上了，这次预演可以直接拿去做决策依据。',
  };

  return {
    ok: true,
    lines,
    total: landedDiff.toNumber(),
    totalText: fmt(landedDiff),
    landedCostDiff: landedDiff.toNumber(),
    landedCostDiffText: fmt(landedDiff),
    cashRequiredDiff: cashDiff.toNumber(),
    cashRequiredDiffText: fmt(cashDiff),
    actualLandedCost: actLanded.toNumber(),
    actualLandedCostText: fmt(actLanded),
    actualCashRequired: actCash.toNumber(),
    actualCashRequiredText: fmt(actCash),
    primaryAttribution: primary,
    routedTo,
    note: noteOf[primary],
    entryDateChanged: dateChanged,
  };
}
