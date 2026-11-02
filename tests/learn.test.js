// 「看懂外贸」视频栏目的守门测试。
//
// 这个栏目的风险跟计税引擎不一样：算错数会被测试抓到，而"栏目里混进一句
// 保证能进、或者混进一条重复/失效的视频"没人会发现。所以这里钉四件事：
//
// 1. 内容坏了不许静默：文件缺失、JSON 烂了、单条缺字段，都要能说出原因，
//    而且单条坏不能拖垮整个栏目（否则一个手误就让栏目变空白，看着像"没内容"）
// 2. 每条视频必须真的可核验：编号格式合法、不重复、时长大于零
// 3. 编排假设要成立：每组至少 2 条（不然通栏主课会把唯一那条吃掉）、每组至多 1 条主课
// 4. 文案要过同一道红线：不出现结果承诺、不出现内部字段名、不出现跨口径合计
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadLearnContent, durationText, playerUrl, watchUrl, playText } from '../lib/learn.js';
import { learnPage } from '../lib/render.js';

const REAL = path.join(process.cwd(), 'data', 'content', 'videos.json');

function loadRaw() {
  return JSON.parse(fs.readFileSync(REAL, 'utf8'));
}

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tantu-learn-'));
  const f = path.join(dir, 'videos.json');
  if (content !== undefined) fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return f;
}

const content = loadLearnContent(REAL);

test('真实内容文件能加载，且三个分组都有内容', () => {
  assert.equal(content.ok, true, `加载失败：${content.reason}`);
  assert.equal(content.groups.length, 3, `应有 3 个分组，实际 ${content.groups.length}`);
  assert.ok(content.videos.length >= 10, `视频太少：${content.videos.length}`);
  assert.deepEqual(content.dropped, [], `有内容没通过校验：${JSON.stringify(content.dropped)}`);
});

test('每条视频的编号合法且不重复', () => {
  const seen = new Set();
  for (const v of content.videos) {
    assert.match(v.bvid, /^BV[0-9A-Za-z]{10}$/, `${v.id} 的编号不对：${v.bvid}`);
    assert.equal(seen.has(v.bvid), false, `${v.id} 与其他条目重复收录了 ${v.bvid}`);
    seen.add(v.bvid);
  }
});

test('FOB / CIF 这类核心术语必须有覆盖', () => {
  const all = content.videos.map((v) => `${v.title} ${(v.tags || []).join(' ')}`).join(' ');
  for (const kw of ['FOB', 'CIF', 'CFR', 'EXW', 'DDP']) {
    assert.ok(all.includes(kw), `栏目里没有覆盖 ${kw} 的视频`);
  }
});

test('每组至少 2 条，且至多 1 条主课', () => {
  for (const g of content.groups) {
    assert.ok(g.videos.length >= 2, `${g.title} 只有 ${g.videos.length} 条，通栏主课会把唯一那条吃掉`);
    const feat = g.videos.filter((v) => v.featured);
    assert.ok(feat.length <= 1, `${g.title} 有 ${feat.length} 条主课，会排成两块通栏`);
  }
});

test('每条都有实质的「看完能答上」，不是占位符', () => {
  for (const v of content.videos) {
    assert.ok(v.takeaway.length >= 12, `${v.id} 的一句话太短：${v.takeaway}`);
    assert.ok(v.takeaway.length <= 120, `${v.id} 的一句话 ${v.takeaway.length} 字，卡片放不下`);
    // hook 允许为空串（有意留空），但不允许是 undefined——那说明字段被漏写了
    assert.notEqual(v.hook, undefined, `${v.id} 缺 hook 字段（不需要就给空串）`);
  }
});

test('文案红线：不出现结果承诺、内部字段名、跨口径合计', () => {
  const banned = [
    '包税', '双清包税', '保证清关', '保证通过', '一定能进',
    'landedCost', 'cashRequired', 'dutyTotal', 'taxTotal',
    '最终税费为', '必定适用', '一定适用',
  ];
  const texts = [];
  for (const g of content.groups) texts.push([g.title, g.sub, g.why].filter(Boolean).join(' '));
  for (const v of content.videos) texts.push([v.title, v.takeaway, v.hook, (v.tags || []).join(' ')].join(' '));
  for (const t of texts) {
    for (const w of banned) assert.equal(t.includes(w), false, `文案里出现了「${w}」：${t.slice(0, 60)}`);
    assert.equal(/总计[^。]{0,16}美元/.test(t), false, `疑似跨口径合计：${t.slice(0, 60)}`);
  }
});

test('文件不存在时降级为「没放进来」，而不是抛错', () => {
  const out = loadLearnContent(tmpFile(undefined));
  assert.equal(out.ok, false);
  assert.match(out.reason, /放进来|导入/);
  assert.deepEqual(out.videos, []);
});

