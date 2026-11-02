import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParams, validateParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { runTaxChain } from '../lib/engine/taxchain.js';
import { evaluateFta } from '../lib/engine/fta.js';
import { computeCompliance } from '../lib/engine/compliance.js';
import { D } from '../lib/decimal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const params = loadParams();
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'params', 'unresolved.seed.json'), 'utf8'));

const TODAY = '2026-10-22';

function run(over = {}) {
  const input = {
    country: 'HU',
    hsCode: '8708.91',
    fob: 48000,
    freight: 2400,
    qty: 1200,
    unit: 'pcs',
    channel: 'B2B',
    exportDate: '2026-10-05',
    declarationDate: '2026-10-20',
    entryDate: '2026-10-22',
    ...over,
  };
  const res = buildReport({ input, params, facts, reportId: 'test', today: TODAY });
  return res;
}

const near = (a, b, msg) => {
  const v = a && typeof a.toNumber === 'function' ? Number(a.toNumber()).toFixed(2) : Number(a).toFixed(2);
  assert.equal(v, Number(b).toFixed(2), msg);
};

test('参数自检通过', () => {
  const errs = validateParams(params.raw);
  assert.deepEqual(errs, []);
});

test('A 匈牙利 B2B', () => {
  const { ok, report } = run();
  assert.ok(ok);
  near(report.expected.cif, 50616.0, 'CIF');
  near(report.expected.duty, 1518.48, 'duty');
  near(report.expected.landedCost, 52134.48, 'landedCost');
  near(report.expected.cashRequired, 66210.79, 'cashRequired');
  near(report.expected.cashGap, 14076.31, 'cashGap');
  assert.equal(report.input.insuranceSource, 'default_from_param');
  assert.ok(report.assumptions.some((a) => a.field === 'insurance' && /216\.00/.test(a.note)));
  assert.equal(report.expected.taxChain.length, 1);
  assert.equal(report.expected.taxChain[0].refundable, true);
});

test('A2 保险填 216 时不产生保险 assumption', () => {
  const { report } = run({ insurance: 216 });
  assert.equal(report.input.insuranceSource, 'provided');
  assert.ok(!report.assumptions.some((a) => a.field === 'insurance'));
});

test('B 捷克 B2B', () => {
  const { report } = run({ country: 'CZ' });
  near(report.expected.landedCost, 52134.48);
  near(report.expected.cashRequired, 63082.72);
  near(report.expected.cashGap, 10948.24);
});

test('C 匈牙利 B2C（合规 2,270，不进 cashGap）', () => {
  const { report } = run({ channel: 'B2C' });
  near(report.expected.complianceCost, 2270.0, '合规');
  near(report.expected.landedCost, 54404.48);
  near(report.expected.cashRequired, 68480.79);
  near(report.expected.cashGap, 14076.31, '合规不进 gap');
});

test('D 美国 branch A（在 232 内）', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  const a = report.branches.find((b) => b.branchId === 'A');
  near(a.expected.surtax, 12654.0);
  near(a.expected.addOnTotal, 13919.4);
  near(a.expected.landedCost, 64535.4);
  near(a.expected.effectiveRate, 0.275);
  assert.equal(a.expected.taxChain.length, 0, '美国 taxChain 为 []');
});

test('E 美国 branch B（不在 232 内，默认）', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  near(report.expected.landedCost, 70862.4);
  near(report.expected.addOnTotal, 20246.4);
  near(report.expected.effectiveRate, 0.4);
  assert.equal(report.expected.cashGap, 0);
  assert.equal(report.expected.dutyBreakdown.length >= 3, true);
});

test('F 巴西税链（ICMS gross-up）', () => {
  const { report } = run({ country: 'BR', fob: 10000, freight: 0, insurance: 0 });
  const chain = report.expected.taxChain;
  const ipi = chain.find((l) => l.taxCode === 'IPI');
  const pis = chain.find((l) => l.taxCode === 'PIS_COFINS');
  const icms = chain.find((l) => l.taxCode === 'ICMS');
  near(ipi.amount, 1160.0);
  near(pis.amount, 1499.3);
  near(icms.base, 14259.3, 'ICMS 税基');
  near(icms.amount, 3130.09, 'ICMS gross-up');
  near(report.expected.landedCost, 17389.39);
});

