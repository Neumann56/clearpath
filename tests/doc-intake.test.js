/**
 * 单据读图的清洗与交叉核对。
 *
 * 这里的 fixture 不是编的，是把真实模型输出原样抄下来的（两家模型、三种清晰度）。
 * 其中最关键的一条：一张字太小的发票，模型报 fob=80,000，而图上印的是 48,000。
 * 也就是说"模型说读到了"和"图上确实有"是两件事，必须机器校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normNumber,
  normHs,
  normDate,
  normalizeFields,
  evidenceMatches,
  adjudicate,
  peerCandidates,
  DOC_FIELDS,
} from '../public/js/doc-intake.js';

// ---------- 真实模型输出（照抄，未修改） ----------

/** 清晰图：deepseek-v4.1-flash 读出 */
const CLEAR_A = {
  seen: 'invoice',
  fields: { country: 'HU', hsCode: '8708.91', fob: 'USD 48,000.00', freight: 'USD 3,200.00', qty: '500 PCS', declarationDate: '2026-10-20' },
  missing: ['channel', 'entryDate'],
  evidence: {
    country: 'Consignee: Budapest Trade Kft.  VAT HU-22910345',
    hsCode: 'HS Code  : 8708.91',
    fob: 'Amount   : USD 48,000.00',
    freight: 'Freight  : USD 3,200.00',
    qty: 'Qty      : 500 PCS',
    declarationDate: 'Declaration Date: 2026-10-20',
  },
};

/** 清晰图：glm-5v-turbo 读出（格式不同，意思相同） */
const CLEAR_B = {
  seen: 'invoice',
  fields: { country: 'HU', hsCode: '8708 91', fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: '2026-10-20' },
  missing: ['entryDate'],
  evidence: { channel: 'Consignee: Budapest Trade Kft.' },
};

/** 压缩后的模糊图：金额读错，两家不一致 */
const BLURRY_A = { seen: 'invoice', fields: { hsCode: '870891', fob: 'USD 48,000.00', freight: 'USD 3,500.00', qty: '500 PCS' }, missing: [], evidence: { fob: 'Amount USD 48,000.00' } };
const BLURRY_B = { seen: 'invoice', fields: { hsCode: '8708.91', fob: 8000, freight: 1200, qty: 1000, declarationDate: '2020-10-20' }, missing: [], evidence: {} };

/** 完全看不清的图：两家读出了完全不同的单据 */
const UNREADABLE_A = { seen: 'invoice', fields: { country: 'IN', hsCode: '0906.11', qty: '340 PCS', declarationDate: '2026-10-10' }, missing: [], evidence: { hsCode: 'HS Code 0906.11' } };
const UNREADABLE_B = { seen: 'invoice', fields: { country: 'HU', hsCode: '870891', fob: 48000, freight: 3200, qty: 500, channel: 'B2B', declarationDate: '2026-10-20' }, missing: [], evidence: {} };

// ---------- 归一 ----------

test('金额归一：货币符号、千分位、单位都不影响比较', () => {
  assert.equal(normNumber('USD 48,000.00'), 48000);
  assert.equal(normNumber('48000'), 48000);
  assert.equal(normNumber('¥ 3,200'), 3200);
  assert.equal(normNumber('500 PCS'), 500);
  assert.equal(normNumber(''), null);
  assert.equal(normNumber(null), null);
});

test('HS 编码归一：点、空格、连字符都去掉', () => {
  assert.equal(normHs('8708.91'), '870891');
  assert.equal(normHs('8708 91'), '870891');
  assert.equal(normHs('8708-91-00'), '87089100');
});

test('日期归一：2026/10/20、20 Oct 2026、Oct 20 2026 都能认', () => {
  assert.equal(normDate('2026-10-20'), '2026-10-20');
  assert.equal(normDate('2026/10/20'), '2026-10-20');
  assert.equal(normDate('2026年10月20日'), '2026-10-20');
  assert.equal(normDate('20 Oct 2026'), '2026-10-20');
  assert.equal(normDate('October 20, 2026'), '2026-10-20');
  assert.equal(normDate('2026-02-30'), '', '2 月 30 日不是日期，不能放过');
  assert.equal(normDate('看不清'), '');
});

