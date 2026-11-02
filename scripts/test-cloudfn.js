/**
 * 云函数本地实跑测试。
 *
 * 为什么要单独测：云函数只有在云开发控制台里才能看到日志，而它最容易出的问题
 * 恰恰是"静默"的——白名单写宽了不报错，转发偶发 502 也不报错，
 * 等到陌生用户点进来才发现首页一片空白。
 *
 * 这个脚本把 index.js 用假 require 加载起来，直接调 main()：
 *   - wx-server-sdk 换成一个空壳（本地没装，也不该为测试去装）
 *   - TANTU_BASE 指向本机，真打真实后端
 *
 * 跑法：先起服务，再 node scripts/test-cloudfn.js
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const FN = path.resolve('miniprogram/cloudfunctions/apiProxy/index.js');

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed += 1;
};

/** 用假 require 加载云函数。base 决定它请求哪台后端。 */
function loadFn(base) {
  process.env.TANTU_BASE = base;
  const code = fs.readFileSync(FN, 'utf8');
  const mod = { exports: {} };
  const fakeRequire = (name) => {
    if (name === 'wx-server-sdk') {
      return { init() {}, DYNAMIC_CURRENT_ENV: 'local-test' };
    }
    // 云函数依赖越少越好：多一个包就多一次"云端安装依赖失败"
    throw new Error('云函数不该依赖这个包：' + name);
  };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
  fn(fakeRequire, mod, mod.exports, FN, path.dirname(FN));
  return mod.exports.main;
}

const main = loadFn(BASE);

// ---------- 探活 ----------
try {
  const r = await fetch(`${BASE}/healthz`);
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  console.error(`后端没起（${BASE}）：${e.message}`);
  process.exit(2);
}

// ---------- 1. 白名单 ----------
const r1 = await main({ path: '/api/meta/hs', method: 'GET' });
ok('放行 /api/ 前缀', r1.status === 200 && r1.body && r1.body.ok !== false, `status ${r1.status}`);

const r2 = await main({ path: '/.cloud/llm/chat/completions', method: 'POST', data: {} });
ok('拦掉 /.cloud（它必须走 llm 分支并带 key）', r2.status === 403, `status ${r2.status}`);

const r3 = await main({ path: '/etc/passwd', method: 'GET' });
ok('拦掉站内任意路径', r3.status === 403, `status ${r3.status}`);

const r4 = await main({ path: 'https://evil.example.com/steal', method: 'GET' });
ok('拦掉绝对 URL（不收 url，只收 path）', r4.status === 403, `status ${r4.status}`);

const r5 = await main({ path: '/api/../admin', method: 'GET' });
ok('拦掉路径穿越', r5.status === 400, `status ${r5.status}`);

// ---------- 2. 真实转发 ----------
const r6 = await main({
  path: '/api/quote/precheck',
  method: 'POST',
  did: 'cloud-test-0001',
  data: {
    input: {
      country: 'HU',
      hsCode: '870891',
      fob: 48000,
      freight: 2400,
      qty: 1200,
      channel: 'B2B',
      dates: { declarationDate: '2026-10-20' },
    },
  },
});
const e = r6.body && r6.body.expected;
ok('POST 转发到后端并拿到数', r6.status === 200 && Boolean(e), `${r6.status} · 耗时 ${r6.ms}ms`);
ok('两个口径都透传回来', Boolean(e && e.landedCost && e.cashRequired), e ? `${e.landedCost} / ${e.cashRequired}` : '');

const r7 = await main({ path: '/api/meta/countries', method: 'GET' });
ok('国家清单完整（68 个）', r7.status === 200 && (r7.body.countries || []).length === 68, `${(r7.body.countries || []).length} 个`);

// ---------- 3. 设备号 ----------
// 后端按设备号隔离报告。云函数不带 did 的话，所有人共用一个"设备"，历史会互相看见。
const did = 'cloud-test-' + Date.now().toString(36);
const r8 = await main({
  path: '/api/quote',
  method: 'POST',
  did,
  data: {
    input: {
      country: 'HU',
      hsCode: '870891',
      fob: 48000,
      freight: 2400,
      qty: 1200,
      channel: 'B2B',
      dates: { declarationDate: '2026-10-20' },
    },
  },
});
const rid = r8.body && r8.body.reportId;
ok('能算出报告', r8.status === 200 && Boolean(rid), rid || `status ${r8.status}`);

const seen = await (await fetch(`${BASE}/api/reports`, { headers: { 'x-device-id': did } })).json();
ok('设备号被透传（历史按设备隔离）', (seen.reports || []).some((x) => x.reportId === rid), `${(seen.reports || []).length} 条`);

const other = await (await fetch(`${BASE}/api/reports`, { headers: { 'x-device-id': 'cloud-test-other-1' } })).json();
ok('别的设备看不到这份', !(other.reports || []).some((x) => x.reportId === rid), '');

// ---------- 4. 后端错误原样透传 ----------
const r9 = await main({ path: '/api/report/does-not-exist', method: 'GET' });
ok('后端 4xx 原样透传（不吞成 200）', r9.status >= 400 && r9.status < 500, `status ${r9.status}`);

// ---------- 5. 后端不可达 ----------
// 这是最要紧的一条：云函数必须把"连不上"变成一个能看懂的 502，
// 而不是抛异常让小程序端拿到一个没有 message 的失败。
const deadFn = loadFn('http://127.0.0.1:9'); // 9 号端口是 discard，必然连不上
const r10 = await deadFn({ path: '/api/meta/hs', method: 'GET' });
ok('后端不可达时返回 502 而不是抛异常', r10.status === 502, `status ${r10.status}`);
ok('502 带得住原因', /连不上后端/.test((r10.body && r10.body.message) || ''), (r10.body && r10.body.message) || '');

// ---------- 6. llm 分支的前置校验 ----------
const r11 = await main({ action: 'llm', messages: [] });
ok('llm 无内容时直接拒绝，不去打模型', r11.ok === false, r11.message || '');

// ---------- 输出 ----------
console.log('');
if (failed) {
  console.error(`${failed} 项未通过`);
  process.exit(1);
}
console.log('全部通过');
