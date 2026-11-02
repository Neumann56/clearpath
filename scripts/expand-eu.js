/**
 * 一次性任务：把欧盟其余 25 个成员国接进参数库。
 *
 * 为什么能一次加这么多：欧盟是关税同盟，成员国共用同一套对外税则（TARIC），
 * 8708 91 的税率对 27 国完全一致；真正逐国不同的是进口环节增值税（VAT）。
 * 所以这次加的是"25 条国家记录 + 25 条共同关税 + 25 条各国 VAT"，
 * 不是 25 套互不相干的税制——后者每个国家都得单独查法条。
 *
 * 数据来源：
 *   - 关税：TARIC（沿用 HU/CZ 已有的 870891 = 3%，同一来源）
 *   - VAT：欧盟官方 Your Europe 增值税税率表（2026-10 核对）
 *
 * 走的是项目自己的治理流程：草稿 → 双人复核 → 黄金用例门禁 → 发布新版本。
 * 历史报告按各自的参数快照存着，金额不会被这次发布改掉（K4）。
 *
 * 用法：
 *   node scripts/expand-eu.js            # 只造草稿，不发布
 *   node scripts/expand-eu.js --publish  # 造草稿并发布
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDraft, publish, draftPathOf } from '../lib/paramsStore.js';
import { PARAMS_DIR } from '../lib/params.js';

const BASE = 'kb-2026.10.22.json';

const TARIC_SRC = 'https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp';
const VAT_SRC = 'https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm';

// 关税口径说明：6 位 870891 在欧盟税则里是 3%，但 8 位子目分三档。
// 写进 note，让参数治理页和报告里都能看到这个前提，而不是悄悄按 3% 算到底。
const TARIFF_NOTE = 'TARIC 8708 91 · 欧盟共同税则 3%（6 位口径）；8 位子目 8708 91 20=3%、35/91=4.5%、99=3.5%，需按实际子目复核';

/** 各国标准增值税率（欧盟官方税率表，2026-10 核对） */
const EU = [
  { code: 'DE', name: '德国', vat: '0.19', cur: 'EUR', local: 'MwSt/USt', from: '2024-01-01' },
  { code: 'FR', name: '法国', vat: '0.20', cur: 'EUR', local: 'TVA', from: '2024-01-01' },
  { code: 'IT', name: '意大利', vat: '0.22', cur: 'EUR', local: 'IVA', from: '2024-01-01' },
  { code: 'NL', name: '荷兰', vat: '0.21', cur: 'EUR', local: 'BTW', from: '2024-01-01' },
  { code: 'BE', name: '比利时', vat: '0.21', cur: 'EUR', local: 'TVA/BTW', from: '2024-01-01' },
  { code: 'AT', name: '奥地利', vat: '0.20', cur: 'EUR', local: 'USt', from: '2024-01-01' },
  { code: 'ES', name: '西班牙', vat: '0.21', cur: 'EUR', local: 'IVA', from: '2024-01-01' },
  { code: 'PL', name: '波兰', vat: '0.23', cur: 'PLN', local: 'VAT', from: '2024-01-01' },
  { code: 'SE', name: '瑞典', vat: '0.25', cur: 'SEK', local: 'Moms', from: '2024-01-01' },
  { code: 'DK', name: '丹麦', vat: '0.25', cur: 'DKK', local: 'Moms', from: '2024-01-01' },
  { code: 'FI', name: '芬兰', vat: '0.255', cur: 'EUR', local: 'ALV', from: '2024-09-01' },
  { code: 'IE', name: '爱尔兰', vat: '0.23', cur: 'EUR', local: 'VAT', from: '2024-01-01' },
  { code: 'PT', name: '葡萄牙', vat: '0.23', cur: 'EUR', local: 'IVA', from: '2024-01-01' },
  { code: 'GR', name: '希腊', vat: '0.24', cur: 'EUR', local: 'FPA / ΦΠΑ', from: '2024-01-01' },
  { code: 'LU', name: '卢森堡', vat: '0.17', cur: 'EUR', local: 'TVA', from: '2024-01-01' },
  { code: 'SI', name: '斯洛文尼亚', vat: '0.22', cur: 'EUR', local: 'DDV', from: '2024-01-01' },
  { code: 'SK', name: '斯洛伐克', vat: '0.23', cur: 'EUR', local: 'DPH', from: '2025-01-01' },
  { code: 'RO', name: '罗马尼亚', vat: '0.21', cur: 'RON', local: 'TVA', from: '2025-08-01' },
  { code: 'BG', name: '保加利亚', vat: '0.20', cur: 'BGN', local: 'DDS', from: '2024-01-01' },
  { code: 'HR', name: '克罗地亚', vat: '0.25', cur: 'EUR', local: 'PDV', from: '2024-01-01' },
  { code: 'LT', name: '立陶宛', vat: '0.21', cur: 'EUR', local: 'PVM', from: '2024-01-01' },
  { code: 'LV', name: '拉脱维亚', vat: '0.21', cur: 'EUR', local: 'PVN', from: '2024-01-01' },
  { code: 'EE', name: '爱沙尼亚', vat: '0.24', cur: 'EUR', local: 'KM', from: '2025-07-01' },
  { code: 'CY', name: '塞浦路斯', vat: '0.19', cur: 'EUR', local: 'FPA', from: '2024-01-01' },
  { code: 'MT', name: '马耳他', vat: '0.18', cur: 'EUR', local: 'VAT', from: '2024-01-01' },
];