test('F 反例：ICMS 若写成 base×0.18 必须不等于 3130.09', () => {
  const wrong = D.of(14259.3).mul('0.18');
  near(wrong, 2566.67);
  assert.notEqual(wrong.toFixed2(), '3130.09');
});

test('F2 巴西开 AFRMM（进 II 税基）', () => {
  const { report } = run({ country: 'BR', fob: 7600, freight: 2400, insurance: 0, enabledCharges: ['AFRMM'] });
  near(report.expected.chargeLines.find((c) => c.lineCode === 'AFRMM').amount, 192.0);
  const chain = report.expected.taxChain;
  near(chain.find((l) => l.taxCode === 'IPI').amount, 1182.27);
  near(chain.find((l) => l.taxCode === 'PIS_COFINS').amount, 1528.09);
  near(chain.find((l) => l.taxCode === 'ICMS').amount, 3190.19);
  near(report.expected.addOnTotal, 7723.27, '合计含 AFRMM');
});

test('G 印度（IGST 税基含 SWS）', () => {
  const { report } = run({ country: 'IN', fob: 20000, freight: 0, insurance: 0 });
  const igst = report.expected.taxChain.find((l) => l.taxCode === 'IGST');
  near(igst.amount, 3897.0);
  near(report.expected.surtax, 150.0, 'SWS');
  near(report.expected.duty + report.expected.surtax + report.expected.taxTotal, 5547.0, '税费合计');
  assert.equal(igst.refundable, true, 'IGST 可退 → 不进 landedCost');
});

test('H 土耳其（KDV 税基含关税）', () => {
  const { report } = run({ country: 'TR', fob: 20000, freight: 0, insurance: 0 });
  const kdv = report.expected.taxChain.find((l) => l.taxCode === 'KDV');
  near(kdv.amount, 4200.0);
  near(report.expected.duty + report.expected.taxTotal, 5200.0, '税费合计');
});

test('I AD 三口径', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62, adDepositRate: 0.99, adFinalRate: 0.45 });
  near(report.expected.remedy.deposit, 50109.84);
  near(report.expected.remedy.final, 22777.2);
  near(report.expected.remedy.potentialRefund, 27332.64);
  near(report.expected.landedCost, 93639.6);
  near(report.expected.cashRequired, 120972.24);
  near(report.expected.cashGap, 27332.64);
});

test('J 在途豁免成立（export 7-20 / entry 7-26）', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62, exportDate: '2026-07-20', entryDate: '2026-07-26' });
  near(report.expected.landedCost, 64535.4);
  const fl = report.expected.skipped.find((s) => s.lineCode === 'SECTION_301_FL_2026');
  assert.ok(fl, '新 301 应被跳过并给出原因');
  assert.match(fl.reason, /在途条款|在途豁免/);
});

test('J 反例：export 7-26 → 豁免不成立', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62, exportDate: '2026-07-26', entryDate: '2026-07-26' });
  near(report.expected.landedCost, 70862.4);
});

test('AC-02 出口晚于放行 → E_DATE_INVALID 且不生成报告', () => {
  const res = run({ exportDate: '2026-10-25', entryDate: '2026-10-20' });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'E_DATE_INVALID');
  assert.match(res.errors[0].message, /物理上不可能/);
});

test('AC-02b 未填放行日 → 推定 + entryDateSource', () => {
  const { report } = run({ entryDate: null });
  assert.equal(report.entryDateSource, 'defaulted_from_declaration');
  assert.ok(report.assumptions.some((a) => a.field === 'entryDate' && a.warnBar));
});

test('AC-04 含量缺失 → 照常出数 + UNPROVEN（不得 pending、不得少出该行）', () => {
  const { report } = run({ country: 'US' });
  const a = report.branches.find((b) => b.branchId === 'A');
  const b232 = a.expected.dutyBreakdown.find((l) => l.lineCode === 'SECTION_232');
  assert.ok(b232, '232 行必须在');
  assert.equal(b232.exemptionStatus, 'UNPROVEN');
  assert.equal(b232.skipped, false);
  near(a.expected.landedCost, 64535.4);
  assert.ok(report.dataGaps.some((g) => /≤15%/.test(g.field)));
});

test('AC-06 互斥：232 命中则旧/新 301 均 skipped 且 reason 非空', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  const a = report.branches.find((b) => b.branchId === 'A');
  for (const code of ['SECTION_301', 'SECTION_301_FL_2026']) {
    const l = a.expected.dutyBreakdown.find((x) => x.lineCode === code);
    assert.equal(l.skipped, true, `${code} 应被跳过`);
    assert.ok(l.skippedReason && l.skippedReason.length > 4);
  }
});

