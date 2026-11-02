// 真浏览器 + 真模型：验证老周能指路，且指出来的链接真能点。
//
// 单测只能证明白名单写对了，"模型会不会照规矩给链接""链接渲染出来是不是可点的"
// 这两件事只有在真页面上才看得见。
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

const QUESTION = process.argv[2] || '我手上有一百多票要一起算，怎么弄';

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
await page.setViewport({ width: 1280, height: 960 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(600);

// A. 模块加载与注入（不花额度）
const probe = await page.evaluate(async () => {
  const pm = await import('/js/product-map.js');
  const pr = await import('/js/assistant-prompt.js');
  const base = pr.GENERAL_SYSTEM_PROMPT.length;
  const q = '我手上有一百多票要一起算，怎么弄';
  return {
    routes: pm.ROUTES.length,
    hit: pm.matchRoutes(q),
    hasRules: /一次只给一个链接/.test(pr.GENERAL_SYSTEM_PROMPT),
    base,
    injected: pr.generalSystemPrompt(q, []).prompt.length,
    // 白名单在浏览器里也要能拦住伪协议
    blockJs: pm.isSafeChatLink('javascript:alert(1)'),
    blockProto: pm.isSafeChatLink('//evil.com'),
    allowBatch: pm.isSafeChatLink('/quote/batch'),
  };
});
ok('功能地图在浏览器里读到 8 个入口', probe.routes >= 8, String(probe.routes));
ok('指路规矩已常驻 system prompt', probe.hasRules);
ok('「一百多票一起算」命中批量页', probe.hit.includes('batch'), probe.hit.join(','));
ok('注入后 prompt 变长但可控', probe.injected > probe.base && probe.injected <= probe.base * 2, `${probe.injected} vs ${probe.base}`);
ok('浏览器里白名单拦住 javascript:', probe.blockJs === false);
ok('浏览器里白名单拦住 //evil.com', probe.blockProto === false);
ok('浏览器里放行 /quote/batch', probe.allowBatch === true);

// B. 真问一句，看它会不会照规矩给链接
await page.evaluate(() => {
  const btn = document.querySelector('#tt-assistant .ta-fab') || document.querySelector('#tt-assistant button');
  if (btn) btn.click();
});
await sleep(1200);
await page.waitForFunction(() => {
  const t = document.querySelector('#tt-assistant .ta-text');
  const s = document.querySelector('#tt-assistant .ta-send');
  return t && s && !s.disabled;
}, { timeout: 20000 }).catch(() => {});

console.log(`\n问：${QUESTION}`);
await page.evaluate((q) => {
  const t = document.querySelector('#tt-assistant .ta-text');
  t.value = q;
  t.dispatchEvent(new Event('input', { bubbles: true }));
}, QUESTION);
await sleep(200);
await page.evaluate(() => document.querySelector('#tt-assistant .ta-send')?.click());

let last = '';
let stable = 0;
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  await sleep(1000);
  const txt = await page.evaluate(() => document.querySelector('#tt-assistant')?.innerText || '');
  if (txt === last) {
    stable += 1;
    if (stable >= 4 && txt.includes(QUESTION.slice(0, 4))) break;
  } else {
    last = txt;
    stable = 0;
  }
}

const links = await page.evaluate(() =>
  [...document.querySelectorAll('#tt-assistant .ta-go')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() }))
);
const answer = await page.evaluate(() => document.querySelector('#tt-assistant')?.innerText || '');
await page.screenshot({ path: 'out/route-answer.png' });
await b.close();

console.log('\n--- 回答 ---');
console.log(answer.split(QUESTION).pop().trim().slice(0, 900));

console.log('\n--- 链接 ---');
if (!links.length) console.log('  （一个链接都没有）');
for (const l of links) console.log(`  ${l.text} → ${l.href}`);

console.log('\n--- 自检 ---');
ok('回答里给出了可点链接', links.length > 0, `实际 ${links.length} 个`);
ok('链接数不超过 2（不是目录）', links.length <= 2, `${links.length} 个`);
ok('链接指向批量页或新预演', links.every((l) => /^\/quote\/(batch|new)/.test(l.href)), links.map((l) => l.href).join(' '));
ok('链接没有外站或伪协议', links.every((l) => l.href.startsWith('/') && !l.href.startsWith('//')));
ok('全程无 JS 异常', errs.length === 0, errs.join(' | ').slice(0, 160));

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
