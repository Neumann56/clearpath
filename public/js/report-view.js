/* 报告视图：Node 端（SSR）与浏览器端（切分支）共用同一份渲染逻辑 */

export const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const neg = Number(n) < 0;
  const s = Math.abs(Number(n)).toFixed(2);
  const [i, f] = s.split('.');
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
};

export const pct = (n, digits = 2) => `${(Number(n) * 100).toFixed(digits)}%`;

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 参数库的 note 字段里混进过内部字段名（"只影响现金流，不进 landedCost"）。
 * 界面上不许出现这些词——它对用户没有意义，只会让人以为自己看的是源码。
 *
 * 在渲染层兜一遍而不是只改数据：历史报告存的是当时的 note 原文，
 * 只改参数库的话，已经出过的报告照样会把这句印在纸上。
 * 数据侧下次发新参数版本时也改掉，两边都做才不会再漏。
 *
 * 手机端 lib/mobile.js 里有一份同样的规则，改这里记得同步。
 */
const FIELD_PLAIN = [
  [/\s*\blandedCost\b/g, '真实成本'],
  [/\s*\bcashRequired\b/g, '需备现金'],
  [/\s*\bcashGap\b/g, '现金缺口'],
  [/\s*\btaxChain\b/g, '税链'],
  [/\s*\bdutyBreakdown\b/g, '关税明细'],
  [/\s*\bchargeLines\b/g, '规费明细'],
  [/\s*\bunresolved\b/g, '待核项'],
  [/\s*\bdataGaps\b/g, '数据缺口'],
  [/\s*\btaxSteps\b/g, '税种'],
  [/\s*\bexpected\b/g, '预计'],
];
export const plainText = (s) => {
  let out = String(s ?? '');
  for (const [re, to] of FIELD_PLAIN) out = out.replace(re, to);
  return out;
};

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

const CONF_BADGE = (c) => {
  const map = {
    high: ['可信', 'ok'],
    medium: ['依据：二手口径', 'mid'],
    low: ['待核', 'low'],
    unverified: ['未核实', 'bad'],
  };
  const [t, k] = map[c] || map.medium;
  return `<span class="conf conf-${k}" data-confidence="${esc(c)}">${t}</span>`;
};

const srcLink = (url, note) => {
  const u = safeUrl(url);
  if (u) return `<a class="src" href="${esc(u)}" target="_blank" rel="noopener">来源</a>`;
  return `<span class="src src-none" title="${esc(note || '待补来源')}">待补来源</span>`;
};

export const CASH_TEXT = {
  green: '资金占用正常。',
  yellow: (gap, months) => `需备 ${fmt(gap)} 美元周转，账期约 ${months} 个月。`,
  red: (gap, ratio) => `这票货要先垫 ${fmt(gap)} 美元（占 ${pct(ratio, 0)}），回款前资金链风险高。`,
};

/** 切分支是纯前端切换：不重新请求、不改快照（K4） */
export function applyBranch(report, branchId) {
  if (!report.branches) return { ...report, viewBranch: null };
  const b = report.branches.find((x) => x.branchId === branchId) || report.branches.find((x) => x.isDefault);
  return {
    ...report,
    expected: b.expected,
    viewBranch: b.branchId,
    viewBranchLabel: b.label,
    range: { ...report.range, expected: b.landedCost },
  };
}

function banner(report) {
  const out = [];
  if (report.state === 'blocked') {
    out.push(
      `<div class="bar bar-red"><b>已阻断</b> 命中禁止性规定，无许可路径。本报告不出任何金额。依据：${esc(
        report.blocked?.legalBasis || '—'
      )}</div>`
    );
  }
  if (report.entryDateSource === 'defaulted_from_declaration') {
    out.push(`<div class="bar bar-yellow">清关日按申报日推定（${esc(report.input.dates.entryDate)}）。若实际放行日不同，请补填后重新预演。</div>`);
  }
  if (report.asOfState?.level === 'yellow') {
    out.push(`<div class="bar bar-yellow">${esc(report.asOfState.reason)}</div>`);
  }
  if (report.asOfState?.level === 'red' || report.asOfState?.level === 'expired') {
    out.push(`<div class="bar bar-red">${esc(report.asOfState.reason)}</div>`);
  }
  if (report.confidence?.unverifiedRatio > 0.3) {
    out.push(`<div class="bar bar-red" data-unverified-badge>本报告有较多未核实参数，结论仅供内部评估，不建议直接对外报价</div>`);
  }
  if (report.unresolved?.some((u) => u.id === 'UF-05')) {
    out.push(
      `<div class="bar bar-yellow">HS 编码体系将于 2027 年起更新，<b>各国实施时点不同（待核）</b>。本报告基于 HS2022 参数。切换后归类可能变化，建议重新预演。</div>`
    );
  }
  return out.join('');
}

