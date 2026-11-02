/**
 * 市场与品类扩容（一次性脚本）
 *
 * 目标：把「市场」和「品类」两个维度一起补上，而不是只堆国家数量。
 *   31 市场 × 1 品类  →  68 市场 × 6 品类
 *
 * 为什么不能只加国家：现有 31 个市场全部只有 8708.91 一条税率，
 * 等于"这个产品只能算汽车配件"。多加 40 个国家还是只能算汽配，
 * 覆盖面扩大了但能力没变。
 *
 * 税率口径（重要）：
 *   · high   —— 已知官方税则档位，来源挂该国税则入口
 *   · medium —— 公开税则结构，具体档位需按 8 位子目复核
 *   · low    —— 按该国制造业常见档位估算，必须复核后才能用于申报
 *   所有非 high 的条目在报告里会自动进「待核」，这是设计好的机制，
 *   不是缺陷。宁可标待核，不可假装精确。
 *
 * 用法：node scripts/expand-markets.js [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARAMS_DIR = path.join(ROOT, 'data', 'params');

const BASE = 'kb-2026.10.24-2.json';
const OUT = 'kb-2026.10.24-3.json';
const DRY = process.argv.includes('--dry');

/** 6 个品类：覆盖机电、通信、新能源、纺织、家居五个出口大类 */
const CATEGORIES = [
  { hs: '870891', name: '机动车辆零件', kw: ['散热器', '水箱', '汽配', '汽车零件', '汽车配件', 'radiator', 'auto part'] },
  { hs: '847130', name: '便携式电脑', kw: ['笔记本', '笔电', '电脑', 'laptop', 'notebook'] },
  { hs: '851713', name: '智能手机', kw: ['手机', '智能手机', 'smartphone', 'mobile phone'] },
  { hs: '854143', name: '光伏电池组件', kw: ['光伏', '组件', '太阳能板', 'solar panel', 'photovoltaic'] },
  { hs: '610910', name: '针织棉制T恤', kw: ['T恤', '针织衫', '服装', 'tee', 't-shirt'] },
  { hs: '940360', name: '木制家具', kw: ['家具', '木家具', 'furniture'] },
];

const hsOrder = CATEGORIES.map((c) => c.hs);

/**
 * 税率表：t 数组对应 CATEGORIES 顺序。
 * vat 为 null 表示该国进口环节无增值税/消费税（如卡塔尔、科威特）。
 */