// ---------- 清洗 ----------

test('清洗：不在白名单里的字段一律丢弃', () => {
  const { fields } = normalizeFields({ fields: { fob: 1000, insurance: 50, invoiceNo: 'CI-1', hsCode: '870891' } });
  assert.deepEqual(Object.keys(fields).sort(), ['fob', 'hsCode']);
});

test('清洗：国家不在支持列表就拒收，不猜最近的', () => {
  // AF 阿富汗：真实存在但参数库没建，必须拒收，不能拿邻近市场顶
  const { fields, rejected } = normalizeFields({ fields: { country: 'AF' } });
  assert.equal(fields.country, undefined);
  assert.equal(rejected[0].why, 'unsupported_country');
});

test('清洗：欧盟国家已入库（2026-10 扩到 27 国），德语发票认得出 DE', () => {
  const { fields, rejected } = normalizeFields({
    fields: { country: 'DE' },
    evidence: { country: 'Consignee: Münchener Handel GmbH, Germany' },
  });
  assert.equal(fields.country, 'DE');
  assert.equal(rejected.length, 0);
});

test('清洗：HS 编码位数不对、负数货值、非法渠道都拒收', () => {
  const { fields, rejected } = normalizeFields({
    fields: { hsCode: '8708', fob: -100, channel: 'B2B2', qty: 0 },
  });
  assert.equal(fields.hsCode, undefined);
  assert.equal(fields.fob, undefined);
  assert.equal(fields.channel, undefined);
  assert.equal(fields.qty, undefined);
  assert.deepEqual(rejected.map((r) => r.field).sort(), ['channel', 'fob', 'hsCode', 'qty']);
});

test('清洗：运费大于货值多半是读错了，把运费摘掉', () => {
  const { fields, rejected } = normalizeFields({ fields: { fob: 800, freight: 3200 } });
  assert.equal(fields.freight, undefined);
  assert.equal(rejected[0].why, 'freight_gt_fob');
});

// ---------- 引文核对 ----------

test('引文核对：值确实在引文里才算有出处', () => {
  assert.equal(evidenceMatches('fob', 48000, 'Amount : USD 48,000.00'), true);
  assert.equal(evidenceMatches('fob', 8000, 'Amount : USD 48,000.00'), false, '48,000 不等于 8,000');
  assert.equal(evidenceMatches('hsCode', '870891', 'HS Code : 8708.91'), true);
  assert.equal(evidenceMatches('declarationDate', '2026-10-20', 'Declaration Date: 2026-10-20'), true);
  assert.equal(evidenceMatches('fob', 48000, ''), false, '没有引文就是没有出处');
});

// ---------- 交叉核对 ----------

test('交叉核对：清晰图格式不同但意思一致 → 可以填', () => {
  const r = adjudicate(CLEAR_A, CLEAR_B);
  assert.equal(r.fill.fob, 48000);
  assert.equal(r.fill.hsCode, '870891', '6 位与 6 位带点应归一后一致');
  assert.equal(r.fill.qty, 500);
  assert.equal(r.fill.declarationDate, '2026-10-20');
  assert.equal(r.fill.country, 'HU');
});

test('交叉核对：渠道是推断出来的，永远不自动填', () => {
  const r = adjudicate(CLEAR_A, CLEAR_B);
  assert.equal(r.fill.channel, undefined, '发票上不会印 B2B，这一项必须让人点一下');
  const c = r.confirm.find((x) => x.field === 'channel');
  assert.ok(c, '渠道应进待确认');
  assert.equal(c.reason, 'inferred');
  assert.deepEqual(c.candidates, ['B2B'], '只有一边读出来时，候选就一个');
});

test('交叉核对：两边对渠道判断不同就把两个都摆出来', () => {
  const a = { seen: 'invoice', fields: { channel: 'B2B' }, evidence: {} };
  const b = { seen: 'invoice', fields: { channel: 'B2C' }, evidence: {} };
  const r = adjudicate(a, b);
  const c = r.confirm.find((x) => x.field === 'channel');
  assert.deepEqual(c.candidates, ['B2B', 'B2C']);
});

