// 真模型验证：老周拿到常识包之后，回答是不是真的变了。
//
// 这一步不能省。注入链路对、prompt 拼对了，但模型可能照样给一段泛泛的套话，
// 那这个功能就是假的。所以要真问一句、真读回答。
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

const QUESTION = process.argv[2] || '客户要 DDP 到门，这单我该不该接';

const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
await sleep(800);

// 打开面板
await page.evaluate(() => {
  const btn = document.querySelector('#tt-assistant .ta-fab') || document.querySelector('#tt-assistant button');
  if (btn) btn.click();
});
await sleep(1200);

console.log(`问：${QUESTION}`);

// 等模型就绪再发（预热要拉 CDN + 模型列表）
const ready = await page.waitForFunction(
  () => {
    const t = document.querySelector('#tt-assistant .ta-text');
    const send = document.querySelector('#tt-assistant .ta-send');
    return t && send && !send.disabled;
  },
  { timeout: 20000 }
).then(() => true).catch(() => false);
console.log(ready ? '面板已就绪' : '面板未就绪，仍然试着发送');

await page.evaluate((q) => {
  const t = document.querySelector('#tt-assistant .ta-text');
  t.value = q;
  t.dispatchEvent(new Event('input', { bubbles: true }));
}, QUESTION);
await sleep(200);

await page.evaluate(() => {
  const s = document.querySelector('#tt-assistant .ta-send');
  if (s) s.click();
});

// 轮询到内容不再增长
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

const full = await page.evaluate(() => document.querySelector('#tt-assistant')?.innerText || '');
const answer = full.split(QUESTION).pop().trim();

await page.screenshot({ path: 'out/kb-answer.png' });
await b.close();

console.log('\n--- 回答 ---');
console.log(answer.slice(0, 1200));
console.log('\n--- 自检 ---');
// 「回答切题」的判据：问税率的，回答里得有税率迹象（百分比 / 税则名）；
// 其余问题按实体词匹配。原来的整串汉字匹配会把"汽配发匈牙利"当成一个词，
// 老周答"3%，出处 TARIC"就被判成跑题——判据比回答更不可靠，是脚本的问题不是他的。
const STOP = ['你们', '我们', '这个', '那个', '什么', '怎么', '为什么', '多少', '哪些', '能不', '可以'];
const askRate = /税率|关税|多少个?点|交多少税|税是/.test(QUESTION);
const rateAnswered = /\d+(\.\d+)?\s*%|TARIC|HTS|税则|关税同盟/.test(answer);
const grams = new Set();
for (const seg of QUESTION.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/)) {
  for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2));
}
const relevant = (askRate && rateAnswered) || [...grams].filter((g) => !STOP.includes(g)).some((g) => answer.includes(g));
const checks = [
  ['回答切题', relevant, askRate ? `问税率 · 有税率迹象=${rateAnswered}` : [...grams].slice(0, 6).join('/')],
  ['给了可执行的动作，不是空泛建议', /改|问|算|确认|要|让|去/.test(answer)],
  ['没有给出具体金额', !/[\d,]{4,}(\.\d+)?\s*(美元|美金|USD)/i.test(answer)],
  ['没有承诺包税或保证清关', !/包税|保证清关|一定能进/.test(answer)],
  ['没有把惯例说成规定', !/必须|一定/.test(answer) || /一般|通常|常见|建议/.test(answer)],
];
for (const [name, cond, extra] of checks) console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && extra ? ` → ${extra}` : ''}`);
console.log(`\n回答长度 ${answer.length} 字 · JS 异常 ${errs.length}`);
if (errs.length) console.log(errs.join(' | ').slice(0, 200));
