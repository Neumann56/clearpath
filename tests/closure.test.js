/**
 * 闭环测试（M4）：校准归因必须落到"哪一行、哪条参数、进没进队列"。
 * 这里只测纯函数，不启服务；队列写临时文件，不污染 runtime。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { calibrate, enqueueParamReview, readQueue } from '../lib/calibrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const params = loadParams();
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'params', 'unresolved.seed.json'), 'utf8'));
const TODAY = '2026-10-22';

function makeReport(over = {}) {
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
  const res = buildReport({ input, params, facts, reportId: 'calib-test', today: TODAY });
  assert.ok(res.ok, '报告应能生成');
  return res.report;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-calib-'));
const queueFile = path.join(tmpDir, 'calib_queue.json');

test('逐行归因：关税高出 520 且无法用税率解释 → 参数错 + 入队', () => {
  const report = makeReport({ country: 'US', metalContentPct: 0.62 });
  const expDuty = report.expected.duty + report.expected.surtax;
  const out = calibrate(report, { actualDuty: (expDuty + 520).toFixed(2) }, { params, facts });

  assert.equal(out.primaryAttribution, '参数错');
  assert.equal(out.lines[0].key, 'duty');
  assert.equal(out.lines[0].attribution, '参数错');
  assert.ok(Math.abs(out.lines[0].diff - 520) < 0.01, `关税差应为 520，实际 ${out.lines[0].diff}`);
  assert.ok(Math.abs(out.landedCostDiff - 520) < 0.01);

  const q = enqueueParamReview(
    { reportId: report.reportId, line: out.lines[0].key, diff: out.lines[0].diff, suspectParam: 'US/MFN', note: out.lines[0].note },
    { file: queueFile }
  );
  assert.equal(q.added, true);
  const saved = readQueue(queueFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'pending');
  assert.equal(saved[0].line, 'duty');

  // 同一票同一行重复校准不重复入队
  const again = enqueueParamReview({ reportId: report.reportId, line: 'duty', diff: 520 }, { file: queueFile });
  assert.equal(again.added, false);
  assert.equal(readQueue(queueFile).length, 1);
});

test('逐行归因：实缴值正好落在分叉另一支 → 挂 UF-01 而不是改税率', () => {
  const report = makeReport({ country: 'US', metalContentPct: 0.62 });
  const alt = report.unresolved.find((u) => u.id === 'UF-01')?.counterValue?.landedCost;
  assert.ok(alt, 'UF-01 应有另一支的金额');

  // 让实缴构成的结果等于「计入 232」那一支：关税少 6,327
  const expDuty = report.expected.duty + report.expected.surtax;
  const out = calibrate(report, { actualDuty: (expDuty - 6327).toFixed(2) }, { params, facts });

  assert.equal(out.primaryAttribution, '参数错');
  assert.equal(out.lines[0].factId, 'UF-01');
  assert.match(out.lines[0].note, /UF-01/);
  assert.deepEqual(out.routedTo, ['UF-01']);
});

test('只改清关日期 → 输入错，不入队', () => {
  const report = makeReport({ country: 'US', metalContentPct: 0.62 });
  const out = calibrate(report, { actualEntryDate: '2026-10-19' }, { params, facts });

  assert.equal(out.primaryAttribution, '输入错');
  assert.equal(out.landedCostDiff, 0);
  assert.equal(out.entryDateChanged, true);
  const dateLine = out.lines.find((l) => l.key === 'entryDate');
  assert.ok(dateLine, '日期变了要单独列一行，否则用户不知道差异从哪来');
  assert.equal(dateLine.attribution, '输入错');
  assert.equal(out.routedTo.length, 0);
});

test('只有一边口径对上 → 口径理解错（不骂参数）', () => {
  const report = makeReport(); // 匈牙利：VAT 可退
  const exp = report.expected;
  // 增值税多交 1000，但同样可退 → 成本不变、现金多垫 1000
  const out = calibrate(
    report,
    { actualTax: (exp.taxTotal + 1000).toFixed(2), actualVat: (exp.refundableVat + 1000).toFixed(2) },
    { params, facts }
  );

  assert.equal(out.primaryAttribution, '口径理解错');
  assert.ok(Math.abs(out.landedCostDiff) < 0.01, `真实成本不该变，实际 ${out.landedCostDiff}`);
  assert.ok(Math.abs(out.cashRequiredDiff - 1000) < 0.01, `现金应多垫 1000，实际 ${out.cashRequiredDiff}`);
  assert.match(out.note, /两个口径/);
  assert.equal(out.routedTo.length, 0);
});

test('全部填对 → 无偏差，不产生任何后续动作', () => {
  const report = makeReport();
  const out = calibrate(report, {}, { params, facts });
  assert.equal(out.primaryAttribution, '无偏差');
  assert.equal(out.landedCostDiff, 0);
  assert.equal(out.cashRequiredDiff, 0);
  assert.ok(out.lines.every((l) => l.attribution === '无偏差' || l.attribution === '未填'));
});

test('未出数的报告不许校准', () => {
  const report = makeReport();
  report.expected = null;
  assert.throws(() => calibrate(report, {}, { params, facts }), /E_REPORT_NOT_CALIBRABLE/);
});

test('校准不得改动报告本身（K4）', () => {
  const report = makeReport({ country: 'US', metalContentPct: 0.62 });
  const before = JSON.stringify(report.expected);
  calibrate(report, { actualDuty: '9999.99' }, { params, facts });
  assert.equal(JSON.stringify(report.expected), before);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- 准确率统计（M4 的另一半） ---------------- */