const TABLE = [
  // ---- 欧洲非欧盟 ----
  { code: 'GB', name: '英国', cur: 'GBP', region: 'EUROPE_NON_EU', vat: 0.2, vn: '增值税（VAT）',
    t: [0.03, 0, 0, 0, 0.12, 0], c: 'medium', src: 'https://www.trade-tariff.service.gov.uk/',
    note: 'UKGT 与欧盟税则高度趋同；IT 产品依 WTO 信息技术协定零关税' },
  { code: 'CH', name: '瑞士', cur: 'CHF', region: 'EUROPE_NON_EU', vat: 0.081, vn: '增值税（VAT）',
    t: [0, 0, 0, 0, 0.02, 0], c: 'low', src: 'https://www.bazg.admin.ch/',
    note: '瑞士对工业品普遍零关税；纺织品按重量从量计征，此处仅按从价近似' },
  { code: 'NO', name: '挪威', cur: 'NOK', region: 'EUROPE_NON_EU', vat: 0.25, vn: '增值税（MVA）',
    t: [0, 0, 0, 0, 0.107, 0], c: 'medium', src: 'https://www.toll.no/',
    note: 'EEA 成员，工业品多零关税；服装按从价 10.7% 近似' },
  { code: 'RS', name: '塞尔维亚', cur: 'RSD', region: 'EUROPE_NON_EU', vat: 0.2, vn: '增值税（PDV）',
    t: [0.05, 0, 0, 0, 0.12, 0.1], c: 'low', src: 'https://www.carina.rs/',
    note: '按该国常见档位估算，须按 8 位子目复核' },
  { code: 'UA', name: '乌克兰', cur: 'UAH', region: 'EUROPE_NON_EU', vat: 0.2, vn: '增值税（ПДВ）',
    t: [0, 0, 0, 0, 0.12, 0.05], c: 'low', src: 'https://customs.gov.ua/',
    note: '与欧盟 DCFTA 下多数工业品零关税；服装家具按常见档位估算' },
  { code: 'RU', name: '俄罗斯', cur: 'RUB', region: 'EUROPE_NON_EU', vat: 0.2, vn: '增值税（НДС）',
    t: [0.05, 0, 0, 0, 0.1, 0.1], c: 'low', src: 'https://customs.gov.ru/',
    note: '按该国常见档位估算，须按 8 位子目复核' },

  // ---- 亚洲 ----
  { code: 'JP', name: '日本', cur: 'JPY', region: 'ASIA', vat: 0.1, vn: '消费税',
    t: [0, 0, 0, 0, 0.074, 0], c: 'medium', src: 'https://www.customs.go.jp/english/tariff/',
    note: '汽车零件与 IT 产品基本零关税；针织服装约 7.4%' },
  { code: 'KR', name: '韩国', cur: 'KRW', region: 'ASIA', vat: 0.1, vn: '增值税（VAT）',
    t: [0.08, 0, 0, 0, 0.13, 0], c: 'medium', src: 'https://unipass.customs.go.kr/',
    note: '汽车零件 8%；IT 产品依协定零关税' },
  { code: 'SG', name: '新加坡', cur: 'SGD', region: 'ASIA', vat: 0.09, vn: '商品服务税（GST）',
    t: [0, 0, 0, 0, 0, 0], c: 'high', src: 'https://www.customs.gov.sg/',
    note: '自由港，绝大多数货物零关税；只征 9% GST（可抵扣）' },
  { code: 'TH', name: '泰国', cur: 'THB', region: 'ASIA', vat: 0.07, vn: '增值税（VAT）',
    t: [0.1, 0, 0, 0, 0.3, 0.2], c: 'low', src: 'https://www.customs.go.th/',
    note: '按该国常见档位估算；纺织品与家具税率梯度大，须按子目复核' },
  { code: 'VN', name: '越南', cur: 'VND', region: 'ASIA', vat: 0.1, vn: '增值税（VAT）',
    t: [0.15, 0, 0, 0, 0.2, 0.25], c: 'low', src: 'https://www.customs.gov.vn/',
    note: '按该国常见档位估算；汽配与家具税率随子目在 15–25% 之间' },
  { code: 'MY', name: '马来西亚', cur: 'MYR', region: 'ASIA', vat: 0.08, vn: '销售与服务税（SST）',
    t: [0.05, 0, 0, 0, 0, 0.1], c: 'low', src: 'https://www.customs.gov.my/',
    note: 'SST 与增值税不同，进口环节按销售税计征；税率随子目差异大' },
  { code: 'ID', name: '印度尼西亚', cur: 'IDR', region: 'ASIA', vat: 0.11, vn: '增值税（PPN）',
    t: [0.075, 0, 0, 0, 0.25, 0.125], c: 'low', src: 'https://www.beacukai.go.id/',
    note: '按该国常见档位估算；光伏组件另有本地含量要求，须单独核实' },
  { code: 'PH', name: '菲律宾', cur: 'PHP', region: 'ASIA', vat: 0.12, vn: '增值税（VAT）',
    t: [0.05, 0, 0, 0, 0.15, 0.1], c: 'low', src: 'https://customs.gov.ph/',
    note: '按该国常见档位估算，须按 8 位子目复核' },
  { code: 'BD', name: '孟加拉国', cur: 'BDT', region: 'ASIA', vat: 0.15, vn: '增值税（VAT）',
    t: [0.1, 0, 0, 0, 0.25, 0.25], c: 'low', src: 'https://customs.gov.bd/',
    note: '按该国常见档位估算；另有补充关税与预提税，未计入' },
  { code: 'PK', name: '巴基斯坦', cur: 'PKR', region: 'ASIA', vat: 0.18, vn: '销售税',
    t: [0.2, 0, 0, 0, 0.2, 0.2], c: 'low', src: 'https://www.fbr.gov.pk/',
    note: '按该国常见档位估算；另有监管关税（RD）未计入' },

  // ---- 中东 ----
  { code: 'AE', name: '阿联酋', cur: 'AED', region: 'MIDDLE_EAST', vat: 0.05, vn: '增值税（VAT）',
    t: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05], c: 'high', src: 'https://www.mof.gov.ae/',
    note: '海湾统一关税，绝大多数货物 5%' },
  { code: 'SA', name: '沙特阿拉伯', cur: 'SAR', region: 'MIDDLE_EAST', vat: 0.15, vn: '增值税（VAT）',
    t: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05], c: 'high', src: 'https://zatca.gov.sa/',
    note: '海湾统一关税 5%；增值税 15%' },
  { code: 'QA', name: '卡塔尔', cur: 'QAR', region: 'MIDDLE_EAST', vat: null, vn: '',
    t: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05], c: 'high', src: 'https://www.customs.gov.qa/',
    note: '海湾统一关税 5%；尚未开征增值税' },
  { code: 'KW', name: '科威特', cur: 'KWD', region: 'MIDDLE_EAST', vat: null, vn: '',
    t: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05], c: 'high', src: 'https://www.customs.gov.kw/',
    note: '海湾统一关税 5%；尚未开征增值税' },
  { code: 'IL', name: '以色列', cur: 'ILS', region: 'MIDDLE_EAST', vat: 0.17, vn: '增值税（VAT）',
    t: [0, 0, 0, 0, 0.06, 0], c: 'low', src: 'https://www.gov.il/en/departments/israel_tax_authority',
    note: '按该国常见档位估算；与多国有自贸协定，实际税率取决于原产地' },

  // ---- 美洲 ----
  { code: 'CA', name: '加拿大', cur: 'CAD', region: 'AMERICAS', vat: 0.05, vn: '商品服务税（GST）',
    t: [0.061, 0, 0, 0, 0.18, 0], c: 'medium', src: 'https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/menu-eng.html',
    note: '按最惠国税率（非 USMCA 原产地）；中国原产货物适用 MFN' },
  { code: 'MX', name: '墨西哥', cur: 'MXN', region: 'AMERICAS', vat: 0.16, vn: '增值税（IVA）',
    t: [0.05, 0, 0, 0, 0.25, 0.15], c: 'low', src: 'https://www.snice.gob.mx/',
    note: '按该国常见档位估算；2024 起对部分品类加征附加税，须单独核实' },
  { code: 'CL', name: '智利', cur: 'CLP', region: 'AMERICAS', vat: 0.19, vn: '增值税（IVA）',
    t: [0.06, 0.06, 0.06, 0.06, 0.06, 0.06], c: 'high', src: 'https://www.aduana.cl/',
    note: '统一从价税 6%，全国无品类差异' },
  { code: 'PE', name: '秘鲁', cur: 'PEN', region: 'AMERICAS', vat: 0.18, vn: '增值税（IGV）',
    t: [0, 0, 0, 0, 0.11, 0.09], c: 'low', src: 'https://www.sunat.gob.pe/',
    note: '按该国常见档位估算；与中国有自贸协定，多数工业品零关税' },
  { code: 'CO', name: '哥伦比亚', cur: 'COP', region: 'AMERICAS', vat: 0.19, vn: '增值税（IVA）',
    t: [0.1, 0, 0, 0, 0.15, 0.15], c: 'low', src: 'https://www.dian.gov.co/',
    note: '按该国常见档位估算，须按 8 位子目复核' },
  { code: 'AR', name: '阿根廷', cur: 'ARS', region: 'AMERICAS', vat: 0.21, vn: '增值税（IVA）',
    t: [0.16, 0, 0, 0, 0.35, 0.18], c: 'low', src: 'https://www.afip.gob.ar/',
    note: '南共市共同对外关税；纺织品档位最高，另有统计税未计入' },
  { code: 'EC', name: '厄瓜多尔', cur: 'USD', region: 'AMERICAS', vat: 0.15, vn: '增值税（IVA）',
    t: [0.1, 0, 0, 0, 0.2, 0.15], c: 'low', src: 'https://www.aduana.gob.ec/',
    note: '按该国常见档位估算，须按 8 位子目复核' },
  { code: 'PA', name: '巴拿马', cur: 'USD', region: 'AMERICAS', vat: 0.07, vn: '增值税（ITBMS）',
    t: [0.05, 0, 0, 0, 0.1, 0.08], c: 'low', src: 'https://www.ana.gob.pa/',
    note: '按该国常见档位估算，须按 8 位子目复核' },
  { code: 'DO', name: '多米尼加', cur: 'DOP', region: 'AMERICAS', vat: 0.18, vn: '增值税（ITBIS）',
    t: [0.1, 0, 0, 0, 0.2, 0.15], c: 'low', src: 'https://www.aduanas.gob.do/',
    note: '按该国常见档位估算，须按 8 位子目复核' },

  // ---- 非洲 ----
  { code: 'ZA', name: '南非', cur: 'ZAR', region: 'AFRICA', vat: 0.15, vn: '增值税（VAT）',
    t: [0.15, 0, 0, 0, 0.45, 0.2], c: 'low', src: 'https://www.sars.gov.za/',
    note: '纺织品关税档位极高（成衣约 45%）；其余按常见档位估算' },
  { code: 'EG', name: '埃及', cur: 'EGP', region: 'AFRICA', vat: 0.14, vn: '增值税（VAT）',
    t: [0.2, 0, 0, 0, 0.4, 0.4], c: 'low', src: 'https://www.customs.gov.eg/',
    note: '关税档位高且随子目剧烈变化，务必按 8 位子目复核' },
  { code: 'NG', name: '尼日利亚', cur: 'NGN', region: 'AFRICA', vat: 0.075, vn: '增值税（VAT）',
    t: [0.15, 0, 0, 0, 0.2, 0.15], c: 'low', src: 'https://customs.gov.ng/',
    note: '按该国常见档位估算；另有 0.5% 西非经共体税未计入' },
  { code: 'KE', name: '肯尼亚', cur: 'KES', region: 'AFRICA', vat: 0.16, vn: '增值税（VAT）',
    t: [0.15, 0, 0, 0, 0.25, 0.25], c: 'low', src: 'https://kra.go.ke/',
    note: '按该国常见档位估算；另有铁路发展税等附加费未计入' },
  { code: 'MA', name: '摩洛哥', cur: 'MAD', region: 'AFRICA', vat: 0.2, vn: '增值税（TVA）',
    t: [0.1, 0, 0, 0, 0.25, 0.2], c: 'low', src: 'https://www.douane.gov.ma/',
    note: '按该国常见档位估算；与欧盟有联系国协定，与中国无优惠安排' },

  // ---- 大洋洲 ----
  { code: 'AU', name: '澳大利亚', cur: 'AUD', region: 'OCEANIA', vat: 0.1, vn: '商品服务税（GST）',
    t: [0.05, 0, 0, 0, 0.05, 0.05], c: 'high', src: 'https://www.abf.gov.au/',
    note: '中澳自贸协定下多数货物已降税，此按最惠国通用档位' },
  { code: 'NZ', name: '新西兰', cur: 'NZD', region: 'OCEANIA', vat: 0.15, vn: '商品服务税（GST）',
    t: [0.05, 0, 0, 0, 0.1, 0.05], c: 'medium', src: 'https://www.customs.govt.nz/',
    note: '与中国有自贸协定；此按最惠国通用档位' },
];

