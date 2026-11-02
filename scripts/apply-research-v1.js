/**
 * 第五轮：消化《进口清关数据调研补充结果 v1》+《17国市场准入认证报告》。
 *
 * 四件事，性质不同，分开处理：
 *   1. tariffs     —— 东盟/欧洲/南亚 19 条税率修正（旧值是"按该国常见档位估算"，调研给了税则库口径）
 *   2. charges     —— 规费从 0 条补到 13 条（欧盟通用包 3 条 + 东盟 6 国 6 条 + 原 US/BR 4 条）
 *   3. fta         —— ACFTA 补满 6 品类，并修掉"印尼汽配 5% 被当成 0%"这个会虚报优惠的错
 *   4. compliance  —— 17 国认证从 5 条补到 ~52 条，按 hsPrefixes 分品类生效
 *
 * 红线（写在这里是因为下次改的人一定会想违反）：
 *   - 不动 IN/870891 的 7.5%：它是黄金用例 G 的标定值（BCD 7.5% → SWS 150 → IGST 3897）。
 *     调研推定 15%，与本档不一致，只能记进 note 等逐子目核实，不能直接改——改了就是 K4 被破坏。
 *   - 不动 US/870891 任何征税规则（黄金用例 I 手填保证金）。
 *   - 规费一律 enabledByDefault:false：默认不计是 v2 §11 黄金用例口径，改了所有存量报告金额都会漂。
 *   - 欧盟"3 欧元过渡关税""2 欧元处理费"不进 charges：调研明确是 B2C 小额包裹专用，
 *     B2B 整柜不适用。塞进到岸成本就是给用户凭空加钱。它们进 policyCalendar 做提醒。
 *   - 认证成本一律填 0：17 国报告只给了机构和周期，没给钱。填 0 会让引擎走
 *     "仅进「要办的事」，不计入金额"分支——这是对的，编一个办证费才是错的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARAMS_DIR } from '../lib/params.js';

const SRC = path.join(PARAMS_DIR, 'kb-2026.10.24-4.json');
const DEST = path.join(PARAMS_DIR, 'kb-2026.10.24-5.json');
const p = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const CAT = {
  '870891': '汽车散热器',
  '847130': '笔记本电脑',
  '851713': '智能手机',
  '854143': '光伏组件',
  '610910': '棉制T恤',
  '940360': '木制家具',
};

const RESEARCH_TAG = '调研补充包 v1';

/* ------------------------------------------------------------------ *
 * 1. 税率修正
 * ------------------------------------------------------------------ */

/**
 * 旧值几乎全是"按该国常见档位估算"（note 里原话），带小数的 7.5%/12.5% 是人为插值。
 * 调研值至少指名了官方税则库，但调研自己也写了"未逐条访问官方税则库、置信度待复核"，
 * 所以置信度保持 low，note 把来源和不确定性都写清楚，不因为"来源变了"就抬高置信度。
 */
const TARIFF_FIX = [
  ['TH', '940360', '0.10', `${RESEARCH_TAG} 表 1.1（Thai Customs Tariff DB 推定值），替代原先的档位估算；泰国对家具另有木材来源与甲醛要求，报关前按 8 位子目复核`],
  ['MY', '610910', '0.20', `${RESEARCH_TAG} 表 1.1（JKDM 推定值）。原值 0% 与之相差 20 个点，是本轮影响最大的一处修正——马来西亚对针织服装并不免税；另需注意 SST 与增值税不是同一件事`],
  ['MY', '940360', '0', `${RESEARCH_TAG} 表 1.1（JKDM 推定值），替代原先的 10% 档位估算；木家具须符合 TLAS 木材合法性，与关税是两件事`],
  ['ID', '870891', '0.15', `${RESEARCH_TAG} 表 1.1（BTBMI 推定值），替代原先的 7.5% 插值；印尼汽配另有 SNI 强制认证，未取证不得清关`],
  ['ID', '854143', '0.05', `${RESEARCH_TAG} 表 1.1（BTBMI 推定值）。原值 0% 与调研值不一致，光伏在印尼并非零关税；另有本地含量（TKDN）要求须单独核`],
  ['ID', '940360', '0.10', `${RESEARCH_TAG} 表 1.1（BTBMI 推定值），替代原先的 12.5% 插值`],
  ['PH', '870891', '0.03', `${RESEARCH_TAG} 表 1.1（Philippines Tariff Commission 推定值），替代原先的 5% 档位估算；菲律宾对安全件另有 PS/ICC 强制认证`],
  ['PH', '940360', '0', `${RESEARCH_TAG} 表 1.1（Philippines Tariff Commission 推定值），替代原先的 10% 档位估算`],
  ['RS', '870891', '0.03', `${RESEARCH_TAG} 表 1.2（与欧盟税则对齐），替代原先的 5% 档位估算；塞尔维亚为 EU 候选国，税则逐年向欧盟靠`],
  ['RS', '940360', '0', `${RESEARCH_TAG} 表 1.2（与欧盟税则对齐），替代原先的 10% 档位估算`],
  ['UA', '870891', '0.03', `${RESEARCH_TAG} 表 1.2（与欧盟 DCFTA 对齐），原值 0% 偏低；乌克兰正处战时状态，法规执行存在不确定性`],
  ['UA', '940360', '0', `${RESEARCH_TAG} 表 1.2（与欧盟 DCFTA 对齐），替代原先的 5% 档位估算`],
  ['RU', '610910', '0.15', `${RESEARCH_TAG} 表 1.2（EAEU 共同关税），替代原先的 10% 档位估算；现况下俄罗斯业务建议延后处理`],
  ['RU', '940360', '0.05', `${RESEARCH_TAG} 表 1.2（EAEU 共同关税），替代原先的 10% 档位估算`],
  ['IN', '940360', '0.10', `${RESEARCH_TAG} 表 1.3（CBIC 推定值），替代原先的 25% 档位估算——原值高了一倍半；印度另有 SWS 社会附加税按关税 10% 计，已由税链单独处理`],
  ['BD', '870891', '0.15', `${RESEARCH_TAG} 表 1.3 推定值，替代原先的 10% 档位估算；孟加拉整体关税偏高，另有补充关税与预提税未计入`],
  ['BD', '847130', '0.10', `${RESEARCH_TAG} 表 1.3 推定值。原值 0% 不成立——孟加拉不是 ITA 扩围成员，电脑不享受零关税`],
  ['BD', '851713', '0.10', `${RESEARCH_TAG} 表 1.3 推定值，原值 0% 不成立（同上，非 ITA 成员）`],
  ['BD', '854143', '0.10', `${RESEARCH_TAG} 表 1.3 推定值，原值 0% 不成立（同上，非 ITA 成员）`],
  ['PK', '847130', '0.10', `${RESEARCH_TAG} 表 1.3 推定值，原值 0% 不成立；巴基斯坦另有监管关税（RD）未计入`],
  ['PK', '851713', '0.10', `${RESEARCH_TAG} 表 1.3 推定值，原值 0% 不成立；另有监管关税（RD）未计入`],
  ['PK', '854143', '0.10', `${RESEARCH_TAG} 表 1.3 推定值，原值 0% 不成立；另有监管关税（RD）未计入`],
];

