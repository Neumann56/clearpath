/**
 * 小程序代码包静态校验。
 *
 * 为什么需要：小程序只有导入微信开发者工具才会报错，而那时候给的提示
 * 往往是"渲染层错误"或者干脆白屏，看不出是哪个文件。这个脚本在命令行里
 * 把能静态发现的问题一次说完：
 *
 *   1. app.json 里声明的页面，四个文件是否都在
 *   2. tabBar 的 pagePath 是否都在 pages 里（写错就是启动直接白屏）
 *   3. usingComponents 里声明的组件，文件是否真的存在（写错是渲染层报错，页面整块空白）
 *   4. 组件目录是否四个文件齐全，js 里是否调了 Component()
 *   5. wxml 里 bind/catch 绑的事件，js 里有没有对应方法（最常见的静默失效）
 *   6. wxml 里 {{}} 引用的顶层字段，data / properties 里有没有
 *   7. wx:for 是否给了 wx:key（不给不报错，但列表更新会错位）
 *   8. js 语法（CommonJS，不能用 import/export）
 *   9. 包里有没有超 2MB 的单文件（小程序主包上限）
 *
 * 跑法：node scripts/check-miniprogram.js
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve('miniprogram');
const fails = [];
const warns = [];
const ok = (cond, msg, extra = '') => {
  if (!cond) fails.push(`${msg}${extra ? ' · ' + extra : ''}`);
  return cond;
};

if (!fs.existsSync(ROOT)) {
  console.error('没找到 miniprogram/ 目录');
  process.exit(2);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

// ---------- 1. app.json ----------
const appJson = readJson(path.join(ROOT, 'app.json'));
const pages = appJson.pages || [];
ok(pages.length > 0, 'app.json 没声明任何页面');

for (const p of pages) {
  for (const ext of ['.wxml', '.js']) {
    ok(exists(path.join(ROOT, p + ext)), `页面缺文件 ${p}${ext}`);
  }
}

// tabBar 的 pagePath 必须出现在 pages 里，否则微信直接白屏且日志里只有一行
const tabs = (appJson.tabBar && appJson.tabBar.list) || [];
ok(tabs.length >= 2 && tabs.length <= 5, 'tabBar 项数必须是 2–5', String(tabs.length));
for (const t of tabs) {
  ok(pages.includes(t.pagePath), `tabBar 指向了未声明的页面 ${t.pagePath}`);
  ok(Boolean(t.text), `tabBar 缺 text：${t.pagePath}`);
}

// ---------- 2. 组件 ----------
const COMP_DIR = path.join(ROOT, 'components');
const components = [];
if (exists(COMP_DIR)) {
  for (const ent of fs.readdirSync(COMP_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(COMP_DIR, ent.name);
    components.push({ name: ent.name, dir, base: 'components/' + ent.name + '/index' });
    for (const f of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
      ok(exists(path.join(dir, f)), `组件 ${ent.name} 缺 ${f}`);
    }
    const jp = path.join(dir, 'index.json');
    if (exists(jp)) {
      let j = {};
      try {
        j = readJson(jp);
      } catch (e) {
        fails.push(`组件 ${ent.name} 的 index.json 不是合法 JSON：${e.message}`);
      }
      ok(j.component === true, `组件 ${ent.name} 的 index.json 少了 "component": true`, '少了它会被当成页面，渲染层直接报错');
    }
  }
}

// usingComponents 里写的路径必须真的能解析到，否则页面整块空白且只说"渲染层错误"
function checkUsing(owner, uc) {
  for (const [tag, p] of Object.entries(uc || {})) {
    const rel = p.startsWith('/') ? p.slice(1) : p;
    const abs = path.join(ROOT, rel);
    ok(exists(abs + '.js'), `${owner} 的 usingComponents["${tag}"] → ${p} 找不到对应文件`);
    ok(exists(abs + '.wxml'), `${owner} 的 usingComponents["${tag}"] → ${p} 缺 .wxml`);
  }
}
checkUsing('app.json', appJson.usingComponents);
for (const p of pages) {
  const jp = path.join(ROOT, p + '.json');
  if (!exists(jp)) continue;
  let j = {};
  try {
    j = readJson(jp);
  } catch (e) {
    fails.push(`${p}.json 不是合法 JSON：${e.message}`);
    continue;
  }
  checkUsing(p + '.json', j.usingComponents);
}

// ---------- 3. 逐单元检查（页面 + 组件） ----------
const EVENT_ATTR = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-z]+)="([A-Za-z_$][\w$]*)"/g;
const MUSTACHE = /\{\{([^}]+)\}\}/g;
const LOOP_TAG = /<[a-zA-Z][\w-]*\b[^>]*\bwx:for\s*=[^>]*>/g;

function jsMethods(src) {
  const set = new Set();
  // 对象字面量里的方法简写：  name(args) {
  const re = /^\s{2,4}([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  // 也允许写在 properties 里：  name: function (
  const re2 = /^\s{2,4}([A-Za-z_$][\w$]*)\s*:\s*function/gm;
  while ((m = re2.exec(src))) set.add(m[1]);
  // 箭头函数写法
  const re3 = /^\s{2,4}([A-Za-z_$][\w$]*)\s*:\s*\(/gm;
  while ((m = re3.exec(src))) set.add(m[1]);
  return set;
}

/** 取对象字面量的第一层键。用于 data: { 和 properties: { */
function objectKeys(src, head) {
  const set = new Set();
  const i = src.indexOf(head);
  if (i < 0) return set;
  let depth = 0;
  let j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = src.slice(start + 1, j);
  const re = /(^|[\n,])\s*([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = re.exec(block))) set.add(m[2]);
  return set;
}

