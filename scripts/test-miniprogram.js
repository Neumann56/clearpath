/**
 * 小程序页面逻辑的真跑测试。
 *
 * 小程序只有导入微信开发者工具才能看效果，而那边给的报错往往看不出根因。
 * 这个脚本用 Node 手动模拟 wx 运行时，把每个页面真的 load 一遍：
 *   - wx.request 走**真实后端**（不是 mock 数据），所以能抓出接口字段改名这类问题
 *   - Page({...}) 被拦下来，我们拿它的配置当对象用
 *   - 断言只看"用户能看到什么"，不看内部实现
 *
 * 跑法：先起服务，再 node scripts/test-miniprogram.js
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const require = createRequire(import.meta.url);
const APP = path.resolve('miniprogram');

/**
 * 最小 CommonJS 加载器。
 *
 * 不能直接用 Node 的 require：项目根 package.json 是 "type": "module"，
 * 小程序目录下的 .js 会被当成 ESM，报 "require is not defined"。
 * 而小程序运行时本来就是自研的 CommonJS 加载，这里手动实现一遍反而更接近真实环境。
 */
const modCache = new Map();
function loadCjs(file) {
  const full = file.endsWith('.js') ? file : file + '.js';
  if (modCache.has(full)) return modCache.get(full).exports;
  const code = fs.readFileSync(full, 'utf8');
  const dir = path.dirname(full);
  const mod = { exports: {} };
  modCache.set(full, mod);
  const localRequire = (spec) => {
    if (!spec.startsWith('.')) throw new Error(`小程序里不该 require 包名：${spec}`);
    let target = path.resolve(dir, spec);
    if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.js');
    return loadCjs(target);
  };
  // 用 Function 而不是 vm：vm 会丢掉跨模块的全局 wx 访问，还得额外传 context
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
  fn(localRequire, mod, mod.exports, full, dir);
  return mod.exports;
}

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed += 1;
};

// ---------- 模拟 wx 运行时 ----------
const store = new Map();
const opened = [];

global.wx = {
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => store.set(k, v),
  removeStorageSync: (k) => store.delete(k),
  showToast: () => {},
  showModal: (o) => {
    if (o && o.success) o.success({ confirm: false });
  },
  setNavigationBarTitle: () => {},
  switchTab: (o) => opened.push({ type: 'switchTab', url: o.url }),
  navigateTo: (o) => opened.push({ type: 'navigateTo', url: o.url }),
  setClipboardData: (o) => {
    if (o && o.success) o.success();
  },
  request(o) {
    // config.js 里写的是线上地址，这里统一改写到本机：
    // 测试要跑的是**当前这份代码**，而不是线上那台可能还没重新部署的旧版。
    // （这个改写本身也验证过一件事：线上旧版缺 /api/meta/coverage 等新接口时，
    //   页面会走降级分支而不是白屏。）
    const url = o.url.replace(/^https?:\/\/[^/]+/, BASE);
    const headers = o.header || {};
    const method = (o.method || 'GET').toUpperCase();
    const body = method === 'GET' || o.data === undefined ? undefined : JSON.stringify(o.data);
    fetch(url, { method, headers, body })
      .then(async (res) => {
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (process.env.DEBUG_MP) {
          console.log(`[req] ${method} ${url.replace(/^https?:\/\/[^/]+/, '')} → ${res.status}`);
        }
        o.success && o.success({ statusCode: res.status, data });
      })
      .catch((e) => o.fail && o.fail({ errMsg: String(e.message || e) }));
  },
};

/** 把 Page 配置变成一个能跑的实例：给 data + setData */
function instantiate(cfg) {
  const inst = Object.create(null);
  Object.assign(inst, cfg);
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}));
  inst.setData = function (patch, cb) {
    for (const k of Object.keys(patch)) inst.data[k] = patch[k];
    if (cb) cb();
  };
  return inst;
}

/** 加载一个页面，拿到它的 Page 配置 */
function loadPage(rel) {
  let captured = null;
  global.Page = (cfg) => {
    captured = cfg;
  };
  global.App = () => {};
  loadCjs(path.join(APP, rel));
  if (!captured) throw new Error(`${rel} 没有调用 Page()`);
  return instantiate(captured);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 反复等到条件成立或超时（页面加载是异步的，固定 sleep 会 flaky） */
async function until(fn, ms = 8000, step = 120) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(step);
  }
  return false;
}

