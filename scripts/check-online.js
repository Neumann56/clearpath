#!/usr/bin/env node
/**
 * 线上巡检：验的是"别人拿到链接能不能用"，不是"服务器活着"。
 *
 * 为什么不能只 curl 200：
 *   - 分享链接少一个 sharecode 就是 403「链接不完整」，但服务器自己一切正常
 *   - 静态资源 200 不代表样式生效（路径变了会是 200 的空壳）
 *   - 老周走浏览器直连云服务，Origin 一变就挂，服务器日志里一条错都没有
 *
 * 用法：
 *   node scripts/check-online.js                                  # 用默认链接
 *   node scripts/check-online.js --url https://x.host --code XXX
 *   node scripts/check-online.js --url http://1.2.3.4:8080 --no-code   # 自建服务器
 *   node scripts/check-online.js --no-ai                          # 跳过模型调用（省钱、快）
 *
 * 要联网，所以不进 verify.js —— 基线必须能断网跑。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = (argOf('--url', 'https://clearpath-duty.app.workbuddy.host') || '').replace(/\/$/, '');
// 自建服务器（阿里云 ECS 等）没有 sharecode 这一层，用 --no-code 显式关掉。
// 不能靠 `--code ''`：argOf 把空串当没传，会静默退回默认值，然后拼出 ?sharecode=FA7USO4LQJ 打到自己的 IP 上。
const CODE = args.includes('--no-code') ? '' : argOf('--code', 'FA7USO4LQJ');
const SKIP_AI = args.includes('--no-ai');
const q = CODE ? `?sharecode=${CODE}` : '';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('没找到 Edge，跑不了浏览器回归。');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (n, c, d = '') => {
  if (c) pass++;
  else fail++;
  console.log(`${c ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`);
};

const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900 });

const failedReq = [];
const badStatus = [];
// 第 1 步是故意不带 sharecode 去撞门禁，那一次 403 是我们自己制造的，不能算站点故障
let probingGate = false;
page.on('requestfailed', (r) => {
  // 走同源转发时，SSE 拿到完整回答后客户端会主动 cancel，浏览器记成 ERR_ABORTED。
  // 这不算故障：回答已经收全（下面"老周回话/不是离线兜底"两项在守它）。
  const abortedStream = /\.cloud\/llm\/chat/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED';
  if (!abortedStream) failedReq.push(`${r.url().slice(0, 80)} ${r.failure()?.errorText}`);
});
page.on('response', (r) => {
  if (probingGate) return;
  // 视频封面来自哔哩哔哩图床，偶尔慢或 403 不算站点故障
  if (r.status() >= 400 && !/player\.bilibili|hdslb\.com|favicon/.test(r.url())) badStatus.push(`${r.status()} ${r.url().slice(0, 80)}`);
});

console.log(`巡检目标：${BASE}${CODE ? '（带 sharecode）' : '（无 sharecode）'}\n`);

// 1. 不带 sharecode 应该被挡住，而不是裸奔
if (CODE) {
  probingGate = true;
  const r = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  ok('无 sharecode 被挡下', r.status() === 403 || /链接不完整/.test(await page.content()), `${r.status()}`);
  await new Promise((s) => setTimeout(s, 200)); // 让 response 事件排空再解禁
  probingGate = false;
}

// 2. 带 sharecode 能进
const t0 = Date.now();
await page.goto(`${BASE}/${q}`, { waitUntil: 'networkidle2', timeout: 60000 });
ok('首页打开', true, `${Date.now() - t0}ms`);

const styled = await page.evaluate(() => {
  const top = document.querySelector('.top');
  return top ? { h: Math.round(top.getBoundingClientRect().height), bg: getComputedStyle(top).backgroundColor } : null;
});
ok('样式表生效', Boolean(styled && styled.h > 40), styled ? `顶栏 ${styled.h}px` : '顶栏没渲染');

const mainBtn = await page.$$eval('a.btn, button.btn', (e) => e.length);
ok('主按钮渲染', mainBtn >= 1, `${mainBtn} 个`);

// 3. 老周：最容易在换域名后静默失效的一环
if (!SKIP_AI) {
  await page.waitForSelector('.ta-fab', { timeout: 15000 });
  await page.click('.ta-fab');
  await new Promise((r) => setTimeout(r, 600));
  ok('老周面板打开', await page.$eval('.ta-panel', (e) => !e.hasAttribute('hidden')).catch(() => false));

  await page.type('.ta-text', 'FOB 和 CIF 差在哪，一句话说清');
  await page.click('.ta-send');

  let answer = '';
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    answer = await page.evaluate(() => [...document.querySelectorAll('.ta-msg.ta-bot')].map((x) => x.textContent.trim()).join('\n'));
    if (answer.length > 40 && !/正在|思考/.test(answer.slice(-6))) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  // 离线兜底也可能是"有回复"，所以单独判一次
  // 兜底文案是有组织的一大段离线常见问题（实测 685 字），所以"字数够多"根本不能证明模型通了。
  // 判据必须是兜底自己会说的话，且不能带 `answer.length < 200` 这类长度门槛——那次就是靠长度
  // 把一次真故障判成了通过。宁可误报，也不要这种绿。
  const degraded = /连不上 AI|服务暂不可用|没连上|网络不通|稍后再试|离线答疑|下面是几个不用联网/.test(answer);
  ok('老周回话', answer.length > 20, `${answer.length} 字`);
  ok('不是离线兜底', !degraded);
  console.log('  ' + answer.replace(/\s+/g, ' ').slice(0, 120));
}

// 4. 每个栏目都要真渲染，不能只 200
for (const p of ['/quote/new', '/reports', '/learn', '/calendar']) {
  const r = await page.goto(`${BASE}${p}${q ? q : ''}`, { waitUntil: 'networkidle2', timeout: 45000 });
  ok(`${p} 打开`, r.status() === 200, `${r.status()}`);
  if (p === '/quote/new') {
    const fields = await page.$$eval('input, select, textarea', (e) => e.length);
    ok('录入页表单渲染', fields >= 6, `${fields} 个控件`);
  }
  if (p === '/learn') {
    const cards = await page.$$eval('[data-learn-card]', (e) => e.length).catch(() => 0);
    ok('视频卡片渲染', cards >= 10, `${cards} 张`);
  }
}

// 5. 后台不该对匿名访客开放。
//    这一步故意不走浏览器：401 带 WWW-Authenticate 会触发认证流程，
//    page.goto 抛 ERR_INVALID_AUTH_CREDENTIALS、page.evaluate 里的 fetch 直接卡死到协议超时。
//    Node 侧发一次请求最干净，也不会被弹窗干扰。
let adminStatus = 0;
try {
  adminStatus = (await fetch(`${BASE}/api/admin/params${q ? q : ''}`, { redirect: 'manual' })).status;
} catch {
  adminStatus = 0;
}
ok('后台参数接口已锁', adminStatus === 401 || adminStatus === 403, String(adminStatus));

ok('无失败请求', failedReq.length === 0, failedReq.slice(0, 3).join(' | '));
ok('无 4xx/5xx 资源', badStatus.length === 0, badStatus.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${fail === 0 ? '✓ 线上可用' : '✗ 有 ' + fail + ' 项没过'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
