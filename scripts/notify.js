#!/usr/bin/env node
/**
 * 待核日报 CLI —— 调用一次就退出，不要常驻定时器。
 *
 *   node scripts/notify.js                     # 用今天，未配 WEBHOOK_URL 就只打印
 *   node scripts/notify.js --today=2026-12-05  # 推演某一天（答辩演示用）
 *   node scripts/notify.js --dry-run           # 强制只打印，即使配了 webhook
 *   node scripts/notify.js --json              # 输出机器可读结构
 *
 * 系统计划任务示例（Windows）：
 *   schtasks /create /tn "通途待核日报" /tr "node D:\...\scripts\notify.js" /sc daily /st 09:00
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDigest, bucketFacts, sendDigest } from '../lib/notify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FACTS_FILE = path.join(ROOT, 'data', 'runtime', 'unresolved.json');

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const todayArg = argOf('today');
const today = todayArg || new Date().toISOString().slice(0, 10);
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');

if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`[notify] --today 格式应为 YYYY-MM-DD，收到 ${today}`);
  process.exit(2);
}

let facts = [];
try {
  facts = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
} catch (e) {
  console.error(`[notify] 读不到待核库 ${FACTS_FILE}：${e.message}`);
  console.error('[notify] 先跑 node scripts/seed-demo.js 或 node scripts/sync-facts.js 建库。');
  process.exit(2);
}

const digest = buildDigest(facts, today);

if (asJson) {
  const b = bucketFacts(facts, today);
  console.log(
    JSON.stringify(
      {
        today,
        digest,
        counts: {
          open: b.open.length,
          overdue: b.overdue.length,
          dueSoon: b.dueSoon.length,
          red: b.red.length,
          expired: b.expired.length,
          noOwner: b.noOwner.length,
        },
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (dryRun) {
  console.log(digest);
  console.log('\n[notify] --dry-run：未发送。');
  process.exit(0);
}

const result = await sendDigest(digest);

if (result.sent) {
  console.log(digest);
  console.log(`\n[notify] 已推送（HTTP ${result.status}）。`);
  process.exit(0);
}

if (result.reason === 'unconfigured') {
  console.log(digest);
  console.log('\n[notify] 未配置 WEBHOOK_URL，只打印不推送。设置后即可自动发送：');
  console.log('         set WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx');
  process.exit(0);
}

console.log(digest);
console.error(`\n[notify] 推送失败（${result.reason}）${result.detail ? '：' + result.detail : ''}`);
console.error('[notify] 摘要已打印到上面，可人工转发。');
process.exit(1);