function sec(n, cls, title, body, extra = '') {
  return `<section id="sec-${n}" data-report-section="${n}" class="sec ${cls}" ${extra}>
    <div class="sec-head"><span class="sec-no">${n}</span><h2>${title}</h2></div>
    ${body}
  </section>`;
}

function conclusion(report) {
  const e = report.expected;
  if (!e) return '<p class="muted">本报告不出金额。</p>';
  const t = `预计真实成本 <b class="num" data-basis="landedCost">${fmt(e.landedCost)}</b> 美元（有效税率 ${pct(e.effectiveRate)}）；清关需备现金 <b class="num" data-basis="cashRequired">${fmt(e.cashRequired)}</b> 美元。`;
  return `<p class="lead">${t}</p>
  <p class="muted small">有效税率 = 到岸后新增总额 ${fmt(e.addOnTotal)} ÷ CIF ${fmt(e.cif)}，不是用真实成本作分母。</p>`;
}

function diamond(report) {
  const r = report.range;
  const min = Math.min(Number(r.best), Number(r.expected), Number(r.worst));
  const max = Math.max(Number(r.best), Number(r.expected), Number(r.worst));
  const pos = (v) => (max === min ? 50 : ((Number(v) - min) / (max - min)) * 100);
  const rows = [
    ['best', '最乐观', r.best, '可按已确认的最有利事实执行'],
    ['expected', '本报告采用', r.expected, '默认分支，产品取舍而非事实结论'],
    ['worst', '最坏可达', r.worst, '按可达状态枚举，不是单条相加'],
  ];
  const bars = rows
    .map(
      ([k, label, v, note]) => `<div class="dm-row dm-${k}">
        <span class="dm-label">${label}</span>
        <div class="dm-track"><i style="left:${pos(v)}%"></i></div>
        <span class="dm-val">${fmt(v)}</span>
        <span class="dm-note">${note}</span>
      </div>`
    )
    .join('');
  const single = (r.states || []).length <= 1;
  return `<div class="dm">${bars}</div>
  <p class="muted small">三档均为 <b>真实成本</b> 口径，不含现金口径。${
    single
      ? '本票没有互斥的待核分叉，区间收敛为单值。'
      : `最坏额外支出 ${fmt(r.worstExtra)} 美元（对应状态：${esc(r.worstState)}，由待核项共同决定，不是单条相加）。`
  }</p>`;
}

function dualBasis(report) {
  const e = report.expected;
  if (!e) return '<p class="muted">本报告不出金额。</p>';
  const lvl = e.cashGapLevel;
  const txt =
    lvl === 'green' ? CASH_TEXT.green : lvl === 'yellow' ? CASH_TEXT.yellow(e.cashGap, 2) : CASH_TEXT.red(e.cashGap, e.cashGapRatio);
  return `<div class="dual">
    <div class="dual-cell">
      <div class="dual-k">真实成本</div>
      <div class="dual-v" data-basis="landedCost">${fmt(e.landedCost)}<span>USD</span></div>
      <div class="dual-h">毛利按这个算（已剔除可退增值税，反倾销按最终税率）</div>
    </div>
    <div class="dual-cell">
      <div class="dual-k">清关需备现金</div>
      <div class="dual-v" data-basis="cashRequired">${fmt(e.cashRequired)}<span>USD</span></div>
      <div class="dual-h">现金流按这个（含可退增值税垫付，反倾销按保证金）</div>
    </div>
    <div class="dual-cell">
      <div class="dual-k">现金缺口</div>
      <div class="dual-v">${fmt(e.cashGap)}<span>USD</span></div>
      <div class="dual-h">= 可退增值税垫付 + 反倾销保证金与最终税额之差</div>
    </div>
    <div class="dual-cell">
      <div class="dual-k">现金缺口比</div>
      <div class="dual-v lvl-${lvl}">${pct(e.cashGapRatio, 0)}<em class="lvl-dot lvl-${lvl}"></em></div>
      <div class="dual-h">分母是真实成本，不是需备现金</div>
    </div>
  </div>
  <p class="note-line">ⓘ 两个数永不相加。目的国无可退增值税且反倾销不追溯时，二者相等。</p>
  <p class="note-line ${lvl}">${txt}</p>`;
}