/** wxml 里 {{a.b}} {{a}} 这种，只取第一段；循环变量与 JS 自带全局跳过 */
const LOOP_VARS = new Set([
  'item', 'index', 'it', 'idx', 'v', 'g', 'm',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
]);

function unit(label, wxmlPath, jsPath) {
  if (!exists(wxmlPath) || !exists(jsPath)) return;
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const src = fs.readFileSync(jsPath, 'utf8');
  const methods = jsMethods(src);
  // 组件的可渲染字段来自 data + properties 两处
  const keys = new Set([...objectKeys(src, 'data: {'), ...objectKeys(src, 'properties: {')]);

  // 3.1 事件绑定必须有实现
  let m;
  EVENT_ATTR.lastIndex = 0;
  while ((m = EVENT_ATTR.exec(wxml))) {
    const name = m[2];
    ok(methods.has(name), `${label}.wxml 绑定了 ${name}，但 ${label}.js 里没有这个方法`);
  }

  // 3.2 wx:for 必须带 wx:key
  //     不给不报错，但列表更新时会按位置复用节点，出现"A 的行显示 B 的数"这种怪事。
  LOOP_TAG.lastIndex = 0;
  while ((m = LOOP_TAG.exec(wxml))) {
    if (!/\bwx:key\s*=/.test(m[0])) {
      warns.push(`${label}.wxml 有一个 wx:for 没写 wx:key：${m[0].slice(0, 60).replace(/\s+/g, ' ')}`);
    }
  }

  // 3.3 模板引用的顶层字段必须有定义
  //     判断"顶层"的办法：先把字符串字面量去掉（{{a === 'B2B'}} 里的 B2B 不是字段），
  //     再用负向后视排掉 item.xxx 这类属性访问——否则每一个 .label 都会被当成漏定义，
  //     满屏误报等于没检查。
  MUSTACHE.lastIndex = 0;
  const unknown = new Set();
  while ((m = MUSTACHE.exec(wxml))) {
    const expr = m[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const ids = expr.match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) || [];
    for (const id of ids) {
      if (LOOP_VARS.has(id)) continue;
      if (keys.has(id)) continue;
      if (wxml.includes(`wx:for-item="${id}"`)) continue;
      unknown.add(id);
    }
  }
  if (unknown.size) {
    warns.push(`${label}.wxml 引用了 data/properties 里没找到的字段：${[...unknown].join(', ')}`);
  }

  // 3.4 js 不能有 ESM 语法
  ok(!/^\s*import\s+.*from\s+['"]/m.test(src), `${label}.js 用了 import，小程序只认 require`);
  ok(!/^\s*export\s+/m.test(src), `${label}.js 用了 export，小程序只认 module.exports`);
  ok(/Page\s*\(/.test(src) || /Component\s*\(/.test(src), `${label}.js 既没调 Page() 也没调 Component()`);
}

for (const p of pages) unit(p, path.join(ROOT, p + '.wxml'), path.join(ROOT, p + '.js'));
for (const c of components) unit('components/' + c.name + '/index', path.join(c.dir, 'index.wxml'), path.join(c.dir, 'index.js'));

// ---------- 4. 语法检查（用 Node 的 parser） ----------
//     云函数目录由微信在打包时排除，不进主包，但语法照样要查
function syntaxWalk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      syntaxWalk(full);
      continue;
    }
    if (!ent.name.endsWith('.js')) continue;
    const code = fs.readFileSync(full, 'utf8');
    try {
      // 只编译不执行：能抓语法错，也不会碰到 wx.* / require 未定义
      new vm.Script(code, { filename: full });
    } catch (e) {
      fails.push(`语法错误 ${path.relative(ROOT, full)}: ${e.message}`);
    }
  }
}
syntaxWalk(ROOT);

// ---------- 5. 体积 ----------
const MAX = 2 * 1024 * 1024 * 0.8; // 主包 2MB，留 20% 余量
let total = 0;
function sizeWalk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    // 云函数不打进主包（cloudfunctionRoot），不计入
    if (ent.isDirectory()) {
      if (full === path.join(ROOT, 'cloudfunctions') || ent.name === 'node_modules') continue;
      sizeWalk(full);
      continue;
    }
    const s = fs.statSync(full).size;
    total += s;
    if (s > MAX) fails.push(`单文件过大 ${path.relative(ROOT, full)} ${(s / 1024).toFixed(0)}KB`);
  }
}
sizeWalk(ROOT);
ok(total < 2 * 1024 * 1024, `包体积超过 2MB（${(total / 1024).toFixed(0)}KB）`);