test('交叉核对：模糊图金额分歧 → 一个都不填', () => {
  const r = adjudicate(BLURRY_A, BLURRY_B);
  assert.equal(r.fill.fob, undefined, '48,000 和 8,000 分歧，不许挑一个填');
  assert.equal(r.fill.qty, undefined);
  assert.equal(r.fill.freight, undefined);
  const fob = r.confirm.find((x) => x.field === 'fob');
  assert.equal(fob.reason, 'conflict');
  assert.deepEqual(fob.candidates, [48000, 8000], '两个候选都要摆出来让人选');
});

test('交叉核对：完全看不清的图，国家与编码都对不上 → 全部不填', () => {
  const r = adjudicate(UNREADABLE_A, UNREADABLE_B);
  assert.equal(r.fill.country, undefined);
  assert.equal(r.fill.hsCode, undefined);
  assert.equal(r.fill.qty, undefined);
  assert.ok(r.confirm.every((c) => ['conflict', 'single', 'inferred'].includes(c.reason)));
});

test('交叉核对：两边一致但找不到原文 → 降级为待确认，不当成可信', () => {
  const a = { seen: 'invoice', fields: { fob: 48000 }, evidence: {} };
  const b = { seen: 'invoice', fields: { fob: '48000' }, evidence: {} };
  const r = adjudicate(a, b);
  assert.equal(r.fill.fob, undefined);
  assert.equal(r.confirm[0].reason, 'no_evidence');
  assert.deepEqual(r.confirm[0].candidates, [48000]);
});

test('交叉核对：引文张冠李戴（值不在引文里）→ 待确认', () => {
  const a = { seen: 'invoice', fields: { fob: 8000 }, evidence: { fob: 'Amount : USD 48,000.00' } };
  const b = { seen: 'invoice', fields: { fob: 8000 }, evidence: {} };
  const r = adjudicate(a, b);
  assert.equal(r.fill.fob, undefined, '引文里没有 8000，这个数没有出处');
  assert.equal(r.confirm[0].reason, 'weak_evidence');
});

test('交叉核对：两家都说不是单据 → 一个字段都不填', () => {
  const r = adjudicate({ seen: 'not_document', fields: { fob: 1 } }, { seen: 'not_document', fields: {} });
  assert.equal(r.notDoc, true);
  assert.deepEqual(Object.keys(r.fill), []);
  assert.equal(r.missing.length, DOC_FIELDS.length);
});

test('交叉核对：只有一家说不是单据时，仍然按能读到的部分处理', () => {
  const r = adjudicate({ seen: 'not_document', fields: {} }, { seen: 'invoice', fields: { country: 'HU' } });
  assert.equal(r.notDoc, false);
  assert.ok(r.confirm.some((c) => c.field === 'country'));
});

test('交叉核对：HS 编码 6 位与 8 位视为同一编码，但只填原文支持得住的那个', () => {
  const a = { seen: 'invoice', fields: { hsCode: '870891' }, evidence: { hsCode: 'HS Code 8708.91' } };
  const b = { seen: 'invoice', fields: { hsCode: '87089100' }, evidence: {} };
  const r = adjudicate(a, b);
  assert.equal(r.fill.hsCode, '870891', '图上只印了 6 位，多出来的两位没有出处，不能填');
});

test('交叉核对：原文确实印了 8 位时，就按 8 位填', () => {
  const a = { seen: 'invoice', fields: { hsCode: '870891' }, evidence: { hsCode: 'HS Code 8708.91.00' } };
  const b = { seen: 'invoice', fields: { hsCode: '87089100' }, evidence: {} };
  const r = adjudicate(a, b);
  assert.equal(r.fill.hsCode, '87089100');
  assert.ok(r.notes.some((x) => x.includes('位数')));
});

// —— 一票多品名 ——
// 真实场景：一张发票两行货（散热器 8708.91 / 支架 8708.99）。
// 编码和数量跨品名没有意义，合起来算出来的是一份不存在的报价。

