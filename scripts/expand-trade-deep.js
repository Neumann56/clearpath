/**
 * 第四轮扩容：贸易救济（AD/CVD）+ 协定优惠税率 + 8 位子目。
 *
 * 三件事的性质不一样，脚本里分开处理：
 *   1. remedies     —— 引擎早就写好（deposit/final 三口径），参数库是空的，填进去就生效
 *   2. FTA 优惠税率 —— 引擎只有 RVC 判定、没有税率，补字段后才可能算"省多少"
 *   3. 8 位子目     —— matchTariff 已最长前缀优先，补明细即生效，不动 6 位行
 *
 * 红线：
 *   - 不动 US/870891 的任何征税规则（黄金用例 I 靠手填保证金跑，加了参数会改金额）
 *   - 不动 6 位行的 rate（会改所有存量市场口径）
 *   - 每条新增数据必须带 sourceUrl + confidence，validateParams 会查 tariffs
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS_DIR } from '../lib/params.js';

const SRC = path.join(PARAMS_DIR, 'kb-2026.10.24-3.json');
const DEST = path.join(PARAMS_DIR, 'kb-2026.10.24-4.json');
const p = JSON.parse(fs.readFileSync(SRC, 'utf8'));

/* ------------------------------------------------------------------ *
 * 1. 贸易救济：只收已查到官方/官方转载裁决的案件
 * ------------------------------------------------------------------ */

/**
 * 计征方式必须写清楚：从价（ad_valorem）与定额（per_sqm / per_kg）混用会差一到两个数量级。
 * 印度案是"基于 CIF 征收百分比"，土耳其案是"每平方米多少美元"，两者不能互相套。
 */
const REMEDIES = [
  {
    country: 'IN',
    hsPrefix: '854143',
    remedyType: 'AD',
    caseNo: 'DGTR 太阳能电池反倾销终裁 2025-09-29',
    basis: 'ad_valorem',
    depositRate: '0.30',
    finalRateEstimate: { p50: '0.30' },
    retrospective: false,
    confidence: 'high',
    sourceUrl: 'https://sw.beijing.gov.cn/zt/mymcyd/ajyd/202511/t20251114_4280896.html',
    note:
      '基于 CIF 征收，为期 3 年。晶科、天合 0%；爱光等合作企业 23%；其他中国生产商 30%。本档按"其他生产商"取 30%——' +
      '若你的生产商在零税率名单内，请把保证金率手填为 0。',
  },
  {
    country: 'IN',
    hsPrefix: '854142',
    remedyType: 'AD',
    caseNo: 'DGTR 太阳能电池反倾销终裁 2025-09-29',
    basis: 'ad_valorem',
    depositRate: '0.30',
    finalRateEstimate: { p50: '0.30' },
    retrospective: false,
    confidence: 'high',
    sourceUrl: 'https://sw.beijing.gov.cn/zt/mymcyd/ajyd/202511/t20251114_4280896.html',
    note: '同一案件覆盖未组装太阳能电池（8541 42）。税率与 8541 43 一致，按"其他生产商"取 30%。',
  },
  {
    country: 'TR',
    hsPrefix: '854143',
    remedyType: 'AD',
    caseNo: '土耳其对华光伏组件反倾销 第 2023/26 号（第一次日落复审）',
    basis: 'per_sqm',
    unitRateUsd: '25',
    retrospective: false,
    confidence: 'high',
    sourceUrl: 'https://swj.changzhou.gov.cn/html/swj/2024/NLKNJFFL_1014/20107.html',
    note:
      '按面积定额计征，20 或 25 美元/㎡，本档取 25（反规避终裁口径）。经马来西亚 / 泰国 / 越南 / 克罗地亚 / 约旦转口同样征 25 美元/㎡；' +
      'Jinko 马来、Vina / JA / Trina 越南、Trina 泰国等名单内企业为 0。需要填总面积才出金额。',
  },
];

p.remedies = REMEDIES;

/* ------------------------------------------------------------------ *
 * 2. 协定优惠税率
 * ------------------------------------------------------------------ */

/**
 * 只写有把握的：中国—东盟自贸区对正常轨道工业品已到零关税，
 * 东盟对这些 HS 的 MFN 是 5%–30%，价差是真实的决策点。
 * RCEP 是分阶段降税、逐年不同，给 low 让人自己核，不假装确定。
 */
const AIFTA_RATES = [
  { hsPrefix: '870891', rate: '0' },
  { hsPrefix: '610910', rate: '0' },
  { hsPrefix: '940360', rate: '0' },
];

