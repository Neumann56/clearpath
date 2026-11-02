/**
 * 《进口清关数据调研补充结果 v1》+《17 国市场准入认证报告》的落地守门测试。
 *
 * 这一轮改的不是算法，是数据。数据错了不会崩，只会"看起来很正常地算错"，
 * 所以每条数据都要有对应的断言，否则下次谁改了一格都没人知道。
 *
 * 四类风险，一类一条：
 *   1. 税率被改回旧值（旧值是"按该国常见档位估算"，很多是人为插值）
 *   2. 规费又被压回一个确定的假数字（报关行报价本来就是区间）
 *   3. 认证不按品类过滤（卖 T 恤被要求办汽配 E-mark）
 *   4. FTA 优惠税率按国家不分（印尼汽配 5% 被当成 0%）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParams, matchCharges, matchTariff } from '../lib/params.js';
import { buildReport } from '../lib/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const params = loadParams();
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'params', 'unresolved.seed.json'), 'utf8'));

const num = (v) => Number(v);

const run = (input) =>
  buildReport({
    input: { fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: '2026-10-20', ...input },
    params,
    facts,
    reportId: 'research-v1',
    today: '2026-10-24',
  }).report;

const rateOf = (country, hs) => {
  const t = params.raw.tariffs.find((x) => x.country === country && x.hsPrefix === hs);
  return t ? t.rate : undefined;
};

/* ------------------------------------------------------------------ *
 * 1. 税率：调研值落地，旧的档位估算不许回来
 * ------------------------------------------------------------------ */

test('税率：马来西亚 T 恤不再按 0% 算（旧值是插值，差 20 个点）', () => {
  // 这一条是全轮影响最大的修正：0% → 20%，一票 5 万美元的货差 1 万。
  assert.equal(num(rateOf('MY', '610910')), 0.2);
  const rep = run({ country: 'MY', hsCode: '610910' });
  assert.ok(num(rep.expected.duty) > 9000, `马来西亚 T 恤关税应超过 9000，实际 ${rep.expected.duty}`);
});

test('税率：非 ITA 成员国的电脑/手机/光伏不再按 0% 算', () => {
  // 旧数据把孟加拉、巴基斯坦的 ITA 产品全填了 0，等于假设它们都在 ITA 扩围清单里。
  for (const country of ['BD', 'PK']) {
    for (const hs of ['847130', '851713', '854143']) {
      assert.ok(
        num(rateOf(country, hs)) > 0,
        `${country}/${hs} 不该是零关税：这两国不是 ITA 扩围参加方`
      );
    }
  }
});

test('税率：印度汽配保持黄金用例标定值，调研推定的 15% 只能记在 note 里', () => {
  // golden G：20000 × 7.5% = 1500；SWS 150；IGST (20000+1650)×18% = 3897；合计 5547。
  // 改成 15% 会让这条用例全崩，K4 不允许——所以分歧只能留在 note，不能进 rate。
  const t = params.raw.tariffs.find((x) => x.country === 'IN' && x.hsPrefix === '870891');
  assert.equal(num(t.rate), 0.075, '印度汽配税率被改动会直接破坏黄金用例 G');
  assert.match(t.note, /15%/, '调研推定的 15% 必须留在 note 里，不能悄悄消失');
  assert.equal(t.researchRef, 'research-v1#T1-disputed', '要能追溯这是"已核过但暂不改"而不是漏了');
});

test('税率：从量计征的品类挂起，不许填一个从价百分比顶替', () => {
  const t = params.raw.tariffs.find((x) => x.country === 'CH' && x.hsPrefix === '610910');
  assert.equal(t.pending, true, '瑞士 T 恤必须标挂起');
  assert.equal(t.rate, null, '挂起的行不能同时留一个从价率——留着就会有人去用它');
  assert.match(t.note, /CHF/, '要写清楚真实的计征方式');
  // matchTariff 仍能匹配到它（覆盖测试要求"每国至少一条"），但引擎在算之前就拦住
  assert.ok(matchTariff(params.idx, 'CH', '610910'));
});