test('JSON 坏掉时给出与「缺文件」不同的原因', () => {
  const out = loadLearnContent(tmpFile('{ 这不是 json'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /格式/);
  assert.doesNotMatch(out.reason, /放进来/);
});

test('单条缺字段只摘掉这一条，不拖垮整个栏目', () => {
  const raw = loadRaw();
  raw.videos.push({ id: 'broken', bvid: 'BV1Qi4y147B7', title: '', author: 'x', seconds: 100, group: 'price', takeaway: '一句话' });
  raw.videos.push({ ...raw.videos[0], id: 'dup-bvid', title: '重复编号的另一条' });
  const out = loadLearnContent(tmpFile(raw));
  assert.equal(out.ok, true);
  assert.equal(out.dropped.length, 2, `应摘掉 2 条，实际 ${JSON.stringify(out.dropped)}`);
  assert.equal(out.videos.some((v) => v.id === 'broken'), false);
  assert.equal(out.videos.some((v) => v.id === 'dup-bvid'), false);
});

test('分组名写错的那条会被摘掉并说明原因', () => {
  const raw = loadRaw();
  raw.videos.push({ ...raw.videos[0], id: 'wrong-group', bvid: 'BV1xxxxxxx01', group: '不存在的组' });
  const out = loadLearnContent(tmpFile(raw));
  assert.equal(out.videos.some((v) => v.id === 'wrong-group'), false);
  assert.match(out.dropped.map((d) => d.why).join(' '), /分组/);
});

test('秒数格式化：分与小时两种情形', () => {
  assert.equal(durationText(87), '1:27');
  assert.equal(durationText(245), '4:05');
  assert.equal(durationText(298), '4:58');
  assert.equal(durationText(2201), '36:41');
  assert.equal(durationText(3600), '1:00:00');
  assert.equal(durationText(3671), '1:01:11');
  assert.equal(durationText(0), '0:00');
});

test('播放器地址带 bvid，且绝不自动播放', () => {
  const u = playerUrl('BV1Qi4y147B7');
  assert.match(u, /^https:\/\/player\.bilibili\.com\/player\.html\?/);
  assert.match(u, /bvid=BV1Qi4y147B7/);
  assert.match(u, /autoplay=0/, '自动播放会吓到人，也会撞浏览器策略');
  // 入参必须编码，否则拼进 URL 能被塞参数
  assert.equal(playerUrl('BV1 a&b').includes('&autoplay'), true);
  assert.match(playerUrl('BV1 a&b'), /bvid=BV1%20a%26b/);
});

test('原站兜底链接始终可得', () => {
  assert.equal(watchUrl('BV1Qi4y147B7'), 'https://www.bilibili.com/video/BV1Qi4y147B7/');
});

test('播放量按万显示，不到一万给原数', () => {
  assert.equal(playText(118045), '11.8 万');
  assert.equal(playText(9718), '9718');
  assert.equal(playText(0), '0');
});

test('页面渲染：卡片数与内容一致，导航有入口，声明版权与抓取日', () => {
  const html = learnPage(content);
  const cards = [...html.matchAll(/data-learn-card/g)].length;
  assert.equal(cards, content.videos.length, `页面 ${cards} 张卡，内容 ${content.videos.length} 条`);
  assert.match(html, /href="\/learn"[^>]*class="on"|class="on"[^>]*href="\/learn"/, '导航没有高亮「看懂外贸」');
  assert.match(html, /版权归原作者所有/);
  assert.match(html, /2026-10-25/, '页面没有印出数据抓取日，播放量会变成无出处的数字');
  // 每条都要有原站兜底，否则播放器挂了就等于内容消失了
  const outs = [...html.matchAll(/class="lv-out"/g)].length;
  assert.equal(outs, content.videos.length, '有卡片缺原站兜底链接');
});

test('页面渲染：栏目读不出来时给说明，不是白屏', () => {
  const html = learnPage(null);
  assert.match(html, /还没导进来/);
  assert.match(html, /不是网络问题/);
  assert.match(html, /\/quote\/new/, '降级页也没有出口，用户会走投无路');
});

test('页面渲染：坏图有兜底样式，不会露出碎图标', () => {
  const html = learnPage(content);
  assert.match(html, /onerror="this\.classList\.add\('lv-cover-broken'\)"/);
  // 哔哩哔哩图床对站外 Referer 返回 403，少这个属性封面全空
  assert.match(html, /referrerpolicy="no-referrer"/);
});

test('页面渲染：整页洗出来的文字也不许出现结果承诺与内部字段名', () => {
  // copy-lint 会扫这个页面，但那条链路要起服务；这里留一道不依赖服务的近身防守，
  // 免得有人改了模板里的固定文案（说明段、规则段）而没跑门禁。
  const text = learnPage(content)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const banned = ['包税', '保证清关', '保证通过', '一定能进', 'landedCost', 'cashRequired', '最终税费为', '必定适用'];
  for (const w of banned) assert.equal(text.includes(w), false, `页面文字里出现了「${w}」`);
});