function scoreCards(report) {
  const r = report.risk;
  const map = { green: ['低', 'ok'], yellow: ['中', 'mid'], red: ['高', 'bad'] };
  const entry = { green: '可进', yellow: '需许可', red: '不可进' };
  const [bTxt, bCls] = map[r.blockRisk] || map.green;
  const [cTxt, cCls] = map[r.costShock] || map.green;
  const lic = r.requiredLicense
    ? `<div class="sc-foot">需办：${esc(r.requiredLicense.type)} · ${esc(r.requiredLicense.authority)}</div>`
    : '';
  return `<div class="sc">
    <div class="sc-card sc-${bCls}">
      <div class="sc-k">能不能进</div>
      <div class="sc-v">${entry[r.blockRisk] || entry.green}</div>
      <div class="sc-d">${esc(r.blockRiskText)}（风险${bTxt}）</div>${lic}
    </div>
    <div class="sc-card sc-${cCls}">
      <div class="sc-k">赚不赚（税负冲击）</div>
      <div class="sc-v">税负${cTxt}</div>
      <div class="sc-d">有效税率 ${pct(report.expected?.effectiveRate || 0)}（分母是 CIF）</div>
    </div>
    <div class="sc-card sc-${map[r.cashGap][1]}">
      <div class="sc-k">钱够不够</div>
      <div class="sc-v">占用${map[r.cashGap][0]}</div>
      <div class="sc-d">现金缺口比 ${pct(report.expected?.cashGapRatio || 0, 0)}</div>
    </div>
  </div>`;
}

function expandBody(line, kind) {
  const rows = [];
  if (line.rate !== undefined && line.rate !== null && Number(line.rate) !== 0)
    rows.push(`税率 <b>${pct(line.rate)}</b>`);
  if (line.baseText) rows.push(`税基构成 <b>${esc(line.baseText)}</b>${line.base !== undefined ? ` = ${fmt(line.base)}` : ''}`);
  if (kind === 'tax') {
    rows.push(line.inclusive ? '计价方式 <b>价内税，已 gross-up</b>（base ÷ (1 − rate) × rate）' : '计价方式 <b>价外税</b>（base × rate）');
    rows.push(line.refundable ? '可退性 <b>可抵扣/退还</b>：只影响现金流，不进真实成本' : '可退性 <b>不可退</b>：计入真实成本');
  }
  if (kind === 'charge') {
    // 规费参数本身就是一段量级（报关行报价从来是区间），合计里放的是中值。
    // 不把区间写出来，用户会把这行当中值就是应交数，然后按它去谈价。
    if (line.amountMin && line.amountMax)
      rows.push(`金额区间 <b>${fmt(line.amountMin)} – ${fmt(line.amountMax)}</b>，合计里按中值 ${fmt(line.amount)} 计`);
    if (line.localText) rows.push(`当地报价 <b>${esc(line.localText)}</b>`);
  }
  if (line.note) rows.push(`备注 ${esc(plainText(line.note))}`);
  return `<div class="row-detail">
    <div class="fx">公式：${esc(line.formula || (line.baseText ? `${line.baseText} × ${pct(line.rate || 0)}` : '—'))}</div>
    <ul>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>
    <div class="src-line">来源：${srcLink(line.sourceUrl, plainText(line.note))} ${CONF_BADGE(line.confidence)}</div>
    ${line.unresolvedIds?.length ? `<div class="src-line">关联待核：${line.unresolvedIds.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join('、')}</div>` : ''}
  </div>`;
}