let fixCount = 0;
for (const [country, hs, rate, note] of TARIFF_FIX) {
  const row = p.tariffs.find((t) => t.country === country && t.hsPrefix === hs);
  if (!row) throw new Error(`税率行不存在：${country}/${hs}`);
  row.rate = rate;
  row.confidence = 'low';
  row.note = note;
  row.validFrom = row.validFrom || '2026-10-24';
  row.researchRef = 'research-v1#T1';
  fixCount += 1;
}

// 印度 870891：黄金用例 G 的标定值，动不得。把分歧写进 note，别让它无声消失。
const inAuto = p.tariffs.find((t) => t.country === 'IN' && t.hsPrefix === '870891');
inAuto.note =
  '样例口径 BCD 7.5%（黄金用例 G 的标定值，改动会让 IGST 3897.00 / 税费合计 5547.00 全部漂移，K4 不允许）。' +
  '调研补充包 v1 表 1.3 推定 15%，与本档不一致——印度汽配按子目、按年度通知变动频繁，' +
  '报价前必须以 CBIC 最新 Customs Notification 逐条确认 8 位子目税率，不要直接引用本档';
inAuto.researchRef = 'research-v1#T1-disputed';

/**
 * 瑞士 610910：从量计征（CHF 0–5/kg），没有可用的从价百分比。
 * 原来的 2% 是"按从价近似"编出来的——对一件 200g 的 T 恤，CHF 5/kg 折算下来可能超过 30%，
 * 跟 2% 差一个数量级。宁可拒绝出数，也不能拿 2% 当答案。
 */
const chTshirt = p.tariffs.find((t) => t.country === 'CH' && t.hsPrefix === '610910');
chTshirt.rate = null;
chTshirt.pending = true;
chTshirt.confidence = 'low';
chTshirt.note =
  '瑞士对针织 T 恤按重量从量计征（CHF 0–5/kg，按纤维成分与织法分档），没有对应的从价百分比。' +
  '两个方案：① 向报关行索取本票按毛重计征的应缴税额后手填；② 改按实际申报结果回填校准。' +
  '此前这里的 2% 是从价近似值，与真实从量税额可能相差一个数量级，已撤下';
chTshirt.researchRef = 'research-v1#T1';

/* ------------------------------------------------------------------ *
 * 2. 规费
 * ------------------------------------------------------------------ */

const EU27 = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

/**
 * 欧元与美元的折算写死在这里，不建 fx 表：这些规费本身是报关行给的量级，
 * 汇率波动 2% 对总额的影响不到 0.02%——为它建一张需要维护的汇率表，是拿复杂度换零收益。
 * 原始本币金额放在 localText 里，报告上能一眼看到"这条按什么价折的"。
 */
const EUR_USD = 1.1;

