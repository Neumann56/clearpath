/**
 * 「看懂外贸」视频栏目的浏览器回归。
 *
 * 要钉住的是三件容易悄悄坏掉的事：
 * 1. 不点不加载——页面打开时一个播放器 iframe 都不该有（性能与断网演示都靠这条）
 * 2. 同时只有一个播放器——切卡时上一条必须被卸掉，否则声音叠在一起
 * 3. 收起之后封面要回来，不能留一块空白
 *
 * 跑法：node scripts/e2e-learn.js [--headed] [--shot]
 * 依赖：本机 Edge/Chrome + 托管工作区里的 puppeteer-core（不给项目加依赖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
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
const wantShot = process.argv.includes('--shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: headed ? false : 'new',
  args: ['--no-sandbox', '--window-size=1360,1000'],
});

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed += 1;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 嵌入的第三方播放器自己会往控制台丢东西（指纹上报、埋点失败之类），那不算我们页面的错。
    // 按消息来源 URL 判，比按文字内容判可靠。
    const from = (m.location() && m.location().url) || '';
    if (/bilibili|hdslb|bilivideo|hdslb\.com/.test(from)) return;
    if (/player\.bilibili|hdslb|net::ERR/.test(m.text())) return;
    errors.push(m.text());
  });

  const resp = await page.goto(BASE + '/learn', { waitUntil: 'domcontentloaded' });
  ok('页面能打开', resp && resp.status() === 200, `HTTP ${resp && resp.status()}`);

  const cards = await page.$$eval('[data-learn-card]', (els) => els.length);
  ok('卡片数量与内容一致', cards === 13, `${cards} 张`);

  // 关键：不点就不该有任何第三方 iframe
  const framesBefore = await page.$$eval('iframe', (els) => els.length);
  ok('打开时零播放器（不预加载）', framesBefore === 0, `${framesBefore} 个`);

  // 导航高亮
  const onNav = await page.$eval('.nav a.on', (a) => a.textContent.trim()).catch(() => '');
  ok('导航高亮「看懂外贸」', onNav === '看懂外贸', onNav);

  // 封面是懒加载的，先滚一遍把它们都触发出来再判断。
  // 关键点：哔哩哔哩的图床对站外 Referer 返回 403，靠 img 上的 referrerpolicy="no-referrer" 才拿得到。
  // 所以"全部加载成功"本身就是一条回归——谁把 referrerpolicy 删了，这里会立刻红。
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 70));
    }
    window.scrollTo(0, 0);
  });
  await sleep(1800);
  const coverState = await page.$$eval('.lv-cover', (els) =>
    els.map((i) =>
      i.naturalWidth > 0 ? 'ok' : i.classList.contains('lv-cover-broken') ? 'hidden' : i.complete ? 'failed-visible' : 'loading'
    )
  );
  const loaded = coverState.filter((s) => s === 'ok').length;
  ok('封面没有露出碎图', coverState.every((s) => s !== 'failed-visible'), coverState.join(','));
  ok('封面基本都能取到', loaded >= 11, `${loaded}/${coverState.length} 张`);

  // 点第一条
  const firstBvid = await page.$eval('[data-play]', (b) => b.dataset.play);
  await page.click('[data-play]');
  await sleep(1200);
  const f1 = await page.$$eval('iframe.lv-frame', (els) => els.map((f) => f.getAttribute('src')));
  ok('点击后插入播放器', f1.length === 1, `${f1.length} 个`);
  ok('播放器指向这条视频', (f1[0] || '').includes(firstBvid), String(f1[0]).slice(0, 72));
  ok('播放器不再贴在封面里', await page.$eval('[data-learn-card]', (c) => c.classList.contains('lv') && !!c.querySelector('.lv-collapse')));

  // 切到第二条：第一条必须被卸掉
  const secondBvid = await page.$$eval('[data-play]', (b) => b.map((x) => x.dataset.play)[1]);
  await page.$$eval('[data-play]', (bs) => bs[1] && bs[1].click());
  await sleep(1200);
  const f2 = await page.$$eval('iframe.lv-frame', (els) => els.map((f) => f.getAttribute('src')));
  ok('切卡后只剩一个播放器', f2.length === 1, `${f2.length} 个`);
  ok('活着的是第二条', (f2[0] || '').includes(secondBvid), String(f2[0]).slice(0, 72));

  // 收起
  await page.click('.lv-collapse');
  await sleep(400);
  const f3 = await page.$$eval('iframe.lv-frame', (els) => els.length);
  ok('收起后播放器被移除', f3 === 0, `${f3} 个`);
  const restored = await page.$$eval('[data-learn-card]', (cs) =>
    cs.filter((c) => c.querySelector('.lv-play') && c.querySelector('.lv-play').style.display !== 'none').length
  );
  ok('播放按钮全部回来', restored === 13, `${restored} 张可见`);

  // 断网：显示提示、不加载播放器
  await page.setOfflineMode(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await sleep(200);
  const offlineShown = await page.$eval('#learnOffline', (el) => !el.hidden);
  ok('断网时给出提示', offlineShown);
  await page.click('[data-play]');
  await sleep(300);
  const fOff = await page.$$eval('iframe.lv-frame', (els) => els.length);
  ok('断网时不插入播放器', fOff === 0, `${fOff} 个`);
  await page.setOfflineMode(false);

  // 窄屏
  await page.setViewport({ width: 720, height: 900 });
  await sleep(300);
  const cols = await page.$eval('.learn-grid', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  ok('窄屏单列', cols === 1, `${cols} 列`);
  const navWrap = await page.$eval('.top', (el) => el.getBoundingClientRect().height >= 56);
  ok('窄屏导航不被裁掉', navWrap);
  await page.setViewport({ width: 1360, height: 1000 });

  if (wantShot) {
    const dir = path.join(process.cwd(), 'out');
    fs.mkdirSync(dir, { recursive: true });
    // 整页截图时，视口外的懒加载图有时来不及合成，截出来是一片渐变底。
    // 这里先全部改成立即加载再等一会儿，让截图跟用户真看到的一致。
    await page.evaluate(() => document.querySelectorAll('.lv-cover').forEach((i) => (i.loading = 'eager')));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await page.screenshot({ path: path.join(dir, 'learn-page.png'), fullPage: true });
    console.log('截图 → out/learn-page.png');
  }

  ok('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  failed += 1;
  console.error('执行中断：', e.message);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