function costTable(report) {
  const e = report.expected;
  if (!e) return '<p class="muted">本报告不出金额。</p>';
  const rows = [];
  let i = 0;
  const add = (line, kind, label, amount, extraCls = '') => {
    i += 1;
    const id = `r${i}`;
    // 区间型规费：金额列直接带上"（下限–上限）"，不另加后缀。
    // label 里已经带了"（代理报价）"这类说明，再拼一层括号会变成两层，读起来像机器写的。
    const amtText =
      line.amountMin && line.amountMax
        ? `${fmt(amount)}<span class="muted small">（${fmt(line.amountMin)}–${fmt(line.amountMax)}）</span>`
        : fmt(amount);
    rows.push(`<tr class="cost-row ${extraCls}" data-row="${id}" data-line="${esc(line.lineCode || label)}">
      <td class="c-name"><button class="exp" data-action="toggle-row" data-target="${id}" aria-expanded="false" aria-label="展开这一行的依据"></button>${esc(label)}</td>
      <td class="c-rate">${line.rate !== undefined && Number(line.rate) !== 0 ? pct(line.rate) : '—'}</td>
      <td class="c-base">${esc(line.baseText || '—')}</td>
      <td class="c-amt" data-confidence="${esc(line.confidence || '')}">${amtText}</td>
    </tr>
    <tr class="detail-row" data-detail="${id}" hidden><td colspan="4">${expandBody(line, kind)}</td></tr>`);
  };

  add(e.dutyBreakdown.find((l) => l.lineCode === 'MFN') || {}, 'duty', `关税 · 最惠国（${pct(e.dutyBreakdown.find((l) => l.lineCode === 'MFN')?.rate || 0)}）`, e.duty);

  for (const l of e.dutyBreakdown.filter((x) => x.lineCode !== 'MFN' && !x.skipped)) {
    add(l, 'surtax', l.label, l.amount);
  }
  for (const l of e.taxChain) {
    add(l, 'tax', `${l.seq}. ${l.name}${l.inclusive ? ' · 价内税' : ''}${l.refundable ? '' : ' · 不可退'}`, l.amount);
  }
  for (const c of e.chargeLines.filter((x) => x.included)) add(c, 'charge', c.label, c.amount);
  for (const c of e.compliance) add({ ...c, baseText: '按票摊销' }, 'compliance', c.label, c.amount);
  // 缺计量数据的定额反倾销税不进成本表：真没加进去，就不能在表里占一行写 0
  if (e.remedy && !e.remedy.incomplete) {
    const unit = e.remedy.basis && e.remedy.basis !== 'ad_valorem' ? `${e.remedy.unitRateUsd} 美元/${e.remedy.unitLabel}` : `final ${pct(e.remedy.finalRate)}`;
    add({ ...e.remedy, baseText: e.remedy.basis === 'ad_valorem' ? 'CIF' : '按量计征', note: 'AD 按最终口径进成本，三口径见 5.5' }, 'remedy', `贸易救济 · ${e.remedy.type}（${unit}）`, e.remedy.final);
  }

  return `<table class="tbl cost-tbl">
    <caption>成本明细（逐行可展开依据：公式 / 税率 / 税基 / 来源 / 置信度）</caption>
    <thead><tr><th>项目</th><th>税率</th><th>税基</th><th class="ta-r">金额 USD</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot>
      <tr><td colspan="3" class="ta-r">到岸后新增总额（真实成本 − CIF）${
        Number(e.refundableVat) > 0
          ? `　·　可退增值税 ${fmt(e.refundableVat)} 不计入真实成本（只计入现金口径）`
          : ''
      }</td><td class="c-amt">${fmt(e.addOnTotal)}</td></tr>
    </tfoot>
  </table>
  <p class="muted small">手风琴同时只展开一条：一次看到 20 条公式会让页面不可读。</p>`;
}

function skippedTable(report) {
  const e = report.expected;
  const rows = (e?.skipped || []).map(
    (s) => `<tr>
      <td>${esc(s.label)}</td>
      <td><span class="tag ${s.pending ? 'tag-mid' : 'tag-low'}">${s.pending ? '待核未计' : s.transitExempt ? '已豁免' : '已跳过'}</span></td>
      <td>${esc(s.reason)}</td>
      <td class="ta-r">${
        s.impactIfApplied !== undefined && s.impactIfApplied !== null
          ? `<b class="${Number(s.impactIfApplied) >= 0 ? 'neg' : 'pos'}">${Number(s.impactIfApplied) >= 0 ? '+' : ''}${fmt(s.impactIfApplied)}</b>`
          : '—'
      }</td>
    </tr>`
  );
  if (!rows.length)
    return `<p class="muted">本票没有被跳过的措施。</p><p class="muted small">用户最常问“为什么这个没算”，所以这一节永远保留位置。</p>`;
  return `<table class="tbl">
    <caption>被跳过的措施（“为什么这个没算”的唯一答案）</caption>
    <thead><tr><th>措施</th><th>状态</th><th>原因</th><th class="ta-r">若成立则影响真实成本</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="muted small">“若成立则影响”= 跑两遍取差得到的净变化（含它对其他措施的连锁淘汰），不是 <code>rate × CIF</code>。符号为负表示该措施成立后成本更低。</p>`;
}

