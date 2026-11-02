/**
 * 生成 4 个演示报告（断网演示 / 截图 / 评审）。走同一套引擎，不写死数字。
 * 用法：node scripts/seed-demo.js
 */
import { loadParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { loadFacts, linkReports, saveFacts } from '../lib/unresolved.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const params = loadParams();
const facts = loadFacts();
const DIR = path.join(process.cwd(), 'data', 'runtime', 'reports');
const INDEX = path.join(process.cwd(), 'data', 'runtime', 'index.json');
fs.mkdirSync(DIR, { recursive: true });

const DEMOS = [
  {
    key: 'us-232',
    label: '美国 8708.91 · 双分支（一个未决事实值 6,327）',
    input: { country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B', exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22', metalContentPct: 0.62 },
  },
  {
    key: 'hu-vat',
    label: '匈牙利 B2B · 双口径（真实成本 5.2 万，要备 6.6 万）',
    input: { country: 'HU', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B', exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22' },
  },
  {
    key: 'br-icms',
    label: '巴西 · ICMS 价内税 gross-up（高得有公式）',
    input: { country: 'BR', hsCode: '8708.91', fob: 10000, freight: 0, insurance: 0, qty: 1, channel: 'B2B', exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22' },
    enabledCharges: ['AFRMM'],
  },
  {
    key: 'us-ad',
    label: '美国 AD 三口径（要备 12.1 万，真实成本 9.4 万）',
    input: { country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B', exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22', metalContentPct: 0.62, adDepositRate: 0.99, adFinalRate: 0.45 },
  },
];

const idx = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
const out = {};

for (const d of DEMOS) {
  const input = { ...d.input, ...(d.enabledCharges ? { enabledCharges: d.enabledCharges } : {}) };
  const reportId = crypto.randomUUID();
  const res = buildReport({ input, params, facts, reportId, today: params.asOf });
  if (!res.ok) {
    console.error('生成失败', d.key, res.errors);
    continue;
  }
  const report = res.report;
  report.demoKey = d.key;
  report.demoLabel = d.label;
  fs.writeFileSync(path.join(DIR, `${reportId}.json`), JSON.stringify(report, null, 2), 'utf8');
  idx.unshift({
    reportId, createdAt: report.createdAt, did: 'demo', country: report.input.country,
    hsCode: report.input.hsCode, landedCost: report.expected?.landedCost ?? null,
    cashRequired: report.expected?.cashRequired ?? null, state: report.state,
    paramsVersion: report.meta.paramsVersion, demoKey: d.key, demoLabel: d.label,
  });
  out[d.key] = { reportId, url: `/quote/${reportId}/report`, landed: report.expected?.landedCost, cash: report.expected?.cashRequired };
  // 闭环：演示报告也要挂到待核项上，否则待核中心"关联报告"一列永远是空的
  linkReports(facts, report);
}

saveFacts(facts);

fs.writeFileSync(INDEX, JSON.stringify(idx.slice(0, 500), null, 2), 'utf8');
fs.writeFileSync(path.join(process.cwd(), 'out', 'demo-reports.json'), JSON.stringify(out, null, 2), 'utf8');

/* ---------------- 演示用的校准记录（M4 看板要有趋势才看得出东西） ---------------- */
const CAL = path.join(process.cwd(), 'data', 'runtime', 'calibrations.jsonl');
const QUEUE = path.join(process.cwd(), 'data', 'runtime', 'calib_queue.json');

const shift = (base, n) => {
  const t = new Date(base + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// 偏差率从 7.8% 一路降到 1.35%：这是"校准真的在让预演变准"的样子
const CAL_SEED = [
  { d: -55, pct: 0.078, country: 'US', name: '美国', landed: 70862.4, attr: '参数错', lines: 1 },
  { d: -48, pct: 0.069, country: 'HU', name: '匈牙利', landed: 52134.48, attr: '口径理解错', lines: 1 },
  { d: -40, pct: 0.061, country: 'BR', name: '巴西', landed: 17389.39, attr: '参数错', lines: 2 },
  { d: -34, pct: 0.052, country: 'US', name: '美国', landed: 70862.4, attr: '参数错', lines: 1 },
  { d: -27, pct: 0.046, country: 'HU', name: '匈牙利', landed: 52134.48, attr: '口径理解错', lines: 1 },
  { d: -21, pct: 0.039, country: 'BR', name: '巴西', landed: 17389.39, attr: '参数错', lines: 1 },
  { d: -14, pct: 0.031, country: 'US', name: '美国', landed: 70862.4, attr: '参数错', lines: 1 },
  { d: -12, pct: 0.027, country: 'CZ', name: '捷克', landed: 52134.48, attr: '输入错', lines: 1 },
  { d: -7, pct: 0.022, country: 'HU', name: '匈牙利', landed: 52134.48, attr: '无偏差', lines: 0 },
  { d: -3, pct: 0.016, country: 'US', name: '美国', landed: 70862.4, attr: '参数错', lines: 1 },
  { d: -1, pct: 0.0135, country: 'HU', name: '匈牙利', landed: 52134.48, attr: '无偏差', lines: 0 },
];

function seedCalibrations() {
  let keep = [];
  try {
    keep = fs
      .readFileSync(CAL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => !r.demo);
  } catch {
    keep = [];
  }
  const demo = CAL_SEED.map((r, i) => {
    const day = shift(params.asOf, r.d);
    const diff = Math.round(r.pct * r.landed * 100) / 100;
    const sign = r.pct >= 0.03 ? 1 : -1;
    return {
      demo: true,
      reportId: `demo-cal-${String(i + 1).padStart(2, '0')}`,
      at: `${day}T10:${String(10 + i).padStart(2, '0')}:00.000Z`,
      country: r.country,
      countryName: r.name,
      hsCode: '8708.91',
      actual: {},
      predicted: { landedCost: r.landed, cashRequired: r.landed },
      lines: Array.from({ length: r.lines }, (_, k) => ({ key: k === 0 ? 'duty' : 'charges', attribution: r.attr })),
      landedCostDiff: sign * diff,
      cashRequiredDiff: sign * diff,
      primaryAttribution: r.attr,
      routedTo: [],
      diffPct: r.pct,
      paramsVersion: params.version,
    };
  });
  const all = [...keep, ...demo].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  fs.writeFileSync(CAL, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return demo.length;
}

const calCount = seedCalibrations();

// 队列留一条真实的：指向这次新建的 us-232 报告，答辩时点得进去
const usReport = out['us-232']?.reportId;
const queue = usReport
  ? [
      {
        id: 'CQ-0001',
        reportId: usReport,
        line: 'duty',
        diff: -6327,
        suspectParam: 'UF-01',
        note: '实缴关税比预演低 6,327.00，恰好等于「计入 232」那一支的差额。先把 UF-01 核掉，别急着改税率。',
        createdAt: `${params.asOf}T09:30:00.000Z`,
        status: 'pending',
      },
    ]
  : [];
fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + '\n', 'utf8');

console.log(JSON.stringify(out, null, 2));
console.log(`\n校准演示记录 ${calCount} 条已写入 · 参数复核队列 ${queue.length} 条`);
