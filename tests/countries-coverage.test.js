/**
 * 市场覆盖的守门测试。
 *
 * 为什么要有：参数库从 6 国扩到 31 国是一次"纯数据"改动，最容易出的不是报错，
 * 而是"少写一条 taxStep / tariff"——那一国看着开通了，一点就掉进 E_MFN_MISSING。
 * 所以这里对每个声称支持的市场都真算一票，算不出来就算失败。
 *
 * 同时钉住两件事：
 *   ① 欧盟各国增值税率与官方税率表一致（写错一位就意味着整票报价差几个点）
 *   ② 每条税率/税负参数都必须带 sourceUrl + confidence + validFrom（项目自检要求）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';

const params = loadParams();

/** 欧盟 27 国标准增值税率（欧盟官方 Your Europe 税率表，2026-10 核对） */
const EU_VAT = {
  AT: 0.2, BE: 0.21, BG: 0.2, CY: 0.19, CZ: 0.21, DE: 0.19, DK: 0.25, EE: 0.24,
  ES: 0.21, FI: 0.255, FR: 0.2, GR: 0.24, HR: 0.25, HU: 0.27, IE: 0.23, IT: 0.22,
  LT: 0.21, LU: 0.17, LV: 0.21, MT: 0.18, NL: 0.21, PL: 0.23, PT: 0.23, RO: 0.21,
  SE: 0.25, SI: 0.22, SK: 0.23,
};

const SHIPMENT = {
  hsCode: '8708.91',
  fob: '48000',
  freight: '3200',
  qty: '500',
  channel: 'B2B',
  declarationDate: '2026-10-22',
};

const calc = (country) =>
  buildReport({ input: { ...SHIPMENT, country }, params, reportId: 'coverage', today: params.asOf });

test('覆盖：每个声称支持的市场，8708.91 都必须真能算出两个口径', () => {
  const supported = params.raw.countries.filter((c) => c.supported).map((c) => c.code);
  assert.ok(supported.length >= 68, `支持市场数应 ≥ 68，实际 ${supported.length}`);

  const broken = [];
  for (const code of supported) {
    const out = calc(code);
    if (!out.ok) {
      broken.push(`${code}: ${out.errors.map((e) => e.code).join(',')}`);
      continue;
    }
    const e = out.report.expected;
    assert.ok(e, `${code} 没有 expected`);
    assert.ok(Number(e.landedCost) > 0, `${code} 真实成本应大于 0`);
    assert.ok(Number(e.cashRequired) > 0, `${code} 需备现金应大于 0`);
    // 有可退增值税的市场，两个口径必须拉开——否则等于把"能退的钱"也算成了成本
    const hasRefundable = params.raw.taxSteps.some((t) => t.country === code && t.refundable === true);
    if (hasRefundable) {
      assert.notEqual(String(e.landedCost), String(e.cashRequired), `${code} 有可退项，两个口径不该相等`);
      assert.ok(
        Number(e.cashRequired) > Number(e.landedCost),
        `${code} 需备现金应高于真实成本（差额是那笔垫出去但能退的税）`
      );
    }
  }
  assert.deepEqual(broken, [], `这些市场开通了但算不出：\n${broken.join('\n')}`);
});

test('覆盖：欧盟 27 国的增值税率与国家代码一一对上，没有多也没有漏', () => {
  const euInKb = params.raw.countries.filter((c) => c.supported && c.region === 'EU').map((c) => c.code).sort();
  const expected = Object.keys(EU_VAT).sort();
  assert.deepEqual(euInKb, expected, '参数库里的欧盟成员国清单与官方清单不一致');

  for (const [code, rate] of Object.entries(EU_VAT)) {
    const step = params.raw.taxSteps.find((t) => t.country === code && t.seq === 30);
    assert.ok(step, `${code} 缺增值税那一步`);
    assert.equal(Number(step.rate), rate, `${code} 增值税率应为 ${rate * 100}%`);
    assert.deepEqual(step.baseComponents, ['cif', 'duty'], `${code} 增值税的计税基础应是 CIF + 关税`);
    assert.equal(step.refundable, true, `${code} 进口增值税应标记为可退`);
  }
});

test('覆盖：同一关税区内关税一致，金额差异只来自增值税', () => {
  // 欧盟共用一套对外税则：FOB/运费/汇率都一样时，真实成本（可退税不算成本）应当相同
  const base = calc('DE').report.expected.landedCost;
  for (const code of Object.keys(EU_VAT)) {
    assert.equal(calc(code).report.expected.landedCost, base, `${code} 与 DE 真实成本不一致，说明关税口径被改了`);
  }
  // 而需备现金必须随增值税率变化，否则说明税率没生效
  assert.notEqual(calc('LU').report.expected.cashRequired, calc('HU').report.expected.cashRequired);
  assert.ok(
    Number(calc('HU').report.expected.cashRequired) > Number(calc('LU').report.expected.cashRequired),
    '27% 的匈牙利需备现金应高于 17% 的卢森堡'
  );
});

test('覆盖：没入库的市场给的是"可操作的拒绝"，不是一句报错', () => {
  // AF 阿富汗：真实存在但参数库没建。2026-10 扩到 68 市场后越南已入库，
  // 这里必须换一个真的没建的市场，否则这条守门测试会变成自欺。
  const out = calc('AF');
  assert.equal(out.ok, false);
  const err = out.errors.find((e) => e.code === 'E_COUNTRY_UNSUPPORTED');
  assert.ok(err, '未入库市场应报 E_COUNTRY_UNSUPPORTED');
  assert.match(err.message, /参数治理/, '文案里要给出下一步动作');
  assert.ok(err.message.length < 120, `文案不该把几十个市场名全列出来（当前 ${err.message.length} 字）`);
});

test('覆盖：每条关税与税负参数都带得出处、置信度和生效日', () => {
  const rows = [...params.raw.tariffs, ...params.raw.taxSteps];
  const bad = rows
    .filter((r) => !r.sourceUrl || !r.confidence || !r.validFrom)
    .map((r) => `${r.country} ${r.hsPrefix || r.taxCode}`);
  assert.deepEqual(bad, [], `这些参数缺 sourceUrl / confidence / validFrom：${bad.join('、')}`);
});