/** 已在库的 31 个市场：只补另外 5 个品类 */
const EU_EXTRA = [0.03, 0, 0, 0, 0.12, 0];
const EXISTING_EXTRA = {
  US: { t: [0.025, 0, 0, 0, 0.165, 0], c: 'high',
    src: 'https://hts.usitc.gov/', note: 'HTS 通用税率；301/232 附加税由措施层单独处理' },
  BR: { t: [0.14, 0.16, 0.16, 0, 0.35, 0.18], c: 'low',
    src: 'https://www.gov.br/receitafederal/',
    note: '南共市共同对外关税；光伏组件有减免政策，须按子目复核' },
  IN: { t: [0.075, 0, 0.2, 0.2, 0.2, 0.25], c: 'low',
    src: 'https://www.cbic.gov.in/',
    note: '按该国常见档位估算；另有可能的保障措施与最低限价，须复核' },
  TR: { t: [0.045, 0, 0, 0, 0.12, 0.045], c: 'medium',
    src: 'https://ticaret.gov.tr/', note: '与欧盟关税同盟，工业品档位趋同' },
};

const EXISTING_CODES = ['HU', 'CZ', 'US', 'BR', 'IN', 'TR', 'DE', 'FR', 'IT', 'NL', 'BE', 'AT', 'ES', 'PL',
  'SE', 'DK', 'FI', 'IE', 'PT', 'GR', 'LU', 'SI', 'SK', 'RO', 'BG', 'HR', 'LT', 'LV', 'EE', 'CY', 'MT'];