const NEW_CHARGES = [
  // —— 欧盟通用包（27 国）——
  {
    id: 'EU_CUSTOMS_AGENT',
    countries: EU27,
    code: 'EU_CUSTOMS_AGENT',
    label: '报关代理费（代理报价）',
    chargeType: 'service',
    rangeUsd: [String(80 * EUR_USD), String(200 * EUR_USD)],
    localText: '€80–200 / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://taxation-customs.ec.europa.eu/',
    validFrom: '2026-10-24',
    note:
      '欧盟各国报关行报价区间，欧元按 1:1.10 折美元。这是代理服务费，不是海关收取的官费，' +
      '不进口径，只影响现金流。整柜与拼箱差异主要体现在 THC 上，这一项按票收',
  },
  {
    id: 'EU_THC',
    countries: EU27,
    code: 'EU_THC',
    label: '码头操作费 THC（代理报价）',
    chargeType: 'service',
    rangeUsd: [String(50 * EUR_USD), String(150 * EUR_USD)],
    localText: '€50–150 / 柜',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://taxation-customs.ec.europa.eu/',
    validFrom: '2026-10-24',
    note: '整柜按柜收；拼箱按立方折算，通常按 1 柜 ≈ 25–30 立方折算单票金额。港口与船公司不同差异较大',
  },
  {
    id: 'EU_DOC_FEE',
    countries: EU27,
    code: 'EU_DOC_FEE',
    label: '单证费（代理报价）',
    chargeType: 'service',
    rangeUsd: [String(15 * EUR_USD), String(50 * EUR_USD)],
    localText: '€15–50 / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://taxation-customs.ec.europa.eu/',
    validFrom: '2026-10-24',
    note: '商业发票、装箱单之外的附加单证（原产地证、检验证书、使领馆认证等）制作费用',
  },

  // —— 东盟 6 国 ——
  {
    id: 'TH_CUSTOMS_FEE',
    country: 'TH',
    code: 'TH_CUSTOMS_FEE',
    label: '海关申报规费 + EDI 系统费',
    chargeType: 'official',
    fixedUsd: (2200 / 35.5).toFixed(2),
    localText: '约 2,000 THB / 票 + 200 THB EDI',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://www.customs.go.th/',
    validFrom: '2026-10-24',
    note: '泰铢按 1:35.5 折算。仅为海关与 EDI 官方收费，不含报关行服务费',
  },
  {
    id: 'VN_CUSTOMS_FEE',
    country: 'VN',
    code: 'VN_CUSTOMS_FEE',
    label: '海关申报规费（官方费率）',
    chargeType: 'official',
    fixedUsd: (20000 / 25400).toFixed(2),
    localText: '20,000 VND / 申报',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://www.customs.gov.vn/',
    validFrom: '2025-10-12',
    note:
      '越南官方申报规费极低（不足 1 美元），真正的清关成本在报关行服务费上，那一部分须向货代索取。' +
      '费率依据 Circular 86/2025/TT-BTC（2025-10-12 起），越盾按 1:25,400 折算',
  },
  {
    id: 'MY_CUSTOMS_FEE',
    country: 'MY',
    code: 'MY_CUSTOMS_FEE',
    label: '清关处理费',
    chargeType: 'official',
    fixedUsd: (50 / 4.45).toFixed(2),
    localText: '50 MYR / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://www.customs.gov.my/',
    validFrom: '2026-10-24',
    note: '另有滞报金 50 MYR/天（逾期申报），属罚款性质，不计入正常到岸成本。马币按 1:4.45 折算',
  },
  {
    id: 'ID_CUSTOMS_AGENT',
    country: 'ID',
    code: 'ID_CUSTOMS_AGENT',
    label: '清关代理费（含 PIB 系统费）',
    chargeType: 'service',
    rangeUsd: ['80', '200'],
    localText: '约 $80–200 / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://www.beacukai.go.id/',
    validFrom: '2026-10-24',
    note: '印尼清关必须由持牌 PPJK 代理申报，这笔费用无法自行办理省掉',
  },
  {
    id: 'PH_CUSTOMS_AGENT',
    country: 'PH',
    code: 'PH_CUSTOMS_AGENT',
    label: '清关代理费',
    chargeType: 'service',
    rangeUsd: ['60', '120'],
    localText: '约 $60–120 / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://customs.gov.ph/',
    validFrom: '2026-10-24',
    note: '按票收，与货量关系不大；菲律宾清关时效波动较大，可能产生滞港费，那部分不在本项',
  },
  {
    id: 'SG_CUSTOMS_FEE',
    country: 'SG',
    code: 'SG_CUSTOMS_FEE',
    label: '清关费（TradeNet）',
    chargeType: 'official',
    fixedUsd: (10 / 1.3).toFixed(2),
    localText: '约 10 SGD / 票',
    enabledByDefault: false,
    confidence: 'low',
    sourceUrl: 'https://www.customs.gov.sg/',
    validFrom: '2026-10-24',
    note: '新加坡通过 TradeNet 单一窗口申报，官方费用很低；新元按 1:1.30 折算',
  },
];

const chargeIds = new Set((p.charges || []).map((c) => c.code));
for (const c of NEW_CHARGES) {
  if (chargeIds.has(c.code)) throw new Error(`规费编码重复：${c.code}`);
  p.charges.push(c);
}

/* ------------------------------------------------------------------ *
 * 3. 自贸协定：ACFTA 补满 + 修正 610910
 * ------------------------------------------------------------------ */

const aifta = p.fta.find((f) => f.code === 'AIFTA');
if (!aifta) throw new Error('AIFTA 协定不存在');

const FORM_E = {
  certificate: 'Form E（中国—东盟原产地证书）',
  leadTimeDays: [1, 3],
  rvcThreshold: '0.40',
  conditions: '直运规则：经第三方中转需未再加工并持联运提单',
  confidence: 'medium',
  sourceUrl: 'http://fta.mofcom.gov.cn/',
};

/**
 * 旧数据里 610910 → 0% 是错的。调研原文："纺织品在 ACFTA 下为敏感税目，各国保留 5% 优惠税率"。
 * 把 0% 报给用户，等于替他假设了一个他拿不到的 5 个点——这类错比"没数据"更危险，
 * 因为报告上看起来是有数据、有省额的。
 */
aifta.preferentialRates = [
  { hsPrefix: '870891', rate: '0', ...FORM_E, note: '汽车零件在 ACFTA 下多数成员已降至零' },
  {
    hsPrefix: '870891',
    rate: '0.05',
    countries: ['ID'],
    ...FORM_E,
    note: '印尼对汽配保留敏感税目 5%——这一档只对印尼成立，其余成员是 0%。旧数据把全体成员都当 0%，会虚报 5 个点的优惠',
  },
  { hsPrefix: '847130', rate: '0', ...FORM_E, note: '笔记本电脑已零关税' },
  { hsPrefix: '851713', rate: '0', ...FORM_E, note: '智能手机已零关税' },
  { hsPrefix: '854143', rate: '0', ...FORM_E, note: '光伏组件已零关税' },
  {
    hsPrefix: '610910',
    rate: '0.05',
    ...FORM_E,
    confidence: 'low',
    note: '纺织品是 ACFTA 敏感税目，各成员统一保留 5%（仍显著低于 MFN 的 15%–30%）。旧数据写 0%，已修正',
  },
  { hsPrefix: '940360', rate: '0', ...FORM_E, note: '木家具已零关税；木材合法性（FLEGT/TLAS）是另一套要求，不在关税里' },
];

const rcep = p.fta.find((f) => f.code === 'RCEP');
if (rcep) {
  rcep.note =
    (rcep.note || '') +
    (rcep.note ? ' ' : '') +
    'RCEP 分 20 年逐年降税，各成员国的年度税率表不同，凭一张总表会算错年份。' +
    '调研补充包 v1 未提供逐年表（表 5.1 注：需作为第二批，先做日韩汽配品类），' +
    '因此本版仍不填优惠税率——宁可显示"暂无"，也不给一个抄错一格就错的数';
}

/* ------------------------------------------------------------------ *
 * 4. 政策日历：欧盟两项 B2C 新收费（不进到岸成本，只做提醒）
 * ------------------------------------------------------------------ */

