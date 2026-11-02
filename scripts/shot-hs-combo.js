/**
 * 给「HS 编码 / 品名」下拉拍两张图：关着的、点开的。
 *
 * 存在的理由：这个下拉被报过「点不开」。单测能断言 hidden=false，但断言不出
 * 它有没有被别的元素盖住、箭头有没有画出来。只有真截一张图才看得见。
 *
 * 用法：node scripts/shot-hs-combo.js   （先起服务）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outDir = path.resolve('out');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE.find((p) => fs.existsSync(p)),
  headless: true,
  args: ['--no-sandbox', '--no-proxy-server'],
  defaultViewport: { width: 1180, height: 780 },
});

try {
  const page = await browser.newPage();
  await page.goto(`${BASE}/quote/new`, { waitUntil: 'networkidle0' });
  await sleep(300);

  // 1. 关着的状态：箭头必须在，不然用户不知道这里能点
  const box = await page.evaluate(() => {
    const c = document.querySelector('.combo');
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x) - 24, y: Math.round(r.y) - 96, w: Math.round(r.width) + 48, h: Math.round(r.height) + 150 };
  });
  await page.screenshot({ path: path.join(outDir, 'hs-combo-closed.png'), clip: { x: box.x, y: box.y, width: box.w, height: box.h } });

  // 2. 点一下（不打字）就该展开
  await page.click('#hsCodeInput');
  await sleep(260);
  const listH = await page.evaluate(() => Math.round(document.getElementById('hsComboList').getBoundingClientRect().height));
  await page.screenshot({
    path: path.join(outDir, 'hs-combo-open.png'),
    clip: { x: box.x, y: box.y, width: box.w, height: box.h + listH + 10 },
  });

  // 再确认列表没被别的元素盖住：取列表中心那个点，看它是不是列表自己
  const onTop = await page.evaluate(() => {
    const list = document.getElementById('hsComboList');
    const r = list.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + 12);
    return { hit: el ? el.tagName + '.' + el.className : 'none', inside: list.contains(el) };
  });

  console.log(listH > 20 ? `✓ 点一下展开 ${listH}px` : `✗ 点一下没展开（${listH}px）`);
  console.log(onTop.inside ? '✓ 下拉没被遮挡' : `✗ 下拉被遮挡，命中的是 ${onTop.hit}`);
  console.log('✓ 截图：out/hs-combo-closed.png / out/hs-combo-open.png');
} finally {
  await browser.close();
}
