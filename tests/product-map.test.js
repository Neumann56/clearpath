// 功能地图的守门测试。
//
// 这里最容易出的两类错，都不是"写不出来"，而是"写错了却看不出来"：
// 1. 指路指到不存在的路径 / 参数名拼错 → 用户点了 404，或者进到页面发现参数没生效
// 2. 白名单开太松 → 模型输出 javascript: 或 //evil.com，esc 挡不住，变成 XSS
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROUTES, ROUTE_RULES, matchRoutes, routeBlock, isSafeChatLink } from '../public/js/product-map.js';
import { generalSystemPrompt, GENERAL_SYSTEM_PROMPT } from '../public/js/assistant-prompt.js';

test('功能地图：八类入口都在，每条有标题、关键词、正文', () => {
  assert.ok(ROUTES.length >= 8, `入口应至少 8 个，实际 ${ROUTES.length}`);
  for (const r of ROUTES) {
    assert.ok(r.id && r.title, `条目缺 id 或 title`);
    assert.ok(Array.isArray(r.keys) && r.keys.length >= 4, `${r.id} 关键词太少，问不到`);
    assert.ok(r.text && r.text.length >= 60, `${r.id} 正文太短，说不清`);
    assert.ok(r.text.length <= 400, `${r.id} 正文 ${r.text.length} 字，超预算`);
  }
});

test('红线：正文不许出现美元金额、内部字段名、结果承诺', () => {
  const banned = ['landedCost', 'cashRequired', 'dutyTotal', 'taxTotal', '包税', '保证清关', '一定能进', '总计'];
  const bad = [];
  for (const r of ROUTES) {
    if (/\$\s*\d|\bUSD\b/.test(r.text)) bad.push(`${r.id} 含货币金额`);
    for (const w of banned) if (r.text.includes(w)) bad.push(`${r.id} 含「${w}」`);
  }
  assert.deepEqual(bad, [], `功能地图混进了不该给客服看的东西：\n${bad.join('\n')}`);
});

test('指路规矩：七个表单参数名一个都不能拼错', () => {
  // 拼错一个字母，链接就是死的，而且用户点进去才发现——那时他已经信了
  for (const p of ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate']) {
    assert.ok(ROUTE_RULES.includes(`${p}=`), `指路规矩里缺参数名 ${p}=`);
  }
  assert.match(ROUTE_RULES, /一次只给一个链接/, '必须限制一次只给一个，否则回答变目录');
  assert.match(ROUTE_RULES, /不许猜着填|绝对不许猜/, '必须禁止猜参数——填错比不填更糟');
});

test('指路规矩里给的示例链接，必须真的通过白名单', () => {
  const links = [...ROUTE_RULES.matchAll(/\]\((\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, '规矩里至少要有一个示例链接，模型才有样子可学');
  for (const l of links) {
    assert.ok(isSafeChatLink(l), `示例链接自己都过不了白名单：${l}`);
  }
});

test('白名单：站内页面放行', () => {
  const good = [
    '/quote/new',
    '/quote/batch',
    '/quote/confirm',
    '/reports',
    '/calendar',
    '/demo/unresolved',
    '/demo/calibration',
    '/quote/new?country=VN&hsCode=610910&fob=48000&freight=3200&qty=500&channel=B2B&declarationDate=2026-10-25',
    `/quote/4aa69c90-a82e-4b22-b61c-9d39ede9fc52/report`,
  ];
  for (const p of good) assert.ok(isSafeChatLink(p), `应该放行：${p}`);
});

test('白名单：协议相对、伪协议、外站、路径穿越全部拦掉', () => {
  // 这几条是真正的攻击面。esc 只处理 & < > " '，对 href 里这些字符完全无效。
  const bad = [
    '//evil.com',
    '//evil.com/quote/new',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '/quote/new"onmouseover="alert(1)',
    'http://evil.com',
    'https://evil.com/quote/new',
    '/admin/params',
    '/admin/unresolved',
    '/quote/../../etc/passwd',
    '/quote/new?x=<script>',
    '/quote/new#hash',
    '',
    null,
    undefined,
  ];
  for (const p of bad) assert.equal(isSafeChatLink(p), false, `必须拦掉：${String(p)}`);
});

test('命中：问法不同也能落到对的页面', () => {
  assert.ok(matchRoutes('我有很多票要一起算').includes('batch'));
  assert.ok(matchRoutes('一次能导入多少行').includes('batch'));
  assert.ok(matchRoutes('待核项是什么，谁负责').includes('unresolved'));
  assert.ok(matchRoutes('报告这么长怎么看').includes('report15'));
  assert.ok(matchRoutes('这东西算得准不准').includes('calibration'));
  assert.ok(matchRoutes('政策什么时候生效').includes('calendar'));
  assert.ok(matchRoutes('上次算的那票找不到了').includes('reports'));
  assert.ok(matchRoutes('能不能直接拿去报关').includes('limits'));
});

test('命中：一次只给一条，别把回答写成目录', () => {
  const q = '我有很多票要一起算，报告怎么看，待核又是什么';
  assert.equal(matchRoutes(q).length, 1, '多条同时命中时仍然只给一条');
});

test('不问就不注入：无关问题 prompt 长度严格不变', () => {
  // 这里只能放两头都不沾的问题——「客户一直压价怎么办」会命中外贸常识包，
  // 拿它当"无关"测，测的其实是另一条链路。
  for (const q of ['今天天气怎么样', '你是谁', '现在几点了']) {
    const { prompt, ids } = generalSystemPrompt(q, []);
    assert.equal(prompt, GENERAL_SYSTEM_PROMPT, `${q} 不该改变 prompt`);
    assert.deepEqual(ids, []);
  }
});

test('注入有上限：两块知识同时命中也不失控', () => {
  const base = GENERAL_SYSTEM_PROMPT.length;
  const { prompt } = generalSystemPrompt('新客户第一单要给账期吗，我这票怎么算，报告又怎么看', []);
  assert.ok(prompt.length > base, '这句应该命中并注入');
  assert.ok(prompt.length <= 3000, `注入后 ${prompt.length} 字，超上限 3000`);
});

test('产品地图里的路径必须在服务端真实存在', () => {
  // 指路指到 404，比不指路更伤——用户会认为整个产品是坏的
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const must = ['/quote/new', '/quote/batch', '/quote/confirm', '/reports', '/calendar', '/demo/unresolved', '/demo/calibration'];
  for (const p of must) {
    assert.ok(server.includes(`'${p}'`), `服务端没有路由 ${p}，但功能地图在让用户去`);
  }
});