function taxChainTable(report) {
  const e = report.expected;
  if (!e) return '';
  if (!e.taxChain.length)
    return `<p class="muted">目的国没有进口环节国内流转税。这是正确结果，不是加载失败。</p>`;
  const rows = e.taxChain
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map(
      (l) => `<tr>
      <td>${l.seq}</td>
      <td>${esc(l.name)} <span class="mono">${esc(l.taxCode)}</span></td>
      <td>${pct(l.rate)}</td>
      <td>${esc(l.baseText)}</td>
      <td class="ta-r">${fmt(l.amount)}</td>
      <td>${l.inclusive ? '<span class="tag tag-mid">价内税（已 gross-up）</span>' : '<span class="tag">价外税</span>'}</td>
      <td>${l.refundable ? '可退 → 仅现金流' : '<span class="neg">不可退 ＝ 真成本</span>'}</td>
    </tr>`
    )
    .join('');
  return `<table class="tbl">
    <caption>国内税链（按 seq 升序，顺序即计算顺序）</caption>
    <thead><tr><th>seq</th><th>税种</th><th>税率</th><th>税基</th><th class="ta-r">金额</th><th>计价</th><th>可退性</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function remedyBlock(report) {
  const e = report.expected;
  const r = e?.remedy;
  if (!r)
    return `<p class="muted">本票未命中反倾销或反补贴措施，不需要交这笔钱。如果你手上有报关行给的保证金率，可以在校准页填进去重新算。</p>`;

  // 缺计量数据：必须说清"没算"，不能摆一行 0 让人误读成"不用交"
  if (r.incomplete) {
    const need = r.missingField === 'weightKg' ? '总净重（kg）' : '总面积（㎡）';
    return `<div class="remedy-incomplete">
      <p><b>缺${esc(need)}，这笔反倾销税没有算进去。</b></p>
      <p>${esc(r.missingText)}。案件：${esc(r.caseNo)}。</p>
      <p class="note-line">这里的空白不是“不用交”，是“没算”。补上${esc(need)}再跑一次，这笔钱会同时进真实成本与需备现金。</p>
    </div>`;
  }

  // 定额计征：没有"保证金按高率缴、终裁按低率退"的结构，两个口径天然相等
  if (r.basis && r.basis !== 'ad_valorem') {
    return `<table class="tbl remedy">
    <caption>贸易救济（按${esc(r.unitLabel)}定额计征）</caption>
    <thead><tr><th>口径</th><th class="ta-r">金额 USD</th><th>进哪个报表</th></tr></thead>
    <tbody>
      <tr><td>清关缴纳（${esc(r.unitRateUsd)} 美元/${esc(r.unitLabel)} × ${fmt(r.quantity)} ${esc(r.unitLabel)}）</td><td class="ta-r">${fmt(r.deposit)}</td><td>需备现金与真实成本同时计入</td></tr>
    </tbody>
  </table>
  <p class="note-line">定额税不区分保证金与终裁，两个口径相等，不存在退款或补缴。案件：${esc(r.caseNo)}。</p>`;
  }

  const diff = Number(r.final) - Number(r.deposit);
  const kind = diff >= 0 ? '或有负债（需补）' : '或有可退';
  return `<table class="tbl remedy">
    <caption>贸易救济三口径（不可合并）</caption>
    <thead><tr><th>口径</th><th class="ta-r">金额 USD</th><th>进哪个报表</th></tr></thead>
    <tbody>
      <tr><td>清关缴纳（保证金 ${pct(r.depositRate)}）</td><td class="ta-r">${fmt(r.deposit)}</td><td>需备现金（现金流）</td></tr>
      <tr><td>预计最终（p50 ${pct(r.finalRate)}）</td><td class="ta-r">${fmt(r.final)}</td><td>真实成本</td></tr>
      <tr><td>${kind}</td><td class="ta-r">${fmt(Math.abs(diff))}</td><td>${diff >= 0 ? '或有负债' : '或有可退'}</td></tr>
    </tbody>
  </table>
  <p class="note-line">退款请求权归登记进口商（IOR），非付款方。案件：${esc(r.caseNo)}。</p>`;
}

/**
 * 协定优惠税率：并列表格，永不并入上方金额。
 * 能不能享惠取决于用户手上有没有原产地证、RVC 是否达标，系统不替他假设。
 */
function ftaBlock(report) {
  const list = report.fta || [];
  if (!list.length) {
    return `<p class="muted">本票没有可用的协定优惠：目的地不在已建协定的成员内，或该品类的协定税率与最惠国税率相同。</p>`;
  }
  const rows = list
    .map(
      (x) => `<tr>
      <td>${esc(x.label)}</td>
      <td class="ta-r">${pct(x.mfnRate)}</td>
      <td class="ta-r"><b>${pct(x.preferentialRate)}</b></td>
      <td class="ta-r">${fmt(x.saving)}</td>
      <td>${esc(x.certificate)}${x.leadTimeDays ? `（约 ${x.leadTimeDays[0]}–${x.leadTimeDays[1]} 个工作日）` : ''}</td>
    </tr>`
    )
    .join('');
  return `<table class="tbl fta">
    <caption>如果办原产地证，关税能降到多少</caption>
    <thead><tr><th>协定</th><th class="ta-r">现在（最惠国）</th><th class="ta-r">办证后</th><th class="ta-r">可省关税 USD</th><th>需要什么</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note-line">这一块<b>不计入</b>上面任何金额。能不能享惠取决于你有没有原产地证、原产地成分是否达标——这两件事系统不知道，所以不替你假设。省下的只是关税；增值税基数同步变小，实际现金流改善更多。</p>`;
}