const TWO_LINE_A = {
  seen: 'invoice',
  fields: { country: 'HU', fob: 50500, freight: 3200 },
  lines: [
    { hsCode: '8708.91', qty: 500, amount: 48000 },
    { hsCode: '8708.99', qty: 200, amount: 2500 },
  ],
  evidence: { country: 'Budapest, Hungary (EU)', fob: 'Total FOB Amount USD 50,500.00', freight: 'Freight (prepaid) USD 3,200.00' },
  missing: ['hsCode', 'qty'],
  notes: [],
};

test('多品名：识别出两个不同 HS 编码就判定为一票多品名', () => {
  const r = adjudicate(TWO_LINE_A, { ...TWO_LINE_A, lines: [] });
  assert.ok(r.multiLine, '应识别为多品名');
  assert.equal(r.multiLine.codes.length, 2);
  assert.equal(r.multiLine.count, 2);
});

test('多品名：编码和数量一律不进表单，总价照填（总价是准的）', () => {
  const r = adjudicate(TWO_LINE_A, { ...TWO_LINE_A, lines: [] });
  assert.equal(r.fill.hsCode, undefined, '不能把两个编码合成一个');
  assert.equal(r.fill.qty, undefined, '跨品名加总的数量对单票没意义');
  assert.equal(r.fill.fob, 50500, '总货值是准的，应该填');
});

test('多品名：不会把数量当候选推给用户点（避免点出一个错的）', () => {
  const a = { ...TWO_LINE_A, fields: { ...TWO_LINE_A.fields, qty: 700 } };
  const r = adjudicate(a, { ...a, lines: [] });
  assert.equal(r.fill.qty, undefined);
  assert.ok(!r.confirm.some((c) => c.field === 'qty'), '数量不该出现在待确认里');
  assert.ok(!r.confirm.some((c) => c.field === 'hsCode'));
});

test('多品名：notes 第一句说清几行几个编码', () => {
  const r = adjudicate(TWO_LINE_A, { ...TWO_LINE_A, lines: [] });
  assert.match(r.notes[0], /2 行、2 个不同的 HS 编码/);
});

test('多品名：同一编码分多行装运不算多品名', () => {
  const a = {
    seen: 'invoice',
    fields: { hsCode: '8708.91', qty: 700 },
    lines: [
      { hsCode: '8708.91', qty: 500 },
      { hsCode: '870891', qty: 200 },
    ],
    evidence: { hsCode: 'HS Code 8708.91', qty: '500 + 200 PCS' },
  };
  const r = adjudicate(a, a);
  assert.equal(r.multiLine, null, '同一编码只是分批装运，不该拦');
  assert.equal(r.fill.hsCode, '870891');
});

test('多品名：只有一家读出明细也照样拦（宁可拆票）', () => {
  const r = adjudicate(TWO_LINE_A, null);
  assert.ok(r.multiLine);
  assert.equal(r.fill.hsCode, undefined);
});

// —— 交叉核对不能自己核自己 ——
// 第一家首选模型看不了图时会降级到备选；第二家如果也从备选开始，
// 两家就是同一个模型，一致是假的。这条测试守的就是这个坑。

const LIST_B = ['glm-5v-turbo', 'kimi-k2.5', 'hy4-preview'];

test('交叉核对：第二家必须避开第一家实际用上的模型', () => {
  const alt = peerCandidates(LIST_B, 'deepseek-v4.1-flash');
  assert.deepEqual(alt, LIST_B, '第一家没降级时，第二家候选不受影响');
});

test('交叉核对：第一家降级到 glm 时，第二家不能再从 glm 开始', () => {
  const alt = peerCandidates(LIST_B, 'glm-5v-turbo');
  assert.ok(!alt.includes('glm-5v-turbo'), '同一个模型自己核自己，一致是假的');
  assert.deepEqual(alt, ['kimi-k2.5', 'hy4-preview']);
});

test('交叉核对：候选被剔空时返回空数组（调用方据此退化为单模型）', () => {
  assert.deepEqual(peerCandidates(['glm-5v-turbo'], 'glm-5v-turbo'), []);
  assert.deepEqual(peerCandidates(undefined, 'x'), []);
});
