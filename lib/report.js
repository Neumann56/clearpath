import { D, money } from './decimal.js';
import { normalizeShipment, runScenario, cashGapLevel, RATE_LABEL } from './engine/quote.js';
import { ParamError } from './engine/taxchain.js';
import { degradeOf } from './unresolved.js';
import { aggregateConfidence, weightedConfidence, unverifiedRatio } from './engine/confidence.js';
import { matchDualUse } from './params.js';

const GAP_REASON = {
  'UF-01': '档位由 232 附件清单决定，不是按金属含量算出来的；清单是 PDF/XLSX，需人工比对税号与 Chapter 99 章号',
  'UF-02': '232 与旧 301 的排除关系只有“传统上不叠加”的口径说法，没有可引用的裁定原文',
  'UF-03': 'PIS/COFINS 税基口径各州不同，SISCOMEX 回执不体现；写错会把 ICMS 重复课税',
  'UF-04': '范围 / 周期 / 版本类参数未核实，报告只作定性提示',
  'UF-05': 'HS2027 各国实施时点未定，切换后归类可能变化',
  'DU-BLOCK': '命中禁止性规定，无许可路径',
};

const GAP_ACTION = {
  'UF-01': '以报关行 Chapter 99 税号申报结果为准',
  'UF-02': '查 CBP 一般豁免清单是否覆盖 9903.88 全段',
  'UF-03': '找巴西税务代理出具书面口径（含法规条号）',
  'UF-04': '按各子项的建议动作逐项索取一手来源',
  'UF-05': '逐国核 TARIC / HTS / 海关总署公告',
};

function scenarioView(sc) {
  const remedy = sc.remedy;
  return {
    cif: sc.cif,
    dutiableCif: sc.dutiableCif,
    duty: sc.dutyTotal,
    surtax: sc.surtaxTotal,
    charges: sc.chargesTotal,
    complianceCost: sc.compliance.total,
    refundableVat: sc.refundableVat,
    unrefundableTax: sc.unrefundableTax,
    taxTotal: sc.taxTotal,
    landedCost: sc.landedCost,
    cashRequired: sc.cashRequired,
    cashGap: sc.cashGap,
    cashGapRatio: sc.cashGapRatio,
    cashGapLevel: cashGapLevel(sc.cashGapRatio),
    addOnTotal: sc.addOnTotal,
    effectiveRate: sc.effectiveRate,
    dutyBreakdown: sc.dutyBreakdown,
    taxChain: sc.taxChain,
    chargeLines: sc.chargeLines,
    compliance: sc.compliance.items,
    remedy: remedy.applicable ? remedy : null,
    skipped: sc.dutyBreakdown.filter((l) => l.skipped).map((l) => ({
      lineCode: l.lineCode,
      label: l.label,
      reason: l.skippedReason,
      pending: !!l.pending,
      transitExempt: !!l.transitExempt,
      unverifiedExcluded: !!l.unverifiedExcluded,
      unresolvedIds: l.unresolvedIds || [],
    })),
  };
}

function patchShipment(s, p) {
  const n = { ...s, ...p };
  n.fob = p.fob ?? s.fob;
  n.freight = p.freight ?? s.freight;
  n.insurance = p.insurance ?? s.insurance;
  n.cif = n.fob.add(n.freight).add(n.insurance);
  return n;
}

