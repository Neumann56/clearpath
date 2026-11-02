/**
 * 移动端（/m）视觉与功能截图。
 *
 * 跑法：node scripts/mobile-shots.js [--headed]
 * 产出：out/m/*.png，用于人工看版式。
 *
 * 为什么要专门写这个：移动端的坑都在"看得见但读不出"的地方——
 * 数字折行、底部导航被安全区盖住、空状态整块消失。
 * 单测断言不了这些，只有真截一张图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const OUT = path.resolve('out/m');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

if (!EDGE) {
  console.error('没找到 Edge/Chrome，跳过。');
  process.exit(2);
}

const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');
const headed = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: headed ? false : 'new',
  // --no-proxy-server 是必需的：本机装了代理时 Chrome 会把 127.0.0.1 也交给代理，
  // 表现成 ERR_CONNECTION_REFUSED，看着像服务没起来，实际是请求没到本机。
  args: ['--no-sandbox', '--no-proxy-server'],
});

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed += 1;
};

try {
  const page = await browser.newPage();
  // iPhone 14 逻辑分辨率：375–390 是绝大多数微信用户的宽度
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push(`console: ${m.text()}`);
  });

  const shot = async (name, full = true) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  };

  // 报告按设备隔离。脚本要是每次用新身份，历史页永远是空的——
  // 那是"设备隔离生效"而不是"功能坏了"，但会让这条断言假红。
  // 所以导航请求和页面内 fetch 都钉死同一个 id。
  const DID = 'mp-shots-0001';
  await page.setExtraHTTPHeaders({ 'x-device-id': DID });
  await page.goto(`${BASE}/m`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((v) => localStorage.setItem('tt_mp_did', v), DID);

  // ---- 首页 ----
  await page.goto(`${BASE}/m`, { waitUntil: 'networkidle0' });
  await shot('01-home');

  const homeCheck = await page.evaluate(() => {
    const btn = document.querySelector('#go');
    const ta = document.querySelector('#nl');
    return {
      // 首屏（844 高）内必须能看见输入框和按钮
      btnTop: btn ? btn.getBoundingClientRect().top : 9999,
      hasTa: !!ta,
      cov: document.querySelector('.covline')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) || '',
    };
  });
  ok('首页输入框存在', homeCheck.hasTa);
  ok('首页主按钮在首屏内', homeCheck.btnTop < 844, `top=${Math.round(homeCheck.btnTop)}`);
  ok('覆盖范围有数字', /68/.test(homeCheck.cov), homeCheck.cov);

  // ---- 一句话录入 → 跳转 ----
  await page.type('#nl', '8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报');
  await page.click('#go');
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
  const onNew = page.url().includes('/m/new');
  ok('一句话能跳到录入页', onNew, page.url().split('?')[1] || '');
  await shot('02-new-prefilled');

  const prefilled = await page.evaluate(() => ({
    country: document.getElementById('countryText')?.value || '',
    hs: document.getElementById('hsCode')?.value || '',
    fob: document.getElementById('fob')?.value || '',
    decl: document.getElementById('declarationDate')?.value || '',
  }));
  ok('国家已预填', prefilled.country === '匈牙利', prefilled.country);
  ok('编码已预填', prefilled.hs.replace(/\D/g, '') === '870891', prefilled.hs);
  ok('货值已预填', prefilled.fob === '48000', prefilled.fob);

  // ---- 补齐渠道 → 提交 ----
  await page.click('#segChannel button[data-v="B2B"]');
  await sleep(700);
  const estText = await page.evaluate(() => document.getElementById('est')?.textContent.replace(/\s+/g, ' ').trim() || '');
  ok('底部实时估算出数', /真实成本/.test(estText) && !/—/.test(estText), estText.slice(0, 60));

  await page.click('#submitBtn');
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
  ok('提交后进报告页', /\/m\/report\//.test(page.url()), page.url().split('/').pop());
  await sleep(400);
  await shot('03-report');

  const rep = await page.evaluate(() => {
    const v = [...document.querySelectorAll('.bigdual .dnum b')].map((x) => x.textContent.trim());
    const folds = [...document.querySelectorAll('.fold')].map((f) => ({
      open: f.hasAttribute('open'),
      title: f.querySelector('summary')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 14),
    }));
    // 数字不能折行：宽度够不够，看 scrollWidth 是否超过 clientWidth
    const nums = [...document.querySelectorAll('.dnum b, .line .v')].map((x) => ({
      t: x.textContent.trim(),
      over: x.scrollWidth > x.clientWidth + 1,
    }));
    return { dual: v, folds, wrapped: nums.filter((n) => n.over).map((n) => n.t) };
  });
  ok('报告首屏两个数都在', rep.dual.length >= 2, rep.dual.join(' / '));
  ok('两个数没有相加成一个', rep.dual.length === 2);
  ok('待核组默认展开', rep.folds.some((f) => f.open && /还没算准/.test(f.title || '')), JSON.stringify(rep.folds.map((f) => (f.open ? '+' : '-') + f.title)));
  ok('金额不折行', rep.wrapped.length === 0, rep.wrapped.join(','));

  // ---- 历史 ----
  await page.goto(`${BASE}/m/reports`, { waitUntil: 'networkidle0' });
  const hist = await page.evaluate(() => document.querySelectorAll('.ritem').length);
  ok('历史里有刚算的票', hist >= 1, `${hist} 条`);
  await shot('04-reports');

  // ---- 日历 ----
  await page.goto(`${BASE}/m/calendar`, { waitUntil: 'networkidle0' });
  const cal = await page.evaluate(() => ({
    months: document.querySelectorAll('.cal-month').length,
    items: document.querySelectorAll('.cal-item').length,
  }));
  ok('日历按月分组', cal.months >= 2, `${cal.months} 个月 / ${cal.items} 项`);
  await shot('05-calendar');

  // ---- 看懂外贸 ----
  await page.goto(`${BASE}/m/learn`, { waitUntil: 'networkidle0' });
  // 封面是 loading=lazy 的，不滚到底根本不会发起请求——
  // 而"B 站图床 403"这个坑只有真发了请求才看得出来，所以要滚一遍再数。
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await sleep(1600);
  const learn = await page.evaluate(() => ({
    cards: document.querySelectorAll('.vcard').length,
    featured: document.querySelectorAll('.vcard.vfeatured').length,
    brokenCovers: [...document.querySelectorAll('.vcover img')].filter((i) => i.naturalWidth === 0).length,
    noSrc: [...document.querySelectorAll('.vcover img')].filter((i) => !i.src).length,
  }));
  ok('视频卡片渲染', learn.cards >= 10, `${learn.cards} 条`);
  ok('每组主课通栏', learn.featured >= 3, `${learn.featured} 条`);
  ok('封面都真的加载出来了（不是 403 空白）', learn.brokenCovers === 0 && learn.noSrc === 0, `坏封面 ${learn.brokenCovers} / 缺地址 ${learn.noSrc}`);
  await shot('06-learn');

  // ---- 老周 ----
  await page.goto(`${BASE}/m/chat`, { waitUntil: 'networkidle0' });
  await shot('07-chat');

  ok('页面没有 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n截图目录：${OUT}`);
if (failed) {
  console.error(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log('\n全部通过');