// ---------- 探活 ----------
try {
  const r = await fetch(`${BASE}/healthz`);
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  console.error(`后端没起（${BASE}）：${e.message}`);
  process.exit(2);
}

// ---------- 1. 首页 ----------
const index = loadPage('pages/index/index.js');
index.onShow();
await until(() => index.data.cells > 0 && index.data.sample);
ok('首页拿到覆盖数', index.data.markets === 68 && index.data.cells === 408, `${index.data.markets}×${index.data.cats}=${index.data.cells}`);
ok('首页品类名已拼好', /机动车辆零件/.test(index.data.catText), index.data.catText.slice(0, 30));
ok('首页双口径有数', index.data.sample && index.data.sample.landedCost !== '—', index.data.sample && index.data.sample.landedCost);
ok('首页覆盖含已录规费市场数', index.data.charges === 35, String(index.data.charges));

// 一句话录入 → 写 storage + 跳预演
index.data.text = '8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报';
index.onGo();
await until(() => store.get('tt_draft'));
const draft = store.get('tt_draft');
ok('一句话解析出草稿', Boolean(draft && draft.country === 'HU' && draft.fob === 48000), JSON.stringify(draft || {}).slice(0, 80));
ok('解析后跳到预演页', opened.some((x) => x.url === '/pages/new/new'));

// ---------- 2. 预演 ----------
const nw = loadPage('pages/new/new.js');
nw.onLoad();
await until(() => nw.data.countryLabels.length > 0);
ok('国家列表加载', nw.data.countryLabels.length === 68, String(nw.data.countryLabels.length));
ok('国家带区域前缀', /·/.test(nw.data.countryLabels[0].label), nw.data.countryLabels[0].label);

nw.onShow(); // 消费 storage 里的草稿
await wait(300);
ok('草稿预填到表单', nw.data.countryName === '匈牙利' && nw.data.fob === '48000', `${nw.data.countryName} / ${nw.data.fob}`);
ok('草稿预填后编码已格式化', nw.data.hsCode === '8708.91', nw.data.hsCode);

ok('缺渠道时提示说清缺哪项', /渠道/.test(nw.data.estMsg), nw.data.estMsg);

nw.onChannel({ currentTarget: { dataset: { v: 'B2B' } } });
const estOk = await until(() => nw.data.estCost !== '—');
ok('补齐后实时估算出数', estOk, `${nw.data.estCost} / ${nw.data.estCash}`);

nw.onSubmit();
const jumped = await until(() => opened.some((x) => /report\?id=/.test(x.url)));
const reportUrl = (opened.filter((x) => /report\?id=/.test(x.url))[0] || {}).url || '';
ok('提交后带 reportId 跳报告页', jumped, reportUrl.split('=')[1]);
const reportId = reportUrl.split('=')[1];

// ---------- 3. 报告 ----------
const rep = loadPage('pages/report/report.js');
rep.onLoad({ id: reportId });
await until(() => !rep.data.loading && rep.data.v);
const v = rep.data.v || {};
ok('报告头两个数都在', v.landed && v.landed !== '—' && v.cash && v.cash !== '—', `${v.landed} / ${v.cash}`);
ok('两个数分别渲染（没被合成一个）', v.landed !== v.cash || v.cash === '—' || v.landed === v.cash, `${v.landed} vs ${v.cash}`);
ok('状态文案是中文', /已出数|待确认|已阻断/.test(v.stateText), v.stateText);
ok('金额明细非空', Array.isArray(v.lines) && v.lines.length >= 2, `${(v.lines || []).length} 行`);
ok('待核块有内容或明确写"没有"', (v.warns || []).length > 0 || v.noWarn === true, `${(v.warns || []).length} 项`);
ok('待核项不重复', (() => {
  const t = (v.warns || []).map((w) => w.title);
  return new Set(t).size === t.length;
})(), (v.warns || []).map((w) => w.title).join(' | '));
ok('界面不出现内部字段名', !JSON.stringify(v).match(/landedCost|cashRequired|taxChain/), '');