function buildSensitivity({ shipment, params, base, opts }) {
  const items = [];
  const add = (id, label, change, alt, metric = 'landedCost', note = '') => {
    const d = metric === 'cashRequired' ? alt.cashRequired.sub(base.cashRequired) : alt.landedCost.sub(base.landedCost);
    if (d.isZero() && !note) return;
    items.push({
      id,
      label,
      change,
      metric,
      delta: d,
      deltaPct: D.of(1), // 占位，渲染层按需计算
      note,
      confidence: 'medium',
    });
  };

  if (base.measures.some((m) => m.inTransitRule)) {
    const alt = runScenario({ shipment, params, opts: { ...opts, ignoreTransitExempt: true } });
    const d = alt.landedCost.sub(base.landedCost);
    add(
      'transit_rule_lost',
      '在途豁免失效',
      '申报晚于豁免窗口截止日',
      alt,
      'landedCost',
      d.isZero() ? '本票装船已晚于豁免窗口，该变量对本票不构成影响（Δ = 0）' : '通常等于新 301 全额（12.5%）'
    );
  }

  if (opts.branchEnabled) {
    const other = opts.defaultBranch === 'B' ? opts.scA : opts.scBase;
    add(
      'u01_flip',
      '232 判定翻转',
      opts.defaultBranch === 'B' ? '该编码实际在 232 附件内' : '该编码实际不在 232 附件内',
      other
    );
  }

  const f110 = money(shipment.freight.mul('1.1'));
  add('freight_10', '运费上涨 10%', `运费 ${shipment.freight.toFixed2()} → ${f110.toFixed2()}`, runScenario({ shipment: patchShipment(shipment, { freight: f110 }), params, opts }));

  const fob105 = money(shipment.fob.mul('1.05'));
  add('fob_5', '货值上涨 5%', `FOB ${shipment.fob.toFixed2()} → ${fob105.toFixed2()}`, runScenario({ shipment: patchShipment(shipment, { fob: fob105 }), params, opts }));

  if (shipment.insuranceSource === 'default_from_param') {
    add('insurance_zero', '保险按实报 0', '实际未投保，保险从默认估算值调为 0', runScenario({ shipment: patchShipment(shipment, { insurance: D.of(0) }), params, opts }));
  }

  if (base.remedy.applicable) {
    add('ad_deposit_gap', 'AD 保证金与最终税率差', '保证金按 99% 缴、最终按 45% 结算', base, 'cashRequired', `现金流口径差 ${base.remedy.deposit.sub(base.remedy.final).toFixed2()} 美元`);
  }

  return items.slice(0, 5);
}

function buildTimeline({ shipment, params, sc }) {
  const items = [];
  for (const p of params.idx.policyCalendar || []) {
    items.push({
      kind: 'point',
      date: p.date,
      label: p.label,
      type: p.type,
      relation: p.date <= shipment.dates.entryDate ? 'past' : 'future',
    });
  }
  for (const m of sc.measures) {
    if (!m.inTransitRule) continue;
    items.push({
      kind: 'window',
      start: m.inTransitRule.shipBy.slice(0, 10),
      end: m.inTransitRule.enterBy.slice(0, 10),
      shipBy: m.inTransitRule.shipBy.slice(0, 10),
      enterBy: m.inTransitRule.enterBy.slice(0, 10),
      label: '新 301 在途豁免窗口（双条件：装船 ≤ shipBy 且 申报 ≤ enterBy）',
      exportDate: shipment.dates.exportDate,
      entryDate: shipment.dates.entryDate,
    });
  }
  return items.sort((a, b) => String(a.date || a.start).localeCompare(String(b.date || b.start)));
}

function buildActions({ sc, duFlags, unresolved }) {
  const actions = [];
  let order = 1;
  for (const a of sc.compliance.actions || []) {
    actions.push({ ...a, order: order++, kind: 'compliance' });
  }
  for (const f of duFlags) {
    actions.push({
      order: order++,
      kind: 'license',
      id: f.id,
      label: `${f.label}：需办理 ${f.requiredLicense?.type}`,
      who: f.requiredLicense?.authority,
      days: `${f.requiredLicense?.leadTimeDays?.[0]}–${f.requiredLicense?.leadTimeDays?.[1]} 天`,
      mandatory: true,
      note: '可申请许可，不阻断出数',
      confidence: f.confidence,
      sourceUrl: f.sourceUrl,
    });
  }
  for (const u of unresolved) {
    if (u.tier === 'T3_FOOTNOTE' || u.tier === 'T4_INTERNAL') continue;
    actions.push({
      order: order++,
      kind: 'verify',
      id: u.id,
      label: `核实「${u.title}」`,
      who: '报关行 / 税务代理 / 运营',
      days: u.reviewDue || '—',
      mandatory: false,
      note: u.reviewAction,
      confidence: 'medium',
    });
  }
  return actions;
}

