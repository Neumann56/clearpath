/**
 * 移动端（/m）页面模板。
 *
 * 和 PC 版（render.js）的区别不是"把表格改窄"，是**信息顺序重排**：
 * 手机上先给两个数和三件事，明细全部折叠；PC 上则是先摆表格再讲结论。
 *
 * 三条不许破的规矩（和 PC 完全一致）：
 *   1. landedCost / cashRequired 各占一格，中间画个「≠」，绝不相加
 *   2. expected 为 null 时显示"—"加原因，不显示 0
 *   3. 待核清单为空也要出现，写「本票没有待核项」
 */
import { esc, stateLabel } from './render.js';
import { fmt, pct } from './decimal.js';

const N = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : fmt(v));

/** 比率一律 0–1 小数，这里统一乘 100 再显示，避免有的地方写 0.03 有的写 3% */
const P = (v, d = 2) => (v === null || v === undefined ? '—' : pct(v, d));

/**
 * 参数库的 note 里混进过内部字段名（如 "不进 landedCost"）。
 * 界面上不许出现这些词——它对人没有意义，只会让读者以为自己看的是源码。
 * 在渲染层统一兜一遍，历史报告里的旧文案也能一起清掉；
 * 数据侧下次发新参数版本时再改干净，两边都做才不会再漏。
 */