function sensitivity(report) {
  const items = report.sensitivity || [];
  if (!items.length) return '<p class="muted">本票无可用敏感性项。</p>';
  const rows = items
    .map(
      (s) => `<tr>
      <td>${esc(s.label)}</td>
      <td>${esc(s.change)}</td>
      <td class="ta-r ${Number(s.delta) >= 0 ? 'neg' : 'pos'}">${Number(s.delta) >= 0 ? '+' : ''}${fmt(s.delta)}</td>
      <td>${esc(plainText(s.note || ''))}</td>
    </tr>`
    )
    .join('');
  return `<table class="tbl">
    <caption>假设变了会怎样（前 5 项）</caption>
    <thead><tr><th>改什么</th><th>怎么改</th><th class="ta-r">差多少（真实成本）</th><th>说明</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted small">静态直出（MVP 降级态）：结论已算好，不可拖动重算。</p>`;
}

function timeline(report) {
  const items = report.timeline || [];
  const lines = items.map((t) => {
    if (t.kind === 'window') {
      return `<div class="tl-window">
        <span class="tl-date">${esc(t.shipBy)}</span>
        <span class="tl-bar"><i></i></span>
        <span class="tl-date">${esc(t.enterBy)}</span>
        <span class="tl-cap">${esc(t.label)}</span>
      </div>
      <p class="muted small">本票装船 ${esc(t.exportDate || '未填')} · 申报 ${esc(t.entryDate)}。用一条线画会误导，因为它是双条件。</p>`;
    }
    return `<div class="tl-row">
      <span class="tl-dot ${t.relation === 'past' ? 'past' : ''}"></span>
      <span class="tl-date">${esc(t.date)}</span>
      <span class="tl-label">${esc(t.label)}</span>
      <span class="tag">${t.relation === 'past' ? '已发生' : '将发生'}</span>
      <span class="tag">${t.type === 'version' ? '版本' : '措施'}</span>
    </div>`;
  });
  return `<div class="tl">${lines.join('')}</div>
  <p class="muted small">只讲“什么时候”，不讲“多危险”（C5 只做时效，风险在段 3 的独立卡片）。</p>`;
}