/**
 * 报告编排：一次请求 = 主链 + 0–1 个分支 + 可达状态枚举 + 敏感性。
 * 顶层 expected 永远等于默认分支的 expected（不是另算一份）。
 *
 * ParamError 必须在这里收成 { ok:false, errors }，不能让它冒到服务端最外层：
 * 那里一律按 500 回「计算失败，请重试」，用户看到的是一个与原因无关的句子，
 * 而"这个品类的税率还没入库"这种本来能自己解决的事，就被吞成了系统故障。
 */
export function buildReport(args) {
  try {
    return buildReportOrThrow(args);
  } catch (e) {
    if (!(e instanceof ParamError)) throw e;
    // ParamError 的 message 是 `${code} ${人话}`，前缀要去掉，否则界面上码会出现两遍
    const human = String(e.message).replace(new RegExp(`^${e.code}\\s*`), '');
    return {
      ok: false,
      errors: [
        {
          code: e.code,
          http: 400,
          message: human || '这个组合缺参数，算不出来。',
          detail: e.detail || null,
        },
      ],
    };
  }
}

function buildReportOrThrow({ input, params, facts = [], reportId, today, createdAt }) {
  const { errors, assumptions, shipment } = normalizeShipment(input, params);
  if (errors.length) return { ok: false, errors };

  const du = matchDualUse(params.idx, shipment.country, shipment.hsDigits);
  const duBlocked = shipment.endUserType === 'military' ? du.find((d) => d.severity === 'blocked') : null;
  const duFlags = du.filter((d) => d.severity === 'flag');
  const now = today || params.asOf;

  if (duBlocked) {
    return {
      ok: true,
      report: toApi({
        reportId,
        createdAt: createdAt || new Date().toISOString(),
        state: 'blocked',
        entryDateSource: shipment.entryDateSource,
        productVersion: params.raw.productVersion,
        input: publicInput(shipment),
        expected: null,
        blocked: {
          code: 'E_DUAL_USE_BLOCKED',
          label: duBlocked.label,
          legalBasis: duBlocked.legalBasis,
          message: '命中禁止性规定，无许可路径。本报告不出金额。',
        },
        unresolved: [
          {
            id: 'DU-BLOCK',
            title: duBlocked.label,
            tier: 'T0_BLOCK',
            category: 'U1_FACT',
            status: 'open',
            impactUsd: null,
            impactDisplay: '不适用（不出金额）',
            reviewAction: '核对最终用户与最终用途证明；不得直接出金额',
            closeCriteria: '取得最终用户/用途书面证明，或主管机关明确无许可路径',
          },
        ],
        dataGaps: [
          {
            field: '两用物项出口管制',
            reason: GAP_REASON['DU-BLOCK'],
            impactUsd: null,
            suggestAction: '按法律依据核对最终用户与用途',
            factId: 'DU-BLOCK',
            tier: 'T0_BLOCK',
          },
        ],
        assumptions,
        meta: metaOf(params),
        asOfState: { degraded: false, level: 'none' },
      }),
    };
  }

  const scBase = runScenario({ shipment, params });
  const f1 = facts.find((f) => f.id === 'UF-01');
  const has232 = scBase.measures.some((m) => m.measureType === 'SECTION_232');
  const branchEnabled = !!(has232 && f1 && f1.displayTier === 'T1_BRANCH' && f1.status !== 'superseded');

  let scA = null;
  let scA2 = null;
  let defaultBranch = 'B';
  let scDefault = scBase;

  if (branchEnabled) {
    scA = runScenario({ shipment, params, opts: { include232: true } });
    scA2 = runScenario({ shipment, params, opts: { include232: true, s301OldExcluded: false } });
    const resolvedToA = f1.status === 'resolved' && f1.currentValue && f1.currentValue.branch === 'A';
    defaultBranch = resolvedToA ? 'A' : 'B';
  }

  const baseOpts = branchEnabled
    ? defaultBranch === 'A'
      ? { include232: true, branchEnabled, defaultBranch, scA, scBase }
      : { include232: false, branchEnabled, defaultBranch, scA, scBase }
    : {};
  scDefault = branchEnabled ? (defaultBranch === 'A' ? scA : scBase) : scBase;

  // 可达状态枚举（BR-23）：互斥取状态最大值、串联求和，禁止单条 max 或直接相加
  const states = branchEnabled
    ? [
        { id: 'B', label: '不计入 232（默认）', landedCost: scBase.landedCost, cashRequired: scBase.cashRequired, note: '未确认的事实不得被当作既定成本' },
        { id: 'A', label: '计入 232，旧 301 被排除', landedCost: scA.landedCost, cashRequired: scA.cashRequired, note: '232 覆盖 301' },
        { id: 'A+UF02', label: '计入 232，旧 301 未被排除', landedCost: scA2.landedCost, cashRequired: scA2.cashRequired, note: '双重不确定叠加' },
      ]
    : [{ id: 'ONLY', label: '唯一可达状态', landedCost: scDefault.landedCost, cashRequired: scDefault.cashRequired, note: '' }];

  const worst = states.reduce((a, b) => (b.landedCost.gt(a.landedCost) ? b : a));
  const best = states.reduce((a, b) => (b.landedCost.lt(a.landedCost) ? b : a));

  // ---- 待核项关联 ----
  const unresolved = [];
  const pushFact = (f, extra = {}) => {
    if (!f) return;
    const dg = degradeOf(f, now);
    unresolved.push({
      id: f.id,
      title: f.title,
      category: f.category,
      tier: f.displayTier,
      status: f.status,
      owner: f.owner,
      reviewDue: f.reviewDue,
      reviewAction: f.reviewAction,
      closeCriteria: f.closeCriteria,
      currentValue: f.currentValue,
      counterValue: f.counterValue,
      currentBasis: f.currentBasis,
      counterBasis: f.counterBasis,
      defaultBranch: f.defaultBranch || null,
      defaultDirectionNote: f.defaultDirectionNote || '',
      appliesToBranch: f.appliesToBranch || null,
      dependsOn: f.dependsOn || null,
      scope: f.scope,
      subItems: f.subItems || null,
      impactRule: f.impactRule,
      impactUsd: extra.impactUsd ?? (f.impactUsdCached ? D.of(f.impactUsdCached) : null),
      impactDisplay: extra.impactDisplay || f.impactDisplay || '',
      // riskNote 是内部备注（给待核中心/运营看的），不进对外报告；
      // 对外只出 dependencyNote，避免把我方 UI 规范原文当成结论读给用户。
      dependencyNote: f.dependencyNote || '',
      degrade: dg,
    });
  };

  if (branchEnabled) {
    const f2 = facts.find((f) => f.id === 'UF-02');
    pushFact(f1, { impactUsd: scBase.landedCost.sub(scA.landedCost).abs() });
    pushFact(f2, { impactUsd: scA2.landedCost.sub(scA.landedCost) });
  }

  const f3 = facts.find((f) => f.id === 'UF-03');
  if (f3 && shipment.country === 'BR' && scDefault.taxChain.some((l) => l.taxCode === 'PIS_COFINS')) pushFact(f3);

  const f4 = facts.find((f) => f.id === 'UF-04');
  if (f4) {
    const relevant = (f4.subItems || []).filter((s) => {
      if (s.id === 'D5') return shipment.country === 'TR';
      if (s.id === 'D6') return shipment.country === 'HU' || shipment.country === 'CZ';
      if (s.id === 'D4') return shipment.country === 'SA';
      if (s.id === 'D2' || s.id === 'D3') return shipment.country === 'ID';
      if (s.id === 'D1') return shipment.hsDigits.startsWith('8507');
      return false;
    });
    if (relevant.length) pushFact({ ...f4, subItems: relevant, title: `D 级存疑参数（本票相关 ${relevant.length} 项）` });
  }

  const f5 = facts.find((f) => f.id === 'UF-05');
  if (f5 && now >= '2026-12-01') pushFact(f5);

  // ---- dataGaps ----
  const dataGaps = unresolved.map((u) => ({
    field: u.title,
    reason: GAP_REASON[u.id] || u.title,
    impactUsd: u.impactUsd,
    suggestAction: GAP_ACTION[u.id] || u.reviewAction,
    factId: u.id,
    tier: u.tier,
    unverified: false,
  }));

  const scanScenarios = branchEnabled ? [scBase, scA] : [scBase];
  const seenGap = new Set();
  for (const sc of scanScenarios) {
    for (const l of sc.dutyBreakdown) {
      if (l.exemptionStatus !== 'UNPROVEN' || seenGap.has(l.lineCode)) continue;
      seenGap.add(l.lineCode);
      dataGaps.push({
        field: '232 ≤15% 免征举证',
        reason:
          '未填金属含量，未证明可享 ≤15% 免征，该行按法定档位照常出数（可能多算）' +
          (branchEnabled ? '（分支 A 即"计入 232"情形下可见）' : ''),
        impactUsd: null,
        suggestAction: '在录入页补金属含量（0–1），或向供应商索取材质证明',
        factId: 'UF-01',
        tier: 'T2_IMPACT',
      });
    }
  }
  if (shipment.dates.exportDate == null && scDefault.measures.some((m) => m.inTransitRule)) {
    dataGaps.push({
      field: '装船日（on board）',
      reason: '缺少装船日，在途豁免无法判定，新 301 行暂不计入',
      impactUsd: null,
      suggestAction: '补填提单上的 on board 日期（不能用“交给货代日”顶替）',
      factId: null,
      tier: 'T2_IMPACT',
    });
  }
  for (const l of scDefault.dutyBreakdown) {
    if (l.unverifiedExcluded) {
      dataGaps.push({
        field: l.label,
        reason: '参数未核实（unverified），按 K2 不进入任何对外合计',
        impactUsd: null,
        suggestAction: '取得一手来源后升级参数；在此之前不得对外引用',
        factId: null,
        tier: 'T4_INTERNAL',
        unverified: true,
      });
    }
  }

  // 按定额计征的反倾销税缺计量数据时，绝不能给 0 装成"已经算过"。
  // 给 0 会让真实成本静默偏低，而且报告上看不出任何异常——这是最危险的一种错。
  if (scDefault.remedy && scDefault.remedy.applicable && scDefault.remedy.incomplete) {
    dataGaps.push({
      field: scDefault.remedy.missingField === 'weightKg' ? '计重（kg）' : '总面积（㎡）',
      reason: `${scDefault.remedy.missingText}；该笔反倾销税未计入真实成本与需备现金，当前金额偏低`,
      impactUsd: null,
      suggestAction:
        scDefault.remedy.missingField === 'weightKg'
          ? '按装箱单填写总净重；或向报关行索取该案按重量计征的应缴金额'
          : '按组件规格 × 片数填写总面积；或向报关行索取该案按平方米计征的应缴金额',
      factId: null,
      tier: 'T2_IMPACT',
    });
  }

  // ---- assumptions ----
  const allAssumptions = [...assumptions, ...scDefault.compliance.assumptions];
  if (scDefault.chargeLines.some((c) => !c.included && c.amount.gt(0))) {
    const avail = scDefault.chargeLines.filter((c) => !c.included && c.amount.gt(0));
    allAssumptions.push({
      field: '规费',
      value: avail.map((c) => `${c.lineCode} ${c.amount.toFixed2()}`).join('、'),
      note: `本报告未计入规费（按 v2 §11 黄金用例口径）；若计入将增加 ${avail.reduce((a, c) => a.add(c.amount), D.of(0)).toFixed2()} 美元`,
      confidence: 'medium',
    });
  } else if (!((params.idx.charges && params.idx.charges.get(shipment.country)) || []).length) {
    // 「有定义但没勾选」和「压根没入库」是两件事：
    //   前者能算出"若计入会多少"，后者连算都算不出来，但金额上同样是 0。
    // 如果这时不说话，用户看到的是一个确定偏低的到岸成本，报告里毫无异样。
    allAssumptions.push({
      field: '规费',
      value: '本市场未入库',
      note:
        '这个市场的清关规费（报关费、码头操作费、单证费）还没有参数，到岸成本与需备现金都未含这部分；' +
        '按行业常见水平约占货值 0.3%–0.8%，报价前请向货代索取本口岸的实际收费标准',
      confidence: 'low',
    });
  }
  if (shipment.dates.entryDate === shipment.dates.declarationDate && shipment.entryDateSource === 'defaulted_from_declaration') {
    // 已在 normalize 中记过；此处不重复
  }

  // ---- 风险 ----
  const risk = {
    blockRisk: duFlags.length ? 'yellow' : 'green',
    blockRiskText: duFlags.length ? '管制但可申请许可' : '未命中禁限运',
    requiredLicense: duFlags[0]?.requiredLicense || null,
    costShock: scDefault.effectiveRate.gt('0.35') ? 'red' : scDefault.effectiveRate.gt('0.15') ? 'yellow' : 'green',
    cashGap: cashGapLevel(scDefault.cashGapRatio),
  };

  const moneyLines = [
    ...scDefault.dutyBreakdown.filter((l) => !l.skipped),
    ...scDefault.taxChain,
    ...scDefault.chargeLines.filter((c) => c.included),
    ...scDefault.compliance.items,
    ...(scDefault.remedy.applicable ? [{ amount: scDefault.remedy.final, confidence: scDefault.remedy.confidence }] : []),
  ];
  const conf = {
    report: aggregateConfidence(moneyLines),
    weighted: weightedConfidence(moneyLines),
    unverifiedCount: moneyLines.filter((l) => l.confidence === 'unverified').length,
    unverifiedRatio: unverifiedRatio(moneyLines),
  };

  let state = 'complete';
  if (dataGaps.length) state = 'complete_with_gaps';
  if (duFlags.length && shipment.endUserType === 'unknown') state = 'needs_confirmation';
  const needsConfirmation = state === 'needs_confirmation';

  let bView = scenarioView(scBase);
  let aView = branchEnabled ? scenarioView(scA) : null;
  if (branchEnabled) {
    // 段 4.5「若成立则影响」必须由跑两遍取差得出（含连锁淘汰），禁止 rate × cif
    const l232 = bView.skipped.find((s) => s.lineCode === 'SECTION_232');
    if (l232) l232.impactIfApplied = scA.landedCost.sub(scBase.landedCost).toNumber();
    const l301 = aView.skipped.find((s) => s.lineCode === 'SECTION_301');
    if (l301) l301.impactIfApplied = scA2.landedCost.sub(scA.landedCost).toNumber();
  }
  const expectedView = branchEnabled ? (defaultBranch === 'A' ? aView : bView) : bView;

  const branches = branchEnabled
    ? [
        {
          branchId: 'B',
          label: '不计入 232（默认）',
          condition: '8708.91 不在 232 汽车零部件附件内',
          isDefault: defaultBranch === 'B',
          landedCost: scBase.landedCost,
          cashRequired: scBase.cashRequired,
          deltaVsDefault: defaultBranch === 'B' ? D.of(0) : scA.landedCost.sub(scBase.landedCost).abs(),
          unresolvedIds: ['UF-01'],
          expected: bView,
        },
        {
          branchId: 'A',
          label: '计入 232（25%）',
          condition: '8708.91 在 Annex I-B 内',
          isDefault: defaultBranch === 'A',
          landedCost: scA.landedCost,
          cashRequired: scA.cashRequired,
          deltaVsDefault: defaultBranch === 'A' ? D.of(0) : scBase.landedCost.sub(scA.landedCost).abs(),
          unresolvedIds: ['UF-01'],
          expected: aView,
        },
      ]
    : undefined;

  const degrade = sortDegrade(unresolved.map((u) => u.degrade));

  const report = {
    reportId,
    createdAt: createdAt || new Date().toISOString(),
    state,
    entryDateSource: shipment.entryDateSource,
    productVersion: params.raw.productVersion,
    input: publicInput(shipment),
    classification: buildClassification(shipment),
    access: {
      flags: duFlags.map((f) => ({ id: f.id, label: f.label, requiredLicense: f.requiredLicense, confidence: f.confidence })),
      blocked: null,
      endUserType: shipment.endUserType,
    },
    expected: needsConfirmation ? null : expectedView,
    branches: needsConfirmation ? undefined : branches,
    range: {
      best: best.landedCost,
      expected: scDefault.landedCost,
      worst: worst.landedCost,
      worstExtra: worst.landedCost.sub(scDefault.landedCost),
      worstState: worst.id,
      bestState: best.id,
      states,
      basis: 'landedCost',
    },
    unresolved,
    dataGaps,
    assumptions: allAssumptions,
    sensitivity: needsConfirmation ? [] : buildSensitivity({ shipment, params, base: scDefault, opts: baseOpts }),
    // 协定优惠税率：并列口径，说明"办证能省多少"，不计入任何金额字段
    fta: scDefault.fta || [],
    timeline: buildTimeline({ shipment, params, sc: scDefault }),
    actions: buildActions({ sc: scDefault, duFlags, unresolved }),
    risk,
    confidence: conf,
    asOfState: { ...degrade, annotationAsOf: now },
    meta: metaOf(params),
    warnings: allAssumptions.filter((a) => a.warnBar).map((a) => a.note),
  };

  return { ok: true, report: toApi(report) };
}