const FIELD_PLAIN = [
  // \s* 是必需的：原文写「不进 landedCost」，只换词会留下「不进 真实成本」这种半中文半空的句子
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

function plain(s) {
  let out = String(s || '');
  for (const [re, to] of FIELD_PLAIN) out = out.replace(re, to);
  return out;
}

const STATE_CLASS = {
  complete: '',
  complete_with_gaps: 'gap',
  needs_confirmation: 'confirm',
  blocked: 'block',
};

const TABS = [
  { id: 'home', href: '/m', label: '首页' },
  { id: 'new', href: '/m/new', label: '预演' },
  { id: 'reports', href: '/m/reports', label: '历史' },
  { id: 'learn', href: '/m/learn', label: '看懂' },
  { id: 'chat', href: '/m/chat', label: '老周' },
];

function mobileLayout({ title, body, active = '', script = '', back = '', footbar = '', nav = true }) {
  const tabbar = nav
    ? `<nav class="mtab">${TABS.map(
        (t) => `<a href="${t.href}" class="${t.id === active ? 'on' : ''}">${esc(t.label)}</a>`
      ).join('')}</nav>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f4d5c">
<meta name="format-detection" content="telephone=no">
<title>${esc(title)} · 通途</title>
<!-- 与小程序头像同一枚 ¥ 标记；改这里要同步 lib/render.js（出图见 scripts/make-icon.js） -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f4d5c'/%3E%3Cpath d='M10 8L16 15L22 8M16 15V24M11.5 17.5H20.5M11.5 21.5H20.5' fill='none' stroke='%23fff' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/css/mobile.css">
</head>
<body data-page="${esc(active)}" class="${nav ? 'has-tab' : ''}">
<header class="mtop">
  ${back ? `<a class="back" href="${esc(back)}" aria-label="返回">‹</a>` : ''}
  <a class="brand" href="/m">通途<em>CLEARPATH</em></a>
  <span class="sp"></span>
  <a class="tiny muted" href="/">电脑版</a>
</header>
<main class="mwrap">${body}</main>
${footbar}
${tabbar}
<script src="/js/mobile.js" type="module"></script>
${script ? `<script src="${script}" type="module"></script>` : ''}
</body>
</html>`;
}

/* ============================ 首页 ============================ */

export function mHome({ params, coverage, sample = null }) {
  const cov = coverage || { markets: { total: 0 }, categories: [], cells: 0, chargesMarkets: 0 };
  const catNames = (cov.categories || []).map((c) => c.name).join('、');
  const S = sample || {};
  const sampleNote = sample
    ? `<p class="tiny muted" style="text-align:center;margin:-6px 0 14px">${
        sample.isOwn ? '你最近算过的' : '样例'
      }：${esc(sample.countryName || sample.country || '')} · ${esc(fmtHs(sample.hsCode))} · 真算出来的数，不是写死的</p>`
    : '';
  const body = `
<section class="mhero">
  <span class="kicker">报价前 3 分钟</span>
  <h1>先把这票货的账<br><b>算清</b>，再报价。</h1>
  <p>给两个数：真实成本、清关需备现金。<br>再加一份标了价的「算不准清单」。</p>
</section>

<div class="card">
  <div class="nlbox">
    <textarea id="nl" placeholder="一句话说清这票货，例：
8708.91 散热器 1200 件，FOB 48000 美元，运到匈牙利"></textarea>
  </div>
  <div class="chips" id="chips">
    <span class="chip" data-fill="8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报">汽配 → 匈牙利</span>
    <span class="chip" data-fill="8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到美国，10 月 20 日申报">汽配 → 美国</span>
    <span class="chip" data-fill="8541.43 光伏组件 500 件，FOB 10000 美元，运到巴西，10 月 20 日申报">光伏 → 巴西</span>
  </div>
  <button class="btn btn-block" id="go" style="margin-top:6px">试算这票货</button>
  <p class="tiny muted" id="parseHint" style="margin:8px 0 0" hidden></p>
</div>

<div class="dual">
  <div class="dnum main">
    <span>真实成本</span>
    <b>${sample ? N(S.landedCost) : '—'}</b>
    <i>毛利按这个算</i>
  </div>
  <div class="dnum">
    <span>需备现金</span>
    <b>${sample ? N(S.cashRequired) : '—'}</b>
    <i>现金流按这个</i>
  </div>
</div>
<p class="dual-note">两个数永不相加。可退的增值税只影响现金，不进成本。</p>
${sampleNote}

<div class="entries">
  <a class="entry" href="/m/new"><b>逐项填</b><span>七个格，慢慢填</span></a>
  <a class="entry" href="/m/calendar"><b>政策日历</b><span>什么时候申报</span></a>
  <a class="entry" href="/m/learn"><b>看懂外贸</b><span>FOB/CIF 是什么</span></a>
</div>

<p class="covline">
参数库覆盖 <b>${cov.markets ? cov.markets.total : 0}</b> 个市场 × <b>${(cov.categories || []).length}</b> 个品类，
共 <b>${cov.cells || 0}</b> 个能直接出数的组合。<br>
品类：${esc(catNames)}。<br>
其中 <b>${cov.chargesMarkets || 0}</b> 个市场已录清关规费，其余在报告里明说「参数未入库」，不填 0 蒙过去。
</p>`;
  return mobileLayout({ title: '报价前先把账算清', body, active: 'home' });
}

/* ============================ 录入 ============================ */

export function mNew({ params, preset = {} }) {
  const countries = (params.raw.countries || []).filter((c) => c.entryEnabled);
  const cats = params.raw.hsCatalog || [];

  // 国家选择用底部弹层：68 个国家塞进原生 select，手机上要点十几下才找得到
  const groups = new Map();
  for (const c of countries) {
    const k = c.region || 'OTHER';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const REGION_ORDER = ['EU', 'EUROPE_NON_EU', 'ASIA', 'MIDDLE_EAST', 'AMERICAS', 'AFRICA', 'OCEANIA'];
  const REGION_TEXT = {
    EU: '欧盟 27 国（共用一套关税）',
    EUROPE_NON_EU: '欧洲其他',
    ASIA: '亚洲',
    MIDDLE_EAST: '中东',
    AMERICAS: '美洲',
    AFRICA: '非洲',
    OCEANIA: '大洋洲',
  };
  const sheetBody = REGION_ORDER.filter((r) => groups.has(r))
    .map(
      (r) => `<div class="sheet-grp">${esc(REGION_TEXT[r] || r)}</div>${groups
        .get(r)
        .map((c) => `<button type="button" class="sheet-op" data-code="${esc(c.code)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`)
        .join('')}`
    )
    .join('');

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const body = `
<form id="qf" novalidate>
  <div class="card">
    <div class="field">
      <label>目的国 <span class="req">*</span></label>
      <input type="text" id="countryText" readonly placeholder="点这里选" value="${esc(
        preset.countryName || ''
      )}" data-code="${esc(preset.country || '')}">
      <div class="hint">${countries.length} 个市场按 7 个区域分组；欧盟 27 国共用一套对外关税。</div>
    </div>

    <div class="field">
      <label>HS 编码 / 品名 <span class="req">*</span></label>
      <input type="text" id="hsCode" placeholder="8708.91 或直接写「汽配」" value="${esc(preset.hsCode || '')}" autocomplete="off">
      <div class="chips" id="hsChips" style="padding-top:8px">
        ${cats
          .map((c) => `<span class="chip" data-hs="${esc(c.hs)}" data-name="${esc(c.name)}">${esc(c.name)}</span>`)
          .join('')}
      </div>
      <div class="hint" id="hsHint">写品名也能认；认不出会直说，不拿相近品类顶替。</div>
    </div>

    <div class="field">
      <label>FOB 货值（美元）<span class="req">*</span></label>
      <input type="number" id="fob" inputmode="decimal" placeholder="48000" value="${esc(preset.fob ?? '')}">
      <div class="hint">不含运费保险的离岸价</div>
    </div>

    <div class="field">
      <label>运费（美元）<span class="req">*</span></label>
      <input type="number" id="freight" inputmode="decimal" placeholder="2400" value="${esc(preset.freight ?? '')}">
    </div>

    <div class="field">
      <label>数量 <span class="req">*</span></label>
      <input type="number" id="qty" inputmode="numeric" placeholder="1200" value="${esc(preset.qty ?? '')}">
    </div>

    <div class="field">
      <label>渠道 <span class="req">*</span></label>
      <div class="seg" id="segChannel">
        <button type="button" data-v="B2B" class="${preset.channel === 'B2B' ? 'on' : ''}">B2B 企业采购</button>
        <button type="button" data-v="B2C" class="${preset.channel === 'B2C' ? 'on' : ''}">B2C 零售包裹</button>
      </div>
      <div class="hint">选 B2C 会多出欧盟包裹费这类按件计的政策</div>
    </div>

    <div class="field" style="margin-bottom:4px">
      <label>申报日期 <span class="req">*</span></label>
      <input type="date" id="declarationDate" value="${esc(preset.declarationDate || todayStr)}">
      <div class="hint">决定适用哪一档税率，也决定 232/301 这类措施的版本</div>
    </div>
  </div>

  <details class="adv">
    <summary>更多选项：出口日、保险、反倾销</summary>
    <div class="inner">
      <div class="field">
        <label>出口日期（装船日）</label>
        <input type="date" id="exportDate" value="${esc(preset.exportDate || '')}">
        <div class="hint">在途豁免要按它判定；不能用「交给货代日」顶替</div>
      </div>
      <div class="field">
        <label>保险（美元）</label>
        <input type="number" id="insurance" inputmode="decimal" placeholder="留空按默认系数估算">
        <div class="hint">留空会进「假设」清单，报告里标出来</div>
      </div>
      <div class="field">
        <label>金属含量（0–1）</label>
        <input type="number" id="metalContentPct" inputmode="decimal" placeholder="0.62" step="0.01">
        <div class="hint">命中 232 且档位允许豁免时才影响结论</div>
      </div>
      <div class="field">
        <label>总面积（㎡）</label>
        <input type="number" id="areaSqm" inputmode="decimal" placeholder="如 5000">
        <div class="hint">反倾销按平方米定额计征时必填（如土耳其对华光伏），缺它这笔钱不出金额</div>
      </div>
      <div class="field" style="margin-bottom:2px">
        <label>规费</label>
        <div class="seg" id="segCharges">
          <button type="button" data-v="" class="on">不计</button>
          <button type="button" data-v="all">全部计入</button>
        </div>
        <div class="hint">报关代理费、码头操作费按区间中值估算，明细可展开</div>
      </div>
    </div>
  </details>
</form>

<div class="sheet-mask" id="sheetMask">
  <div class="sheet">
    <div class="sheet-hd"><b>选目的国</b><span class="x" id="sheetX">×</span></div>
    <div class="sheet-bd">${sheetBody}</div>
  </div>
</div>`;

  const footbar = `<div class="mfootbar">
  <div class="est" id="est">
    <span>真实成本 <b>—</b></span>
    <span>需备现金 <b>—</b></span>
  </div>
  <button class="btn btn-block" id="submitBtn" type="button">算出这票的账</button>
</div>`;

  return mobileLayout({ title: '新预演', body, active: 'new', footbar, back: '/m' });
}

/* ============================ 报告 ============================ */

function dutyLines(e) {
  const rows = [];
  for (const d of e.dutyBreakdown || []) {
    if (d.skipped) continue;
    rows.push(`<div class="line">
      <span class="k">${esc(d.label || '关税')}${
      d.confidence ? `<span class="tag ${esc(d.confidence)}">${esc(confText(d.confidence))}</span>` : ''
    }${d.baseText ? `<i>基数 ${esc(d.baseText)} · ${N(d.base)}</i>` : ''}</span>
      <span class="v">${d.pending ? '待定' : N(d.amount)}</span>
    </div>`);
  }
  for (const t of e.taxChain || []) {
    rows.push(`<div class="line">
      <span class="k">${esc(t.name || t.label || '税')}${
      t.refundable ? '<span class="tag high">可抵扣</span>' : ''
    }${t.confidence ? `<span class="tag ${esc(t.confidence)}">${esc(confText(t.confidence))}</span>` : ''}
      <i>${P(t.rate)} × ${N(t.base)}${t.note ? ' · ' + esc(plain(t.note)) : ''}</i></span>
      <span class="v">${N(t.amount)}</span>
    </div>`);
  }
  for (const c of (e.chargeLines || []).filter((x) => x.included)) {
    rows.push(`<div class="line">
      <span class="k">${esc(c.label || '规费')}<i>${esc(c.baseText || '')}</i></span>
      <span class="v">${N(c.amount)}</span>
    </div>`);
  }
  for (const c of e.compliance || []) {
    if (!c.amount) continue;
    rows.push(`<div class="line">
      <span class="k">${esc(c.label || '认证成本')}<i>按票摊销</i></span>
      <span class="v">${N(c.amount)}</span>
    </div>`);
  }
  if (e.remedy && !e.remedy.incomplete) {
    rows.push(`<div class="line">
      <span class="k">贸易救济 · ${esc(e.remedy.type || '')}<i>按最终口径计入成本</i></span>
      <span class="v">${N(e.remedy.final)}</span>
    </div>`);
  }
  return rows.join('') || '<p class="small muted" style="margin:6px 0">本票没有需要单列的税</p>';
}

function confText(c) {
  return { high: '高', medium: '中', low: '低' }[c] || c;
}

export function mReport({ report }) {
  const r = report;
  const e = r.expected || null;
  const st = STATE_CLASS[r.state] !== undefined ? STATE_CLASS[r.state] : '';
  const unresolved = r.unresolved || [];
  // 同一条 D 级参数会同时出现在 dataGaps 和 unresolved 里。
  // 手机上两条一模一样、一条红一条黄，谁看都以为是重复渲染。
  // 待核项那条信息更全（带复核动作和截止日），所以缺口里同 id 的不再单独列。
  const unresolvedIds = new Set(unresolved.map((u) => u.id).filter(Boolean));
  const gaps = (r.dataGaps || []).filter((g) => !g.factId || !unresolvedIds.has(g.factId));
  const actions = r.actions || [];

  const head = `<div class="rhead">
  <span class="rstate ${st}">${esc(stateLabel(r.state))}</span>
  <h2>${esc(r.input?.countryName || r.input?.country || '')} · ${esc(fmtHs(r.input?.hsCode))}</h2>
  <div class="sub">${esc(r.input?.dates?.declarationDate || '')} 申报 · 参数版本 ${esc(r.meta?.paramsVersion || '')}</div>
</div>`;

  // expected 为 null 是 blocked / needs_confirmation 的正常形态：
  // 这时候写 0 会让人以为算出来了，所以只写「—」加原因。
  const dual = e
    ? `<div class="dual bigdual">
    <div class="dnum main"><span>真实成本</span><b>${N(e.landedCost)}</b><i>毛利按这个算</i></div>
    <div class="dnum"><span>需备现金</span><b>${N(e.cashRequired)}</b><i>现金流按这个</i></div>
  </div>
  <p class="dual-note">两个数永不相加。${
    e.refundableVat ? `其中可退增值税 ${N(e.refundableVat)} 只占现金，不进成本。` : '本票没有可退的进口环节税。'
  }</p>`
    : `<div class="card">
    <h3>这份算不出来</h3>
    <p class="small muted" style="margin:0">${
      (r.warnings && r.warnings[0] && esc(r.warnings[0])) || '缺关键输入，或命中了不允许出数的规则。'
    }</p>
    <p class="small muted" style="margin:6px 0 0">宁可不出数，也不给一个看起来像答案的 0。</p>
  </div>`;

  const gapBar =
    e && e.cashGap > 0
      ? `<div class="gapbar">
    <span>现金缺口<b>${N(e.cashGap)}</b></span>
    <span>${P(e.cashGapRatio, 1)} 要先垫</span>
  </div>`
      : '';

  const unresolvedHtml = unresolved.length
    ? unresolved
        .map(
          (u) => `<div class="warn-item">
      <b>${esc(u.title || u.id)}</b>
      ${u.reviewDue ? `要在 ${esc(String(u.reviewDue).slice(0, 10))} 前核清` : ''}
      ${u.impactUsd || (u.counterValue && u.counterValue.impactUsd) ? ` · 影响约 ${N(u.impactUsd || u.counterValue.impactUsd)} 美元` : ' · 影响金额未量化'}
      ${u.reviewAction ? `<span class="act">怎么核：${esc(u.reviewAction)}</span>` : ''}
    </div>`
        )
        .join('')
    : '<div class="empty-ok">本票没有待核项。所有用到的参数都有出处。</div>';

  const gapsHtml = gaps.length
    ? gaps
        .map(
          (g) => `<div class="warn-item" style="background:var(--red-soft);color:#7d2818">
      <b>${esc(g.field)}</b>${esc(g.reason)}
      ${g.suggestAction ? `<span class="act">怎么办：${esc(g.suggestAction)}</span>` : ''}
    </div>`
        )
        .join('')
    : '';

  const actionsHtml = actions.length
    ? actions
        .map(
          (a) => `<div class="line">
      <span class="k">${esc(a.label)}${a.mandatory ? '<span class="tag low">强制</span>' : ''}
      <i>${esc(a.who || '')}${a.days ? ' · 提前 ' + esc(a.days) : ''}${a.note ? ' · ' + esc(a.note) : ''}</i></span>
    </div>`
        )
        .join('')
    : '<p class="small muted" style="margin:6px 0">这票不需要额外办证。</p>';

  const rangeHtml = r.range
    ? `<div class="line"><span class="k">最好情况</span><span class="v q">${N(r.range.best)}</span></div>
       <div class="line"><span class="k">按现在参数</span><span class="v">${N(r.range.expected)}</span></div>
       <div class="line"><span class="k">最坏情况<span class="tag low">报价要按这个</span></span><span class="v">${N(r.range.worst)}</span></div>
       ${r.range.worstExtra ? `<div class="line"><span class="k">最坏比现在多</span><span class="v neg">${N(r.range.worstExtra)}</span></div>` : ''}`
    : '<p class="small muted" style="margin:6px 0">本票只有一种可达状态，没有区间。</p>';

  const sensHtml = (r.sensitivity || []).length
    ? (r.sensitivity || [])
        .map(
          (s) => `<div class="line">
      <span class="k">${esc(s.label)}<i>${esc(s.change || '')}</i></span>
      <span class="v ${s.delta >= 0 ? 'neg' : 'pos'}">${s.delta >= 0 ? '+' : ''}${N(s.delta)}</span>
    </div>`
        )
        .join('')
    : '<p class="small muted" style="margin:6px 0">没有可做的敏感度分析。</p>';

  const assumeHtml = (r.assumptions || []).length
    ? (r.assumptions || [])
        .map(
          (a) => `<div class="line">
      <span class="k">${esc(a.field)}${a.confidence ? `<span class="tag ${esc(a.confidence)}">${esc(confText(a.confidence))}</span>` : ''}
      <i>${esc(a.note || '')}</i></span>
      <span class="v q">${a.value === null || a.value === undefined ? '—' : esc(String(a.value))}</span>
    </div>`
        )
        .join('')
    : '<p class="small muted" style="margin:6px 0">没有额外假设。</p>';

  const timeHtml = (r.timeline || []).length
    ? (r.timeline || [])
        .map(
          (t) => `<div class="cal-item ${t.relation === 'past' ? 'in' : ''}">
      <span class="cal-d">${esc(String(t.date || '').slice(5))}</span>
      <span class="cal-b"><div class="t">${esc(t.label)}</div>
      <div class="m">${t.relation === 'past' ? '已过' : t.relation === 'future' ? '未到' : ''}</div></span>
    </div>`
        )
        .join('')
    : '<p class="small muted" style="margin:6px 0">本票没有相关的时间节点。</p>';

  const body = `
${head}
${dual}
${gapBar}

<details class="fold" open>
  <summary><span class="idx">1</span>钱是怎么算出来的<span class="caret">›</span></summary>
  <div class="body">
    <div class="line"><span class="k">CIF 到岸价<i>FOB + 运费 + 保险</i></span><span class="v">${N(e?.cif)}</span></div>
    ${e ? dutyLines(e) : ''}
    ${
      e
        ? `<div class="line tot"><span class="k">真实成本</span><span class="v">${N(e.landedCost)}</span></div>
           <div class="line tot"><span class="k">需备现金</span><span class="v">${N(e.cashRequired)}</span></div>`
        : ''
    }
    <p class="tiny muted" style="margin:10px 0 0">税率与置信度都来自参数库，每个数都能追到出处。打开电脑版可以逐行看来源链接。</p>
  </div>
</details>

<details class="fold" open>
  <summary><span class="idx">2</span>还没算准的 <span class="cnt">${unresolved.length + gaps.length} 项</span><span class="caret">›</span></summary>
  <div class="body">
    ${gapsHtml}
    ${unresolvedHtml}
  </div>
</details>

<details class="fold">
  <summary><span class="idx">3</span>要办的事 <span class="cnt">${actions.length} 项</span><span class="caret">›</span></summary>
  <div class="body">${actionsHtml}</div>
</details>

<details class="fold">
  <summary><span class="idx">4</span>别的可能 <span class="cnt">最坏值 / 敏感度 / 假设</span><span class="caret">›</span></summary>
  <div class="body">
    <h3 style="font-size:12.5px;color:var(--muted);margin:2px 0 4px">三种情况</h3>
    ${rangeHtml}
    <h3 style="font-size:12.5px;color:var(--muted);margin:14px 0 4px">哪个变量最要命</h3>
    ${sensHtml}
    <h3 style="font-size:12.5px;color:var(--muted);margin:14px 0 4px">我替你默认了什么</h3>
    ${assumeHtml}
  </div>
</details>

<details class="fold">
  <summary><span class="idx">5</span>时间节点 <span class="cnt">${(r.timeline || []).length} 个</span><span class="caret">›</span></summary>
  <div class="body">${timeHtml}</div>
</details>

<div class="card tight">
  <p class="tiny muted" style="margin:0">
    这份报告不会因为参数库更新而改金额。校准只用于改进参数，历史金额永久冻结。
    <br>要逐行看来源、打印存档，打开<a href="/quote/${esc(r.reportId)}/report">电脑版完整报告</a>。
  </p>
</div>`;

  return mobileLayout({
    title: `${r.input?.countryName || ''} ${fmtHs(r.input?.hsCode)}`,
    body,
    active: 'reports',
    back: '/m/reports',
  });
}

function fmtHs(hs) {
  const s = String(hs || '').replace(/\D/g, '');
  if (s.length === 6) return `${s.slice(0, 4)}.${s.slice(4)}`;
  return s;
}

/* ============================ 历史 ============================ */

export function mReports({ list = [], demos = [] }) {
  const item = (r) => {
    const e = r.expected || null;
    const cls = r.state === 'complete' ? 'g' : r.state === 'blocked' ? 'r' : 'a';
    return `<a class="ritem" href="/m/report/${esc(r.reportId)}">
    <div class="top2">
      <span class="cn">${esc(r.input?.countryName || r.input?.country || '')}</span>
      <span class="hs">${esc(fmtHs(r.input?.hsCode))}</span>
      <span class="dot ${cls}"></span>
    </div>
    <div class="nums">
      <div>真实成本<b>${N(e?.landedCost)}</b></div>
      <div>需备现金<b>${N(e?.cashRequired)}</b></div>
    </div>
    <div class="when">${esc(String(r.createdAt || '').slice(0, 16).replace('T', ' '))} · ${esc(stateLabel(r.state))}</div>
  </a>`;
  };

  const body = list.length
    ? `<div class="rlist">${list.map(item).join('')}</div>`
    : `<div class="empty">
    <div class="ic">◷</div>
    <p>还没有算过的票。<br>算第一票，它就会出现在这里。</p>
    <a class="btn" href="/m/new">去算一票</a>
  </div>`;

  return mobileLayout({ title: '历史报告', body, active: 'reports' });
}

/* ============================ 日历 ============================ */

export function mCalendar({ view }) {
  const items = view?.items || [];
  const spans = view?.spans || [];

  const byMonth = new Map();
  for (const it of items) {
    const m = String(it.date).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(it);
  }

  const months = [...byMonth.entries()]
    .map(
      ([m, arr]) => `<div class="cal-month">${esc(m.replace('-', ' 年 '))} 月</div>
  <div class="card tight">${arr
    .map(
      (it) => `<div class="cal-item ${esc(it.state)}">
    <span class="cal-d">${esc(String(it.date).slice(5))}</span>
    <span class="cal-b">
      <div class="t">${esc(it.label)}</div>
      <div class="m">${esc(it.kind)}${it.countryName ? ' · ' + esc(it.countryName) : ''}${
        it.state === 'soon' ? ' · 30 天内' : it.state === 'in' ? ' · 已生效' : ''
      }</div>
    </span>
  </div>`
    )
    .join('')}</div>`
    )
    .join('');

  const spanHtml = spans.length
    ? `<div class="card">
    <h3>在途豁免：两个日期缺一不可</h3>
    ${spans
      .map(
        (s) => `<div class="span-box">
      <b>${esc(s.label)}${s.countryName ? ' · ' + esc(s.countryName) : ''}</b>
      装船不晚于 ${esc(s.shipBy)}，申报不晚于 ${esc(s.enterBy)}。两个条件差一天，豁免就没了。
      ${s.note ? `<br>${esc(s.note)}` : ''}
    </div>`
      )
      .join('')}
  </div>`
    : '';

  const body = `
<div class="banner info">今天是 ${esc(view?.today || '')}。只看参数库里已经入库的节点——没列出来不代表没有变化，只代表还没调研到。</div>
${spanHtml}
${months || '<div class="empty"><div class="ic">◷</div><p>参数库里还没有可显示的政策节点。</p></div>'}`;

  return mobileLayout({ title: '政策日历', body, active: 'home', back: '/m' });
}

/* ============================ 看懂外贸 ============================ */

export function mLearn({ view }) {
  const groups = view?.groups || [];
  const body = view?.ok
    ? `<div class="banner info">按「先看哪条」排好序，每条都写清看完能答上什么。点开在浏览器里看。</div>
${groups
  .map(
    (g) => `<section class="vgroup">
  <h3>${esc(g.title)}</h3>
  <p class="why">${esc(g.why)}</p>
  ${g.videos
    .map(
      (v) => `<div class="vcard ${v.featured ? 'vfeatured' : ''}" data-watch="${esc(v.watchUrl)}">
    <div class="vcover">
      <img src="${esc(v.cover || '')}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="dur">${esc(v.durationText)}</span>
    </div>
    <div class="vbody">
      <div class="t">${esc(v.title)}</div>
      <div class="a">${esc(v.author)} · ${esc(v.playText)} 次播放</div>
      <div class="tk">${esc(v.takeaway)}</div>
    </div>
  </div>`
    )
    .join('')}
</section>`
  )
  .join('')}`
    : `<div class="empty"><div class="ic">▷</div><p>${esc(view?.reason || '内容还没导进来')}</p></div>`;

  return mobileLayout({ title: '看懂外贸', body, active: 'learn', back: '/m' });
}

/* ============================ 老周 ============================ */

export function mChat() {
  const body = `
<div id="log">
  <div class="msg bot"><div class="bub">我是老周，做了十二年外贸。

这票货上的事都能问：税率为什么是这个数、报关行要什么材料、客户压价怎么回。
我手上只有系统算好的数，只转述不重算——给不出出处的金额，我不给。</div></div>
</div>
<div class="chips" id="chips" style="padding:14px 0 0">
  <span class="chip" data-q="我之前问的那个 8708.91 发匈牙利，增值税为什么退不掉">增值税为什么退不掉</span>
  <span class="chip" data-q="客户要求 DDP 到门，这单我该不该接">DDP 该不该接</span>
  <span class="chip" data-q="这票货 FOB 和 CIF 报哪个更稳">FOB 还是 CIF</span>
</div>`;

  const footbar = `<div class="chatin">
  <textarea id="q" rows="1" placeholder="问点具体的，越具体越有用"></textarea>
  <button id="send" aria-label="发送">↑</button>
</div>`;

  return mobileLayout({ title: '问老周', body, active: 'chat', footbar, back: '/m', nav: false });
}
