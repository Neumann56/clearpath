/**
 * 贸易救济（AD/CVD）与协定优惠税率的守门测试。
 *
 * 这一层最容易出的错不是崩溃，而是**静默算错**：
 *   1. 把定额税（25 美元/㎡）当从价率乘 CIF —— 差一到两个数量级，不报错
 *   2. 缺计量数据时给 0 —— 真实成本偏低，报告上看不出任何异常
 *   3. 把 FTA 优惠税率直接算进 landedCost —— 替用户假设了一个他没拿到的原产地证
 *   4. 8 位子目被 6 位行挡住 —— 加了明细却不生效，一声不响
 *
 * 下面每条都对应一个真实场景（印度光伏、土耳其光伏、越南 T 恤、欧盟汽配）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadParams, matchTariff } from '../lib/params.js';
import { buildReport } from '../lib/report.js';

const params = loadParams();

const run = (input) =>
  buildReport({
    input: { fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: '2026-10-20', ...input },
    params,
    today: '2026-10-24',
  }).report;

const num = (v) => Number(v);

test('参数：remedies 每条都能被引擎读懂（计征方式、来源、置信度齐备）', () => {
  const list = params.raw.remedies || [];
  assert.ok(list.length > 0, 'remedies 不能为空——空了等于反倾销功能永远返回"不适用"');
  for (const r of list) {
    assert.ok(r.country, '缺 country');
    assert.ok(r.hsPrefix, `缺 hsPrefix：${r.country}`);
    assert.ok(r.basis, `缺计征方式 basis：${r.country}/${r.hsPrefix}`);
    assert.ok(r.confidence, `缺置信度：${r.country}/${r.hsPrefix}`);
    assert.ok(r.sourceUrl, `缺来源：${r.country}/${r.hsPrefix}`);
    if (r.basis === 'per_sqm' || r.basis === 'per_kg') {
      assert.ok(r.unitRateUsd, `定额计征必须有单价：${r.country}/${r.hsPrefix}`);
      assert.ok(
        r.depositRate === undefined,
        `定额计征不能再挂从价率，否则两条路径会打架：${r.country}/${r.hsPrefix}`
      );
    } else {
      assert.ok(r.depositRate != null, `从价计征必须有保证金率：${r.country}/${r.hsPrefix}`);
    }
  }
});

test('从价反倾销：印度光伏按 CIF 计 30%，进真实成本也进现金', () => {
  const rep = run({ country: 'IN', hsCode: '854143' });
  const e = rep.expected;
  assert.ok(e.remedy, '印度 8541 43 应命中 DGTR 太阳能电池案');
  assert.equal(e.remedy.basis, 'ad_valorem');
  assert.equal(num(e.remedy.depositRate), 0.3);
  // 30% × CIF
  assert.ok(Math.abs(num(e.remedy.final) - num(e.dutiableCif) * 0.3) < 0.02);
  // 从价案保证金与终裁同率 → 两个口径相等，现金缺口只来自增值税
  assert.equal(num(e.remedy.deposit), num(e.remedy.final));
});

test('定额反倾销：土耳其光伏按平方米计，25 × 5000 = 125000', () => {
  const rep = run({ country: 'TR', hsCode: '854143', areaSqm: '5000' });
  const e = rep.expected;
  assert.ok(e.remedy, '土耳其 8541 43 应命中光伏组件案');
  assert.equal(e.remedy.basis, 'per_sqm');
  assert.equal(num(e.remedy.deposit), 125000);
  // 定额税没有"保证金 vs 终裁"的结构，两口径必须相等
  assert.equal(num(e.remedy.deposit), num(e.remedy.final));
  assert.equal(num(e.remedy.contingentLiability), 0);
  assert.equal(num(e.remedy.potentialRefund), 0);
});

test('定额反倾销：缺总面积时不给 0，报告降级为"有缺口"', () => {
  const without = run({ country: 'TR', hsCode: '854143' });
  const withArea = run({ country: 'TR', hsCode: '854143', areaSqm: '5000' });
  const e = without.expected;

  assert.equal(e.remedy.incomplete, true, '缺面积必须标 incomplete');
  assert.equal(num(e.remedy.deposit), 0, '金额位是 0 只代表没算');
  // 关键：不能因为"没算"就装成一切正常
  assert.equal(without.state, 'complete_with_gaps', '缺计量数据必须降级状态，否则用户以为已经算全了');
  assert.ok(
    (without.dataGaps || []).some((g) => /总面积/.test(g.field || '')),
    '缺口里必须出现"总面积"，让人知道该补什么'
  );
  // 补上面积后金额必须真的变大
  assert.ok(num(withArea.expected.landedCost) > num(without.expected.landedCost));
});

test('协定优惠：越南 T 恤走 AIFTA，关税从 20% 降到 5%（纺织品是敏感税目，不是零）', () => {
  // 2026-10-24 调研补充包 v1 表 5.1 明确：纺织品在 ACFTA 下为敏感税目，各成员保留 5%。
  // 上一版参数这里写的是 0%，等于替用户假设了一个他拿不到的 5 个点——
  // 报告上看起来"有数据、有省额"，实际拿着 Form E 去清关会被补税。
  const rep = run({ country: 'VN', hsCode: '610910' });
  const fta = rep.fta || [];
  assert.equal(fta.length, 1, '中国原产 → 越南，应命中中国—东盟协定');
  const x = fta[0];
  assert.equal(x.code, 'AIFTA');
  assert.equal(num(x.mfnRate), 0.2);
  assert.equal(num(x.preferentialRate), 0.05, '纺织品的 ACFTA 优惠税率是 5%，不是 0');
  // 可省 = CIF × (20% − 5%)
  assert.ok(Math.abs(num(x.saving) - num(rep.expected.dutiableCif) * 0.15) < 0.02);
  assert.ok(x.certificate, '必须告诉用户要办什么证');
});

test('协定优惠：同一协定里成员国税率不同时，国家特化档要压过通用档', () => {
  // ACFTA 下汽配：印尼保留 5%，其余成员 0%。只按 hsPrefix 匹配会把印尼的 5% 当 0 报出去。
  const id = (run({ country: 'ID', hsCode: '870891' }).fta || []).find((x) => x.code === 'AIFTA');
  const th = (run({ country: 'TH', hsCode: '870891' }).fta || []).find((x) => x.code === 'AIFTA');
  assert.ok(id, '印尼汽配应命中 ACFTA');
  assert.ok(th, '泰国汽配应命中 ACFTA');
  assert.equal(num(id.preferentialRate), 0.05, '印尼对汽配保留 5%，不能按通用档的 0% 报');
  assert.equal(num(th.preferentialRate), 0, '其余成员是 0%');
  assert.deepEqual(id.appliesTo, ['ID'], '这一档只对印尼成立，要说出来');
});

test('协定优惠：绝不并入 landedCost / cashRequired（红线）', () => {
  const rep = run({ country: 'VN', hsCode: '610910' });
  const e = rep.expected;
  const saving = num(rep.fta[0].saving);
  const cif = num(e.cif);

  // 这一票没有不可退税、没有规费、没有合规成本，真实成本正好 = CIF + 全额关税，
  // 所以用"大于等于"而不是"大于"；只要实现偷偷扣了优惠额，就会掉到 CIF 附近。
  assert.ok(
    num(e.landedCost) + 0.02 >= cif + num(e.duty),
    `真实成本应含全额关税：landedCost=${e.landedCost}，CIF+关税=${cif + num(e.duty)}`
  );
  assert.ok(
    num(e.landedCost) > cif + saving - 1,
    `优惠额被扣进了真实成本：landedCost=${e.landedCost}，CIF+可省=${cif + saving}（相等才正常，掉到 CIF≈${cif} 就是扣了）`
  );
  assert.ok(
    num(e.cashRequired) + 0.02 >= cif + num(e.duty),
    '需备现金同样必须按最惠国税率缴，不能按优惠后的税率备'
  );
  assert.ok(num(e.duty) > 0, '优惠是"待争取"的，当前关税仍应按 MFN 计入');
  assert.ok(!('ftaSaving' in e), '不允许把优惠额塞进金额字段——它会被人拿去加总');
});

test('协定优惠：不在协定成员内的市场不出建议', () => {
  const de = run({ country: 'DE', hsCode: '870891' });
  assert.equal((de.fta || []).length, 0, '中德之间没有自贸协定，不应给出优惠建议');
  const us = run({ country: 'US', hsCode: '847130' });
  assert.equal((us.fta || []).length, 0, '中美之间没有自贸协定');
});

test('协定优惠：给不出价差就不占版面（优惠率不低于最惠国时不出）', () => {
  for (const x of run({ country: 'TH', hsCode: '870891' }).fta || []) {
    assert.ok(num(x.preferentialRate) < num(x.mfnRate), `${x.code} 的优惠率必须真的更低才有意义`);
    assert.ok(num(x.saving) > 0, '可省金额必须大于 0');
  }
});

test('8 位子目：输入 8 位走子目税率，输入 6 位仍走 6 位', () => {
  const six = matchTariff(params.idx, 'HU', '870891');
  const eight = matchTariff(params.idx, 'HU', '87089135');
  assert.equal(six.hsPrefix, '870891', '6 位输入不能被子目行抢走');
  assert.equal(eight.hsPrefix, '87089135', '8 位输入必须命中子目（最长前缀优先）');
  assert.notEqual(num(six.rate), num(eight.rate), '子目税率必须真的不同于 6 位，否则加了个寂寞');
});

test('8 位子目：更长的前缀永远优先（排序一坏就会静默失效）', () => {
  // 取一个国家，既有 6 位行又有 8 位行，逐个比长度
  const list = [...(params.idx.tariffs.get('HU') || [])];
  let prevLen = Infinity;
  for (const t of list) {
    const len = String(t.hsPrefix).replace(/\D/g, '').length;
    assert.ok(len <= prevLen, `税率索引没有按长度降序：${t.hsPrefix} 排在更长的前缀后面，8 位明细会被 6 位挡住`);
    prevLen = len;
  }
});

test('规费：市场没入库时必须说出来，不能当成"这票没有规费"', () => {
  // 「有定义但没勾选」和「压根没入库」在金额上都是 0，但性质完全不同：
  //   前者能算出"若计入会多少"，后者连算都算不出来。
  // 如果后者不说话，用户拿到的是一个确定偏低、报告上却毫无异样的到岸成本。
  // 2026-10-24 起欧盟与东盟已入库，所以拿日本当"仍然空白"的样本（本轮调研未覆盖）。
  const inKb = run({ country: 'US', hsCode: '870891' });
  const noKb = run({ country: 'JP', hsCode: '870891' });

  const a = (noKb.assumptions || []).find((x) => x.field === '规费');
  assert.ok(a, '这个市场没有任何规费参数，报告必须有一条「未入库」的说明');
  assert.match(a.value, /未入库/, '要说清是"没入库"，不能含糊成"未计入"');
  assert.match(a.note, /未含/, '要明确到岸成本里没有这部分');

  // 有参数的市场走原有逻辑：能给出"若计入将增加多少"，不能被新分支顶掉
  const b = (inKb.assumptions || []).find((x) => x.field === '规费');
  assert.ok(b, '美国有规费参数，应保留"若计入将增加"的说明');
  assert.doesNotMatch(b.value, /未入库/, '有参数的市场不该说"未入库"');
});

test('规费：欧盟 27 国与东盟 6 国都已入库，且区间型规费不许被压成一个假精确值', () => {
  // 这是本轮数据需求的核心交付：上一版欧盟 27 + 东盟 5 一条规费都没有。
  const sample = ['DE', 'HU', 'PL', 'VN', 'TH', 'SG', 'ID', 'PH', 'MY'];
  for (const country of sample) {
    const rep = run({ country, hsCode: '610910' });
    const lines = rep.expected?.chargeLines || [];
    assert.ok(lines.length > 0, `${country} 仍缺规费参数，报告只能显式说"未入库"`);

    // 默认不计：v2 §11 黄金用例口径，改了所有存量报告金额都会漂
    const on = lines.filter((l) => l.included);
    assert.equal(on.length, 0, `${country} 的规费不该默认计入（enabledByDefault 必须为 false）`);

    // 区间型：合计里放中值，但上下限必须一路带到报告上
    for (const l of lines) {
      if (!l.amountMin || !l.amountMax) continue;
      assert.ok(
        num(l.amountMin) < num(l.amountMax),
        `${country}/${l.lineCode} 的区间上下限写反了`
      );
      assert.ok(
        Math.abs(num(l.amount) - (num(l.amountMin) + num(l.amountMax)) / 2) < 0.02,
        `${country}/${l.lineCode} 的合计金额应等于区间中值`
      );
      assert.equal(l.baseText, '区间中值', '报告上要标出这一行是区间估算，不能混在确定值里');
    }
  }
  // 勾选后必须真的加到成本里，而不是只显示不算
  const withFee = run({ country: 'DE', hsCode: '610910', enabledCharges: ['EU_CUSTOMS_AGENT'] });
  assert.ok(
    num(withFee.expected.landedCost) > num(run({ country: 'DE', hsCode: '610910' }).expected.landedCost),
    '勾选规费后真实成本必须变大'
  );
});

test('从量计征：瑞士 T 恤拒绝出数，不许拿从价百分比顶替', () => {
  // 瑞士对针织 T 恤按 CHF 0–5/kg 从量计征，没有对应的从价百分比。
  // 上一版填的 2% 是编的：一件 200g 的 T 恤按上限折下来可能超过 30%，差一个数量级。
  // run() 只返回 report，拒绝出数的场景要拿到 ParamError 本身，所以这里单独包一层。
  // 调用方（server.js）也是 catch 完转 HTTP 400，测试要跟真实调用路径一致。
  const raw = (input) => {
    try {
      return buildReport({
        input: { fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: '2026-10-20', ...input },
        params,
        today: '2026-10-24',
      });
    } catch (e) {
      return { ok: false, errors: [{ code: e.code, message: e.message }] };
    }
  };

  const out = raw({ country: 'CH', hsCode: '610910' });
  assert.equal(out.ok, false, '瑞士 T 恤必须拒绝出数');
  const err = (out.errors || []).find((e) => e.code === 'E_MFN_PENDING');
  assert.ok(err, '必须是"挂起待核"（E_MFN_PENDING），不是"没入库"——两者对用户的意义不同');
  assert.match(err.message, /从量|重量/, '要说清为什么不给百分比');
  assert.ok(err.message.length > 40, '要给出可执行的下一步，不能只有错误码');
  // 同一国家的其他品类不受影响
  assert.ok(raw({ country: 'CH', hsCode: '870891' }).report, '瑞士汽配仍应正常出数');
});
