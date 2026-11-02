/**
 * 离线演示数据。
 *
 * 为什么要有这个：比赛现场的网络基本不可靠，评委面前白屏一次就没了。
 * 连不上后端时自动切进来，页面顶部打一条黄条明说是演示数据——
 * **必须让人知道这是样例，不能让人误以为是刚算的。**
 *
 * 数字取自黄金用例 E（8708.91 · FOB 48,000 + 运费 2,400 · 匈牙利 · B2B），
 * 和线上真算的结果一致，不是编的。
 */

const report = {
  reportId: 'demo-0000-0000-0000-000000000001',
  createdAt: '2026-10-25T10:00:00.000Z',
  state: 'complete_with_gaps',
  isDemo: true,
  input: {
    country: 'HU',
    countryName: '匈牙利',
    hsCode: '8708.91',
    fob: 48000,
    freight: 2400,
    insurance: 216,
    cif: 50616,
    qty: 1200,
    unit: 'pcs',
    channel: 'B2B',
    origin: 'CN',
    dates: { exportDate: '2026-10-05', declarationDate: '2026-10-20', entryDate: '2026-10-22' },
  },
  expected: {
    cif: 50616,
    dutiableCif: 50616,
    duty: 1518.48,
    surtax: 0,
    charges: 0,
    refundableVat: 14076.31,
    unrefundableTax: 0,
    taxTotal: 14076.31,
    landedCost: 52134.48,
    cashRequired: 66210.79,
    cashGap: 14076.31,
    cashGapRatio: 0.27,
    cashGapLevel: 'yellow',
    effectiveRate: 0.03,
    dutyBreakdown: [
      {
        lineCode: 'MFN',
        label: '最惠国关税 3%',
        rate: 0.03,
        base: 50616,
        baseText: 'CIF',
        amount: 1518.48,
        confidence: 'high',
        note: 'TARIC 8708 91 00 · 3%',
        skipped: false,
        pending: false,
      },
    ],
    taxChain: [
      {
        seq: 30,
        taxCode: 'HU_VAT',
        name: '增值税（ÁFA）',
        rate: 0.27,
        base: 52134.48,
        baseText: 'CIF + 关税',
        amount: 14076.31,
        inclusive: false,
        refundable: true,
        confidence: 'high',
        note: 'B2B 持有 VAT 号可抵扣，只影响现金流，不进真实成本',
      },
    ],
    chargeLines: [],
    compliance: [],
    remedy: null,
  },
  range: {
    best: 52134.48,
    expected: 52134.48,
    worst: 52134.48,
    worstExtra: 0,
    states: [{ id: 'ONLY', label: '唯一可达状态', landedCost: 52134.48, cashRequired: 66210.79 }],
  },
  unresolved: [
    {
      id: 'UF-04',
      title: 'D 级存疑参数（本票相关 1 项）',
      status: 'open',
      reviewDue: '2027-04-20',
      reviewAction: '逐项向认证机构 / 主管部门 / 承运人索取书面口径',
      impactUsd: null,
    },
  ],
  dataGaps: [],
  assumptions: [
    { field: 'insurance', value: 216, note: '按参数默认 0.45% 估算，未填实际保费', confidence: 'medium' },
  ],
  sensitivity: [
    { label: '运费上涨 10%', change: '运费 2,400.00 → 2,640.00', delta: 247.2, deltaPct: 1 },
    { label: '货值上涨 5%', change: 'FOB 48,000.00 → 50,400.00', delta: 2472, deltaPct: 1 },
  ],
  timeline: [
    { date: '2026-04-06', label: '232 钢铝铜按完整海关估价征收生效', relation: 'past' },
    { date: '2026-12-01', label: 'HS2027 产品提醒起点（非法定生效日）', relation: 'future' },
  ],
  actions: [
    {
      label: 'ECE/E-mark 汽配认证',
      mandatory: true,
      who: '出口商 / 制造商',
      days: '45–120 天',
      note: '该类要求成本未入库，只进「要办的事」，不计入金额',
    },
  ],
  risk: { blockRisk: 'green', blockRiskText: '未命中禁限运', costShock: 'green', cashGap: 'yellow' },
  confidence: { report: 'high', weighted: 1, unverifiedCount: 0 },
  meta: { engineVersion: '0.1.0', paramsVersion: '演示数据', asOf: '2026-10-22' },
  warnings: [],
};

const coverage = {
  paramsVersion: '演示数据',
  asOf: '2026-10-24',
  markets: { total: 68, entryEnabled: 68, byRegion: [] },
  categories: [
    { hs: '870891', hsDisplay: '8708.91', name: '机动车辆零件' },
    { hs: '847130', hsDisplay: '8471.30', name: '便携式电脑' },
    { hs: '851713', hsDisplay: '8517.13', name: '智能手机' },
    { hs: '854143', hsDisplay: '8541.43', name: '光伏电池组件' },
    { hs: '610910', hsDisplay: '6109.10', name: '针织棉制T恤' },
    { hs: '940360', hsDisplay: '9403.60', name: '木制家具' },
  ],
  cells: 408,
  chargesMarkets: 35,
  complianceMarkets: 45,
};

const calendar = {
  today: '2026-10-25',
  count: 4,
  note: '演示数据。只收录参数库里已入库的节点。',
  items: [
    { date: '2026-04-06', label: '232 钢铝铜按完整海关估价征收生效', kind: '政策生效', state: 'in', countryName: '' },
    { date: '2026-11-15', label: '欧盟 B2C 包裹费起适用', kind: '政策生效', state: 'soon', countryName: '欧盟' },
    { date: '2026-12-01', label: 'HS2027 产品提醒起点', kind: '版本提醒', state: 'far', countryName: '' },
    { date: '2027-01-01', label: '美国 MPF 下限按财年调整', kind: '规费', state: 'far', countryName: '美国' },
  ],
  spans: [],
};

module.exports = { report, coverage, calendar };
