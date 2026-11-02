#!/usr/bin/env node
/**
 * 单据读图的端到端验证（真浏览器 + 真模型）。
 *
 * 单元测试（tests/doc-intake.test.js）管的是"拿到模型输出之后怎么清洗"，
 * 这个脚本管的是"从点上传到表单被填上"这条链路真的通。
 *
 * 用法：
 *   node server.js            # 另开一个终端
 *   node scripts/e2e-doc-intake.js [图片路径]
 *
 * 默认用 data/fixtures/invoice-demo.png（一张内容已知的商业发票）。
 * 退出码 0 = 表单确实被填上了，且每个填进去的字段都能在面板里找到图上原话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const IMG = process.argv[2] || path.join(ROOT, 'data', 'fixtures', 'invoice-demo.png');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

if (!EDGE) {
  console.error('没找到 Edge/Chrome，跳过 E2E。');
  process.exit(2);
}
if (!fs.existsSync(IMG)) {
  console.error(`测试图不存在：${IMG}`);
  process.exit(2);
}

// puppeteer-core 装在托管工作区里，避免给项目加依赖
const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
});

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed += 1;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];   // JS 异常：页面真的坏了，必须红
  const netNoise = []; // 网络抖动：模型网关偶发 CORS / ERR_FAILED，代码会换模型重试，不算故障
  const NET_RE = /CORS policy|ERR_FAILED|ERR_NETWORK|ERR_CONNECTION|Failed to load resource|net::/i;
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (NET_RE.test(t)) netNoise.push(t);
    else errors.push('console: ' + t);
  });

  await page.goto(`${BASE}/quote/new`, { waitUntil: 'networkidle2', timeout: 30000 });

  // 记下"上传之前"的表单状态。页面本身有默认值（申报日默认今天），
  // 所以判"没填"只能跟上传前比，不能跟空串比。
  const readForm = () =>
    page.evaluate(() => {
      const f = document.querySelector('form.form-grid') || document.querySelector('main form');
      const keys = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate'];
      const out = {};
      for (const k of keys) if (f?.elements?.[k]) out[k] = f.elements[k].value;
      return out;
    });
  const formValsBefore = await readForm();

  // 打开面板（open 类挂在外层 #tt-assistant 上，CSS 靠 .ta.open .ta-panel 显示）
  await page.click('.ta-fab');
  await page.waitForSelector('.ta.open .ta-panel', { timeout: 5000 });
  ok('助手面板能打开', true);

  // 没选图时预览框必须是隐藏的：display:flex 会盖掉 [hidden]，一漏就是每次都空着一个破图框
  const previewVisible = await page.$eval('.ta-preview', (el) => getComputedStyle(el).display !== 'none');
  ok('没选图时不显示空预览框', !previewVisible);

  // 选图（走真实的 file input，等于用户点"单据"挑文件）
  const input = await page.$('.ta-file');
  await input.uploadFile(IMG);
  await page.waitForSelector('.ta-preview:not([hidden])', { timeout: 15000 });
  const thumb = await page.$eval('.ta-thumb', (el) => ({ src: el.src.slice(0, 30), w: el.naturalWidth }));
  ok('图片预处理完成（压缩后能显示缩略图）', thumb.w > 0, `缩略图宽 ${thumb.w}px`);
  ok('缩略图是压缩后的 JPEG', thumb.src.includes('data:image/jpeg'), thumb.src);

  // 发送
  await page.click('.ta-send');
  ok('已发出识别请求', true);

  // 等结果：出现"已填"或"没把握"
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.ta-msgs')?.textContent || '';
      return /已填|我没把握|看不出是外贸单据|看不了图/.test(t);
    },
    { timeout: 120000 }
  );

  const panel = await page.$eval('.ta-msgs', (el) => el.textContent.replace(/\s+/g, ' ').trim());

  ok('识别出结果并给了说明', panel.length > 20, `${panel.length} 字`);

  // 关键断言：面板上说"已填"的字段，表单里必须真的有值。
  // 只查"某个字段非空"会被页面默认值骗过（申报日一进页面就有值），所以按面板列出的字段逐个回查。
  const LABEL2FIELD = {
    目的国: 'country',
    'HS 编码': 'hsCode',
    货值: 'fob',
    运费: 'freight',
    数量: 'qty',
    申报日: 'declarationDate',
    放行日: 'entryDate',
  };
  const claimed = await page.$$eval('.ta-ev li b', (els) => els.map((e) => e.textContent.trim()));
  const formVals = await readForm();
  const notWritten = claimed.filter((label) => {
    const f = LABEL2FIELD[label];
    return f && !String(formVals[f] || '').trim();
  });
  console.log(`   面板说已填 ${claimed.length} 项：${claimed.join('、') || '（无）'}`);
  console.log('   表单实际值：', JSON.stringify(formVals));
  const expectMode = process.env.E2E_EXPECT || '';
  ok('面板说已填的字段，表单里确实写完', (claimed.length > 0 || expectMode === 'nodoc') && notWritten.length === 0,
    notWritten.length ? `这些没写进去：${notWritten.join('、')}` : '');

  const quotes = await page.$$eval('.ta-ev-q', (els) => els.map((e) => e.textContent.trim()));
  ok('每个填上的字段都附了图上原话', claimed.length === quotes.length, `字段 ${claimed.length} / 引文 ${quotes.length}`);
  if (quotes.length) console.log('   引文样例：', quotes.slice(0, 3).join(' | '));

  // 单品名 vs 多品名：这是两条相反的正确行为，分开断言
  const multi = await page.$('.ta-multi');
  const expect = process.env.E2E_EXPECT || '';
  if (expect === 'single') {
    ok('单品名单据不该冒出"多品名"提示', !multi);
    ok('单品名单据的 HS 编码能填上', /^\d{6,}$/.test(String(formVals.hsCode || '')), formVals.hsCode || '（null）');
  } else if (expect === 'multi') {
    const txt = multi ? await page.$eval('.ta-multi', (el) => el.textContent.replace(/\s+/g, ' ').trim()) : '';
    ok('多品名单据给出了"拆票"提示', Boolean(multi), txt.slice(0, 90));
    ok('多品名时不把编码合成一个', !String(formVals.hsCode || '').trim(), 'HS 编码留空');
  } else if (expect === 'nodoc') {
    // 传一张不是单据的图：宁可不填，也不能从无关图片里"读"出金额
    ok('认得出这不是外贸单据', /看不出是外贸单据/.test(panel));
    const changed = Object.keys(formVals).filter((k) => formVals[k] !== formValsBefore[k]);
    ok('不是单据就一个字都不改', claimed.length === 0 && changed.length === 0,
      changed.length ? `被改了：${changed.map((k) => `${k} "${formValsBefore[k]}"→"${formVals[k]}"`).join(', ')}` : '表单与上传前一致');
  }

  const confirmLines = await page.$$eval('.ta-cand-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  if (confirmLines.length) {
    console.log('   没把握、留给用户点的：', confirmLines.join(' ‖ '));
  }

  // 点第一个候选，看能不能真的填进去
  const firstCand = await page.$('.ta-cand');
  if (firstCand) {
    const fld = await page.evaluate((el) => el.dataset.pick, firstCand);
    const before = await page.evaluate((k) => {
      const f = document.querySelector('form.form-grid') || document.querySelector('main form');
      return f?.elements?.[k]?.value ?? '';
    }, fld);
    await firstCand.click();
    await sleep(300);
    const after = await page.evaluate((k) => {
      const f = document.querySelector('form.form-grid') || document.querySelector('main form');
      return f?.elements?.[k]?.value ?? '';
    }, fld);
    ok('点候选能把字段填上', after !== '' && after !== before, `${fld}: "${before}" → "${after}"`);
  }

  ok('页面没有 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '));
  if (netNoise.length) {
    console.log(`   · 网络重试 ${netNoise.length} 次（网关瞬时不可达，已由换模型兜住，不影响结果）`);
  }

  // 截图要在"验粘贴"之前拍，否则重载后识别结果已经没了，截出来的图不对
  await page.screenshot({ path: path.join(ROOT, 'out', `e2e-doc-intake${process.env.E2E_SHOT_SUFFIX || ''}.png`) });

  // 截图直接 Ctrl+V 是最常用的入口。这里只验"粘进来能出预览"，不发请求（不烧额度）。
  await page.reload({ waitUntil: 'networkidle2' });
  await page.click('.ta-fab');
  await page.waitForSelector('.ta.open .ta-panel', { timeout: 5000 });
  const bytes = [...fs.readFileSync(IMG)];
  const pasted = await page.evaluate(async (arr) => {
    const blob = new Blob([new Uint8Array(arr)], { type: 'image/png' });
    const file = new File([blob], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const box = document.querySelector('.ta-text');
    box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, bytes);
  let previewShown = false;
  try {
    await page.waitForSelector('.ta-preview:not([hidden])', { timeout: 8000 });
    previewShown = true;
  } catch {}
  ok('Ctrl+V 粘贴截图能出预览', pasted && previewShown);
  console.log(`\n截图：out/e2e-doc-intake${process.env.E2E_SHOT_SUFFIX || ''}.png`);

} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nE2E 通过。' : `\nE2E 有 ${failed} 项没通过。`);
process.exit(failed === 0 ? 0 : 1);