const NEW_POLICY = [
  {
    date: '2026-07-01',
    label: '欧盟 3 欧元过渡关税生效（仅 ≤€150 的 B2C 包裹，按 HS 税目计）',
    type: 'FEE',
    sourceUrl: 'https://eur-lex.europa.eu',
    note: '理事会条例 (EU) 2026/382。B2B 一般贸易不适用，本引擎不计入到岸成本；走 B2C 直邮需另计',
  },
  {
    date: '2026-11-01',
    label: '欧盟海关处理费 2 欧元/品项生效（B2C 远距销售）',
    type: 'FEE',
    sourceUrl: 'https://taxation-customs.ec.europa.eu/',
    note: 'TAXUD 2026-10-08 指引。同样只针对 B2C 小额包裹，B2B 整柜拼箱不受影响',
  },
];

const polKeys = new Set((p.policyCalendar || []).map((x) => `${x.date}|${x.label}`));
for (const x of NEW_POLICY) {
  if (!polKeys.has(`${x.date}|${x.label}`)) p.policyCalendar.push(x);
}

/* ------------------------------------------------------------------ *
 * 5. 认证要求：17 国 × 6 品类
 * ------------------------------------------------------------------ */

const S17 = ['ID', 'VN', 'TH', 'MY', 'PH', 'SG', 'JP', 'KR', 'IN', 'BD', 'PK', 'GB', 'CH', 'NO', 'RS', 'UA', 'RU'];

/**
 * 成本一律 0，这是刻意的。
 *
 * 《17 国市场准入认证报告》给的是"办什么证、多久、谁办、强制与否"，没给钱。
 * 发动机遇到 onetime/annual/perShipment 全 0 的记录，会把它放进「要办的事」而不是金额——
 * 这条路径是给"知道有这个要求但不知道要花多少钱"准备的。凭感觉填一个"SNI 约 $2000"，
 * 报告上就会多一条看起来精确、实际没有任何依据的成本，而且没人会去查。
 *
 * hsPrefixes 是这轮新加的字段：认证按品类走，不按国家走。
 * 印尼 SNI 管光伏不代表管 T 恤；韩国 KC 管汽配不代表管木家具。不按品类过滤，
 * 卖 T 恤的人会被要求去办 SNI（白花钱），卖光伏的人反而不一定看到该看的证（会扣货）。
 */
const CH_ = ['B2B', 'B2C'];
const c = (o) => ({
  channels: CH_,
  onetime: '0',
  annual: '0',
  perShipment: '0',
  trigger: 'regulated_product',
  mandatory: true,
  confidence: 'medium',
  researchRef: 'research-v1#P1-1',
  ...o,
});

/**
 * 给原有记录补上品类范围。
 *
 * ECE_EMARK 是欧盟汽配认证，但老记录没有 hsPrefixes——在"只按国家过滤"的旧逻辑下，
 * 卖 T 恤的德国客户也会被告知"要办 E-mark"。这个错一直存在，只是没人点开看过。
 * 新加 hsPrefixes 过滤后它就暴露出来了，顺手补上。
 * 其余 4 条（GPSR / EPR / PRODUCT_LIABILITY / SABER）确实是与品类无关的通用要求，不补。
 */
const ece = (p.compliance || []).find((x) => x.id === 'ECE_EMARK');
if (ece) ece.hsPrefixes = ['870891'];

