// 真浏览器验证：老周加载了新常识包，且注入只在命中时发生。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`);
  }
};

const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(600);

// 1. 模块能加载、无 JS 异常
ok('首页无 JS 报错', errs.filter((e) => !/favicon|404/i.test(e)).length === 0, errs.join(' | ').slice(0, 160));

// 2. 悬浮球在
const ball = await page.$('#tt-assistant .ta-fab, #tt-assistant .ta-toggle, #tt-assistant button');
ok('老周悬浮球存在', !!ball);

// 3. 直接验证模块在浏览器里能跑（网络缓存与 MIME 都对）
const probe = await page.evaluate(async () => {
  const kb = await import('/js/trade-knowledge.js');
  const pr = await import('/js/assistant-prompt.js');
  const base = pr.GENERAL_SYSTEM_PROMPT.length;
  const hit = pr.generalSystemPrompt('客户要 DDP 到门，这单我该不该接', []);
  const miss = pr.generalSystemPrompt('今天天气怎么样', []);
  return {
    topics: kb.TOPICS.length,
    hitIds: hit.ids,
    hitLen: hit.prompt.length,
    missIds: miss.ids,
    missLen: miss.prompt.length,
    base,
    hasBrake: /不要据此推算|不要往里加任何金额/.test(hit.prompt),
  };
});

ok(`常识包在浏览器里读到 ${probe.topics} 类主题`, probe.topics >= 18, String(probe.topics));
ok('命中 DDP 问题会注入', probe.hitIds.length > 0, probe.hitIds.join(','));
ok('注入内容比基线长', probe.hitLen > probe.base, `${probe.hitLen} vs ${probe.base}`);
ok('注入量没失控（≤ 3000 字）', probe.hitLen <= 3000, `${probe.hitLen} 字`);
ok('注入块带刹车语', probe.hasBrake);
ok('无关问题不注入且长度不变', probe.missIds.length === 0 && probe.missLen === probe.base, `${probe.missLen} vs ${probe.base}`);

console.log(`\n  体积：基线 ${probe.base} 字 → 命中后 ${probe.hitLen} 字（+${probe.hitLen - probe.base}）`);

// 4. 点开面板，看建议问题里有没有外贸类
const opened = await page.evaluate(() => {
  const btn = document.querySelector('#tt-assistant .ta-fab') || document.querySelector('#tt-assistant button');
  if (btn) btn.click();
  return !!btn;
});
if (opened) {
  await sleep(500);
  const text = await page.evaluate(() => document.querySelector('#tt-assistant')?.innerText || '');
  ok('面板出现外贸类建议问题', /付款方式|DDP/.test(text), text.replace(/\n/g, ' ').slice(0, 120));
}

ok('全程无 JS 异常', errs.filter((e) => !/favicon|404/i.test(e)).length === 0, errs.join(' | ').slice(0, 160));

await b.close();
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
