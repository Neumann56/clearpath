/**
 * 品类矩阵的守门测试。
 *
 * 为什么要有：2026-10 之前参数库只有 8708.91 一个品类，
 * 31 个市场其实只能算同一件东西——"覆盖 31 国"听着像全球化，
 * 一问"我出口光伏组件能算吗"就露底。扩到 6 个品类后，
 * 最容易出的错同样不是报错，而是某个 (市场 × 品类) 格子漏建，
 * 点进去才发现 E_MFN_MISSING。
 *
 * 所以这里把整张矩阵真跑一遍：68 × 6 = 408 个组合，一个都不许空。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadParams } from '../lib/params.js';
import { buildReport } from '../lib/report.js';
import { hsMeta } from '../lib/parse.js';

const params = loadParams();
const catalog = params.raw.hsCatalog;
const supported = params.raw.countries.filter((c) => c.supported);

// 税率缺失 / 挂起时 runScenario 抛 ParamError，调用方（server.js）catch 后转 400。
// 这里复刻同一条路径，让矩阵里的"拒绝出数"能被当作一种结果来看，而不是让整轮测试崩在中间。
const calc = (country, hsCode) => {
  try {
    return buildReport({
      input: { country, hsCode, fob: '48000', freight: '3200', qty: '500', channel: 'B2B', declarationDate: params.asOf },
      params,
      reportId: 'cat-coverage',
      today: params.asOf,
    });
  } catch (e) {
    return { ok: false, errors: [{ code: e.code, message: e.message }] };
  }
};

test('矩阵：参数库自己声明了品类目录，且不空', () => {
  assert.ok(Array.isArray(catalog) && catalog.length >= 6, `品类目录应至少有 6 个，实际 ${catalog?.length ?? 0}`);
  const bad = catalog.filter((c) => !c.hs || !c.name || !Array.isArray(c.kw) || !c.kw.length);
  assert.deepEqual(
    bad.map((c) => c.hs || '?'),
    [],
    '每个品类都要有编码、中文名和识别关键词，否则自然语言录入认不出它'
  );
});

test('矩阵：每个「市场 × 品类」格子都真能算出两个口径', () => {
  const broken = [];
  const pending = [];
  let cells = 0;
  for (const c of supported) {
    for (const cat of catalog) {
      cells += 1;
      const out = calc(c.code, cat.hs);
      if (!out.ok) {
        // E_MFN_PENDING 是合法的"我不算"：该品类在这个市场不按货值百分比征（瑞士纺织品按 CHF/kg）。
        // 这类格子允许拒绝出数，但必须带一句人话说明怎么才能算——不能是空错误码。
        const codes = out.errors.map((e) => e.code);
        if (codes.length === 1 && codes[0] === 'E_MFN_PENDING' && (out.errors[0].message || '').length > 40) {
          pending.push(`${c.code}/${cat.hs}`);
          continue;
        }
        broken.push(`${c.code}/${cat.hs}: ${codes.join(',')}`);
        continue;
      }
      const e = out.report.expected;
      if (!e) {
        broken.push(`${c.code}/${cat.hs}: 没有 expected`);
        continue;
      }
      // 零关税是合法的（新加坡、ITA 产品），但成本必须大于 0
      assert.ok(Number(e.landedCost) > 0, `${c.code}/${cat.hs} 真实成本应大于 0`);
      assert.ok(Number(e.cashRequired) > 0, `${c.code}/${cat.hs} 需备现金应大于 0`);
      assert.ok(
        Number(e.cashRequired) >= Number(e.landedCost),
        `${c.code}/${cat.hs} 需备现金不该低于真实成本`
      );
    }
  }
  assert.ok(cells >= 408, `矩阵应至少 408 个组合，实际 ${cells}`);
  assert.deepEqual(broken, [], `这些格子声称能算但算不出来：\n${broken.slice(0, 20).join('\n')}`);
  // 挂起格子的数量也要守住：挂起是"诚实拒绝"，但挂起变成大面积撒手就不对了。
  // 目前只有瑞士纺织品这一个格子（从量计征，没有从价百分比）。
  assert.ok(
    pending.length <= 2,
    `挂起（拒绝出数）的格子过多，说明参数在系统性缺失而不是个别品类非从价计征：${pending.join(',')}`
  );
});

test('矩阵：品类目录与税率表一一对上，没有"声明了却没建"或"建了却没声明"', () => {
  // 土耳其的 8703（整车）与 9005（光学仪器）是机制用例的载体：
  // AC-15 靠 8703 验证未核实的电动车附加税必须跳过，AC-22 靠 9005 验证两用物项打 flag 不阻断。
  // 它们只在 1 个国家存在，不参与品类矩阵，所以在核对时单列。
  const MECHANISM_CARRIER = new Set(['8703', '9005']);
  const declared = new Set(catalog.map((c) => c.hs));
  const inTariffs = new Set(params.raw.tariffs.map((t) => String(t.hsPrefix)));
  const orphanTariff = [...inTariffs].filter(
    (hs) => !declared.has(hs) && !declared.has(hs.slice(0, 6)) && !MECHANISM_CARRIER.has(hs)
  );
  const orphanDecl = [...declared].filter((hs) => !inTariffs.has(hs));
  assert.deepEqual(orphanDecl, [], `这些品类在目录里声明了但一条税率都没有：${orphanDecl.join(',')}`);
  assert.deepEqual(orphanTariff, [], `这些税率行对应的品类没写进目录，主页不会显示它们：${orphanTariff.join(',')}`);
});

test('矩阵：同一品类在欧盟 27 国内部税率一致（共用一套对外税则）', () => {
  const eu = supported.filter((c) => c.region === 'EU').map((c) => c.code);
  for (const cat of catalog) {
    const rates = new Set();
    for (const code of eu) {
      const t = params.raw.tariffs.find((x) => x.country === code && String(x.hsPrefix) === cat.hs);
      rates.add(String(t?.rate));
    }
    assert.equal(rates.size, 1, `品类 ${cat.hs} 在欧盟内部出现多个税率：${[...rates].join(' / ')}`);
  }
});

test('矩阵：品类之间税率确实不同，不是一个数字套所有品（除少数统一税则市场）', () => {
  // 欧盟内部应至少有两个不同档位（汽配/服装有税，IT 产品零关税）
  const eu = supported.filter((c) => c.region === 'EU').map((c) => c.code);
  const deRates = new Set(
    params.raw.tariffs.filter((t) => t.country === 'DE').map((t) => String(t.rate))
  );
  assert.ok(deRates.size >= 2, `德国 6 个品类只有 ${deRates.size} 种税率，像是同一个数抄了 6 遍`);
  assert.ok(eu.length === 27, `欧盟成员国应为 27 个，实际 ${eu.length}`);
});

test('矩阵：自然语言能认出的品类，要么能算，要么当场说算不了', () => {
  // 能算的品类：hsMeta 必须标 inKb: true
  for (const cat of catalog) {
    const hits = hsMeta(params, cat.name);
    const hit = hits.find((h) => String(h.hsCode).replace('.', '') === cat.hs);
    assert.ok(hit, `按品类名「${cat.name}」搜不到自己`);
    assert.equal(hit.inKb, true, `已入库品类「${cat.name}」应标 inKb: true`);
  }
  // 未入库的品类：可以给候选，但必须标 inKb: false，不能让人以为能算
  const off = hsMeta(params, '锂电池');
  assert.ok(off.length > 0, '未入库品类也该给得出候选（否则用户不知道自己在说什么）');
  assert.ok(
    off.some((h) => h.inKb === false),
    '未入库品类必须标 inKb: false，否则用户会以为点下去就能算'
  );
});

test('匹配：税率索引按编码长度降序，保证 8 位明细不会被 6 位行挡住', () => {
  // matchTariff 用 find 取第一个能前缀匹配的行，所以"最长前缀优先"完全依赖这里的排序。
  // 将来有人加 8708 91 20（3%）这类 8 位明细时，如果排序坏了，
  // 6 位的 870891（3%）会先命中，8 位明细永远不生效——而且报错都没有，只是数悄悄算错。
  for (const [country, list] of params.idx.tariffs) {
    for (let i = 1; i < list.length; i += 1) {
      const prev = String(list[i - 1].hsPrefix).replace(/\D/g, '').length;
      const cur = String(list[i].hsPrefix).replace(/\D/g, '').length;
      assert.ok(prev >= cur, `${country} 的税率列表没按长度降序：第 ${i} 项 ${prev} 位 < 前一项 ${cur} 位`);
    }
  }
  // 每个市场都必须真能匹配到至少一条主品类税率
  for (const c of supported) {
    const t = params.idx.tariffs.get(c.code) || [];
    assert.ok(t.length > 0, `${c.code} 一条税率都没有`);
  }
});

