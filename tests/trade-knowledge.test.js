// 外贸常识包的守门测试。
//
// 这轮改动的风险不在于"能不能答"，而在于"会不会开始算"。
// 一个知识包只要往里塞进一条"常见报价 = 成本 × 1.3"，老周就会开始给用户算钱，
// 双口径体系当场失效，而且报告上完全看不出异常。所以下面一半用例是在钉红线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, matchTopics, knowledgeBlock } from '../public/js/trade-knowledge.js';
import { generalSystemPrompt, GENERAL_SYSTEM_PROMPT } from '../public/js/assistant-prompt.js';

test('常识包：十八类主题都在，每条都有标题、关键词、正文', () => {
  assert.ok(TOPICS.length >= 18, `主题数应至少 18 类，实际 ${TOPICS.length}`);
  for (const t of TOPICS) {
    assert.ok(t.id && t.title, `主题缺 id 或 title：${JSON.stringify(t).slice(0, 60)}`);
    assert.ok(Array.isArray(t.keys) && t.keys.length >= 4, `${t.id} 关键词太少，容易问不到`);
    assert.ok(t.text && t.text.length >= 80, `${t.id} 正文太短，讲不透`);
    assert.ok(t.text.length <= 420, `${t.id} 正文 ${t.text.length} 字，超预算（按命中注入，太长拖慢首 token）`);
  }
});

test('红线：正文不许出现阿拉伯数字、金额、费率', () => {
  // 一旦出现"多少多少钱""几个点"，模型就会顺手拿它去套这票的账。
  // 行业惯例该不该带比例另说，但金额和费率一律不许进。
  const bad = [];
  for (const t of TOPICS) {
    if (/\d/.test(t.text)) bad.push(`${t.id} 含阿拉伯数字：${t.text.match(/\d[^\n]{0,20}/)[0]}`);
    if (/\$\s*\d|\bUSD\b|\bCNY\b|\bRMB\b/i.test(t.text)) bad.push(`${t.id} 含货币金额`);
    if (/\d+\s*[%％]/.test(t.text)) bad.push(`${t.id} 含百分比费率`);
  }
  assert.deepEqual(bad, [], `常识包混进了数字，老周会开始自己算：\n${bad.join('\n')}`);
});

test('红线：正文不许出现界面禁用词与内部字段名', () => {
  const banned = [
    'landedCost', 'cashRequired', 'cashGapRatio', 'dutyTotal', 'taxTotal',
    'effectiveRate', 'refundableVat', 'unrefundableTax', 'complianceCost',
    '包税', '双清包税', '保证清关', '一定能进', '保证通过',
    '最终税费为', '以本报告为准', '总计',
  ];
  const bad = [];
  for (const t of TOPICS) {
    for (const w of banned) if (t.text.includes(w)) bad.push(`${t.id} 含「${w}」`);
  }
  assert.deepEqual(bad, [], `常识包混进了禁用词：\n${bad.join('\n')}`);
});

test('注入块自带刹车：必须写明"不要据此推算金额"', () => {
  const { text } = knowledgeBlock('客户要 DDP 到门，这单我该不该接');
  assert.ok(text.length > 0, '这句应该命中');
  assert.match(text, /不是这票的数/, '要说清这是通用经验，不是这票的数');
  assert.match(text, /不要据此推算|不要往里加任何金额/, '必须带一句"别拿它算钱"');
});

test('命中：DDP 到门该不该接 → 同时带上贸易术语和风险两类', () => {
  const { ids, matched } = matchTopics('客户要 DDP 到门，这单我该不该接');
  assert.equal(matched, true);
  assert.ok(ids.includes('incoterms'), `应命中贸易术语，实际 ${ids.join(',')}`);
  assert.ok(ids.includes('risk'), `应命中风险识别，实际 ${ids.join(',')}`);
  assert.ok(ids.length <= 2, '最多注入两条，多了拖慢首 token');
});

test('命中：英文术语大小写都不敏感', () => {
  for (const q of ['客户要 DDP 到门', '客户要 ddp 到门', '客户要 Ddp 到门']) {
    const { ids } = matchTopics(q);
    assert.ok(ids.includes('incoterms'), `${q} 没命中贸易术语`);
  }
});