const AIFTA_MEMBERS = ['VN', 'TH', 'MY', 'ID', 'PH'];

const aifta = (p.fta || []).find((f) => f.code === 'AIFTA');
if (!aifta) throw new Error('参数库里找不到 AIFTA，脚本假设不成立，先确认结构');
aifta.preferentialRates = AIFTA_RATES.map((r) => ({
  ...r,
  certificate: 'Form E（中国—东盟原产地证书）',
  leadTimeDays: [1, 3],
  rvcThreshold: '0.40',
  conditions: '直运规则：经第三方中转需未再加工并持联运提单',
  confidence: 'medium',
  sourceUrl: 'http://fta.mofcom.gov.cn/',
  note: `覆盖 ${AIFTA_MEMBERS.join('/')}；东盟正常轨道工业品已零关税。敏感清单品类不适用，报关前按目的国税则复核。`,
}));
aifta.certificate = 'Form E（中国—东盟原产地证书）';
aifta.leadTimeDays = [1, 3];

const rcep = (p.fta || []).find((f) => f.code === 'RCEP');
if (rcep) {
  // RCEP 降税分 20 年、各国 Schedule 不同，本系统不逐格抄表，只标注结构性事实
  rcep.preferentialRates = [];
  rcep.certificate = 'RCEP 原产地证明（自证或签证机构签发）';
  rcep.leadTimeDays = [1, 5];
  rcep.note =
    'RCEP 按各国降税表分阶段实施，同一 HS 在成员国之间、不同年份的协定税率都不同。' +
    '本系统不预置具体税率以免给错数，需要时按目的国 Schedule 人工核对后手填。';
}

/* ------------------------------------------------------------------ *
 * 3. 8 位子目：只补有据可查的三档，且不改 6 位行
 * ------------------------------------------------------------------ */

/**
 * 8708 91 在欧盟 TARIC 下按用途分三档，6 位统一记 3% 是乐观值。
 * 加 8 位行后：录 8708.91（6 位）仍走 3%，录 8 位才用子目税率——互不干扰。
 */
const EU_SUBHEADINGS = [
  { hsPrefix: '87089120', rate: '0.03', label: '散热器及其零件' },
  { hsPrefix: '87089135', rate: '0.045', label: '其他（消声器、排气管、离合器及其零件等）' },
  { hsPrefix: '87089199', rate: '0.035', label: '其他零件' },
];

const EU_CODES = p.countries.filter((c) => c.region === 'EU').map((c) => c.code);
const existing = new Set(p.tariffs.map((t) => `${t.country}|${t.hsPrefix}`));
let addedSub = 0;

for (const code of EU_CODES) {
  for (const s of EU_SUBHEADINGS) {
    const key = `${code}|${s.hsPrefix}`;
    if (existing.has(key)) continue;
    p.tariffs.push({
      country: code,
      hsPrefix: s.hsPrefix,
      rate: s.rate,
      confidence: 'medium',
      sourceUrl: 'https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp',
      validFrom: '2026-01-01',
      note:
        `TARIC 8 位子目：${s.label}。6 位 8708 91 统一记 3% 属乐观值，` +
        '本行按子目实际税率；归类以报关行 TARIC 查询结果为准。',
    });
    addedSub += 1;
  }
}

/* ------------------------------------------------------------------ *
 * 4. 版本
 * ------------------------------------------------------------------ */

p.paramsVersion = 'kb-2026.10.24-4';
p.asOf = '2026-10-24';
p.changelog = [
  ...(p.changelog || []),
  {
    version: p.paramsVersion,
    date: p.asOf,
    summary: `新增贸易救济 ${REMEDIES.length} 条、AIFTA 协定优惠税率 ${AIFTA_RATES.length} 条、EU 8 位子目 ${addedSub} 条`,
    reason: '补齐反倾销（引擎早已实现、参数为空）、协定优惠（引擎只有 RVC 无税率）、8 位精度（6 位为乐观值）',
  },
];

fs.writeFileSync(DEST, JSON.stringify(p, null, 2));
console.log(`写入 ${path.basename(DEST)}`);
console.log(`  贸易救济  ${REMEDIES.length} 条（IN×2 从价、TR×1 按面积）`);
console.log(`  AIFTA 优惠 ${AIFTA_RATES.length} 条税率 × ${AIFTA_MEMBERS.length} 个东盟成员`);
console.log(`  EU 8 位子目 ${addedSub} 条（覆盖 ${EU_CODES.length} 国）`);