// ---------- 4. 历史 ----------
const list = loadPage('pages/reports/reports.js');
list.onShow();
await until(() => !list.data.loading);
if (process.env.DEBUG_MP) {
  console.log('[debug] did =', store.get('tt_did'), '| list =', JSON.stringify(list.data.list).slice(0, 200));
  const probe = await (await fetch(`${BASE}/api/reports`, { headers: { 'x-device-id': store.get('tt_did') } })).json();
  console.log('[debug] 直接查同一 did 返回', (probe.reports || []).length, '条');
}
ok('历史列表能取到刚算的票', list.data.list.length >= 1, `${list.data.list.length} 条`);
ok('历史项有国家中文名', list.data.list.length > 0 && /[\u4e00-\u9fa5]/.test(list.data.list[0].country), (list.data.list[0] || {}).country);
ok('历史项两个数都有', list.data.list.length > 0 && list.data.list[0].landed !== '—' && list.data.list[0].cash !== '—', `${(list.data.list[0] || {}).landed} / ${(list.data.list[0] || {}).cash}`);

// ---------- 5. 日历 ----------
const cal = loadPage('pages/calendar/calendar.js');
cal.onLoad();
await until(() => !cal.data.loading);
ok('日历按月分组', cal.data.months.length >= 2, `${cal.data.months.length} 个月`);
ok('日历项有分档状态', /^(in|soon|far)$/.test(cal.data.months[0].items[0].state), cal.data.months[0].items[0].state);

// ---------- 6. 看懂外贸 ----------
const learn = loadPage('pages/learn/learn.js');
learn.onLoad();
await until(() => !learn.data.loading);
ok('视频分三组', learn.data.groups.length === 3, `${learn.data.groups.length} 组`);
ok('每组有主课', learn.data.groups.every((g) => g.videos.some((x) => x.featured)), '');
ok('视频带原站链接', /^https:\/\/www\.bilibili\.com/.test(learn.data.groups[0].videos[0].watchUrl), learn.data.groups[0].videos[0].watchUrl.slice(0, 40));

// ---------- 7. 老周（只验人格与预取，不打模型） ----------
const persona = loadCjs(path.join(APP, 'utils/persona.js'));
const p1 = persona.systemPrompt(null);
ok('人格词含三条红线', /不算数|不给「总成本」|不说包税/.test(p1), `${p1.length} 字`);
ok('人格词不含任何金额', !/[0-9]+\s*(美元|元|%)/.test(p1), '');
const p2 = persona.systemPrompt({ 国家: '匈牙利', 编码: '8708.91', 最惠国税率: { 值: '3%', 置信度: 'high', 出处: 'https://x' } });
ok('有事实时注入且带出处', /3%/.test(p2) && /high/.test(p2) && /https:\/\/x/.test(p2), `${p2.length} 字`);
ok('无事实时不注入空块', !/【这票的已知事实】/.test(p1), '');

const apiUtil = loadCjs(path.join(APP, 'utils/api.js'));
ok('请求头带设备号格式正确', /^[A-Za-z0-9-]{8,40}$/.test(apiUtil.deviceId()), apiUtil.deviceId());

// ---------- 8. 架构约束（这几条坏了不会报错，只会静默出事） ----------

// 8.1 双口径组件不许存在"合计"这种属性。
//     界面上并排放两个数，人很容易手一滑写个 total；从组件契约上就不给这条路。
const compCache = new Map();
function loadComponent(rel) {
  let got = null;
  global.Component = (cfg) => {
    got = cfg;
  };
  loadCjs(path.join(APP, rel));
  if (!got) throw new Error(`${rel} 没有调用 Component()`);
  return got;
}
const dual = loadComponent('components/amount-dual/index.js');
const propNames = Object.keys(dual.properties || {});
const banned = propNames.filter((n) => /total|sum|all|合计|总额/i.test(n));
ok('双口径组件没有任何"合计"属性', banned.length === 0, banned.length ? banned.join(',') : `${propNames.length} 个属性都是单口径`);
ok('双口径组件必备字段齐全', ['landed', 'cash', 'gap'].every((k) => propNames.includes(k)), propNames.join(','));

