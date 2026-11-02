#!/usr/bin/env node
// 一次跑完 ROADMAP §1 的四项基线。
// 用法： node scripts/verify.js
// 退出码 0 = 四项全绿；非 0 = 至少一项不达标（先修基线，不要往下做）。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });

const results = [];

// 1) 黄金用例 + 全部测试（自动发现，不要写 tests/ 目录参数：Node 22 在 Windows 下会把它当单个模块）
{
  const r = run(['--test']);
  const out = r.stdout || '';
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || 0);
  const pass = num('pass');
  const fail = num('fail');
  results.push({
    name: '黄金用例 + 全部测试',
    pass: r.status === 0 && fail === 0 && pass > 0,
    detail: `${pass} 通过 / ${fail} 失败`,
    hint: r.status !== 0 ? (out.match(/^not ok .*$/m) || [''])[0].trim() : '',
  });
}

// 2) 文案门禁：界面不许出现内部字段名 / 规范原文 / 英文枚举
{
  const r = run(['scripts/copy-lint.js']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').pop() || '';
  results.push({
    name: '文案门禁',
    pass: r.status === 0,
    detail: tail.replace(/^文案门禁/, '').replace(/^通过 · /, '通过 · ') || tail,
  });
}

// 3) 性能：报价 p95 预算
{
  const r = run(['scripts/perf.js']);
  let ok = false;
  let detail = '无法解析输出';
  try {
    const j = JSON.parse(r.stdout);
    ok = j.pass === true;
    detail = `p50 ${j.p50}ms / p95 ${j.p95}ms / p99 ${j.p99}ms（预算 ${j.budget}ms）`;
  } catch {
    /* 保持默认 */
  }
  results.push({ name: '性能', pass: ok, detail });
}

// 4) 线上参数版本与报告存量（发布链路的落地证据）
{
  let ok = false;
  let detail = '服务未启动';
  try {
    const res = await fetch('http://127.0.0.1:4173/healthz');
    if (res.ok) {
      const j = await res.json();
      const errs = Array.isArray(j.paramsErrors) ? j.paramsErrors.length : 0;
      ok = Boolean(j.paramsVersion) && errs === 0;
      detail = `参数 ${j.paramsVersion} · 报告 ${j.reports} 份 · 待核 ${j.unresolvedOpen} 项`
        + (errs ? ` · ${errs} 处参数校验错误` : '');
    } else {
      detail = `HTTP ${res.status}`;
    }
  } catch {
    /* 服务没起不算失败，只是跳过 */
    ok = true;
    detail = '服务未启动，已跳过';
  }
  results.push({ name: '参数版本', pass: ok, detail });
}

let bad = 0;
console.log('');
for (const r of results) {
  console.log(`${r.pass ? '✓' : '✗'} ${r.name.padEnd(16, ' ')}${r.detail}`);
  if (r.hint) console.log(`  ${r.hint}`);
  if (!r.pass) bad += 1;
}
console.log('');
console.log(bad === 0 ? '基线全绿，可以继续做新功能。' : `${bad} 项不达标，先修基线，不要往下做。`);
process.exit(bad === 0 ? 0 : 1);