const EU_CODES = ['HU', 'CZ', ...EU.map((c) => c.code)];

const patches = [];

for (const c of EU) {
  patches.push({
    collection: 'countries',
    field: '__add',
    to: {
      code: c.code,
      name: c.name,
      supported: true,
      entryEnabled: true,
      currency: c.cur,
      fxDateRule: 'declaration_date',
      region: 'EU',
      confidence: 'high',
      sourceUrl: TARIC_SRC,
    },
  });

  patches.push({
    collection: 'tariffs',
    field: '__add',
    to: {
      country: c.code,
      hsPrefix: '870891',
      rate: '0.03',
      confidence: 'high',
      sourceUrl: TARIC_SRC,
      validFrom: '2024-01-01',
      note: TARIFF_NOTE,
    },
  });

  patches.push({
    collection: 'taxSteps',
    field: '__add',
    to: {
      country: c.code,
      seq: 30,
      taxCode: `${c.code}_VAT`,
      taxNameZh: `增值税（${c.local}）`,
      rate: c.vat,
      baseComponents: ['cif', 'duty'],
      inclusive: false,
      refundable: true,
      dppFactor: '1',
      payableAt: 'import',
      confidence: 'high',
      sourceUrl: VAT_SRC,
      validFrom: c.from,
      note: `标准税率 ${(Number(c.vat) * 100).toFixed(Number(c.vat) * 100 % 1 === 0 ? 0 : 1)}%`,
    },
  });
}

const draft = createDraft({
  baseFile: BASE,
  patches,
  author: '运营 C（税务主管）',
  authorKey: 'ops-carol',
  note: '接入欧盟其余 25 个成员国：共同关税（TARIC 870891=3%）+ 各国标准增值税率（欧盟官方税率表），并把欧盟通用合规条目扩到全部成员国',
});

// ---- 合规条目是"一条规则 + 国家数组"，patch 的 key 表达不了，直接改草稿正文 ----
const bodyPath = draftPathOf(draft.id);
const body = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
const EU_WIDE = ['GPSR', 'EPR', 'PRODUCT_LIABILITY', 'ECE_EMARK'];
const complianceEdits = [];
for (const row of body.compliance || []) {
  if (!EU_WIDE.includes(row.id)) continue;
  const before = (row.countries || []).slice();
  row.countries = [...new Set([...before, ...EU_CODES])].sort();
  complianceEdits.push({
    collection: 'compliance',
    key: row.id,
    field: 'countries',
    from: `${before.length} 国`,
    to: `${row.countries.length} 国`,
  });
}

// 顺带修正两条国家的本币字段（原值写成 EUR，实际 HU=HUF / CZ=CZK；该字段当前不参与计算）
const currencyFixes = [];
for (const [code, cur] of [['HU', 'HUF'], ['CZ', 'CZK']]) {
  const row = (body.countries || []).find((c) => c.code === code);
  if (row && row.currency !== cur) {
    currencyFixes.push({ collection: 'countries', key: code, field: 'currency', from: row.currency, to: cur });
    row.currency = cur;
  }
}

fs.writeFileSync(bodyPath, JSON.stringify(body, null, 2), 'utf8');

// 把直接改动也记进审计，别让草稿看起来"只有 patches"
const metaPath = path.join(path.dirname(bodyPath), `${draft.id}.meta.json`);
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
meta.applied = [...meta.applied, ...complianceEdits, ...currencyFixes];
meta.directEdits = [...complianceEdits, ...currencyFixes];
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

console.log(`草稿 ${draft.id} 已生成 → 目标版本 ${draft.targetVersion}（${draft.targetFile}）`);
console.log(`  新增国家 ${EU.length} 个：${EU.map((c) => c.code).join(' ')}`);
console.log(`  新增关税 ${EU.length} 条、VAT ${EU.length} 条`);
console.log(`  合规条目扩展：${complianceEdits.map((e) => `${e.key} ${e.from}→${e.to}`).join('；')}`);
if (currencyFixes.length) console.log(`  本币修正：${currencyFixes.map((f) => `${f.key} ${f.from}→${f.to}`).join('；')}`);

if (process.argv.includes('--publish')) {
  console.log('\n发布中（会先跑黄金用例门禁）…');
  const out = publish(draft.id, { key: 'ops-alice', name: '运营 A（复核人）' });
  console.log(`已发布：${out.targetFile} · ${out.version} · 黄金用例 ${out.golden.total} 项通过`);
} else {
  console.log('\n只造了草稿，未发布。复查后执行：node scripts/expand-eu.js --publish');
}

void PARAMS_DIR;