/* ------------------------------------------------------------------ *
 * 2. 规费：区间型不许被压成一个假精确值
 * ------------------------------------------------------------------ */

const chargeCountriesOf = (code) => {
  const row = (params.raw.charges || []).find((x) => x.code === code);
  return row ? [...(row.countries || (row.country ? [row.country] : []))] : [];
};

test('规费：欧盟 27 国与东盟 6 国都有参数，不再静默为零', () => {
  const eu = params.raw.countries.filter((c) => c.region === 'EU').map((c) => c.code);
  assert.equal(eu.length, 27, '欧盟成员国数量不对，说明国家表本身变了');
  const euCovered = chargeCountriesOf('EU_CUSTOMS_AGENT');
  for (const code of eu) assert.ok(euCovered.includes(code), `${code} 缺欧盟通用包规费`);
  for (const code of ['TH', 'VN', 'MY', 'ID', 'PH', 'SG']) {
    assert.ok(matchCharges(params.idx, code).length > 0, `${code} 缺规费参数`);
  }
});

test('规费：区间型金额取中值进合计，但上下限必须一路带到报告', () => {
  const rows = (params.raw.charges || []).filter((x) => Array.isArray(x.rangeUsd));
  assert.ok(rows.length >= 4, '区间型规费应至少有欧盟三项与印尼、菲律宾两项');
  for (const r of rows) {
    assert.equal(r.rangeUsd.length, 2, `${r.code} 的区间必须是两段`);
    assert.ok(num(r.rangeUsd[0]) < num(r.rangeUsd[1]), `${r.code} 上下限写反了`);
    assert.ok(!r.rate, `${r.code} 是区间型，不该同时挂从价率——两条路径会打架`);
  }

  const rep = run({ country: 'DE', hsCode: '610910', enabledCharges: ['EU_CUSTOMS_AGENT'] });
  const line = rep.expected.chargeLines.find((c) => c.lineCode === 'EU_CUSTOMS_AGENT');
  assert.ok(line, '德国应命中欧盟报关代理费');
  assert.ok(line.amountMin && line.amountMax, '报告上必须能看到区间上下限');
  assert.equal(line.baseText, '区间中值', '要标明这是区间估算，不能和确定值混在一起');
  assert.ok(
    Math.abs(num(line.amount) - (num(line.amountMin) + num(line.amountMax)) / 2) < 0.02,
    '合计金额应等于区间中值'
  );
  assert.ok(line.localText.includes('€'), '要保留当地报价原文，否则没人能核这个折算');
});

test('规费：默认一律不计入（v2 §11 黄金用例口径，改了所有存量金额都会漂）', () => {
  for (const r of params.raw.charges || []) {
    assert.equal(r.enabledByDefault, false, `${r.code} 的 enabledByDefault 必须是 false`);
  }
  const rep = run({ country: 'DE', hsCode: '610910' });
  assert.equal(
    rep.expected.chargeLines.filter((c) => c.included).length,
    0,
    '不开规费开关时一条都不该进成本'
  );
});

test('规费：欧盟两项 B2C 新收费绝不进 charges（B2B 整柜不适用）', () => {
  // 「3 欧元过渡关税」与「2 欧元海关处理费」都只针对 ≤€150 的 B2C 小额包裹。
  // 把它们塞进 charges，等于给每一票 B2B 整柜凭空加钱，而且加得毫无知觉。
  const codes = (params.raw.charges || []).map((c) => c.code).join(',');
  assert.doesNotMatch(codes, /EU_3EUR|EU_PARCEL_FEE|TRANSITIONAL/i, 'B2C 小额包裹费不许进规费表');
  const pol = (params.raw.policyCalendar || []).filter((x) => /3 欧元|2 欧元/.test(x.label));
  assert.equal(pol.length, 2, '这两项要进政策日历做提醒，不能直接丢掉');
  for (const x of pol) assert.match(x.note, /B2B|B2C/, '提醒里要写清适用范围');
});

/* ------------------------------------------------------------------ *
 * 3. 认证：按品类过滤，不按国家一刀切
 * ------------------------------------------------------------------ */