test('AC-08 匈牙利 B2B cashGapRatio 三档', () => {
  const { report } = run();
  near(report.expected.cashGapRatio, 0.27);
  assert.equal(report.expected.cashGapLevel, 'yellow');
});

test('AC-09 沙特 SABER 摊销 166.67', () => {
  const r = computeCompliance({
    country: 'SA',
    channel: 'B2B',
    params,
    shipment: { shipmentsPerYear: 12, amortizationYears: 1 },
  });
  near(r.total, 166.67);
});

test('AC-11 双分支：两值并列 + 差额 6,327', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  assert.equal(report.branches.length, 2);
  const b = report.branches.find((x) => x.branchId === 'B');
  const a = report.branches.find((x) => x.branchId === 'A');
  near(b.landedCost, 70862.4);
  near(a.landedCost, 64535.4);
  near(a.deltaVsDefault, 6327.0);
  assert.equal(b.isDefault, true);
  assert.equal(report.expected.landedCost, b.landedCost, '顶层 expected = 默认分支');
});

test('AC-11b branch A 旧 301 被跳过且挂 UF-02', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  const a = report.branches.find((b) => b.branchId === 'A');
  const l = a.expected.dutyBreakdown.find((x) => x.lineCode === 'SECTION_301');
  assert.equal(l.skipped, true);
  assert.deepEqual(l.unresolvedIds, ['UF-02']);
  const u2 = report.unresolved.find((u) => u.id === 'UF-02');
  near(u2.impactUsd, 12654.0);
  assert.equal(u2.tier, 'T2_IMPACT');
  assert.equal(u2.dependsOn, 'UF-01');
});

test('AC-10 待核不求和：可达状态枚举得 worst 77,189.40（不是 83,516.40 / 89,843.40）', () => {
  const { report } = run({ country: 'US', metalContentPct: 0.62 });
  near(report.range.worst, 77189.4);
  near(report.range.best, 64535.4);
  near(report.range.expected, 70862.4);
  assert.equal(report.range.states.length, 3);
});

test('AC-12 巴西 UF-03 脚注且不给第二组完整数字', () => {
  const { report } = run({ country: 'BR', fob: 10000, freight: 0, insurance: 0 });
  const u3 = report.unresolved.find((u) => u.id === 'UF-03');
  assert.ok(u3);
  assert.equal(u3.tier, 'T3_FOOTNOTE');
  assert.equal(u3.impactUsd, null, '不得给精确影响金额');
  assert.match(u3.impactDisplay, /1–3%/);
});

test('AC-15 unverified 不进合计，且差值可见', () => {
  const { report } = run({ country: 'TR', hsCode: '8703.00', fob: 20000, freight: 0, insurance: 0 });
  const ev = report.expected.dutyBreakdown.find((l) => l.lineCode === 'TR_EV_SURCHARGE');
  assert.equal(ev.skipped, true);
  assert.equal(ev.unverifiedExcluded, true);
  assert.equal(report.state, 'complete_with_gaps');
  assert.ok(!/40%/.test(JSON.stringify(report.expected.dutyBreakdown.filter((l) => !l.skipped))));
});

test('AC-22 两用物项默认 flag，不 blocked', () => {
  const { report } = run({ country: 'TR', hsCode: '9005.10.00', fob: 20000, freight: 0, insurance: 0 });
  assert.notEqual(report.state, 'blocked');
  assert.equal(report.access.flags.length >= 1, true);
  assert.ok(report.access.flags[0].requiredLicense.type.includes('两用物项'));
  assert.notEqual(report.expected, null);
});

test('AC-22b 最终用户军事 → blocked，expected = null', () => {
  const { report } = run({ country: 'TR', hsCode: '9005.10.00', endUserType: 'military' });
  assert.equal(report.state, 'blocked');
  assert.equal(report.expected, null);
  assert.equal(report.branches, undefined);
});

test('AC-23 RVC 按协定成员累积（日本成分计入 RCEP）', () => {
  const rcep = params.raw.fta.find((f) => f.code === 'RCEP');
  const components = [
    { origin: 'CN', valueUsd: 600 },
    { origin: 'JP', valueUsd: 300 },
    { origin: 'US', valueUsd: 100 },
  ];
  const out = evaluateFta({ components, agreements: [rcep] });
  near(out[0].rvc, 0.9, '只有美国成分 100 算非原产');
});