// ---------- 6. 模式自检 ----------
//     'proxy' 档没填环境 ID 是最容易犯的错：代码全对，一打开就说"还没填环境 ID"。
const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const modeM = cfg.match(/const MODE\s*=\s*'([a-z]+)'/);
const mode = modeM ? modeM[1] : '?';
ok(['direct', 'proxy', 'mock'].includes(mode), 'config.js 的 MODE 只能是 direct / proxy / mock', mode);
if (mode === 'proxy' && /envId:\s*''/.test(cfg)) {
  warns.push("MODE 是 'proxy'，但 CLOUD.envId 还是空的——真机上会一条请求都发不出去");
}
if (mode === 'mock') {
  warns.push("MODE 是 'mock'：所有数字都是样例。提审前记得改回 'proxy' 或 'direct'");
}

// ---------- 输出 ----------
console.log(
  `页面 ${pages.length} 个 · 组件 ${components.length} 个 · tabBar ${tabs.length} 项 · 通道 ${mode} · 包体积 ${(total / 1024).toFixed(0)}KB`
);

if (warns.length) {
  console.log('');
  for (const w of warns) console.log(`! ${w}`);
}

if (fails.length) {
  console.log('');
  for (const f of fails) console.log(`✗ ${f}`);
  console.error(`\n${fails.length} 项未通过`);
  process.exit(1);
}

console.log(`\n✓ 静态校验通过（${warns.length} 条提示需人工确认）`);