function sortDegrade(list) {
  const order = { none: 0, yellow: 1, red: 2, expired: 3 };
  const worst = (list || []).reduce((a, b) => (order[b.level] > order[a.level] ? b : a), { level: 'none', overdue: 0, reason: '' });
  return { degraded: worst.level !== 'none', level: worst.level, since: null, reason: worst.reason };
}

function buildClassification(shipment) {
  return {
    hsCode: shipment.hsCode,
    hsDigits: shipment.hsDigits,
    hsVersion: shipment.hsVersion,
    source: 'user_input',
    note: '编码由用户提供；未经过 LLM 归类，K5 边界内不生成任何税率',
  };
}

function publicInput(s) {
  return {
    country: s.country,
    countryName: s.countryName,
    hsCode: s.hsCode,
    fob: s.fob,
    freight: s.freight,
    insurance: s.insurance,
    insuranceSource: s.insuranceSource,
    cif: s.cif,
    qty: s.qty,
    unit: s.unit,
    channel: s.channel,
    origin: s.origin,
    dates: s.dates,
    metalContentPct: s.metalContentPct,
    shipmentsPerYear: s.shipmentsPerYear,
    amortizationYears: s.amortizationYears,
    endUserType: s.endUserType,
    adDepositRate: s.adDepositRate,
    adFinalRate: s.adFinalRate,
  };
}

function metaOf(params) {
  return {
    engineVersion: params.raw.engineVersion,
    paramsVersion: params.raw.paramsVersion,
    asOf: params.asOf,
    hsVersion: params.raw.hsVersion,
  };
}

/** D → number，产出纯 JSON（之后不再参与计算） */
export function toApi(v) {
  return JSON.parse(JSON.stringify(v));
}