test('认证：德国卖 T 恤不该被要求办汽配 E-mark', () => {
  // 老记录 ECE_EMARK 没有 hsPrefixes，在"只按国家过滤"的逻辑下，卖服装的也会看到它。
  const tshirt = run({ country: 'DE', hsCode: '610910' });
  const labels = (tshirt.actions || []).map((a) => a.label);
  assert.ok(!labels.some((l) => /E-mark/.test(l)), `德国 T 恤不该要求 E-mark：${labels.join('/')}`);
  assert.ok(labels.some((l) => /纺织品标签/.test(l)), '德国 T 恤该提醒纺织品标签');

  const radiator = run({ country: 'DE', hsCode: '870891' });
  assert.ok(
    (radiator.actions || []).some((a) => /E-mark/.test(a.label)),
    '德国汽配该要求 E-mark'
  );
});

test('认证：印尼 SNI 只对受管制品类生效，T 恤不办 SNI', () => {
  const solar = run({ country: 'ID', hsCode: '854143' });
  assert.ok(
    (solar.actions || []).some((a) => /SNI/.test(a.label)),
    '印尼光伏必须提示 SNI（SNI IEC 61215）'
  );
  const tshirt = run({ country: 'ID', hsCode: '610910' });
  assert.ok(
    !(tshirt.actions || []).some((a) => /SNI/.test(a.label)),
    '印尼 T 恤不强制 SNI，提示了就是让用户白花钱'
  );
  // 汽配要提示，但 note 里必须带"散热器是否在强制清单内待确认"
  const auto = run({ country: 'ID', hsCode: '870891' });
  const sni = (auto.actions || []).find((a) => /SNI/.test(a.label));
  assert.ok(sni, '印尼汽配应提示 SNI');
  assert.match(sni.note, /确认/, '汽配的 SNI 覆盖不确定，必须写成待确认而不是确定要办');
});

test('认证：笔记本与手机的差异要算进去（越南 VR 只管汽配）', () => {
  const laptop = run({ country: 'VN', hsCode: '847130' });
  const labels = (laptop.actions || []).map((a) => a.label);
  assert.ok(labels.some((l) => /CR/.test(l)), '越南笔记本要 CR');
  assert.ok(!labels.some((l) => /VR/.test(l)), '越南笔记本不该要求机动车零部件 VR 认证');
  assert.ok(labels.some((l) => /MIC|能效/.test(l)), '越南笔记本还要 MIC 或能效');

  const radiator = run({ country: 'VN', hsCode: '870891' });
  assert.ok(
    (radiator.actions || []).some((a) => /VR/.test(a.label)),
    '越南汽配要提示 VR（安全件强制）'
  );
});

test('认证：成本一律不编，只进「要办的事」', () => {
  // 调研报告给了机构、周期、强制与否，就是没给钱。
  // 全 0 会让引擎走"仅进要办的事、不计入金额"分支——这才是对的。
  const newOnes = (params.raw.compliance || []).filter((x) => x.researchRef || x.id.match(/^(ID_|VN_|TH_|MY_|PH_|SG_|JP_|KR_|IN_|BD_|PK_|GB_|CH_|NO_|RS_|UA_|RU_|TEXTILE_|TIMBER_|ENERGY_)/));
  assert.ok(newOnes.length >= 45, `17 国认证应至少 45 条，实际 ${newOnes.length}`);
  for (const x of newOnes) {
    const money = num(x.onetime || 0) + num(x.annual || 0) + num(x.perShipment || 0);
    assert.equal(money, 0, `${x.id} 编了金额——调研没给钱，填一个数没人能核`);
    assert.ok(Array.isArray(x.leadTimeDays) && x.leadTimeDays.length === 2, `${x.id} 缺办理周期`);
    assert.ok(x.sourceUrl && x.sourceUrl.startsWith('http'), `${x.id} 缺一手来源链接`);
    assert.ok(x.note && x.note.length > 10, `${x.id} 缺办理方或关键限制说明`);
  }
});

