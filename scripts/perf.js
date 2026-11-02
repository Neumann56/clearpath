/**
 * 性能预算（PRD §10.4.1）：一次 POST /api/quote ≈ 主链 1 + 分支 1 + 敏感性 5 ≈ 7 次全链。
 * 预算：POST /api/quote P95 ≤ 400ms。CI 超预算即失败。
 */
import { performance } from 'node:perf_hooks';
import { loadParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { loadFacts } from '../lib/unresolved.js';

const params = loadParams();
const facts = loadFacts();
const input = {
  country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B',
  exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22', metalContentPct: 0.62,
};

const run = () => buildReport({ input, params, facts, reportId: 'perf', today: params.asOf });

for (let i = 0; i < 50; i++) run(); // 预热：参数索引与 JIT

const N = Number(process.env.PERF_N || 1000);
const samples = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const r = run();
  samples.push(performance.now() - t0);
  if (!r.ok) throw new Error('perf run failed');
}
samples.sort((a, b) => a - b);
const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

const budget = 400;
const out = {
  n: N,
  p50: Number(p(0.5).toFixed(2)),
  p95: Number(p(0.95).toFixed(2)),
  p99: Number(p(0.99).toFixed(2)),
  avg: Number(avg.toFixed(2)),
  budget,
  pass: p(0.95) <= budget,
};
console.log(JSON.stringify(out, null, 2));
if (!out.pass) {
  console.error(`性能预算未达标：P95 ${out.p95}ms > ${budget}ms`);
  process.exit(1);
}