const NEW_COMPLIANCE = [
  /* ---------------- 东盟 6 国 ---------------- */
  c({
    id: 'ID_SNI',
    label: 'SNI 国家标准认证',
    countries: ['ID'],
    hsPrefixes: ['847130', '851713', '854143', '870891'],
    leadTimeDays: [120, 180],
    sourceUrl: 'https://www.bsn.go.id/',
    note:
      '办理方：进口商或制造商，境外企业须指定印尼官方代表 + 本地商标注册 + 本地仓库。' +
      '汽配只有 24 项关键安全件在强制清单内，散热器是否被归为散热系统关键件必须与进口商确认；' +
      '光伏按 SNI IEC 61215；2025-06 起音视频设备新增强制（SNI IEC 62368-1:2014）',
  }),
  c({
    id: 'ID_POSTEL',
    label: 'POSTEL 电信设备认证',
    countries: ['ID'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.kominfo.go.id/',
    note: '通信部 Kominfo 主管。带无线功能的笔记本与手机都须办，须本地代表提交',
  }),
  c({
    id: 'VN_CR',
    label: 'CR 符合性法规认证',
    countries: ['VN'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [42, 56],
    sourceUrl: 'https://tcvn.gov.vn/',
    note:
      '依据 15/2024/TT-BCT（2024-07 生效）取代旧 VCCE 体系，覆盖 6 大类 83 种产品，须越南本地代理提交。' +
      '汽配走 CR 或 VR 其中一条，不是两条都要',
  }),
  c({
    id: 'VN_VR',
    label: 'VR 机动车零部件认证',
    countries: ['VN'],
    hsPrefixes: ['870891'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.vr.org.vn/',
    note:
      '安全件强制：安全玻璃 QCVN 32、轮毂 QCVN 78、后视镜 QCVN 45、灯具 QCVN 51、轮胎 QCVN 62。' +
      '关键区别：VR 必须由制造商直接申请，进口商不能代；已有 ECE/EC 认证可豁免部分测试，周期缩短 30% 以上',
  }),
  c({
    id: 'VN_MIC',
    label: 'MIC 无线电设备型式认证',
    countries: ['VN'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://mic.gov.vn/',
    note: '带 WiFi / 蓝牙的笔记本同样须 MIC 型号核准，不只是手机',
  }),
  c({
    id: 'TH_TISI',
    label: 'TISI 泰国工业标准认证',
    countries: ['TH'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [90, 180],
    sourceUrl: 'https://www.tisi.go.th/',
    note:
      '截至 2025-07 含 147 个强制标准。汽配实行"整车 + 零部件"双重认证体系，' +
      '散热器若非清单内安全件可能只需自愿认证——这一点必须在报价前确认，两种情形差一整轮认证',
  }),
  c({
    id: 'TH_NBTC',
    label: 'NBTC 无线电通信设备认证',
    countries: ['TH'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [14, 35],
    sourceUrl: 'https://www.nbtc.go.th/',
    note: '手机须 Class B Approval（3–5 周）；笔记本走 SDoC（2–4 周）。2025-06-30 起禁止仅 2G/3G 设备进口与认证',
  }),
  c({
    id: 'MY_SIRIM',
    label: 'SIRIM 认证（ST Mark + MCMC CoA）',
    countries: ['MY'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [56, 84],
    sourceUrl: 'https://www.sirim.my/',
    note:
      '双轨监管：能源委员会（ST）管电气安全、MCMC 管无线设备。持证代理必须是马来西亚本地注册公司。' +
      '2025-07 起 IPv6 全协议强制测试；ST-SIRIM 标贴须直接加施于产品本体（2024-09 起）',
  }),
  c({
    id: 'MY_MCMC',
    label: 'MCMC 无线电设备认证',
    countries: ['MY'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.mcmc.gov.my/',
    note: '与 SIRIM 的安全认证并行，不是替代关系：同一台手机要过安全、EMC、无线三道',
  }),
  c({
    id: 'MY_ROHS',
    label: 'SIRIM RoHS 2.0 有害物质声明',
    countries: ['MY'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [56, 84],
    sourceUrl: 'https://www.sirim.my/',
    note: '2026 年起强制纳入 SIRIM 认证，管控 10 种有害物质，与 SIRIM 申请同步办理不额外拉长周期（周期按 SIRIM 计）',
  }),
  c({
    id: 'PH_PS_ICC',
    label: 'PS 标志 / ICC 清关标志（二选一）',
    countries: ['PH'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [14, 180],
    sourceUrl: 'https://www.bps.dti.gov.ph/',
    note:
      '两条路差别很大，选错就是白等三个月：PS 标志走持续量产（须工厂审查、证书 3 年、年度监督，3–6 个月）；' +
      'ICC 走单批次进口（每批申请、无需工厂审查，2–4 周）。只做一两票货就走 ICC。' +
      '周期跨度 14–180 天就是这个原因，不是数据不准',
  }),
  c({
    id: 'PH_NTC',
    label: 'NTC 型式核准',
    countries: ['PH'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://ntc.gov.ph/',
    note: '带无线功能的笔记本同样须 NTC 核准',
  }),
  c({
    id: 'SG_SAFETY_MARK',
    label: 'Safety Mark 消费者保护安全标志',
    countries: ['SG'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.enterprisesg.gov.sg/',
    note:
      'CPSR 法规下 33 类受控商品，按风险分低/中/高三档：高风险（如热水器）须 3 年内新全项测试，低风险可用 SDoC。' +
      '证书持有者必须是新加坡注册公司，外国企业不能直接申请——这是最常见的卡点。' +
      '汽配不在受控商品清单内，故本条不含 870891',
  }),
  c({
    id: 'SG_IMDA',
    label: 'IMDA 电信设备注册',
    countries: ['SG'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [14, 28],
    sourceUrl: 'https://www.imda.gov.sg/',
    note: '电信设备注册，与 Safety Mark 不是一回事：Safety Mark 管电气安全，IMDA 管无线与电信接口，同一台设备要过两道',
  }),

  /* ---------------- 东亚 2 国 ---------------- */
  c({
    id: 'JP_PSE',
    label: 'PSE 电气用品安全认证',
    countries: ['JP'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [14, 42],
    sourceUrl: 'https://www.meti.go.jp/',
    note:
      '圆形 PSE（341 种，自我声明，证书 1–3 年）与菱形 PSE（116 种，须第三方认证 + 工厂审核，证书 3–7 年）是两套，' +
      '手机适配器走菱形、笔记本走圆形。2025-12 修订生效后，跨境电商卖家被定义为"特定进口商"，须指定日本国内管理人。' +
      '光伏面板本身不直接接市电，通常豁免，须看电源系统是否随货',
  }),
  c({
    id: 'JP_METI',
    label: 'METI 经济产业省备案',
    countries: ['JP'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [5, 7],
    sourceUrl: 'https://www.meti.go.jp/',
    note: '所有 PSE 认证产品都要备案，5–7 个工作日。须日本进口商或指定日本国内管理人办理，不能由境外企业直接提交',
  }),
  c({
    id: 'JP_MIC',
    label: 'MIC / TELEC 无线电认证（技适标志）',
    countries: ['JP'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.tele.soumu.go.jp/',
    note: '技术基准适合证明（技适），产品须加施技适标志（Giteki）',
  }),
  c({
    id: 'JP_VEHICLE_TYPE',
    label: '汽车型式指定（道路运送车辆法）',
    countries: ['JP'],
    hsPrefixes: ['870891'],
    leadTimeDays: [56, 112],
    sourceUrl: 'https://www.mlit.go.jp/',
    note:
      '日本走独立型式认证体系，UNECE E-mark 不能直接替代。整车厂通常已覆盖本项，' +
      '做售后件市场（aftermarket）才需要自己走一遍',
  }),
  c({
    id: 'KR_KC_SAFETY',
    label: 'KC 安全认证',
    countries: ['KR'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.kats.go.kr/',
    note: '须韩国本地授权代表。持有效 CB 报告可转证，周期缩到 2–3 周',
  }),
  c({
    id: 'KR_KC_EMC',
    label: 'KC 电磁兼容认证',
    countries: ['KR'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.rra.go.kr/',
    note: '额定电压 ≥50V AC 或 ≥75V DC 的产品均须，与 KC 安全认证是两套流程',
  }),
  c({
    id: 'KR_KC_RF',
    label: 'KC 无线电认证',
    countries: ['KR'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.rra.go.kr/',
    note: '2025 年新增：物联网设备须做 KC 网络安全测试（KN18031 渗透测试），这是近年最常见的漏项',
  }),
  c({
    id: 'KR_MEPS',
    label: 'MEPS 最低能效标准与能效标签',
    countries: ['KR'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.kemco.or.kr/',
    note: '能效 1–5 级标签；手机适配器须满足待机功耗 ≤1W',
  }),

  /* ---------------- 南亚 3 国 ---------------- */
  c({
    id: 'IN_BIS_CRS',
    label: 'BIS 强制注册（CRS）',
    countries: ['IN'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [120, 180],
    sourceUrl: 'https://www.bis.gov.in/',
    note:
      '注册制、无需工厂审查，但要印度授权代表（AIR）+ BIS 认可实验室测试。' +
      '已列入 80 多类电子 IT 产品。光伏除 CRS 外还要 ISI 与两项 EPR，见 IN_BIS_ISI',
  }),
  c({
    id: 'IN_BIS_ISI',
    label: 'BIS 标准标志（ISI）',
    countries: ['IN'],
    hsPrefixes: ['870891', '854143'],
    leadTimeDays: [180, 240],
    sourceUrl: 'https://www.bis.gov.in/',
    note:
      '须工厂审查，周期最长的一项。光伏：IS 14286 + 2025 年新 QCO，且须 BIS + REEIMS + 电子废物 EPR + 塑料废物 EPR 四重合规，' +
      '缺任何一项都清不了关。汽配：QCO 覆盖约 769 种产品，含 24 类汽车零部件',
  }),
  c({
    id: 'IN_TEC',
    label: 'TEC / MTCTE 电信设备认证',
    countries: ['IN'],
    hsPrefixes: ['851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.tec.gov.in/',
    note: 'MTCTE 电信设备强制测试与认证，手机与带蜂窝功能的设备都须。与 WPC 是两件事：TEC 管电信接口协议，WPC 管射频，缺一项都过不了关',
  }),
  c({
    id: 'IN_WPC',
    label: 'WPC 无线电频率核准（ETA）',
    countries: ['IN'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.dot.gov.in/',
    note: '带 WiFi / 蓝牙的笔记本同样须 ETA，只做手机不够',
  }),
  c({
    id: 'IN_BEE',
    label: 'BEE 能效星标',
    countries: ['IN'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://beeindia.gov.in/',
    note: '能效星标，笔记本本体与随货适配器都要注册；星级须标在产品与包装上，只做注册不贴标一样会被查',
  }),
  c({
    id: 'BD_BSTI',
    label: 'BSTI 标准认证',
    countries: ['BD'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [28, 42],
    sourceUrl: 'http://www.bsti.gov.bd/',
    note:
      '截至 2025 年 299 种产品强制认证，含 27 种电子产品。须当地代理。' +
      '光伏的具体认证路径调研方也未能确认，须直接向 BSTI 问',
    confidence: 'low',
  }),
  c({
    id: 'BD_BSTI_ROHS',
    label: 'BSTI RoHS 有害物质声明',
    countries: ['BD'],
    hsPrefixes: ['847130', '851713', '854143'],
    leadTimeDays: [28, 35],
    sourceUrl: 'http://www.bsti.gov.bd/',
    note: '2024-01 起强制，6 种有害物质限值对标 EU RoHS 2.0；BSTI 联合海关做 AI 审查，声明不实会被扣货',
  }),
  c({
    id: 'BD_BTRC',
    label: 'BTRC 电信设备认证',
    countries: ['BD'],
    hsPrefixes: ['851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'http://www.btrc.gov.bd/',
    note: '孟加拉电信监管委员会型式核准；手机还须在 BTRC 备案 IMEI，未备案无法入网',
  }),
  c({
    id: 'PK_PSQCA',
    label: 'PSQCA 认证 + COC 清关证书',
    countries: ['PK'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [60, 120],
    sourceUrl: 'https://www.psqca.com.pk/',
    note:
      '105 种产品强制认证，两条路：FMCS（外国制造商许可，适合长期供货）与 CAR（批次清关证书，适合单票）。' +
      '受管制产品清关时必须持 PSQCA 签发的 COC，没有 COC 到港也提不出来',
  }),
  c({
    id: 'PK_PTA',
    label: 'PTA 电信设备型式核准',
    countries: ['PK'],
    hsPrefixes: ['851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.pta.gov.pk/',
    note: '除型式核准外还要做 IMEI 注册，漏了 IMEI 的手机在巴基斯坦无法入网',
  }),

  /* ---------------- 欧洲及独联体 6 国 ---------------- */
  c({
    id: 'GB_UKCA',
    label: 'UKCA 标志（或 CE，二选一）',
    countries: ['GB'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [14, 84],
    sourceUrl: 'https://www.gov.uk/guidance/ukca-marking',
    note:
      '2024-10 起 CE 在英国无限期有效，CE 或 UKCA 二选一，不必重复认证——这一条能省掉一整轮费用。' +
      '自我声明 2–4 周，需要公告机构的 8–12 周。无线产品走 UKCA-RED；须英国境内责任方。' +
      '汽配：UNECE E-mark 在英国被认可，部分需英国 VCA 型式认证',
  }),
  c({
    id: 'CH_CE',
    label: 'CE 标志（EU-CH 互认）/ CH 标志',
    countries: ['CH'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [14, 28],
    sourceUrl: 'https://www.esti.admin.ch/',
    note:
      'EU-CH 互认协议下 CE 产品通常可直接进入瑞士，多数情况不必另做。电气产品受 ENSO 管辖，ESTI 执行市场监督。' +
      '汽配是例外：Annex 1 no.2 清单内的安全件（灯具、制动、安全带等）须 TARV 型式认证',
  }),
  c({
    id: 'CH_OFCOM',
    label: 'OFCOM 无线电设备认证',
    countries: ['CH'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [14, 28],
    sourceUrl: 'https://www.ofcom.admin.ch/',
    note: '瑞士无线电设备认证；带 WiFi / 蓝牙的笔记本同样须办，不只是手机',
  }),
  c({
    id: 'NO_CE',
    label: 'CE 标志（EEA 协议）',
    countries: ['NO'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [14, 28],
    sourceUrl: 'https://www.innovasjonnorge.no/',
    note: '挪威通过 EEA 协议执行欧盟 CE 体系，与欧盟同一套。汽配接受 UNECE E-mark，部分品类须挪威补充测试',
  }),
  c({
    id: 'NO_NKOM',
    label: 'Nkom 无线电与终端设备认证',
    countries: ['NO'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [14, 28],
    sourceUrl: 'https://www.nkom.no/',
    note: '挪威通信管理局认证；带无线功能的设备须登记，与 CE 是两道手续，CE 不能替代它',
  }),
  c({
    id: 'NO_EPR',
    label: 'EPR 生产者责任延伸注册',
    countries: ['NO'],
    hsPrefixes: ['847130', '851713', '854143', '940360'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://www.mattilsynet.no/',
    note: '包装、WEEE、电池三类强制注册，注册后按实际投放量申报缴费。金额随销量变动，未入库，须按年估',
  }),
  c({
    id: 'RS_AAA',
    label: 'AAA 认证 / ORS 合格标志',
    countries: ['RS'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.iss.rs/',
    note:
      '塞尔维亚国家级强制认证，技术法规以欧盟为蓝本，已获 CE 可大幅简化。' +
      '在签署 ACAA 之前仍须使用 AAA 标志，CE 不能直接替代。须塞尔维亚本地授权代表',
  }),
  c({
    id: 'RS_RATEL',
    label: 'RATEL 无线电设备型号核准',
    countries: ['RS'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.ratel.rs/',
    note: '2024-03 起新无线电法规对标欧盟 RED 指令',
  }),
  c({
    id: 'UA_UKRSEPRO',
    label: 'UkrSEPRO 国家认证（正向 CE 过渡）',
    countries: ['UA'],
    hsPrefixes: ['870891', '847130', '851713', '854143'],
    leadTimeDays: [45, 60],
    sourceUrl: 'https://www.ukrtest.com/',
    note:
      '须乌克兰本地法律实体作为责任方。2021-07 起新 EMC 技术法规（No. 300-2019-П）对标欧盟 CE-EMC；' +
      '2024 年起电子设备须符合 RoHS-3 与 REACH。认证失败主因：辐射发射超标 62%、ESD 抗扰度不达标 23%——' +
      '送测前先自查这两项能省一轮。战时状态，法规执行存在不确定性',
    confidence: 'low',
  }),
  c({
    id: 'RU_EAC_COC',
    label: 'EAC 合格证书（高风险品）',
    countries: ['RU'],
    hsPrefixes: ['870891'],
    leadTimeDays: [90, 180],
    sourceUrl: 'https://www.eaeunion.org/',
    note: '须样品测试 + 工厂审核，证书有效期 1–5 年。须 EAEU 境内法人持证。现况下俄罗斯业务建议整体延后',
    confidence: 'low',
  }),
  c({
    id: 'RU_EAC_DOC',
    label: 'EAC 符合性声明（中低风险品）',
    countries: ['RU'],
    hsPrefixes: ['847130', '851713', '854143', '610910', '940360'],
    leadTimeDays: [7, 10],
    sourceUrl: 'https://www.eaeunion.org/',
    note:
      '2025-09-01 起取消"免测试"政策，DoC 也须 EAEU 认可实验室报告，周期从 1 周变数周。' +
      '所有 EAC 商品须附加动态 QR 码（链接 EAEU 检测数据库）。纺织品按 TR CU 017/2011，家具按 TR CU 025/2012',
    confidence: 'low',
  }),
  c({
    id: 'RU_FSS',
    label: 'FSS 联邦安全局通知（加密设备）',
    countries: ['RU'],
    hsPrefixes: ['851713', '854143'],
    leadTimeDays: [28, 56],
    sourceUrl: 'https://www.eaeunion.org/',
    note: '带加密或蜂窝功能的设备须 FSS 通知，与 EAC 是两件事，容易漏',
    confidence: 'low',
  }),

  /* ---------------- 跨国家条目 ---------------- */
  c({
    id: 'TEXTILE_LABEL',
    label: '纺织品标签合规',
    countries: [...S17, ...EU27],
    hsPrefixes: ['610910'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2011/1007/oj',
    note:
      '这 17 国加欧盟 27 国对 T 恤都没有强制产品安全认证，只有标签法规——所以这一条不是"办证"，是"别在标签上翻车"。' +
      '必须标：纤维成分及含量、原产地、维护/护理说明、制造商或进口商信息。' +
      '语言按国别：印尼语、越南语、泰语、马来语、菲律宾语/英语、英语、日语、韩语、英语+印地语、孟加拉语、乌尔都语/英语、' +
      '英语、德/法/意/西等欧盟成员国官方语言、挪威语、塞尔维亚语、乌克兰语、俄语。' +
      '这是一条跨市场提醒，不是逐国条文清单；来源链接给的是欧盟同名法规（标签必备项在全球基本一致），' +
      '各国语言与细则须按当地法规核。标签不合规的退运成本远高于认证费，但它在货代报价里通常不含',
  }),
  c({
    id: 'TIMBER_EUDR',
    label: 'EUDR 零毁林尽职调查',
    countries: [
      ...EU27,
      'NO',
      'CH',
    ],
    hsPrefixes: ['940360'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://eur-lex.europa.eu/',
    note:
      '2025-12-30 起全面实施，取代 EUTR。须把木材追溯到地块坐标（geolocation），并保存尽职调查声明。' +
      '这是木家具出口欧盟最容易被卡的一环，而且没有"买证"的捷径——要上游供应商配合提供林场地块数据。' +
      '调研报告只覆盖了 17 国中的部分欧洲国家，欧盟 27 国这一条按法规本身补充',
  }),
  c({
    id: 'TIMBER_UKTR',
    label: 'UKTR 英国木材法规',
    countries: ['GB'],
    hsPrefixes: ['940360'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://www.gov.uk/guidance/timber-and-flegt-licences',
    note: 'UKTR 取代 EU EUTR 在英国施行，要求首次投放英国市场的运营商做木材合法性尽职调查；印尼 FLEGT 许可被英国认可',
  }),
  c({
    id: 'TIMBER_FLEGT',
    label: 'FLEGT VPA 木材合法性证明',
    countries: ['ID', 'VN', 'MY'],
    hsPrefixes: ['940360'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://www.euflegt.efi.int/',
    note: '印尼、越南、马来西亚均为 FLEGT VPA 伙伴国，进口木材及木制品须提供合法性证明。马来西亚另有 TLAS 体系',
  }),
  c({
    id: 'TIMBER_CITES',
    label: 'CITES 濒危木材许可',
    countries: ['JP', 'KR', 'TH', 'PH', 'SG', 'RS', 'UA', 'BD', 'PK', 'IN', 'RU'],
    hsPrefixes: ['940360'],
    leadTimeDays: [0, 0],
    sourceUrl: 'https://cites.org/',
    note: '只在使用红木、紫檀等 CITES 附录物种时才触发。用普通木材（松、橡、橡胶木）不涉及，别被"要不要办 CITES"绕晕',
    mandatory: false,
  }),
  c({
    id: 'ENERGY_LABEL',
    label: '强制能效标签 / MEPS 注册',
    countries: ['VN', 'TH', 'MY', 'PH', 'SG', 'KR', 'IN', 'RU'],
    hsPrefixes: ['847130', '851713'],
    leadTimeDays: [28, 42],
    sourceUrl: 'https://www.iea.org/policies',
    note:
      '各国主管机构：越南 MOIT（TCVN 11848:2021，2025-04 起禁止进口低于 MEPS 的产品）、泰国 TISI、马来 ST、' +
      '菲律宾 DOE、新加坡 NEA、韩国 KEMCO、印度 BEE、俄罗斯 Rostest（GOST）。' +
      '手机本体多数不强制，强制的是随货适配器——不含适配器出货可以绕开，但客户体验会受影响',
  }),
];

/* ------------------------------------------------------------------ *
 * 6. 待核项结论回填
 * ------------------------------------------------------------------ */

/**
 * 调研对 UF-01 / UF-02 都给了结论，但可信度不同，处理方式也必须不同：
 *   UF-02 有一手官方接口核验（hts.usitc.gov REST，2026-10-20），可以关。
 *   UF-01 只有"未明确列入 + 需关注分类争议"，属于"更确定了但仍非定论"，不能关，只能降级。
 * 把两者都关掉是偷懒：报关行若按"铝制品"归类，成本会差 25%。
 */
const ufPath = path.join(PARAMS_DIR, 'unresolved.seed.json');
if (fs.existsSync(ufPath)) {
  const uf = JSON.parse(fs.readFileSync(ufPath, 'utf8'));
  const byId = new Map(uf.map((x) => [x.id, x]));

  const uf01 = byId.get('UF-01');
  if (uf01) {
    uf01.currentBasis =
      '调研补充包 v1 结论（confidence: medium）：232 的 407 类衍生品清单以成品钢铝为主（家具、压缩机、家电），' +
      '8708.91 汽车散热器未明确列入。但存在一条真实的分歧路径——若海关把散热器认定为"铝制品"而非"汽车零件"，' +
      '就会落进 232 范围。这一票的成本差 6,327.00，方向是"如果成立则更贵"，所以默认仍按不计入。';
    uf01.counterBasis =
      'CBP 2026-04-02 公告 Annex I-B 列名（若能列到 8708.91 即成立）；或海关对"含铝汽车零件"作出铝制品归类裁定。' +
      '关闭条件：取得 USITC 最新公告附件正文逐条比对 + 报关行书面确认归类意见。';
    uf01.researchRef = 'research-v1#UF-01';
    uf01.progress = '本轮调研未关闭，但把不确定性收敛到"归类争议"一种情形，比分之前的"完全不知道是否在清单内"更窄';
  }

  const uf02 = byId.get('UF-02');
  if (uf02) {
    uf02.status = 'resolved';
    uf02.resolvedAt = '2026-10-24';
    uf02.resolvedBy = '调研补充包 v1（一手核验：hts.usitc.gov REST API，2026-10-20）';
    uf02.currentBasis =
      '已核：301 List 1–3 仍执行 25%，List 4A 为 7.5%。8708.91.75（汽车散热器）第三方标记挂 List 1–3 25%。' +
      '2026-10 第八轮中美磋商的 300 亿对等降税不涵盖 8708（仅玩具、家电受益）。' +
      '301 四年复审于 2026-05 启动，结论未出——复审结果出来前本档不会变。';
    uf02.researchRef = 'research-v1#UF-02';
  }

  fs.writeFileSync(ufPath, JSON.stringify(uf, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 7. 输出
 * ------------------------------------------------------------------ */

p.compliance = [...(p.compliance || []), ...NEW_COMPLIANCE];

p.paramsVersion = 'kb-2026.10.24-5';
p.asOf = '2026-10-24';
p.changelog = [
  {
    version: 'kb-2026.10.24-5',
    date: '2026-10-24',
    summary:
      `消化调研补充包 v1：税率修正 ${fixCount} 条（东盟/欧洲/南亚）、规费新增 ${NEW_CHARGES.length} 条（欧盟通用包 + 东盟 6 国）、` +
      `认证新增 ${NEW_COMPLIANCE.length} 条（17 国 × 6 品类，按 hsPrefixes 生效）、` +
      'ACFTA 补满 6 品类并修正 610910 与印尼汽配档位、瑞士 T 恤改为"按重量从量、拒绝从价出数"、欧盟两项 B2C 新收费进政策日历',
    reason: '调研方交付《进口清关数据调研补充结果 v1》与《17 国市场准入认证报告》',
  },
  ...(p.changelog || []),
];

fs.writeFileSync(DEST, JSON.stringify(p, null, 2), 'utf8');
console.log(`✓ ${path.basename(DEST)}`);
console.log(`  税率修正 ${fixCount} 条 · 挂起 1 条（CH/610910）`);
console.log(`  规费 ${p.charges.length} 条（+${NEW_CHARGES.length}）`);
console.log(`  认证 ${p.compliance.length} 条（+${NEW_COMPLIANCE.length}）`);
console.log(`  ACFTA 优惠档 ${aifta.preferentialRates.length} 条`);
console.log(`  政策日历 ${p.policyCalendar.length} 条`);