test('认证：每条都限定了品类范围，或明确是通用要求', () => {
  const universal = new Set(['GPSR', 'EPR', 'PRODUCT_LIABILITY', 'SABER']);
  for (const x of params.raw.compliance || []) {
    if (universal.has(x.id)) continue;
    assert.ok(
      Array.isArray(x.hsPrefixes) && x.hsPrefixes.length > 0,
      `${x.id} 没写 hsPrefixes，会被当成"全品类适用"——卖什么都会看到它`
    );
    for (const p of x.hsPrefixes) {
      assert.match(String(p), /^\d{6}$/, `${x.id} 的 hsPrefixes 必须是 6 位编码：${p}`);
    }
  }
});

test('认证：认证成本不进真实成本与需备现金（金额为 0 时不能占一行金额）', () => {
  const rep = run({ country: 'ID', hsCode: '854143' });
  assert.ok((rep.actions || []).some((a) => /SNI/.test(a.label)), '要有提示');
  assert.equal(rep.expected.compliance.length, 0, '成本未入库的认证不该出现在金额明细里');
  assert.equal(num(rep.expected.complianceCost), 0, '合规金额必须是 0，不能凭空摊一笔');
  // 真实成本 = CIF + 关税 + 附加税 + 不可退税 + 规费（无合规、无 AD），逐项对得上才算没偷偷加钱
  const rebuilt = num(rep.expected.cif) + num(rep.expected.duty) + num(rep.expected.surtax) + num(rep.expected.unrefundableTax);
  assert.ok(Math.abs(num(rep.expected.landedCost) - rebuilt) < 0.02, `真实成本对不上：${rep.expected.landedCost} vs ${rebuilt}`);
});

/* ------------------------------------------------------------------ *
 * 4. 协定优惠：按国家分档
 * ------------------------------------------------------------------ */

test('协定优惠：ACFTA 纺织品是 5%，不是 0%', () => {
  const aifta = params.raw.fta.find((f) => f.code === 'AIFTA');
  const row = aifta.preferentialRates.find((r) => r.hsPrefix === '610910');
  assert.equal(num(row.rate), 0.05, '纺织品在 ACFTA 下是敏感税目，各成员保留 5%');
  assert.match(row.note, /旧数据|0%/, '要留下"曾经写错"的痕迹，否则下次又会被改回去');
});

test('协定优惠：同一协定里印尼汽配有独立档位，不被通用档覆盖', () => {
  const aifta = params.raw.fta.find((f) => f.code === 'AIFTA');
  const rows = aifta.preferentialRates.filter((r) => r.hsPrefix === '870891');
  assert.equal(rows.length, 2, '汽配应有通用档 + 印尼特化档两条');
  const generic = rows.find((r) => !r.countries);
  const idOnly = rows.find((r) => Array.isArray(r.countries));
  assert.equal(num(generic.rate), 0);
  assert.equal(num(idOnly.rate), 0.05);
  assert.deepEqual(idOnly.countries, ['ID']);

  // 走一遍引擎，确认印尼拿到 5%、泰国拿到 0%
  const id = (run({ country: 'ID', hsCode: '870891' }).fta || []).find((x) => x.code === 'AIFTA');
  const th = (run({ country: 'TH', hsCode: '870891' }).fta || []).find((x) => x.code === 'AIFTA');
  assert.equal(num(id.preferentialRate), 0.05);
  assert.equal(num(th.preferentialRate), 0);
});

test('协定优惠：ACFTA 六个品类都有档位，不留半张表', () => {
  const aifta = params.raw.fta.find((f) => f.code === 'AIFTA');
  for (const hs of ['870891', '847130', '851713', '854143', '610910', '940360']) {
    assert.ok(
      aifta.preferentialRates.some((r) => r.hsPrefix === hs),
      `ACFTA 缺 ${hs} 的优惠档`
    );
  }
});

test('协定优惠：RCEP 仍不填税率（没有逐年表，填了就是抄错一格）', () => {
  const rcep = params.raw.fta.find((f) => f.code === 'RCEP');
  assert.equal((rcep.preferentialRates || []).length, 0, 'RCEP 逐年降税表未到手，不能凭印象填');
  assert.match(rcep.note || '', /逐年/, '要在 note 里说清为什么是空的');
});
