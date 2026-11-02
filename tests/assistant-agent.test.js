// 预取模块的守门测试。
//
// 这一层的风险不是"算错"，是"认错"——认出错的编码、把 10% 当成编码、
// 或者把查不到说成免税。三种都不会报错，只会让老周在演示现场说一句没有出处的话。
//
// 所以这里钉四件事：
// 1. 认出来的必须是参数库里真有的组合，且带出处、带置信度
// 2. partial_code 必须挡掉（"客户砍价 10%"里的 10 是最大的坑）
// 3. 查不到要给"没调研到"的文案，绝不能出现"免税/零关税"这种结论
// 4. 附加措施只列不判，规费标明默认不计入——不许越权替引擎下结论
import test from 'node:test';
import assert from 'node:assert/strict';

import { prefetch } from '../lib/assistant-agent.js';

const real = (q) => prefetch(q);

/** 最小假参数库：用来测"库里没有"的分支，不依赖真实库的缺口 */
const EMPTY_PARAMS = {
  raw: {
    countries: [{ code: 'ZZ', name: '测试国' }],
    hsCatalog: [{ hs: '870891', name: '机动车辆零件', kw: ['零件'] }],
    tariffs: [],
    measures: [],
    charges: [],
  },
  idx: { tariffs: new Map(), measures: new Map(), charges: new Map() },
  version: 'kb-test',
  asOf: '2026-01-01',
};

test('直接给编码 + 国家：认出组合，给出带出处的税率', () => {
  const r = real('8708.91 汽配发匈牙利，最惠国税率多少');
  assert.equal(r.kind, 'facts');
  assert.equal(r.facts.编码, '870891');
  assert.equal(r.facts.市场, '匈牙利（HU）');
  const t = r.facts.最惠国税率;
  assert.equal(t.值, '3%');
  assert.equal(t.置信度, 'high');
  assert.ok(t.出处.startsWith('http'), '必须带出处，否则模型没法说"哪来的"');
});

test('只给品名：走品名归一，不是只认数字', () => {
  const r = real('光伏组件发巴西要交什么税');
  assert.equal(r.kind, 'facts');
  assert.equal(r.facts.编码, '854143');
  assert.match(r.facts.编码来源, /按品名/);
});

test('百分比里的数字不许当成编码（这条最容易翻车）', () => {
  const r = real('客户砍价 10% 我该怎么回');
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'partial_code');
});

test('没有国家就不预取，交回常识回答', () => {
  const r = real('这批货总共要花多少钱');
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'no_country');
});

test('品类没入库：不预取，也不许瞎猜一个编码', () => {
  const r = real('锂电池发美国要注意什么');
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'no_hs');
});

test('参数库没有这个组合：文案必须是"没调研到"，不许暗示免税', () => {
  const r = prefetch('8708.91 发测试国', EMPTY_PARAMS);
  assert.equal(r.kind, 'facts');
  const t = r.facts.最惠国税率;
  assert.equal(typeof t, 'string');
  assert.match(t, /没调研到|还没有/);
  // 允许写"不代表免税"（否定表述本身是对的），禁止的是把免税当结论说出来
  assert.match(t, /不代表/);
  assert.doesNotMatch(t, /可以免税|享受免税|享受零关税|不用交税/);
});

test('低置信度要带警示，否则模型会把它说成已确认', () => {
  const r = real('光伏组件发巴西要交什么税');
  const t = r.facts.最惠国税率;
  assert.equal(t.置信度, 'low');
  assert.ok(t.注意, 'low 置信度必须带"注意"');
  assert.match(t.注意, /不要.*已确认|定性提示/);
});

test('附加措施只列不判：每条都要写明不能自己加', () => {
  const r = real('8708.91 到美国税率和出处');
  assert.ok(Array.isArray(r.facts.附加措施) && r.facts.附加措施.length > 0);
  for (const m of r.facts.附加措施) {
    assert.match(m.是否适用, /不要自己判断/);
    assert.ok(m.出处, '措施也要带出处');
  }
});

test('规费未入库：说清缺失，且不许给零', () => {
  const r = prefetch('8708.91 发测试国', EMPTY_PARAMS);
  const c = r.facts.清关规费;
  assert.equal(typeof c, 'string');
  assert.match(c, /还没入库|缺失/);
  assert.match(c, /不要当成零/);
});

test('规费默认状态必须带出来：默认不计入的不能让人以为已经算了', () => {
  const r = real('8708.91 到美国税率和出处');
  assert.ok(Array.isArray(r.facts.清关规费));
  for (const c of r.facts.清关规费) {
    assert.match(c.默认是否计入, /默认/);
  }
});

test('小数精度：比率要按千分位显示，不许四舍五入成 0%', () => {
  const r = real('8708.91 到美国税率和出处');
  const mpf = r.facts.清关规费.find((c) => /MPF/.test(c.名称));
  assert.ok(mpf, '美国必须有 MPF');
  assert.equal(mpf.计法, '按货值 0.346%');
});

test('facts 里不许出现双口径字段名，也不许有合计', () => {
  const r = real('8708.91 到美国税率和出处');
  const flat = JSON.stringify(r.facts);
  assert.doesNotMatch(flat, /landedCost|cashRequired|totalCost|合计|总计/);
});

test('参数版本必须带出来，用户才知道这是哪天的口径', () => {
  const r = real('8708.91 到美国税率和出处');
  assert.match(r.facts.参数版本, /^kb-/);
  assert.match(r.facts.数据截止, /^\d{4}-\d{2}-\d{2}$/);
});