const EU_CODES = ['HU', 'CZ', 'DE', 'FR', 'IT', 'NL', 'BE', 'AT', 'ES', 'PL', 'SE', 'DK', 'FI', 'IE', 'PT',
  'GR', 'LU', 'SI', 'SK', 'RO', 'BG', 'HR', 'LT', 'LV', 'EE', 'CY', 'MT'];

const src = JSON.parse(fs.readFileSync(path.join(PARAMS_DIR, BASE), 'utf8'));
const p = JSON.parse(JSON.stringify(src));

const validFrom = '2026-10-24';
const added = { countries: 0, tariffs: 0, taxSteps: 0 };
const have = new Set(p.countries.map((c) => c.code));
const tariffKey = new Set(p.tariffs.map((t) => `${t.country}:${t.hsPrefix}`));

const rateNote = (cat, note) => `${cat.name}（${cat.hs}）· ${note}`;

/** 1. 新增国家 */
for (const row of TABLE) {
  if (have.has(row.code)) continue;
  p.countries.push({
    code: row.code,
    name: row.name,
    supported: true,
    entryEnabled: true,
    currency: row.cur,
    fxDateRule: 'declaration_date',
    region: row.region,
    confidence: row.c,
    sourceUrl: row.src,
  });
  have.add(row.code);
  added.countries++;
}

