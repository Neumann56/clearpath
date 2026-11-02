#!/usr/bin/env node
/**
 * 把三个必须成立的场景一次跑完（真浏览器 + 真模型，约 1-3 分钟）：
 *
 *   1. 单品名发票  → 六项全填，HS 编码有值
 *   2. 多品名发票  → 编码和数量不填，给出拆票提示
 *   3. 一张生活照  → 一个字都不改
 *
 * 这三条是互相矛盾的"正确"，只跑其中一条会被另一条悄悄破坏，
 * 所以必须一起过。任何一条红了就非 0 退出。
 *
 * 用法：node scripts/e2e-doc-all.js
 * 前置：另开一个终端 node server.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(ROOT, 'scripts', 'e2e-doc-intake.js');

const CASES = [
  { expect: 'single', img: 'data/fixtures/invoice-single.png', suffix: '-single', name: '单品名发票' },
  { expect: 'multi', img: 'data/fixtures/invoice-demo.png', suffix: '', name: '多品名发票' },
  { expect: 'nodoc', img: 'data/fixtures/not-a-document.png', suffix: '-nodoc', name: '非单据图片' },
];

const missing = CASES.filter((c) => !fs.existsSync(path.join(ROOT, c.img)));
if (missing.length) {
  console.error(`缺测试图：${missing.map((c) => c.img).join('、')}`);
  process.exit(2);
}

const results = [];

for (const c of CASES) {
  console.log(`\n${'='.repeat(52)}\n场景：${c.name}（${path.basename(c.img)}）\n${'='.repeat(52)}`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, c.img], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, E2E_EXPECT: c.expect, E2E_SHOT_SUFFIX: c.suffix },
    });
    p.on('exit', (n) => resolve(n ?? 1));
  });
  results.push({ ...c, code });
}

console.log(`\n${'='.repeat(52)}\n汇总\n${'='.repeat(52)}`);
for (const r of results) {
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name}`);
}
const bad = results.filter((r) => r.code !== 0);
console.log(bad.length ? `\n${bad.length} 个场景没通过。` : '\n三个场景全部通过。');
process.exit(bad.length ? 1 : 0);