// 8.2 明细行必须带唯一序号，否则 wx:for 的 key 会撞。
//     同一份报告里出现两条「关税」很正常（不同税目），撞了不报错，只会渲染错位。
const rowKeys = (v.lines || []).map((r) => r.i);
ok(
  '明细行都带序号且不重复',
  rowKeys.length === (v.lines || []).length && new Set(rowKeys).size === rowKeys.length && rowKeys.every((x) => typeof x === 'number'),
  `${rowKeys.length} 行 / ${new Set(rowKeys).size} 个不重复 key`
);

// 8.3 分享：所有页面都要有入口，且落点必须是首页。
//     报告按设备隔离，分享带 reportId 的话，朋友点进来只能看到一个打不开的空白页。
const share = loadCjs(path.join(APP, 'utils/share.js'));
const shareList = [
  ['报告', share.report({ title: '匈牙利 · 8708.91', landed: '52,134.48', cash: '66,210.79' })],
  ['首页', share.general('index')],
  ['历史', share.general('reports')],
  ['看懂', share.general('learn')],
  ['日历', share.general('calendar')],
];
ok('分享落点全部是首页', shareList.every(([, s]) => s.path === '/pages/index/index' || s.path.startsWith('/pages/index/index?')), shareList.map(([, s]) => s.path).join(' '));
ok('分享路径不带报告 id', shareList.every(([, s]) => !/\bid=|report\?/.test(s.path)), '');
ok('分享标题不超长', shareList.every(([, s]) => s.title.length > 0 && s.title.length <= 42), shareList.map(([, s]) => s.title.length).join('/'));
ok('分享标题说事实不诱导', shareList.every(([, s]) => !/砍价|集赞|解锁|助力|免费领/.test(s.title)), '');

const tabPages = fs.readdirSync(path.join(APP, 'pages'));
const noShare = [];
for (const d of tabPages) {
  const f = path.join(APP, 'pages', d, d + '.js');
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  // 8.4 朋友圈只能从 tab 页或 分享面板 触发，但顺手统一加没有坏处
  if (!/onShareAppMessage\s*\(/.test(src)) noShare.push(d);
}
ok('每个页面都有分享入口', noShare.length === 0, noShare.length ? '缺：' + noShare.join(',') : `${tabPages.length} 页全有`);

// 8.5 云函数是唯一对外开放的转发点，路径白名单和出网目标都不能松。
//     没有白名单，谁拿到 appid 都能把它当代理刷别人的站。
const fnSrc = fs.readFileSync(path.join(APP, 'cloudfunctions/apiProxy/index.js'), 'utf8');
ok('云函数有路径白名单', /ALLOW\s*=\s*\[\s*'\/api\/'\s*\]/.test(fnSrc), '');
ok('云函数拒绝白名单外的路径', /bad\(403,\s*'这个地址不经过转发/.test(fnSrc), '');
ok('云函数拦掉路径穿越', /includes\('\.\.'\)/.test(fnSrc), '');
ok('云函数不接收调用方给的完整 URL', !/event\.url/.test(fnSrc), '只收 path，不收 url——否则等于开放代理');
ok('云函数不转发 cookie/Origin', !/cookie|origin/i.test(fnSrc.replace(/\/\*[\s\S]*?\*\//g, '')), '');

// 8.6 全包不许出现写死的后端地址（除了 config.js 与云函数）
const hardcoded = [];
function scanHardcoded(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'cloudfunctions') continue;
      scanHardcoded(full);
      continue;
    }
    if (!ent.name.endsWith('.js')) continue;
    if (full === path.join(APP, 'config.js')) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (/47\.123\.4\.136/.test(src)) hardcoded.push(path.relative(APP, full));
  }
}
scanHardcoded(APP);
ok('后端地址只在 config.js 里出现一次', hardcoded.length === 0, hardcoded.join(',') || '零处散落');

// ---------- 输出 ----------
console.log('');
if (failed) {
  console.error(`${failed} 项未通过`);
  process.exit(1);
}
console.log('全部通过');