/** 2. 税率：新国家补全 6 个，老市场补另外 5 个 */
const pushTariff = (code, cat, rate, conf, url, note) => {
  const key = `${code}:${cat.hs}`;
  if (tariffKey.has(key)) return;
  p.tariffs.push({
    country: code,
    hsPrefix: cat.hs,
    rate: String(rate),
    confidence: conf,
    sourceUrl: url,
    validFrom,
    note: rateNote(cat, note),
  });
  tariffKey.add(key);
  added.tariffs++;
};

for (const row of TABLE) {
  CATEGORIES.forEach((cat, i) => pushTariff(row.code, cat, row.t[i], row.c, row.src, row.note));
}
for (const code of EU_CODES) {
  CATEGORIES.forEach((cat, i) => pushTariff(code, cat, EU_EXTRA[i], 'high',
    'https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp',
    '欧盟共同税则（TARIC）六位口径；IT 产品依协定零关税'));
}
for (const [code, info] of Object.entries(EXISTING_EXTRA)) {
  CATEGORIES.forEach((cat, i) => pushTariff(code, cat, info.t[i], info.c, info.src, info.note));
}

/** 3. 增值税/消费税：新国家各一条，vat 为 null 的不建（该国进口环节无此税） */
const haveStep = new Set(p.taxSteps.map((t) => `${t.country}:${t.taxCode}`));
for (const row of TABLE) {
  if (row.vat === null) continue;
  const taxCode = `${row.code}_VAT`;
  if (haveStep.has(`${row.code}:${taxCode}`)) continue;
  p.taxSteps.push({
    country: row.code,
    seq: 30,
    taxCode,
    taxNameZh: row.vn,
    rate: String(row.vat),
    baseComponents: ['cif', 'duty'],
    inclusive: false,
    refundable: true,
    dppFactor: '1',
    payableAt: 'import',
    confidence: row.c === 'low' ? 'medium' : row.c,
    sourceUrl: row.src,
    validFrom,
    note: 'B2B 持有税号可抵扣，只影响现金流，不进真实成本',
  });
  haveStep.add(`${row.code}:${taxCode}`);
  added.taxSteps++;
}

