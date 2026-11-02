/**
 * 抓 UN Comtrade 的进口数据，落成本地快照。
 *
 * 为什么要落快照而不是实时查：
 *   应用的红线是「零依赖、断网可跑」。比赛现场网络不可控，
 *   实时查一旦超时就只能看空白页。抓一次存下来，页面永远有数。
 *
 * 用法：
 *   node scripts/fetch-market-trend.js --dry            只抓 2 个市场 × 1 年，验证通路
 *   node scripts/fetch-market-trend.js --limit 5        抓前 5 个市场，估时间
 *   node scripts/fetch-market-trend.js                  全量（68 市场 × 6 品类 × 5 年）
 *
 * 三个必须守住的规矩：
 *   1. 请求间隔 ≥1.2s。连发 5 次就会被限速，返回体不是 JSON，看起来像"没数据"。
 *   2. 拿不到就是拿不到——不写 0。0 在页面上和"真的没有进口"长得一模一样。
 *   3. isReported=false 表示这条不是报告国自己报的（镜像估算），要原样带给页面。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadParams, APP_ROOT } from '../lib/params.js';

const API = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const REF = 'https://comtradeapi.un.org/files/v1/app/reference/Reporters.json';
const OUT_DIR = path.join(APP_ROOT, 'data', 'market');
const CHINA = 156;
const GAP_MS = 1200;
const RETRY = 3;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = has('--dry');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const YEARS = argOf('--years', '2021,2022,2023,2024,2025')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, label) {
  for (let attempt = 1; attempt <= RETRY; attempt += 1) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // 限速时返回的是错误页或截断体，JSON.parse 会抛，这里统一按失败重试
      return JSON.parse(text);
    } catch (e) {
      if (attempt === RETRY) {
        console.warn(`    ✗ ${label} 放弃：${e.message}`);
        return null;
      }
      await sleep(1500 * attempt);
    }
  }
  return null;
}

async function main() {
  const params = loadParams();
  const catalog = (params.raw.hsCatalog || []).map((c) => String(c.hs).replace(/\D/g, '').slice(0, 6));
  const markets = params.raw.countries.filter((c) => c.supported);
  const targets = LIMIT ? markets.slice(0, LIMIT) : markets;
  const years = DRY ? YEARS.slice(0, 3) : YEARS;

  console.log(`参数库 ${params.version} · ${targets.length} 市场 × ${catalog.length} 品类 × ${years.length} 年`);

  // reporterCode 映射：直接吃 alpha2，不手抄 68 个数字码
  const ref = await getJson(REF, 'Reporters 参考表');
  if (!ref) throw new Error('拿不到国家码参考表，后面全都做不了');
  const byIso2 = new Map();
  for (const r of ref.results || ref) {
    if (r.reporterCodeIsoAlpha2) byIso2.set(r.reporterCodeIsoAlpha2, Number(r.reporterCode));
  }

  const out = {
    version: `trend-${new Date().toISOString().slice(0, 10)}`,
    asOf: new Date().toISOString().slice(0, 10),
    source: {
      name: 'UN Comtrade',
      dataset: 'HS as reported · annual · imports (M)',
      url: API,
      note: '公开预览接口，无需密钥。数值为进口额（美元），netWgt 为净重。isReported=false 表示非报告国自行申报（镜像估算）。',
    },
    years,
    paramsVersion: params.version,
    markets: {},
    skipped: [],
  };

  let done = 0;
  const total = targets.length * years.length * 2;

  for (const m of targets) {
    const rc = byIso2.get(m.code);
    if (!rc) {
      out.skipped.push({ code: m.code, name: m.name, reason: 'Comtrade 无对应 reporterCode' });
      console.warn(`  ⚠ ${m.code} ${m.name}：参考表里没有，跳过`);
      continue;
    }
    const entry = { reporterCode: rc, name: m.name, items: {} };
    for (const hs of catalog) entry.items[hs] = { world: [], china: [] };

    for (const y of years) {
      for (const [key, partner] of [
        ['world', 0],
        ['china', CHINA],
      ]) {
        const q = `${API}?reporterCode=${rc}&period=${y}&partnerCode=${partner}&cmdCode=${catalog.join(',')}&flowCode=M&includeDesc=false`;
        const j = await getJson(q, `${m.code} ${y} ${key}`);
        done += 1;
        if (j && Array.isArray(j.data)) {
          for (const row of j.data) {
            const hs = String(row.cmdCode).replace(/\D/g, '').slice(0, 6);
            if (!entry.items[hs]) continue;
            // 值为空就不写这个年份：写 0 会在页面上变成"这个国家没进口"
            if (row.primaryValue == null) continue;
            entry.items[hs][key].push({
              year: y,
              valueUsd: Math.round(row.primaryValue),
              netWgtKg: row.netWgt == null ? null : Math.round(row.netWgt),
              isReported: row.isReported !== false,
            });
          }
        }
        if (done % 20 === 0) process.stdout.write(`  进度 ${done}/${total}\n`);
        await sleep(GAP_MS);
      }
    }
    out.markets[m.code] = entry;
    console.log(`  ✓ ${m.code} ${m.name}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${out.version}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`\n写入 ${path.relative(APP_ROOT, file)} · ${kb}KB`);
  if (out.skipped.length) console.log(`跳过 ${out.skipped.length} 个：${out.skipped.map((s) => s.code).join(' ')}`);
}

main().catch((e) => {
  console.error('抓取失败：', e.message);
  process.exit(1);
});