test('AC-01 保险若填 216 则不产生 assumption；默认则产生', () => {
  const a = run().report;
  const b = run({ insurance: 216 }).report;
  assert.ok(a.assumptions.some((x) => x.field === 'insurance'));
  assert.ok(!b.assumptions.some((x) => x.field === 'insurance'));
});

test('U1 待核用例：branches[2] + delta + 默认 B', () => {
  const { report } = run({ country: 'US' });
  assert.equal(report.branches.length, 2);
  near(report.branches.find((b) => b.branchId === 'A').deltaVsDefault, 6327.0);
  assert.equal(report.branches.find((b) => b.isDefault).branchId, 'B');
});

test('U2 branch A 旧 301 skipped 且 impactUsd 12654', () => {
  const { report } = run({ country: 'US' });
  const a = report.branches.find((b) => b.branchId === 'A');
  assert.equal(a.expected.dutyBreakdown.find((l) => l.lineCode === 'SECTION_301').skipped, true);
  near(report.unresolved.find((u) => u.id === 'UF-02').impactUsd, 12654.0);
});

test('U3 巴西 UF-03 T3', () => {
  const { report } = run({ country: 'BR', fob: 10000, freight: 0, insurance: 0 });
  assert.equal(report.unresolved.find((u) => u.id === 'UF-03').tier, 'T3_FOOTNOTE');
});

test('U4 D 级不产生确定结论文案', () => {
  const { report } = run({ country: 'HU' });
  const txt = JSON.stringify(report);
  assert.ok(!/必须办理 SNI/.test(txt));
  assert.ok(!/必须做 SABER/.test(txt));
});

test('U5 2027 之后报告带 HS 版本横幅', () => {
  const input = {
    country: 'HU', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1, unit: 'pcs', channel: 'B2B',
    declarationDate: '2027-02-01', entryDate: '2027-02-03',
  };
  const { report } = buildReport({ input, params, facts, reportId: 't2', today: '2027-02-03' });
  assert.ok(report.unresolved.some((u) => u.id === 'UF-05'));
  assert.ok(report.meta.hsVersion);
});

test('逾期降级：>90 天红条，>180 天 T1 不再预选默认分支', () => {
  const expireFacts = facts.map((f) => (f.id === 'UF-01' ? { ...f, reviewDue: '2026-01-01' } : f));
  const { report } = buildReport({
    input: { country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1, unit: 'pcs', channel: 'B2B', declarationDate: '2026-10-20', entryDate: '2026-10-22' },
    params,
    facts: expireFacts,
    reportId: 't3',
    today: TODAY,
  });
  assert.equal(report.asOfState.degraded, true);
  assert.equal(report.asOfState.level, 'expired');
  assert.match(report.asOfState.reason, /未复核/);
});

test('税链：环引用必须抛 E_TAX_REF_CYCLE，不得静默', () => {
  assert.throws(
    () =>
      runTaxChain(
        [
          { seq: 10, taxCode: 'A', taxNameZh: 'A', rate: '0.1', baseComponents: [{ ref: 'B' }], inclusive: false, refundable: false },
          { seq: 20, taxCode: 'B', taxNameZh: 'B', rate: '0.1', baseComponents: [{ ref: 'A' }], inclusive: false, refundable: false },
        ],
        { cif: D.of(100), duty: D.of(0), surtax: D.of(0), charges: D.of(0), freight: D.of(0) }
      ),
    /E_TAX_REF_CYCLE/
  );
});

test('税链：向前引用必须抛 E_TAX_REF_FORWARD', () => {
  assert.throws(
    () =>
      runTaxChain(
        [
          { seq: 10, taxCode: 'A', taxNameZh: 'A', rate: '0.1', baseComponents: ['cif'], inclusive: false, refundable: false },
          { seq: 20, taxCode: 'B', taxNameZh: 'B', rate: '0.1', baseComponents: [{ ref: 'C' }], inclusive: false, refundable: false },
        ],
        { cif: D.of(100), duty: D.of(0), surtax: D.of(0), charges: D.of(0), freight: D.of(0) }
      ),
    /E_TAX_REF_FORWARD/
  );
});