test('命中：付款方式、单据、软条款各走各的', () => {
  assert.ok(matchTopics('新客户第一单，付款方式怎么定').ids.includes('payment'));
  assert.ok(matchTopics('提单上的数量和发票对不上怎么办').ids.includes('docs'));
  assert.ok(matchTopics('信用证能不能接').ids.includes('lc'));
  assert.ok(matchTopics('客户一直压价，怎么回').ids.includes('talk'));
  assert.ok(matchTopics('原产地证能省多少关税').ids.includes('origin'));
});

test('不问就不注入：无关问题保持原 prompt 一个字节都不涨', () => {
  const base = GENERAL_SYSTEM_PROMPT.length;
  for (const q of ['今天天气怎么样', '你是谁', '这工具怎么用', '真实成本和需备现金有什么区别']) {
    const { prompt, ids } = generalSystemPrompt(q, []);
    assert.deepEqual(ids, [], `${q} 不该命中任何主题`);
    assert.equal(prompt, GENERAL_SYSTEM_PROMPT, `${q} 没命中却改了 prompt`);
    assert.equal(prompt.length, base);
  }
});

test('注入后体积可控：不管怎么问，prompt 不超过 3000 字', () => {
  // 用绝对上限而不是"基线的两倍"——基线会随功能扩张往上走，倍数上限跟着漂，
  // 最后就变成"永远都过得去"。3000 字约 8KB，对模型很小，但足够挡住失控。
  const BASE_MAX = 3000;
  const base = GENERAL_SYSTEM_PROMPT.length;
  let worst = 0;
  for (const t of TOPICS) {
    const { prompt } = generalSystemPrompt(`${t.title} ${t.keys.join(' ')} ${t.text}`, []);
    worst = Math.max(worst, prompt.length);
    assert.ok(prompt.length <= BASE_MAX, `${t.id} 注入后 ${prompt.length} 字，超上限 ${BASE_MAX}`);
  }
  assert.ok(worst > base, '至少有一种问法真的会注入，否则机制等于没接上');
});

test('指代能接上：短问句继承上一轮主题，长问句不继承', () => {
  // 用户问完 DDP，接一句"那具体怎么弄"——不带上下文会突然断片
  const shortCarry = matchTopics('那具体怎么弄', ['incoterms']);
  assert.deepEqual(shortCarry.ids, ['incoterms'], '短问句应继承上一轮主题');
  assert.equal(shortCarry.carried, true);

  // 但换了个完整问题就不该带着旧主题跑
  const longFresh = matchTopics('你们这个工具的报告怎么看，十五段分别是什么', ['incoterms']);
  assert.deepEqual(longFresh.ids, [], '完整问题不该继承旧主题，会把话带偏');
  assert.equal(longFresh.carried, false);

  // 没有历史就更不该凭空带
  assert.deepEqual(matchTopics('那具体怎么弄', []).ids, []);
});

test('同一个问题问两遍，结果完全一致（没有随机性，便于回归）', () => {
  const a = matchTopics('客户要 DDP 到门，这单我该不该接');
  const b = matchTopics('客户要 DDP 到门，这单我该不该接');
  assert.deepEqual(a, b);
});

test('预取事实注入：带版本、带引用规矩，且不许相加', () => {
  const facts = {
    编码: '870891',
    参数版本: 'kb-test',
    数据截止: '2026-01-01',
    最惠国税率: { 值: '2.5%', 置信度: 'high', 出处: 'https://hts.usitc.gov' },
  };
  const { prompt } = generalSystemPrompt('8708.91 到美国税率是多少', [], null, facts);
  assert.match(prompt, /【这票的已知事实】/, '事实块必须单独成块');
  assert.match(prompt, /kb-test/, '必须带参数版本，否则不知道是哪天的口径');
  assert.match(prompt, /不许相加/, '引用规矩必须紧跟在同一段里');
  assert.match(prompt, /要跑预演|用户问总额/, '问总额仍要挡回预演');
});

test('品名有歧义：注入的是反问指令，不是税率', () => {
  const facts = { 歧义: '「德国」方向能对上多个品类：服装（610910）、家用纺织品（940360）。先问清是哪一种。' };
  const { prompt } = generalSystemPrompt('服装到德国怎么算', [], null, facts);
  assert.match(prompt, /先问清是哪一种|先反问/);
  assert.doesNotMatch(prompt, /最惠国税率/, '有歧义时不许注入税率');
});

test('没预取到东西时，prompt 与原来完全一致（不多一个字节）', () => {
  const a = generalSystemPrompt('真实成本和需备现金有什么区别', [], null, null);
  const b = generalSystemPrompt('真实成本和需备现金有什么区别', [], null);
  assert.equal(a.prompt, b.prompt);
});