function actions(report) {
  const list = report.actions || [];
  if (!list.length) return '<p class="muted">本票无额外待办。</p>';
  const rows = list
    .map(
      (a) => `<tr>
      <td>${a.order}</td>
      <td>${esc(a.label)}${a.mandatory === false ? ' <span class="tag">可选</span>' : ''}</td>
      <td>${esc(a.who || '—')}</td>
      <td class="nowrap">${esc(a.days || '—')}</td>
      <td>${esc(plainText(a.note || ''))}</td>
    </tr>`
    )
    .join('');
  return `<table class="tbl">
    <caption>要办的事（谁办 / 几天 / 顺序）</caption>
    <thead><tr><th>#</th><th>事项</th><th>谁办</th><th>时限</th><th>备注</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function branchCompare(report) {
  if (!report.branches) return '';
  const [b1, b2] = report.branches;
  const delta = Math.abs(Number(b2.landedCost) - Number(b1.landedCost));
  return `<div class="bc" data-branch-compare>
    <div class="bc-head">同一条未决事实，两个互斥结论（必须同屏，不折叠）</div>
    ${report.branches
      .map(
        (b) => `<button class="bc-row ${b.isDefault ? 'is-default' : ''} ${
          report.viewBranch === b.branchId ? 'is-active' : ''
        }" data-action="switch-branch" data-branch="${b.branchId}">
        <span class="bc-tag">${b.isDefault ? '默认' : '另一分支'}</span>
        <span class="bc-label">若 ${esc(b.condition)}，则真实成本 <b>${fmt(b.landedCost)}</b> / 需备现金 ${fmt(
          b.cashRequired
        )}</span>
        <span class="bc-act">${report.viewBranch === b.branchId ? '当前视图' : '查看此分支'}</span>
      </button>`
      )
      .join('')}
    <div class="bc-delta">差额 <b>${fmt(delta)}</b> 美元 ${report.unresolved.find((u) => u.id === 'UF-01') ? '（12.5 个点）' : ''}<span>这一个未决事实值这么多钱——值不值得去问，是这条数字要回答的。</span></div>
    <div class="bc-note">默认分支 = 不计入未确认的措施。这是<b>产品取舍，不是事实结论</b>；本默认按不计入计算，若该措施成立，成本会更低 ${fmt(
      delta
    )}。</div>
  </div>`;
}

function unresolvedCards(report) {
  if (!report.unresolved?.length) return '<p class="muted">本票未命中待核项。</p>';
  return report.unresolved
    .map((u) => {
      const t1 = u.tier === 'T1_BRANCH';
      const cond = t1
        ? `若 ${esc(u.counterValue?.label || '该事实成立')}，则真实成本 ${fmt(u.counterValue?.landedCost)} 美元；若不计入，则为 ${fmt(
            u.currentValue?.landedCost
          )} 美元`
        : `若 ${esc(u.counterValue?.label || u.title)}，则本票再 ${fmt(u.impactUsd)} 美元`;
      const amountLine =
        u.impactUsd !== null && u.impactUsd !== undefined
          ? `<div class="uc-impact" data-unresolved-impact>${cond}<span class="uc-delta">${t1 ? '差额' : '影响'} ${fmt(
              u.impactUsd
            )} 美元</span></div>`
          : `<div class="uc-impact" data-unresolved-impact><span class="uc-noprice">本项无法单独标价</span>${esc(
              u.impactDisplay || '不进入金额'
            )}</div>`;
      const subs = u.subItems
        ? `<ul class="uc-subs">${u.subItems
            .map((s) => `<li><b>${esc(s.id)}</b> ${esc(s.title)}：${esc(s.reportText)}<span class="muted">｜${esc(s.suggestAction)}</span></li>`)
            .join('')}</ul>`
        : '';
      return `<article class="uc uc-${u.tier}" data-unresolved-id="${esc(u.id)}" data-exclusive-group="G-232-301" id="${esc(u.id)}">
      <header class="uc-head">
        <span class="uc-tier">${esc(u.tier)}</span>
        <h3>${esc(u.title)}</h3>
        <span class="uc-id">${esc(u.id)}</span>
        ${u.status === 'open' ? '<span class="tag tag-mid">待核中</span>' : `<span class="tag">${esc(u.status)}</span>`}
      </header>
      ${amountLine}
      <dl class="uc-dl">
        <dt>为什么这么算</dt><dd>${esc(u.currentBasis)}</dd>
        ${u.counterBasis ? `<dt>反事实</dt><dd>${esc(u.counterBasis)}</dd>` : ''}
        <dt>怎么核</dt><dd>${esc(u.reviewAction)}</dd>
        <dt>关闭条件</dt><dd>${esc(u.closeCriteria)}</dd>
        <dt>复核期限</dt><dd>${esc(u.reviewDue || '—')}${
          u.degrade?.overdue > 30 ? ` <span class="neg">（已逾期 ${u.degrade.overdue} 天）</span>` : ''
        }</dd>
        ${u.dependsOn ? `<dt>依赖关系</dt><dd>关联 ${esc(u.dependsOn)}：两条要一起看，金额不能相加</dd>` : ''}
      </dl>
      ${u.dependencyNote ? `<p class="uc-risk">${esc(u.dependencyNote)}</p>` : ''}
      ${subs}
    </article>`;
    })
    .join('');
}

function gaps(report) {
  const gaps = report.dataGaps || [];
  const unver = gaps.filter((g) => g.unverified);
  const others = gaps.filter((g) => !g.unverified);
  const row = (g) => `<tr>
    <td>${esc(g.field)}</td>
    <td>${esc(g.reason)}</td>
    <td class="ta-r">${g.impactUsd !== null && g.impactUsd !== undefined ? fmt(g.impactUsd) : '—'}</td>
    <td>${esc(g.suggestAction)}</td>
  </tr>`;
  const states = (report.range?.states || [])
    .map(
      (s) =>
        `<li>${s.id && s.id !== 'ONLY' ? `<b>${esc(s.id)}</b> ` : ''}${esc(s.label)} → ${fmt(s.landedCost)}${
          s.note ? ` <span class="muted">（${esc(plainText(s.note))}）</span>` : ''
        }</li>`
    )
    .join('');
  return `<div class="gap-wrap">
    <div class="gap-conf" data-unverified-badge>
      报告置信度（min 法，对外）：<b>${esc(report.confidence.report)}</b> ·
      金额加权置信度（对内）：${pct(report.confidence.weighted, 0)} ·
      未核实项：${report.confidence.unverifiedCount} 项
    </div>
    ${
      others.length
        ? `<table class="tbl"><caption>缺口清单（每条都标价）</caption>
      <thead><tr><th>缺口</th><th>为什么算不准</th><th class="ta-r">值多少钱</th><th>下一步</th></tr></thead>
      <tbody>${others.map(row).join('')}</tbody></table>`
        : '<p class="muted">无缺口记录。</p>'
    }
    ${
      unver.length
        ? `<div class="gap-unver" data-unverified-badge><h4>未核实项（不可对外引用）</h4><table class="tbl">
        <thead><tr><th>缺口</th><th>说明</th><th class="ta-r">金额</th><th>下一步</th></tr></thead>
        <tbody>${unver.map(row).join('')}</tbody></table></div>`
        : ''
    }
    ${
      states
        ? `<div class="gap-states"><h4>可达状态枚举（不给“总不确定性”）</h4>
      <ul>${states}</ul>
      <p class="muted small">互斥项取状态最大值、串联项才求和。单条 max 会给出不存在的状态，直接相加会重复计算。</p></div>`
        : ''
    }
  </div>`;
}

function footer(report) {
  const m = report.meta;
  return `<div class="rp-foot">
    <div class="foot-meta">引擎 ${esc(m.engineVersion)} / 参数 ${esc(m.paramsVersion)} / 截止 ${esc(m.asOf)} / 报告 ${esc(
    report.reportId
  )}</div>
    <div class="foot-meta">产品版本 ${esc(report.productVersion)} · HS 版本 ${esc(m.hsVersion)} · 标注截止 ${esc(
    report.asOfState?.annotationAsOf || m.asOf
  )}</div>
    <p class="disclaimer" data-unverified-badge>本报告为基于公开参数与您提供输入的估算，不构成法律、税务或海关申报意见。标注“待核/未核实”的事项尚未取得一手来源，不得作为申报依据。最终税费以目的国海关与您的报关代理确认为准。</p>
  </div>`;
}

function calibrate(report) {
  return `<div class="cal">
    <div class="cal-txt"><b>上传实际税单，帮我们算准。</b>系统会算出偏差并归因到四类：参数错 / 输入错 / 政策变 / 口径理解错。校准只用于改进参数与文案，<b>不会回写这份报告的历史金额</b>。</div>
    <a class="btn btn-ghost" href="/quote/${esc(report.reportId)}/calibrate" data-action="calibrate">上传实际税单</a>
  </div>`;
}

export function renderSections(report) {
  const blocked = report.state === 'blocked';
  const parts = [
    sec(1, 'sec-conclusion', '一句话结论', conclusion(report)),
    sec(2, 'sec-diamond', '区间：最乐观 / 本报告 / 最坏', diamond(report)),
    sec('2.5', 'sec-dual', '双口径对比：真实成本 vs 要备现金', dualBasis(report)),
    sec(3, 'sec-score', '两个分数：能不能进 / 赚不赚', scoreCards(report)),
  ];

  if (!blocked) {
    parts.push(sec(4, 'sec-cost', '成本明细：每一分钱怎么算出来的', costTable(report)));
    parts.push(sec('4.5', 'sec-skipped', '被跳过的措施', skippedTable(report)));
    parts.push(sec(5, 'sec-tax', '国内税链', taxChainTable(report)));
    parts.push(sec('5.5', 'sec-remedy', '贸易救济与协定优惠', `${remedyBlock(report)}${ftaBlock(report)}`));
  } else {
    parts.push(
      sec(4, 'sec-cost', '成本明细', `<p class="muted">已阻断，不出金额。</p>`),
      sec('4.5', 'sec-skipped', '被跳过的措施', `<p class="muted">已阻断，不出金额。</p>`),
      sec(5, 'sec-tax', '国内税链', `<p class="muted">已阻断，不出金额。</p>`),
      sec('5.5', 'sec-remedy', '贸易救济与协定优惠', `<p class="muted">已阻断，不出金额。</p>`)
    );
  }

  parts.push(
    sec(6, 'sec-sens', '假设变了会怎样', sensitivity(report)),
    sec(7, 'sec-timeline', '时间轴与豁免窗口', timeline(report)),
    sec(8, 'sec-actions', '要办的事', actions(report)),
    sec(
      '8.5',
      'sec-unres',
      '待核与双分支',
      `${branchCompare(report)}
      <div class="unres-list">${unresolvedCards(report)}</div>`,
      'data-unresolved-block'
    ),
    sec(9, 'sec-gaps', '置信度与缺口汇总', gaps(report)),
    sec(10, 'sec-footer', '页脚与免责声明', footer(report)),
    sec(11, 'sec-cal', '校准入口', calibrate(report))
  );

  return parts.join('\n');
}

export function renderReport(report, opts = {}) {
  const view = opts.branchId ? applyBranch(report, opts.branchId) : { ...report, viewBranch: report.branches?.find((b) => b.isDefault)?.branchId || null };
  const viewTag = view.viewBranch
    ? `<div class="view-tag">当前视图：分支 ${esc(view.viewBranch)} · ${esc(view.viewBranchLabel || '')}（切换不改金额快照）</div>`
    : '';
  return `<div class="rp" data-state="${esc(report.state)}">
    ${viewTag}
    ${banner(view)}
    ${report.state === 'needs_confirmation' ? '<div class="bar bar-yellow">缺少关键输入，本报告不出金额。请补齐后重新预演。</div>' : ''}
    ${renderSections(view)}
  </div>`;
}