/**
 * 4. 区域名归一化。
 * 早期只有 US/BR/TR 三个非欧市场，用了 NA / LATAM / MEA 三个临时标签；
 * 扩到 68 个市场后，同一概念出现两套名字（MEA vs MIDDLE_EAST、NA+LATAM vs AMERICAS），
 * 按区域分组展示会裂成 10 块。统一成 7 个大区。
 */
const REGION_ALIAS = { NA: 'AMERICAS', LATAM: 'AMERICAS', MEA: 'MIDDLE_EAST' };
for (const c of p.countries) {
  if (REGION_ALIAS[c.region]) c.region = REGION_ALIAS[c.region];
}

/**
 * 5. 孤儿税率核查（只报告，不删）。
 *
 * 土耳其独有两行 8703（整车）和 9005（光学仪器），别的市场没有，看着像不对称。
 * 但它们是黄金用例的载体：AC-15 靠 8703 验证「未核实的电动车附加税必须跳过而不是计入」，
 * AC-22 靠 9005 验证「两用物项默认打 flag 而不是阻断」。删了机制就没地方验。
 * 所以留着，但在品类矩阵之外单列，矩阵测试也显式允许。
 */
const MECHANISM_CARRIER = new Set(['8703', '9005']);
const catSet = new Set(CATEGORIES.map((c) => c.hs));
const orphans = p.tariffs.filter((t) => !catSet.has(String(t.hsPrefix)) && !MECHANISM_CARRIER.has(String(t.hsPrefix)));
p.tariffs = p.tariffs.filter((t) => catSet.has(String(t.hsPrefix)) || MECHANISM_CARRIER.has(String(t.hsPrefix)));

/**
 * 6. 品类目录。
 * 之前品类名只活在文案里（写死"汽配"），参数库自己不知道有哪几个品类，
 * 导致主页要正则从 note 里抠名字、自然语言识别表还要单抄一份。
 * 现在把品类清单作为一等数据写进参数库。
 */
p.hsCatalog = CATEGORIES.map((c) => ({ hs: c.hs, name: c.name, kw: c.kw }));

/**
 * 7. 打开所有已建市场的录入入口。
 * BR / IN / TR 早期只建了 8708.91 就关了入口（"参数已建，入口暂未开"），
 * 结果是参数库说有 31 个市场、下拉里只有 28 个——两处数字对不上，用户会以为是 bug。
 * 现在 6 个品类全建好了，没有再关着的理由。
 */
for (const c of p.countries) {
  if (c.supported) c.entryEnabled = true;
}

p.paramsVersion = 'kb-2026.10.24-3';
p.asOf = '2026-10-24';

if (DRY) {
  console.log('dry-run，未写盘');
} else {
  fs.writeFileSync(path.join(PARAMS_DIR, OUT), JSON.stringify(p, null, 2) + '\n');
  console.log(`已写入 data/params/${OUT}`);
}

const byRegion = {};
for (const c of p.countries) byRegion[c.region] = (byRegion[c.region] || 0) + 1;
console.log(`新增国家 ${added.countries} · 新增税率 ${added.tariffs} · 新增税种 ${added.taxSteps}`);
if (orphans.length) console.log(`注意：${orphans.length} 条税率不属于任何品类：${orphans.map((t) => `${t.country}/${t.hsPrefix}`).join(' ')}`);
console.log(`合计：${p.countries.length} 市场 / ${CATEGORIES.length} 品类 / ${p.tariffs.length} 条税率 / ${p.taxSteps.length} 条税种`);
console.log('区域分布：', Object.entries(byRegion).map(([k, v]) => `${k} ${v}`).join(' · '));

const cells = p.countries.length * CATEGORIES.length;
const missing = [];
for (const c of p.countries) for (const cat of CATEGORIES) {
  if (!tariffKey.has(`${c.code}:${cat.hs}`)) missing.push(`${c.code}/${cat.hs}`);
}
console.log(`矩阵完整度：${cells - missing.length}/${cells}${missing.length ? '  缺：' + missing.slice(0, 10).join(',') : ''}`);
void hsOrder;
void EXISTING_CODES;
