/**
 * 录入页能不能顺畅走通。
 *
 * 起因是一个真实的卡点：用户填满六个可见字段，「下一步」仍然是灰的，
 * 页面只写「还差 2 项」——不说差哪两项，等于让人对着一屏框挨个试。
 *
 * 三条底线：
 *   1. 页面上写了「写品名也能认」，那填品名就必须真能算出来，不能只认数字
 *   2. 品名对不上唯一品类时不许猜——猜错品类 = 用错税目 = 金额全错
 *   3. 差项要说清是哪几项、为什么，且申报日的默认值不能让日期自相矛盾
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParams, resolveHsInput } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { newPage } from '../lib/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const params = loadParams();
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'params', 'unresolved.seed.json'), 'utf8'));

const base = { country: 'HU', fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: '2026-10-20' };

const run = (input) => buildReport({ input: { ...base, ...input }, params, facts, reportId: 'intake', today: '2026-10-24' });

test('填品名能算出数：光伏组件 → 854143，且留痕说明按哪个品名归一', () => {
  const out = run({ hsCode: '光伏组件' });
  assert.equal(out.ok, true, `品名应能直接出数：${JSON.stringify(out.errors || '').slice(0, 200)}`);
  assert.equal(out.report.input.hsCode, '8541.43');
  assert.equal(out.report.expected.landedCost > 0, true);

  // 关税、反倾销、认证全按这个码走，它不能是"系统默默定了"的结论
  const a = (out.report.assumptions || []).find((x) => x.field === 'HS 编码');
  assert.ok(a, '品名归一必须进假设清单，否则用户不知道系统替他做了归类');
  assert.match(a.note, /光伏组件/, '假设要写明是从哪个品名归过来的');
  assert.match(a.note, /8541\.43|854143/, '假设要写清归到了哪个编码');
});

test('编码与品名两条路的结果必须一致——同一票货不能因为写法不同算出两个价', () => {
  const byCode = run({ hsCode: '854143' });
  const byName = run({ hsCode: '光伏组件' });
  assert.equal(byCode.ok && byName.ok, true);
  assert.match(String(byName.report.input.hsCode), /8541\.43/, '品名应归到 8541.43');
  assert.equal(
    byName.report.input.hsCode,
    byCode.report.input.hsCode,
    '品名和编码必须落到同一个税目'
  );
  assert.equal(
    Number(byName.report.expected.landedCost),
    Number(byCode.report.expected.landedCost),
    '品名和编码指向同一税目，金额不能有差'
  );
});

test('品名对不上唯一品类时不许猜：命中多个要给候选', () => {
  // 参数库当前没有歧义词，所以造一个：给"家具"也加一个 kw 高度重合的品类
  const ambiguous = JSON.parse(JSON.stringify(params.raw));
  ambiguous.hsCatalog.push({ hs: '940330', name: '办公木家具', kw: ['家具', '办公桌'] });
  const p2 = { ...params, raw: ambiguous };

  const res = resolveHsInput(p2, '家具');
  assert.equal(res.matchedBy, 'ambiguous');
  assert.equal(res.digits, '', '有歧义就不能给编码');
  assert.equal(res.candidates.length, 2);

  // 走到引擎层也一样：报错要列出候选，而不是随便挑一个
  const out = buildReport({
    input: { ...base, hsCode: '家具' },
    params: { ...p2, idx: params.idx },
    facts,
    reportId: 'amb',
    today: '2026-10-24',
  });
  // idx 是按原始 raw 建的，品类目录只影响品名解析，不影响税率匹配
  assert.equal(out.ok, false);
  const err = (out.errors || []).find((e) => e.code === 'E_HS_INVALID');
  assert.ok(err, '有歧义必须拒绝出数');
  assert.match(err.message, /木制家具/, '要把候选列出来让人自己挑');
  assert.match(err.message, /办公木家具/);
});

test('认不出的品名要说清已入库哪几个，不能只说"格式不对"', () => {
  const out = run({ hsCode: '无人机' });
  assert.equal(out.ok, false);
  const err = (out.errors || []).find((e) => e.code === 'E_HS_INVALID');
  assert.ok(err);
  assert.match(err.message, /没认出/, '要说清是认不出品名，不是位数问题');
  assert.match(err.message, /光伏电池组件|机动车辆零件/, '要告诉用户已入库哪些品类');
});

test('编码位数不够时不能被当成品名兜底', () => {
  const res = resolveHsInput(params, '8708');
  assert.equal(res.matchedBy, 'partial_code', '4 位数字是笔误，不该拿去匹配品名');
  assert.equal(res.digits, '8708');
  const out = run({ hsCode: '8708' });
  assert.equal(out.ok, false);
  assert.match(out.errors[0].message, /只填了 4 位/, '要直接说缺几位');
});

test('录入页默认申报日是今天，不是参数快照日', () => {
  // 之前默认取 params.asOf，今天是 10-25 而 asOf 是 10-24，
  // 用户按今天填出口日，一进页面就被判「出口晚于申报」——差项的根源。
  const html = newPage(params, {});
  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m = /name="declarationDate" type="date" value="([^"]*)"/.exec(html);
  assert.ok(m, '录入页必须有申报日期字段');
  assert.equal(m[1], todayStr, '默认值应是今天，否则一进页面就可能自相矛盾');
});

test('日期填反时，要说清跟哪个日子比的', () => {
  // 放行日没填时系统按申报日推定，此时说"晚于放行日"等于让人去翻一个自己没填过的字段
  const out = run({ hsCode: '870891', declarationDate: '2026-10-24', exportDate: '2026-10-25' });
  assert.equal(out.ok, false);
  const err = (out.errors || []).find((e) => e.code === 'E_DATE_INVALID');
  assert.ok(err, '出口晚于清关必须拒绝出数');
  assert.match(err.message, /晚于申报日/, '没填放行日时应说"申报日"，不能拿"放行日"糊过去');
  assert.match(err.message, /2026-10-25/, '要把用户填的日期念回去，他才好对');

  // 用户自己填了放行日，才说放行日
  const out2 = run({ hsCode: '870891', declarationDate: '2026-10-20', entryDate: '2026-10-22', exportDate: '2026-10-25' });
  const err2 = (out2.errors || []).find((e) => e.code === 'E_DATE_INVALID');
  assert.match(err2.message, /晚于放行日/);
});

test('参数缺失不许变成"计算失败，请重试"——原因要原样交回', () => {
  // 曾经：E_MFN_MISSING / E_MFN_PENDING 这类 ParamError 一路冒到服务端最外层，
  // 被统一改成 500 + "计算失败，请重试"，真实原因塞进 detail，前端只显示 message。
  // 用户看到的是"系统故障"，实际只是"这个品类没入库"——本来自己换个品类就能解决。
  const miss = run({ hsCode: '999999' });
  assert.equal(miss.ok, false);
  const e1 = miss.errors[0];
  assert.equal(e1.code, 'E_MFN_MISSING');
  assert.equal(e1.http, 400, '是"这个组合没有数据"，不是服务器坏了');
  assert.match(e1.message, /税率还没入库/, '要说清是没入库');
  assert.match(e1.message, /已入库品类/, '要给出能算的替代项');
  assert.doesNotMatch(e1.message, /计算失败|请重试/, '不许用通用兜底吞掉原因');

  const pend = run({ country: 'CH', hsCode: '610910' });
  const e2 = pend.errors[0];
  assert.equal(e2.code, 'E_MFN_PENDING');
  assert.equal(e2.http, 400);
  assert.match(e2.message, /从量|按重量/, '挂起项也要说清为什么给不了数');
});

test('录入页把品类目录注入前端，且与参数库同一份', () => {
  // 前端不许另抄一份品类表：抄了就会跟后端各说各话（旧代码在 parse.js 和主页各抄过一遍）
  const html = newPage(params, {});
  const m = /window\.__HS_CATALOG__ = (\[[\s\S]*?\]);/.exec(html);
  assert.ok(m, '页面必须注入品类目录供前端校验品名');
  const injected = JSON.parse(m[1]);
  assert.equal(injected.length, params.raw.hsCatalog.length, '条数要与参数库一致');
  assert.deepEqual(
    injected.map((x) => x.hs),
    params.raw.hsCatalog.map((x) => x.hs),
    '注入的品类必须与参数库逐个对上'
  );
});

test('录入页必填项数量与文案一致', () => {
  const html = newPage(params, {});
  const m = /([一二三四五六七八九十])个必填/.exec(html);
  assert.ok(m, '页面要说明几个必填');
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1]];
  const required = (html.match(/class="req"/g) || []).length;
  assert.equal(cn, required, `文案说 ${cn} 个必填，实际标了 ${required} 个星号`);
});