test('看板统计：3 条记录 → 3 票、平均偏差非空、能分国家', async () => {
  const { calibrationStats } = await import('../lib/calibStats.js');
  const recs = [
    { at: '2026-10-20T10:00:00Z', country: 'US', countryName: '美国', diffPct: 0.02, primaryAttribution: '参数错', predicted: { landedCost: 70000 } },
    { at: '2026-10-21T10:00:00Z', country: 'US', countryName: '美国', diffPct: 0.04, primaryAttribution: '参数错', predicted: { landedCost: 70000 } },
    { at: '2026-10-22T10:00:00Z', country: 'HU', countryName: '匈牙利', diffPct: 0.006, primaryAttribution: '无偏差', predicted: { landedCost: 50000 } },
  ];
  const s = calibrationStats(recs, '2026-10-22');
  assert.equal(s.windows.d30.count, 3);
  assert.ok(Math.abs(s.windows.d30.avgPct - 0.022) < 1e-9, `平均偏差应为 2.2%，实际 ${s.windows.d30.avgPct}`);
  assert.equal(s.byCountry.length, 2);
  assert.equal(s.byCountry.find((c) => c.key === 'US').count, 2);
  assert.equal(s.byAttribution[0].key, '参数错');
  assert.match(s.headline, /近 30 天 3 票/);
});

test('看板统计：偏差扩大时要说"上升"，不许恒定正向措辞', async () => {
  const { calibrationStats } = await import('../lib/calibStats.js');
  const recs = [
    { at: '2026-09-05T10:00:00Z', country: 'US', diffPct: 0.01, primaryAttribution: '参数错', predicted: {} },
    { at: '2026-10-20T10:00:00Z', country: 'US', diffPct: 0.06, primaryAttribution: '参数错', predicted: {} },
  ];
  const s = calibrationStats(recs, '2026-10-22');
  assert.match(s.headline, /上升/);
  assert.match(s.headline, /偏差在扩大/);
});

test('看板统计：空数据不编结论', async () => {
  const { calibrationStats } = await import('../lib/calibStats.js');
  const s = calibrationStats([], '2026-10-22');
  assert.equal(s.windows.d30.count, 0);
  assert.equal(s.windows.d30.avgPct, null);
  assert.match(s.headline, /还没有校准记录/);
  assert.equal(s.weekly.length, 8);
});
