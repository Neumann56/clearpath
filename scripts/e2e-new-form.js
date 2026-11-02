/**
 * 录入页交互回归：复现"填完了但按钮是灰的"那个卡点，并确认现在能自己看出差在哪。
 *
 * 跑法：node scripts/e2e-new-form.js [--headed]
 * 依赖：本机 Edge/Chrome + 托管工作区里的 puppeteer-core（不给项目加依赖）
 */
import fs from 'node:fs';
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
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(`${BASE}/quote/new`, { waitUntil: 'networkidle0' });

  const read = () =>
    page.evaluate(() => ({
      hint: document.getElementById('formHint').textContent.trim(),
      hintRed: document.getElementById('formHint').classList.contains('warn'),
      disabled: document.getElementById('submitBtn').disabled,
      invalid: [...document.querySelectorAll('.field.invalid label')].map((l) => l.textContent.replace('*', '').trim()),
      errors: [...document.querySelectorAll('.field .err')].map((e) => e.textContent.trim()),
      decl: document.querySelector('[name=declarationDate]').value,
    }));

  const setVal = async (name, value) => {
    await page.evaluate(
      (n, v) => {
        const el = document.querySelector(`[name=${n}]`);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      name,
      value
    );
    await sleep(120);
  };

  // 1. 一进页面：空表单，差项数应与"真正空着的必填栏"一致（申报日有默认值，不算差）
  const blank = await page.evaluate(() => {
    const names = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate'];
    return names.filter((n) => !String(document.querySelector(`[name=${n}]`).value || '').trim()).length;
  });
  let s = await read();
  const shown = Number((/还差 (\d+) 项/.exec(s.hint) || [])[1] || -1);
  ok('初始差项数 = 实际空着的必填栏', shown === blank, `页面说 ${shown}，实际空 ${blank} 项`);
  ok('初始按钮禁用', s.disabled === true);
  ok('空栏不刷红（只有提示条变色）', s.invalid.length === 0, `红框 ${s.invalid.length} 个`);

  // 1.5 品类下拉：点一下就要展开。
  // 原先用原生 <datalist>，点框不展开、要打一个字才冒出来，被报过"下拉框点不开"。
  const readCombo = () =>
    page.evaluate(() => {
      const list = document.getElementById('hsComboList');
      const shownItems = [...list.querySelectorAll('li[data-hs]')].filter((li) => !li.hidden);
      return {
        hidden: list.hidden,
        h: Math.round(list.getBoundingClientRect().height),
        total: list.querySelectorAll('li[data-hs]').length,
        shown: shownItems.length,
        names: shownItems.map((li) => li.dataset.name),
        value: document.getElementById('hsCodeInput').value,
        open: document.querySelector('.combo').dataset.open,
      };
    });

  await page.click('#hsCodeInput');
  await sleep(150);
  let c = await readCombo();
  ok('点一下 HS 输入框就展开（不用先打字）', c.hidden === false && c.h > 20, `hidden=${c.hidden} 高=${c.h}px`);
  ok('展开的是整个品类表', c.shown === c.total && c.total >= 6, `显示 ${c.shown}/${c.total}`);

  // 打字能筛：写"光"只剩光伏
  await page.type('#hsCodeInput', '光');
  await sleep(200);
  c = await readCombo();
  ok('打字能筛品类', c.shown === 1 && /光伏/.test(c.names[0] || ''), `${c.shown} 条：${c.names.join('/')}`);
  await page.keyboard.press('Escape');
  await sleep(100);

  // 键盘：↓ 开列表 + Enter 选中
  await page.click('#hsCodeInput');
  await page.evaluate(() => {
    const el = document.getElementById('hsCodeInput');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    el.focus();
  });
  await sleep(120);
  await page.click('.combo-btn');
  await sleep(120);
  c = await readCombo();
  ok('点右箭头也能展开', c.hidden === false && c.h > 20, `hidden=${c.hidden}`);
  await page.click('#hsComboList li[data-hs="870891"]');
  await sleep(250);
  c = await readCombo();
  ok('点品类填成编码（不是填品名）', c.value === '8708.91', c.value);
  ok('选中后自动收起', c.hidden === true && c.open === '0');
  s = await read();
  ok('选完 HS 那一栏不再报错', !s.errors.some((e) => e.includes('HS')), s.errors.join(' | ').slice(0, 80));

  // 点页面空白处要能关掉，否则挡住下面的栏
  await page.click('#hsCodeInput');
  await sleep(100);
  await page.click('h2');
  await sleep(120);
  c = await readCombo();
  ok('点别处能收起', c.hidden === true);

  // 键盘：↓ 展开、再 ↓ 选中第一条、Enter 落定（不摸鼠标也能挑）
  await page.evaluate(() => {
    const el = document.getElementById('hsCodeInput');
    el.value = '';
    el.focus();
  });
  await page.keyboard.press('ArrowDown');
  await sleep(140);
  await page.keyboard.press('ArrowDown');
  await sleep(120);
  await page.keyboard.press('Enter');
  await sleep(220);
  c = await readCombo();
  ok('键盘也能选中品类', /^\d{4}\.\d{2}$/.test(c.value) && c.hidden === true, c.value);


  // 2. 复现原始卡点：品名 + 出口日晚于申报日
  await setVal('country', 'HU');
  await setVal('hsCode', '光伏组件');
  await setVal('fob', '48000');
  await setVal('freight', '3200');
  await setVal('qty', '500');
  await page.click('.seg button[data-v=B2B]');
  await setVal('declarationDate', '2026-10-24');
  await setVal('exportDate', '2026-10-25');
  await sleep(300);

  s = await read();
  ok('品名"光伏组件"不再被拦', !s.errors.some((e) => e.includes('HS')), s.errors.join(' | ').slice(0, 80));
  ok('只差 1 项（日期）', s.hint.includes('还差 1 项'), s.hint.slice(0, 60));
  ok('差项说清了是哪项', /出口日期/.test(s.hint), s.hint.slice(0, 80));
  ok('差项说清了跟哪个日子比', /晚于申报日 2026-10-24/.test(s.hint), s.hint.slice(0, 120));
  ok('提示条标红', s.hintRed === true);
  ok('出口日期那一栏标红', s.invalid.some((x) => x.includes('出口日期')), s.invalid.join(','));

  // 3. 把日期改对 → 按钮亮
  await setVal('exportDate', '2026-10-20');
  await sleep(300);
  s = await read();
  ok('改对日期后按钮可点', s.disabled === false, s.hint);
  ok('改对后提示条转正常', s.hintRed === false && s.hint.includes('必填已齐'), s.hint);

  // 4. 认不出的品名要给出已入库清单，不能只说格式不对
  await setVal('hsCode', '无人机');
  await sleep(350);
  s = await read();
  ok('认不出的品名被拦', s.disabled === true);
  ok('告诉用户已入库哪些品类', /光伏电池组件|机动车辆零件/.test(s.errors.join(' ')), s.errors.join(' | ').slice(0, 100));

  // 5. 预检被后端拒绝时，必须留在本页说清原因，不能跳到确认页去报"没有找到草稿"
  await setVal('hsCode', '999999');
  await sleep(350);
  await page.click('#submitBtn');
  await sleep(1200);
  s = await read();
  ok('预检没过仍留在录入页', page.url().includes('/quote/new'), page.url());
  ok('说出了真实原因（税率没入库）', /税率还没入库/.test(s.hint), s.hint.slice(0, 90));
  ok('预检没过时按钮可再点', s.disabled === false);

  // 6. 填回品名，点下一步 → 应进确认页
  await setVal('hsCode', '光伏组件');
  await sleep(350);
  await page.click('#submitBtn');
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 8000 }).catch(() => {});
  ok('点下一步能进确认页', page.url().includes('/quote/confirm'), page.url());

  const confirmText = await page.evaluate(() => document.body.innerText);
  ok('确认页拿到了数', /8541\.43/.test(confirmText), confirmText.slice(0, 60).replace(/\n/g, ' '));

  // 7. 新标签直接打开确认页：草稿只活在原标签，要说清怎么进来，而不是让人以为是产品坏了
  const p2 = await (await browser.newPage());
  await p2.goto(`${BASE}/quote/confirm`, { waitUntil: 'networkidle0' });
  const t2 = await p2.evaluate(() => document.body.innerText);
  ok('直接打开确认页会说清来路', /从「新预演」点「下一步」进来/.test(t2), t2.replace(/\n/g, ' ').slice(0, 70));
  ok('不再只说"没有找到草稿"', !/^[^]{0,80}没有找到草稿/.test(t2.replace(/\n/g, ' ')));
  await p2.close();

  ok('全程无 JS 异常', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 120));

  if (headed) await sleep(1500);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
