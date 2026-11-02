import { renderReport } from '../public/js/report-view.js';
import { fmt } from '../public/js/report-view.js';
import { D, pct } from './decimal.js';
import { addDays, diffDays } from './engine/dates.js';
import { buildReport } from './report.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 6 位码点分显示：870891 → 8708.91（只用于展示，判断一律用纯数字） */
const hsFmt = (h) => {
  const d = String(h || '').replace(/\D/g, '');
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.');
};

// 运营看得懂的分级名，代号放 title 里（T1/T2 是治理口径，不该让人猜）
const TIER_LABEL = {
  T0_BLOCK: 'T0 阻断',
  T1_BRANCH: 'T1 分支',
  T2_IMPACT: 'T2 影响金额',
  T3_FOOTNOTE: 'T3 脚注',
  T4_INTERNAL: 'T4 内部',
};
export const tierLabel = (t) => TIER_LABEL[t] || t || '—';

// "default:T2=90d" 这种内部策略串，换成人话
export const dueByText = (s) => {
  const m = /^default:([A-Z0-9]+)=(\d+)d$/.exec(String(s || ''));
  return m ? `按 ${m[1]} 规则默认（${m[2]} 天）` : s || '';
};

// 状态机用英文键存，展示层给人看的是中文
const STATUS_LABEL = { open: '待核', in_review: '复核中', resolved: '已关闭', expired: '已失效', superseded: '已替代' };
export const statusLabel = (s) => STATUS_LABEL[s] || s || '—';

const STATE_LABEL = {
  complete: '已出数',
  complete_with_gaps: '已出数 · 有缺口',
  needs_confirmation: '待确认',
  blocked: '已阻断',
};
export const stateLabel = (s) => STATE_LABEL[s] || s || '—';

// 区域的中文名与展示顺序。68 个市场平铺成一个下拉会让人找不到北，
// 按 7 个大区分组后，"有没有我这个市场"变成一眼能答的问题。
const REGION_LABEL = {
  EU: '欧盟 27 国（共用一套关税）',
  EUROPE_NON_EU: '欧洲其他',
  ASIA: '亚洲',
  MIDDLE_EAST: '中东',
  AMERICAS: '美洲',
  AFRICA: '非洲',
  OCEANIA: '大洋洲',
};
const REGION_ORDER = ['EU', 'EUROPE_NON_EU', 'ASIA', 'MIDDLE_EAST', 'AMERICAS', 'AFRICA', 'OCEANIA'];

/** 按区域分组的国家下拉。分组顺序固定，组内按中文名排。 */
export function countryOptionsHtml(countries, selected = '') {
  const groups = new Map();
  for (const c of countries) {
    const r = REGION_LABEL[c.region] ? c.region : 'ASIA';
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  return REGION_ORDER.filter((r) => groups.has(r))
    .map((r) => {
      const list = groups.get(r).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
      const opts = list
        .map((c) => `<option value="${c.code}" ${selected === c.code ? 'selected' : ''}>${esc(c.name)}（${c.code}）</option>`)
        .join('');
      return `<optgroup label="${esc(REGION_LABEL[r])}">${opts}</optgroup>`;
    })
    .join('');
}

// 助手默认挂在每个页面的右下角（general 模式，只讲通用问题，不假装知道某票的数）。
// 不想要的地方显式传 assistant: ''。打印页必须传，否则会把悬浮球印到纸上。
export function layout({ title, body, active = '', script = '', wide = false, head = '', assistant = 'general' }) {
  const nav = [
    ['/', '首页', 'home'],
    ['/quote/new', '新预演', 'new'],
    ['/reports', '历史报告', 'reports'],
    ['/demo/unresolved', '待核中心（演示）', 'unresolved'],
    ['/calendar', '政策日历', 'calendar'],
    ['/market', '市场热度', 'market'],
    ['/shop-guide', '店铺入驻', 'shop-guide'],
    ['/guide', '快速上手', 'guide'],
    ['/about', '数据出处', 'about'],
    ['/demo/calibration', '预演准确率', 'calibration'],
    ['/learn', '看懂外贸', 'learn'],
  ];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 通途 CLEARPATH</title>
<!-- 图标与小程序的头像是同一个 ¥ 标记，一处改了另一处必须跟着改（scripts/make-icon.js 出图） -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f4d5c'/%3E%3Cpath d='M10 8L16 15L22 8M16 15V24M11.5 17.5H20.5M11.5 21.5H20.5' fill='none' stroke='%23fff' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/css/app.css">
${head}
</head>
<body>
<header class="top">
  <a class="brand" href="/"><b>通途</b><span>CLEARPATH</span></a>
  <nav class="nav">
    ${nav.map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')}
  </nav>
  <div class="top-right"><span>不报关 · 不代缴税 · 只做决策支持</span></div>
</header>
<main class="wrap ${wide ? 'wrap-wide' : ''}">${body}</main>
${assistant ? `<div id="tt-assistant" class="ta" data-context="${esc(assistant)}"></div>
<script type="module" src="/js/assistant.js"></script>` : ''}
<script type="module" src="/js/app.js"></script>
${script ? `<script type="module" src="${script}"></script>` : ''}
</body>
</html>`;
}

/**
 * 首页样例必须真算，不能手抄。
 *
 * 原先这里是四个硬编码数字（70,862.40 / 70,862.40 / 0% / 6,327.00）。
 * 参数库更新后实算已经变成 64,535.40，首页还写着旧数——用户从首页点进报告，
 * 看到另一个数字，会以为哪边算错了。这类漂移没有任何报错，只有人肉对比才发现。
 *
 * 换成匈牙利：美国没有进口环节增值税，两个数必然相同，摆在首屏反而让人
 * 以为是产品坏了。匈牙利 27% VAT，两个数差出 14,076，正好把"为什么要分口径"
 * 说清楚——那笔差额就是可退增值税，能抵扣，但钱得先垫出去。
 */
const DEMO_INPUT = {
  country: 'HU',
  channel: 'B2B',
  hsCode: '870891',
  fob: 48000,
  freight: 2400,
  insurance: 216,
  qty: 1200,
};

function demoQuote(params, facts) {
  const today = params.asOf;
  const res = buildReport({
    input: { ...DEMO_INPUT, declarationDate: today, entryDate: today },
    params,
    facts,
    reportId: 'home-demo',
    today,
  });
  // 首页宁可退回到不显示样例，也不能显示一个算错的数
  return res.ok ? res.report : null;
}

export function homePage(params, facts = []) {
  const supported = params.raw.countries.filter((c) => c.supported);
  const euCount = supported.filter((c) => c.region === 'EU').length;
  const entryCount = params.raw.countries.filter((c) => c.entryEnabled).length;
  const catalog = params.raw.hsCatalog || [];
  const cells = supported.length * catalog.length;
  const catNames = catalog.map((c) => c.name).join('、');
  const demo = demoQuote(params, facts);
  const de = (demo && demo.expected) || {};
  const body = `
<section class="hero">
  <h1>报价前 3 分钟，<br>先把这票货的账算清。</h1>
  <p class="sub">通途给你<b>两个数</b>：真实成本、清关需备现金；再给你<b>一份标了价的“算不准清单”</b>。<br>
  市面上只有前者的是记账工具，只有后者的是免责声明——两件事必须一起说。</p>

  <div class="nl-box">
    <textarea id="nl" placeholder="例：8708.91 散热器 1200 件，FOB 48000 美元，运到美国，10 月 20 日申报" aria-label="自然语言录入"></textarea>
    <div class="nl-row">
      <div class="chips">
        <span class="chip" data-fill="8708.91 散热器 1200 件，FOB 48000 美元，运费 2400，运到美国，10 月 20 日申报">汽配 → 美国（含双分支）</span>
        <span class="chip" data-fill="8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报">汽配 → 匈牙利（现金缺口）</span>
        <span class="chip" data-fill="8708.91 汽配，FOB 10000 美元，运到巴西，10 月 20 日申报">汽配 → 巴西（ICMS 价内税）</span>
      </div>
      <button class="btn" id="go">试试看</button>
    </div>
  </div>
  <p class="small muted">参数库覆盖 ${supported.length} 个市场 × ${catalog.length} 个品类，共 <b>${cells}</b> 个能直接出数的组合。欧盟 ${euCount} 国共用一套对外关税（TARIC）、各自一道增值税，其余 ${supported.length - euCount} 个市场按各自税则单独建；${
    entryCount === supported.length ? `${entryCount} 个全部可在录入页直接选` : `其中 ${entryCount} 个已在录入页可选`
  }。<br>
  品类：${esc(catNames)}。每条税率都带出处和置信度，拿不准的会在报告里标成「待核」并把影响金额单列，不装成已确认。</p>
</section>

<section class="hero-points">
  <div class="hp"><b>① 两个口径分开算</b><span>把 27% 可退增值税当成本，毛利被虚减一半；当成不用备的钱，接单后资金链断。这是行业最大的认知盲区。</span></div>
  <div class="hp"><b>② 能不能进，提前到发货前</b><span>禁限运与许可做成 flag，而不是到了港口才知道。控制但不拦死。</span></div>
  <div class="hp"><b>③ 算不准的必须标价</b><span>一个未决事实值 6,327 美元——不是“可能影响结果”，是标了价的差额。</span></div>
</section>

<section class="trim">
  <h3>一票真账：汽配 8708.91 → 匈牙利</h3>
  <div class="trim-grid">
    <div class="trim-card"><div class="k">真实成本</div><div class="v">${esc(fmt(de.landedCost))}</div><div class="d">算毛利，用这个</div></div>
    <div class="trim-card"><div class="k">需备现金</div><div class="v">${esc(fmt(de.cashRequired))}</div><div class="d">报关那几天，账上要压这么多</div></div>
    <div class="trim-card"><div class="k">两者相差</div><div class="v">${esc(fmt(de.cashGap))}</div><div class="d">${
      de.cashGapRatio != null ? `${Math.round(de.cashGapRatio * 100)}% ` : ''
    }增值税：能抵扣，但钱得先垫出去</div></div>
    <div class="trim-card"><div class="k">只作定性提示</div><div class="v">${demo ? (demo.dataGaps || []).length : '—'} 项</div><div class="d">没有一手来源的参数，明说，不编数</div></div>
  </div>
  <p class="small muted">样例：8708.91 · FOB 48,000 + 运费 2,400 + 保险 216 · 匈牙利 · ${esc(params.asOf)} 申报 · 1200 件 B2B。
  <b>这四个数不是写死的</b>——每次打开首页都按当前参数库重算，参数改了这里跟着变，不会和报告页对不上。</p>
</section>
<section class="entry-cards" style="margin-top:20px">
  <a class="entry-card" href="/market">
    <b>市场热度</b>
    <span>这个品类在目的国一年真进了多少钱——UN Comtrade 数据，不是估算</span>
  </a>
  <a class="entry-card" href="/shop-guide">
    <b>店铺入驻</b>
    <span>海外平台怎么选？入驻要什么资质、佣金多少、回款等多久</span>
  </a>
  <a class="entry-card" href="/learn">
    <b>看懂外贸</b>
    <span>FOB、CIF、DDP 到底差在哪？13 条视频按先看哪条排好了</span>
  </a>
</section>
<p class="small muted" style="margin-top:12px">右下角蓝色气泡「问老周」是干了十二年的外贸业务经理，随时在。有发票装箱单直接拍照给他。</p>`;
  return layout({ title: '报价前先把账算清', body, active: 'home', script: '/js/home.js' });
}

/** 美元按中文习惯缩写。进口额动辄上亿，写全 151,234,567 没人读得下去 */
const usdShort = (v) => {
  if (v == null) return '—';
  const n = Number(v);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)} 万`;
  return n.toFixed(0);
};

/** 同比：正红负绿是股市习惯，这里是贸易额，用文字箭头加中性色，避免被读成涨跌行情 */
const yoyCell = (r) => {
  if (r == null) return '<span class="mkt-yoy flat">—</span>';
  const p = (r * 100).toFixed(1);
  if (r > 0.005) return `<span class="mkt-yoy up">↑ ${p}%</span>`;
  if (r < -0.005) return `<span class="mkt-yoy down">↓ ${p.replace('-', '')}%</span>`;
  return '<span class="mkt-yoy flat">持平</span>';
};

export function marketPage(params, view, markets) {
  const opts = markets
    .map((m) => `<option value="${esc(m.code)}"${m.code === view.code ? ' selected' : ''}>${esc(m.name)}</option>`)
    .join('');

  const head = `
<section class="mkt-head">
  <h1>这个品类在这个国家，一年真进了多少钱</h1>
  <p class="sub">不是估算，也不是问卷。是各国海关报给联合国商品贸易数据库的进口额。<br>
  它回答一个问题：你要卖的这类货，这个市场一年吃下多少；其中从中国进了多少——也就是你现有的天花板和已经占住的份额。</p>
  <form class="mkt-pick" method="get" action="/market">
    <label for="mktCountry">看哪个市场</label>
    <select id="mktCountry" name="country">${opts}</select>
    <button class="btn" type="submit">看这个市场</button>
  </form>
</section>`;

  if (!view.available) {
    return layout({
      title: '市场热度',
      body: `${head}<section class="card"><p class="muted">${esc(view.note || '这个市场暂时没有可用的进口数据。')}</p></section>`,
      active: 'market',
    });
  }

  const rows = view.categories
    .filter((c) => c.hasData)
    .map((c) => {
      const max = Math.max(...c.series.map((s) => s.world || 0), 1);
      const bars = c.series
        .map(
          (s) =>
            `<i style="height:${Math.max(4, Math.round(((s.world || 0) / max) * 100))}%" title="${s.year} 世界进口 ${esc(fmt(s.world))} 美元"></i>`
        )
        .join('');
      const share = c.chinaShare == null ? null : Math.max(0, Math.min(1, c.chinaShare));
      return `
<article class="mkt-row">
  <div class="mkt-name"><b>${esc(c.name)}</b><span>${esc(hsFmt(c.hs))} · ${c.latestYear}</span></div>
  <div class="mkt-num"><b>${esc(usdShort(c.worldValue))}</b><span>美元 · 世界进口</span></div>
  <div class="mkt-mid">
    ${yoyCell(c.worldYoy)}
    <div class="mkt-share">
      <span>中国占 ${share == null ? '—' : (share * 100).toFixed(1) + '%'}</span>
      <div class="mkt-bar"><b style="width:${share == null ? 0 : Math.max(1, share * 100).toFixed(1)}%"></b></div>
    </div>
  </div>
  <div class="mkt-bars">${bars}</div>
  ${c.mirrored ? '<span class="mkt-mirror" title="这条不是报告国自行申报，是镜像估算">镜像</span>' : ''}
</article>`;
    })
    .join('');

  const body = `${head}
<section class="mkt-list">${rows}</section>
<section class="mkt-note">
  <p class="small muted"><b>口径三条，请一起读：</b></p>
  <p class="small muted">① <b>这是该国的进口总额，不是你这一票的金额</b>，也不等于零售端销量。一票 FOB 四万八的货放进一年一亿美元的盘子里，占比不到万分之五——它的用处是判断这个市场有没有量、在涨还是在缩。</p>
  <p class="small muted">② 标「镜像」的是<b>贸易伙伴反向报送推算出来的</b>，不是该国自己报的。方向上可用，绝对值会有偏差，别拿它做精确承诺。</p>
  <p class="small muted">③ <b>某年没报送就不画那根柱子</b>，也不补零。空白代表"不知道"，不代表"没有"。</p>
  <p class="small muted">数据：${esc(view.source ? view.source.name : 'UN Comtrade')} · ${esc(view.source ? view.source.dataset : '')} · 抓取于 ${esc(view.asOf || '')} · 参数库 ${esc(view.paramsVersion || '')}。更新命令 <code>node scripts/fetch-market-trend.js</code>。</p>
</section>`;
  return layout({ title: '市场热度', body, active: 'market' });
}

export function shopGuidePage(params) {
  const platforms = [
    {
      name: 'Amazon 北美站', url: 'https://sell.amazon.com',
      fee: '$39.99/月 + 佣金 8%~15%', time: '审核 1~2 周',
      steps: [
        { title: '注册卖家账号', desc: '进入 sell.amazon.com，选「专业卖家」。个人卖家功能受限，不推荐。' },
        { title: '提交资质文件', desc: '上传营业执照、法人身份证正反面、地址证明（银行账单/水电单）。建议提前翻译成英文。' },
        { title: '设置收款账户', desc: '绑定 Payoneer、WorldFirst 或 PingPong。别用个人银行卡，汇率差很大。' },
        { title: '品牌注册（推荐）', desc: '在 Amazon Brand Registry 注册商标。没注册会被跟卖，注册后能用 A+ 页面和品牌分析。' },
        { title: '上架 Listing', desc: '标题、五点描述、A+ 页面写好后再选物流。FBA 先把货运到亚马逊仓库；自发货自己发货。' },
        { title: '开通广告', desc: '先跑自动广告测品——让亚马逊帮你找关键词。跑两周出了数据再转手动精准。' },
      ],
      materials: ['营业执照', '法人身份证正反面', '双币信用卡（Visa/Mastercard）', '收款账户（Payoneer 等）', '品牌授权书（如代理品牌，英文版）'],
      note: 'FBA 头程和仓储费把很多新手的第一批利润吃光——先算好再入仓。',
    },
    {
      name: 'Amazon 欧洲站', url: 'https://sell.amazon.eu',
      fee: '€39/月 + 佣金同北美', time: '审核 1~2 周，VAT 另需 2~4 周',
      steps: [
        { title: '完成北美站入驻（可选）', desc: '用同一个账号开通欧洲站，资料复用，审核快一些。' },
        { title: '注册目的国 VAT', desc: '在德国、法国、意大利、西班牙、英国分别注册 VAT 税号。找当地税务代理，别自己填——填错被查账。' },
        { title: '申请 EPR 注册号', desc: '德国和法国强制要求包装法（VerpackG）+ 电子废物（WEEE）。没注册会被下架。' },
        { title: '指定欧代', desc: '非欧盟卖家必须指定欧盟境内授权代表。找有资质的服务商，别用便宜无资质的。' },
        { title: '选择物流方案', desc: 'EFN（从一个国仓发全欧）或 Pan-EU FBA（多国分仓）。后者运费低但 VAT 更复杂。' },
        { title: '上架并设置 VAT 含税价', desc: '欧洲消费者看到的价格含 VAT。在后台设好，否则会被差评说价格欺诈。' },
      ],
      materials: ['营业执照（英文翻译件）', '法人身份证', 'VAT 注册号（各国）', 'EPR 注册号', '欧代授权协议', '收款账户'],
      note: '多国 VAT 合规是整个跨境行业最大的隐形门槛。先算清合规成本再决定做哪个国家。',
    },
    {
      name: 'eBay', url: 'https://www.ebay.cn',
      fee: '免费版有上架额度；店铺 $7.95~$349.95/月', time: '审核 3~5 个工作日',
      steps: [
        { title: 'ebay.cn 注册', desc: '中国大陆卖家通过 ebay.cn 注册，比在 ebay.com 直接注册少填很多项。' },
        { title: '提交营业执照 + 法人身份证', desc: '与 Amazon 要求相似，审核比 Amazon 松。' },
        { title: '绑定 PayPal', desc: 'eBay 收款走 PayPal。先注册 PayPal 企业账户，再绑定。个人账户有收款额度。' },
        { title: '设置店铺', desc: '选店铺等级（Starter / Basic / Premium / Anchor / Enterprise）。月费越高，免费上架额度越多。' },
        { title: '上架产品', desc: 'eBay 支持拍卖和一口价两种模式。二手和收藏品用拍卖效果更好。' },
        { title: '设置国际物流', desc: '开 International Shipping 或提前把货发到目的国海外仓。eBay 买家对运费敏感。' },
      ],
      materials: ['营业执照', '法人身份证', 'PayPal 企业账户', '品牌授权书（如有）'],
      note: '中国卖家通过 ebay.cn 走，流程比 Amazon 简单很多。适合二手、汽配、收藏品。',
    },
    {
      name: 'TikTok Shop', url: 'https://seller.tiktokglobalshop.com',
      fee: '免费入驻，佣金 5%~8%', time: '审核 1~3 个工作日',
      steps: [
        { title: '注册卖家账号', desc: '进入 seller.tiktokglobalshop.com，选跨境卖家。填写企业信息。' },
        { title: '提交资质', desc: '上传营业执照、法人身份证。经营范围需要和打算卖的商品匹配。' },
        { title: '填写品牌和品类', desc: '有些品类需要额外资质（美妆要备案、电子要有认证）。先查你的品能不能上。' },
        { title: '设置仓库', desc: '填写跨境仓或本土仓地址。仓库信息要和实际发货地址一致，平台会抽查。' },
        { title: '上架商品 + 绑定内容账号', desc: '把 TikTok 个人号或企业号绑到店铺。一个号只能绑一个国家的店铺。' },
        { title: '开始发短视频/做直播', desc: 'TikTok 本质是内容平台。拍好短视频、运营好直播间，花在内容上的时间不要比上架少。' },
      ],
      materials: ['营业执照', '法人身份证', '仓库地址证明（租赁合同/照片）', '品牌授权或商标注册证（如有）'],
      note: '内容能力决定销量——纯铺货没有流量。花在拍视频上的时间，至少和上架一样多。',
    },
    {
      name: 'Shopee', url: 'https://shopee.cn',
      fee: '免费入驻，佣金 5%~6%', time: '审核 1~2 个工作日',
      steps: [
        { title: 'shopee.cn 注册', desc: 'Shopee 对中国卖家非常友好，注册流程简洁。个体户也可以入驻。' },
        { title: '提交营业执照 + 法人身份证', desc: '个体户营业执照或公司执照均可。没有执照先办一个，深圳个体户可网上办。' },
        { title: '绑定收款', desc: '支持 Payoneer、PingPong、LianLian。选你熟悉的就行。' },
        { title: '设置店铺并上架', desc: '先做一两个市场（比如马来西亚和菲律宾），跑通后再开其他站点。' },
        { title: '选物流方案', desc: 'Shopee 有官方物流 SLS，运费比市场价低。大件可以自发货或本地仓。' },
        { title: '报名平台活动', desc: 'Shopee 每个月有多场大促（双数日 9.9、11.11）。提前两周报名才有流量。' },
      ],
      materials: ['营业执照（公司或个体户）', '法人身份证', '收款账户', '品牌授权书（如有）'],
      note: '东南亚客单价偏低，走量路线。先算清楚运费和佣金占比再加利润，否则发货越多亏越多。',
    },
    {
      name: 'Lazada', url: 'https://www.lazada.com',
      fee: '免费入驻，佣金 4%~6%', time: '审核 1~3 个工作日',
      steps: [
        { title: 'lazada.com/sell 注册', desc: 'Lazada 现在对中国卖家开放六国：马来西亚、新加坡、泰国、菲律宾、印尼、越南。' },
        { title: '提交营业执照 + 法人身份证', desc: '与 Shopee 类似。公司执照通过率更高，个体户也可以。' },
        { title: '选店铺类型', desc: 'LazMall（品牌店，需要品牌授权）或普通店铺。有品牌走 LazMall，流量明显不一样。' },
        { title: '上架产品并设置物流', desc: 'Lazada 有 FBL（类似 FBA），把货运到 Lazada 仓库，由平台完成分发。' },
        { title: '设置多语言产品信息', desc: 'Lazada 自动翻译功能不错，但标题和关键卖点最好自己翻一遍。' },
        { title: '关注平台大促', desc: 'Lazada 年终大促（11.11、12.12）流量相当于平常的 5~10 倍。提前一个月备货。' },
      ],
      materials: ['营业执照', '法人身份证', '收款账户', '品牌授权书（LazMall 需要）'],
      note: '与 Shopee 互补——LazMall 对品牌更友好，客单价也比 Shopee 高。两个平台一起做效果最好。',
    },
    {
      name: '速卖通 AliExpress', url: 'https://sell.aliexpress.com',
      fee: '年费保证金（按类目 ¥10,000~50,000）', time: '审核 3~7 个工作日',
      steps: [
        { title: 'sell.aliexpress.com 注册', desc: '中国卖家最友好的跨境平台。全中文后台，支付宝收款。' },
        { title: '提交营业执照 + 法人身份证', desc: '公司执照或个体户均可。年费保证金根据类目不同，入门级约 ¥10,000。' },
        { title: '选经营类目', desc: '选好后不可随意更改。想多类目就交多份保证金。' },
        { title: '上架产品', desc: '速卖通买家遍布俄语区、南美、中东。产品信息支持多语言自动翻译。' },
        { title: '选物流方案', desc: 'AliExpress 无忧物流、菜鸟物流，或自选物流。不同国家运费差异大，设好运费模板。' },
        { title: '关注汇率和收款周期', desc: '人民币结算，不用换汇。放款周期约 15 天，资金快点到要提额。' },
      ],
      materials: ['营业执照', '法人身份证', '支付宝企业认证', '品牌授权或商标（如有）'],
      note: '中国卖家最友好——中文后台、支付宝收款、不用换汇。俄语区和南美市场有天然流量。',
    },
    {
      name: 'Temu', url: 'https://seller.kuajingmaihuo.com',
      fee: '免费入驻（全托管模式）', time: '审核 1~3 个工作日',
      steps: [
        { title: 'seller.kuajingmaihuo.com 注册', desc: 'Temu 是全托管——你只管把货交到国内仓，卖价、推广、物流全由 Temu 决定。' },
        { title: '提交营业执照 + 法人身份证', desc: '公司执照或个体户均可。需要有稳定的供货能力。' },
        { title: '选品类并寄样', desc: '平台核价。Temu 会要求你寄样品，核价通过后才能上架。' },
        { title: '上架（由平台定卖价）', desc: 'Temu 的买手团队给你定零售价。你不参与定价——只能接受或拒绝。' },
        { title: '备货到国内仓', desc: '出单后把货送到 Temu 国内集货仓，平台完成跨境物流。你不需要自己发国际件。' },
        { title: '等待结算', desc: '按周结算，结的是 Temu 给你的供货价。零售端的利润与你无关。' },
      ],
      materials: ['营业执照', '法人身份证', '产品报价单', '样品（核价用）'],
      note: '全托管 = 你只管供货，平台做一切。好处是简单、不用懂运营；代价是利润被压到极致，纯走量。不适合有品牌溢价的产品。',
    },
    {
      name: 'Walmart', url: 'https://marketplace.walmart.com',
      fee: '免费入驻，佣金 6%~20%', time: '审核 2~4 周',
      steps: [
        { title: '申请入驻（走沃尔玛全球电商）', desc: '中国卖家不能直接在 marketplace.walmart.com 注册。要通过沃尔玛全球电商中国团队申请。' },
        { title: '准备美国资质', desc: '必须有美国税号（EIN 或 ITIN）、商业综合责任保险、美国退货地址。这三样缺一不可。' },
        { title: '提交申请材料', desc: '营业执照、法人身份证、品牌授权或商标。审核比 Amazon 严格很多。' },
        { title: '设置 WFS（类 FBA）或自发货', desc: 'WFS 让你用沃尔玛仓库发货，时效和 Amazon FBA 看齐。可选自发货。' },
        { title: '上架 Listing', desc: 'Walmart 对产品信息的格式要求严格，不要直接从 Amazon 复制粘贴——格式不一样。' },
        { title: '关注定价规则', desc: 'Walmart 要求你的价格不能高于其他平台。如果你的 Amazon 价比 Walmart 低，会被警告。' },
      ],
      materials: ['营业执照', '法人身份证', '美国税号（EIN/ITIN）', '商业综合责任保险（COI）', '美国退货地址', '品牌授权或商标'],
      note: '门槛比 Amazon 高。三件套（税号+保险+退货地址）必须都齐。但竞争远低于 Amazon，利润空间更大。',
    },
    {
      name: 'Mercado Libre', url: 'https://www.mercadolibre.com',
      fee: '免费入驻，佣金 11%~17%', time: '审核 1~2 周',
      steps: [
        { title: 'mercadoshops 或 marketplace.mercadolibre.com 注册', desc: '拉美第一电商。覆盖巴西、墨西哥、阿根廷、智利等 18 个国家。' },
        { title: '解决本地税务', desc: '每个国家都要本地税号（巴西 CNPJ / 墨西哥 RFC）。通常找当地税务代理办理。' },
        { title: '提交资质文件', desc: '营业执照翻译件、法人身份证、本地税号、银行账户。建议用本地代理加速。' },
        { title: '选物流方案', desc: 'Mercado Envíos Full（类似 FBA）或自发货。拉美物流慢，用 Full 能提升评分。' },
        { title: '上架产品（葡语/西语）', desc: '产品信息要用葡萄牙语（巴西）或西班牙语（其他国家）。自动翻译质量一般，最好人工翻。' },
        { title: '管理回款周期', desc: 'Mercado Libre 回款周期较长（15~60 天不等），要有充足的周转资金。' },
      ],
      materials: ['营业执照（翻译件）', '法人身份证', '本地税号（各国不同）', '本地银行账户', '海关授权书'],
      note: '拉美第一电商，订单不缺——缺的是能撑过 60 天回款周期的现金。资金链薄的先别碰。',
    },
  ];

  const rows = platforms.map((p) => `
<details class="sg-step" open>
  <summary class="sg-summary">
    <span class="sg-name">${esc(p.name)}</span>
    <span class="sg-meta">费用 ${esc(p.fee)} · 预计 ${esc(p.time)}</span>
  </summary>
  <div class="sg-body">
    <div class="sg-section"><b>入驻步骤</b></div>
    <ol class="sg-steps">
      ${p.steps.map((s, i) => `
      <li><b>${esc(String(i + 1))}. ${esc(s.title)}</b><br>${esc(s.desc)}</li>`).join('')}
    </ol>
    <div class="sg-section"><b>需要的材料</b></div>
    <ul class="sg-mats">
      ${p.materials.map((m) => `<li>${esc(m)}</li>`).join('')}
    </ul>
    ${p.note ? `<p class="sg-caveat">⚠ ${esc(p.note)}</p>` : ''}
    <div class="sg-go"><a href="${esc(p.url)}" target="_blank" rel="noopener">去 ${esc(p.name)} 官网入驻 →</a></div>
  </div>
</details>`).join('');

  const body = `
<section class="mkt-head">
  <h1>一步一步教你入驻海外平台</h1>
  <p class="sub">点击展开你想入驻的平台，每一步都写清了——从准备什么材料、到审核要多久、再到第一个单怎么上架。<br>
  如果是第一次做跨境，建议先看「Amazon 北美站」或「速卖通」，这两个对中国卖家最友好。</p>
</section>
<section class="mkt-list">${rows}</section>
<p class="small muted" style="margin-top:22px">
  ⚠️ 以上流程和费用是截至 2026 年 10 月的公开信息。<b>入驻政策和费率由平台方随时调整，请以各平台官网为准。</b><br>
  本页只做流程指引，不代入驻、不代注册、不收取任何费用。材料准备有疑问，点右下角蓝色气泡问老周。
</p>`;
  return layout({ title: '店铺入驻指南', body, active: 'shop-guide' });
}

export function aboutPage(params) {
  const supported = params.raw.countries.filter((c) => c.supported);
  const catalog = params.raw.hsCatalog || [];
  const body = `
<section class="mkt-head">
  <h1>数据是怎么来的，为什么可以信</h1>
  <p class="sub">不是问卷，不是估算，也不是从第三方数据平台买的。每一条税率都从税则原文爬到参数库，<br>带出处链接和置信度——所以你可以在报告里逐条追到源头。</p>
</section>
<section class="about-grid">
  <div class="hp">
    <b>① 直采官方税则，不经二手转述</b>
    <span>TARIC（欧盟共同税则）、USITC（美国关税表）、印度 CBIC……每一项都是从公开税则数据库原样录入，不插"合理估计"、不套近似税率。没有调研到价的参数就标成「存疑」，不拿相近品类顶替。</span>
  </div>
  <div class="hp">
    <b>② 两个数分开算，各是各的</b>
    <span>真实成本给利润核算用，需备现金给资金链用。因为 27% 增值税能抵扣，但必须先垫给海关——混在一起既不是成本也不是现金，但市面上几乎都按一个数报。</span>
  </div>
  <div class="hp">
    <b>③ ${supported.length} 个市场 × ${catalog.length} 个品类可检验</b>
    <span>总数 ${supported.length * catalog.length} 个组合，哪个能算、哪个挂起、哪个缺数据，录入页下拉里一个个列着。不说"主流市场"，说具体的。</span>
  </div>
  <div class="hp">
    <b>④ 每条税率都有出处和置信度</b>
    <span>报告中每一条税和规费都跟着来源链接，同时标 high / medium / low 三级置信度。low 的归类为定性提示，不做精确承诺——不把"可能是"包装成"就是"。</span>
  </div>
  <div class="hp">
    <b>⑤ 算不准的，直接列出来</b>
    <span>待核清单是 15 段报告不可分割的一部分。一个未决事实不是"可能影响结果"，而是标到美元的差额——你知道这一项是多少钱，也知道要怎样才有准数。</span>
  </div>
  <div class="hp">
    <b>⑥ 参数更新不翻旧账</b>
    <span>参数库以 <code>kb-YYYY.MM.DD</code> 版本化快照管理（当前 ${esc(params.version)}，生效日 ${esc(params.asOf)}），改了税率和规费就新建一版。已生成的报告金额永久冻结——同一个报告 ID，过十年打开还是那个数字。</span>
  </div>
</section>
<p class="small muted" style="margin-top:22px">
  我们不做的事：不代报关、不代缴税、不保证一定能过海关。本工具只做"先把账算清楚"这一件事——决策是你做的，责任是你担的，但数不能是估的。
</p>`;
  return layout({ title: '数据出处', body, active: 'about' });
}

export function guidePage(params) {
  const supported = params.raw.countries.filter((c) => c.supported);
  const catalog = params.raw.hsCatalog || [];
  const body = `
<section class="mkt-head">
  <h1>三步上手：从零到第一份成本报告，3 分钟</h1>
  <p class="sub">不用注册、不用付费、不用安装任何东西。打开网页就能用。</p>
</section>

<div class="guide-steps">
  <div class="guide-card">
    <div class="guide-num">1</div>
    <b>写一句话，告诉它要算什么</b>
    <p>在首页输入框里用自然语言描述这票货。比如：<br>
    <code>8708.91 散热器 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报</code></p>
    <p>不知道 HS 编码？写品名也行——「光伏组件」、「T 恤」、「手机壳」，系统会帮你归到最可能的编码，并在报告里标清归因。</p>
    <p>或者直接点下面蓝色的快捷示例，一步跳到录入页。</p>
  </div>

  <div class="guide-card">
    <div class="guide-num">2</div>
    <b>看两个数 + 一份清单</b>
    <p>报告打开，最上面就是<b>两个数</b>：</p>
    <ul>
      <li><b>真实成本</b>——算毛利用的，扣掉了可退的增值税</li>
      <li><b>需备现金</b>——报关那几天账上要压多少，包含了要垫的增值税</li>
    </ul>
    <p class="muted">这两个数是分开的，因为 27% 增值税能退回来但得先垫出去——混在一起，既不是成本，也不是现金。</p>
    <p>往下翻是<b>待核清单</b>——哪些税率拿不准、缺什么资料、每一项值多少钱，都标好了。如果你有缺失的资料补充进去，点一下重新算，数字会更新。</p>
  </div>

  <div class="guide-card">
    <div class="guide-num">3</div>
    <b>把数用起来</b>
    <p>报告不是算完就完了：</p>
    <ul>
      <li>去<a href="/market">市场热度</a>看看——你这个品类在目的国一年真进了多少钱，是涨还是缩</li>
      <li>去<a href="/calendar">政策日历</a>看一眼——申报日前后有没有税率调整或反倾销裁决生效</li>
      <li>去<a href="/shop-guide">店铺入驻</a>查一下——哪些海外平台适合你，怎么一步步入驻</li>
      <li>右下角蓝色气泡<b>「问老周」</b>随时在——有发票装箱单直接拍照给他，他帮你填表</li>
    </ul>
  </div>
</div>

<p class="small muted" style="margin-top:20px">
  <b>这个产品和所有页面的工具体系总览：</b>首页（算一票）→ 报告（两个数+清单）→ 市场热度（看盘子有多大）→ 店铺入驻（选卖货平台）→ 政策日历（别撞枪口）→ 看懂外贸（把基础概念补上）→ 数据出处（告诉你数据从哪来）。
  右下角的老周横跨所有页面，随时问他。
</p>
<section style="margin-top:22px">
  <h3>一个具体例子，走一遍</h3>
  <p class="muted">品类：汽车散热器（HS 8708.91）· 目的国：匈牙利 · FOB $48,000 + 运费 $2,400 · 1200 件 · B2B</p>
  <div class="guide-walk">
    <div><b>点首页「汽配 → 匈牙利」快捷示例</b><span>→ 自动填好表单</span></div>
    <div><b>点「提交」</b><span>→ 3 秒出报告</span></div>
    <div><b>真实成本 $52,134</b><span>→ 比 FOB 多了 $3,774（关税+保险+运费）</span></div>
    <div><b>需备现金 $66,211</b><span>→ 比真实成本多了 $14,076（匈牙利 27% 增值税，先垫后退）</span></div>
    <div><b>待核清单 1 项</b><span>→ D 级存疑参数，只作定性提示，无金额影响</span></div>
  </div>
  <p class="small muted">这个例子的每一行数字都是首页打开时用当前参数库实时算出来的，</b>不会和报告页对不上</b>。你自己算一票的话，首页那个框里写清楚，一样的流程。</p>
</section>`;
  return layout({ title: '快速上手', body, active: 'guide' });
}

export function newPage(params, preset = {}) {
  const countries = params.raw.countries.filter((c) => c.entryEnabled);
  const allSupported = params.raw.countries.filter((c) => c.supported);
  // 申报日默认"今天"，不是参数快照日：asOf 是数据的截止日，拿它当默认值会让
  // 今天填的出口日晚于默认的申报日，一进页面就被判成"日期填反"。
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const body = `
<div class="card">
  <h2>新预演</h2>
  <p class="muted small">七个必填，其余折叠。输入即校验，不等提交才报错。</p>
  <form id="quoteForm" class="form-grid" style="margin-top:16px" novalidate>
    <div class="field">
      <label>目的国<span class="req">*</span></label>
      <select name="country" required>
        <option value="">请选择</option>
        ${countryOptionsHtml(countries, preset.country)}
      </select>
      <div class="hint">下拉里的 ${allSupported.length} 个市场由参数库实时生成，按区域分组；要加新市场走「参数治理」提申请。</div>
    </div>
    <div class="field">
      <label for="hsCodeInput">HS 编码 / 品名<span class="req">*</span></label>
      <!-- 原先用 <input list="..."> + <datalist>：原生下拉要打一个字才冒出来，
           点框本身不展开，用户会以为坏了。而且各浏览器表现不一致（Safari 基本不显示）。
           这里自己铺一层，点框/点箭头就出全部品类。 -->
      <div class="combo" data-combo="hs" data-open="0">
        <input id="hsCodeInput" name="hsCode" placeholder="8708.91 或 光伏组件" value="${esc(preset.hsCode || '')}"
               autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="hsComboList">
        <button type="button" class="combo-btn" tabindex="-1" aria-label="展开品类清单">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <ul class="combo-list" id="hsComboList" role="listbox" hidden>
          ${(params.raw.hsCatalog || [])
            .map(
              (c) =>
                `<li role="option" data-hs="${esc(c.hs)}" data-name="${esc(c.name)}" data-kw="${esc((c.kw || []).join(' '))}">` +
                `<span class="c-hs">${esc(hsFmt(c.hs))}</span><span class="c-name">${esc(c.name)}</span>` +
                `<span class="c-kw">${esc((c.kw || []).slice(0, 2).join(' / '))}</span></li>`
            )
            .join('')}
          <li class="combo-empty" hidden>没有对上的品类，可以直接写 6–10 位编码</li>
        </ul>
      </div>
      <div class="hint">已入库 ${(params.raw.hsCatalog || []).length} 个品类，点开能挑，写品名也能认；认不出会当场告诉你，不会拿相近的品类顶替。</div>
    </div>
    <div class="field">
      <label>FOB 货值（USD）<span class="req">*</span></label>
      <input name="fob" inputmode="decimal" placeholder="48000" value="${esc(preset.fob ?? '')}">
      <div class="hint">货值必须是大于 0 的数字</div>
    </div>
    <div class="field">
      <label>运费（USD）<span class="req">*</span></label>
      <input name="freight" inputmode="decimal" placeholder="2400" value="${esc(preset.freight ?? '')}">
    </div>
    <div class="field">
      <label>数量<span class="req">*</span></label>
      <input name="qty" inputmode="numeric" placeholder="1200" value="${esc(preset.qty ?? '')}">
    </div>
    <div class="field">
      <label>渠道<span class="req">*</span></label>
      <div class="seg" data-seg="channel">
        <button type="button" data-v="B2B" class="${preset.channel === 'B2B' ? 'on' : ''}">B2B</button>
        <button type="button" data-v="B2C" class="${preset.channel === 'B2C' ? 'on' : ''}">B2C</button>
      </div>
      <input type="hidden" name="channel" value="${esc(preset.channel || '')}">
    </div>
    <div class="field">
      <label>申报日期<span class="req">*</span></label>
      <input name="declarationDate" type="date" value="${esc(preset.declarationDate || todayStr)}">
      <div class="hint">清关日未填时按申报日推定，并打黄条</div>
    </div>
    <div class="field">
      <label>出口日期（装船日 on board）</label>
      <input name="exportDate" type="date" value="${esc(preset.exportDate || '')}">
      <div class="hint">不能用“交给货代日”顶替；缺它时在途豁免无法判定</div>
    </div>

    <details class="adv" style="grid-column:1/-1">
      <summary>高级：日期、含量、反倾销、摊销（可留空）</summary>
      <div class="form-grid">
        <div class="field"><label>放行日 entryDate</label><input name="entryDate" type="date"><div class="hint">缺省 = 申报日</div></div>
        <div class="field"><label>清算日 liquidationDate</label><input name="liquidationDate" type="date"><div class="hint">仅影响 AD 结算展示</div></div>
        <div class="field"><label>保险（USD）</label><input name="insurance" inputmode="decimal" placeholder="留空按参数默认 0.45% 估算"><div class="hint">该系数是回标黄金用例的标定值，不是行业惯例</div></div>
        <div class="field"><label>金属含量（0–1）</label><input name="metalContentPct" inputmode="decimal" placeholder="0.62"><div class="hint">命中 232 且档位允许 ≤15% 豁免时影响结论</div></div>
        <div class="field"><label>年发货票数</label><input name="shipmentsPerYear" inputmode="numeric" placeholder="1"><div class="hint">缺省 1；年费 > 0 时会产生假设</div></div>
        <div class="field"><label>摊销年数</label><input name="amortizationYears" inputmode="numeric" placeholder="1"></div>
        <div class="field"><label>AD 保证金率（%）</label><input name="adDepositPct" inputmode="decimal" placeholder="如 99"><div class="hint">手填即按 low 置信度计算</div></div>
        <div class="field"><label>总面积（㎡）</label><input name="areaSqm" inputmode="decimal" placeholder="如 5000"><div class="hint">反倾销税按平方米定额计征时必填（如土耳其对华光伏），缺它这笔钱不出金额</div></div>
        <div class="field"><label>AD 预计最终率（%）</label><input name="adFinalPct" inputmode="decimal" placeholder="如 45"><div class="hint">缺省 = 保证金率（不得假设保证金偏高）</div></div>
        <div class="field"><label>最终用户 / 用途</label>
          <select name="endUserType">
            <option value="civil">民用（默认）</option>
            <option value="unknown">不清楚</option>
            <option value="military">军事 / 涉恐</option>
          </select>
        </div>
        <div class="field"><label>规费</label>
          <select name="chargesMode">
            <option value="">不计（默认，按 v2 §11 用例口径）</option>
            <option value="all">全部计入</option>
          </select>
          <div class="hint">报关代理费、码头操作费这类按报关行报价的量级入库；计入时按区间中值估算，明细可展开看区间</div>
        </div>
      </div>
    </details>
  </form>
  <div class="form-foot">
    <div class="hint" id="formHint">请补全必填项</div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-ghost" id="demoBtn" type="button">填入演示样例</button>
      <button class="btn" id="submitBtn" type="button" disabled>下一步：确认</button>
    </div>
  </div>
</div>
<script>window.__HS_CATALOG__ = ${JSON.stringify((params.raw.hsCatalog || []).map((c) => ({ hs: c.hs, name: c.name, kw: c.kw || [] })))};</script>`;
  return layout({ title: '新预演', body, active: 'new', script: '/js/new.js', assistant: 'form' });
}

export function confirmPage() {
  const body = `
<div class="card">
  <h2>确认页</h2>
  <p class="muted small">把所有“系统不敢自己定”的东西集中让你定一次，并记录为假设。这里的“我不确定”是一等公民，不是逃避。</p>
  <div id="confirmBody" style="margin-top:14px"><p class="muted">正在预检…</p></div>
  <div class="form-foot">
    <div class="hint" id="confirmHint"></div>
    <div style="display:flex;gap:10px">
      <a class="btn btn-ghost" href="/quote/new">返回修改</a>
      <button class="btn" id="confirmBtn" type="button">生成报告</button>
    </div>
  </div>
</div>`;
  return layout({ title: '确认', body, active: 'new', script: '/js/confirm.js' });
}

export function reportPage(report) {
  const body = `${renderReport(report)}
<div class="no-print" style="display:flex;justify-content:space-between;margin-top:18px;gap:12px;flex-wrap:wrap">
  <a class="btn btn-ghost" href="/quote/new">再算一票</a>
  <div style="display:flex;gap:10px">
    <button class="btn btn-ghost" data-action="export">生成存档件</button>
    <a class="btn" href="/quote/${esc(report.reportId)}/print" data-action="print">打印 / 存档</a>
  </div>
</div>
<script>window.__REPORT__ = ${JSON.stringify(JSON.stringify(report))};</script>`;
  return layout({ title: `报告 ${report.reportId.slice(0, 8)}`, body, active: 'reports', script: '/js/report.js', wide: true, assistant: 'report' });
}

export function reportsPage(list, demos = []) {
  const rows = list.length
    ? list
        .map(
          (r) => `<tr>
      <td><a href="/quote/${esc(r.reportId)}/report">${esc(r.hsCode)} · ${esc(r.country)}</a></td>
      <td>${esc(r.createdAt.slice(0, 19).replace('T', ' '))}</td>
      <td class="ta-r">${fmt(r.landedCost)}</td>
      <td class="ta-r">${fmt(r.cashRequired)}</td>
      <td><span class="tag" title="${esc(r.state)}">${esc(stateLabel(r.state))}</span></td>
      <td>${esc(r.paramsVersion)}</td>
    </tr>`
        )
        .join('')
    : '';
  const demoRows = demos
    .map(
      (r) => `<tr>
      <td><a href="/quote/${esc(r.reportId)}/report">${esc(r.demoLabel || r.hsCode)}</a></td>
      <td class="ta-r">${fmt(r.landedCost)}</td>
      <td class="ta-r">${fmt(r.cashRequired)}</td>
      <td><span class="tag" title="${esc(r.state)}">${esc(stateLabel(r.state))}</span></td>
    </tr>`
    )
    .join('');
  const body = `<div class="card">
    <h2>历史报告</h2>
    <div class="toolbar" style="margin:10px 0 0">
      <a class="btn btn-sm" href="/quote/batch">批量试算</a>
      <a class="btn btn-sm btn-ghost" href="/quote/new">单票新预演</a>
      <div class="spacer"></div>
      <span class="muted small">SKU 多的时候用批量，一票一票录不现实</span>
    </div>
    <p class="muted small">MVP 无账号：按匿名设备 ID 归档。报告不可变——参数更新不重算历史，只标注“建议重新预演”。</p>
    ${
      list.length
        ? `<table class="tbl" style="margin-top:12px"><thead><tr><th>票</th><th>生成时间</th><th class="ta-r">真实成本</th><th class="ta-r">需备现金</th><th>状态</th><th>参数版本</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="muted" style="margin-top:16px">还没有预演记录。<a href="/quote/new">算一票试试</a></p>`
    }
  </div>
  ${
    demos.length
      ? `<div class="card" style="margin-top:14px">
    <h2>演示样例</h2>
    <p class="muted small">这四票是预置的，<b>不属于你的设备记录</b>，只用来直接看四种典型形态（双分支 / 双口径 / 价内税 gross-up / AD 三口径）。</p>
    <table class="tbl" style="margin-top:12px"><thead><tr><th>场景</th><th class="ta-r">真实成本</th><th class="ta-r">需备现金</th><th>状态</th></tr></thead><tbody>${demoRows}</tbody></table>
  </div>`
      : ''
  }`;
  return layout({ title: '历史报告', body, active: 'reports' });
}

export function printPage(report) {
  const body = `${renderReport(report)}
  <div class="rp-foot" style="margin-top:14px">
    <div class="foot-meta">存档版本 1 · 生成时刻为准 · 报告 ${esc(report.reportId)}</div>
  </div>`;
  return layout({ title: '打印', body, active: 'reports', wide: true, script: '/js/print.js', assistant: '' });
}

export function unresolvedPage(facts, opts = {}) {
  const { readonly = false, today, filter = 'all', owner = '', baseUrl, asOf, operators: ops = [] } = opts;

  // 默认排序：逾期越久越靠前，同档再按影响金额（先解决最贵也最急的）
  const byUrgency = (a, b) => {
    const la = a.daysLeft === null || a.daysLeft === undefined ? Infinity : a.daysLeft;
    const lb = b.daysLeft === null || b.daysLeft === undefined ? Infinity : b.daysLeft;
    if (la !== lb) return la - lb;
    return Number(b.impactUsdCached || 0) - Number(a.impactUsdCached || 0);
  };
  const allSorted = [...facts].sort(byUrgency);

  const isOverdue = (f) => f.daysLeft !== null && f.daysLeft !== undefined && f.daysLeft < 0;
  const counts = {
    all: allSorted.length,
    overdue: allSorted.filter(isOverdue).length,
    mine: owner ? allSorted.filter((f) => f.owner === owner).length : 0,
    noowner: allSorted.filter((f) => !f.owner).length,
  };

  const sorted = allSorted.filter((f) => {
    if (filter === 'overdue') return isOverdue(f);
    if (filter === 'mine') return !!owner && f.owner === owner;
    if (filter === 'noowner') return !f.owner;
    return true;
  });

  const totalImpact = sorted.reduce((a, f) => a + Number(f.impactUsdCached || 0), 0);
  const overdueCount = counts.overdue;
  const open = sorted.filter((f) => f.status === 'open' || f.status === 'in_review').length;

  const qs = (extra = {}) => {
    const sp = new URLSearchParams();
    if (asOf) sp.set('asOf', asOf);
    if (owner) sp.set('owner', owner);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  };
  const base = baseUrl || (readonly ? '/demo/unresolved' : '/admin/unresolved');

  const chips = [
    ['all', '全部', counts.all],
    ['overdue', '已逾期', counts.overdue],
    ['mine', owner ? `我负责的（${owner}）` : '我负责的（未指定身份）', counts.mine],
    ['noowner', '无负责人', counts.noowner],
  ]
    .map(([k, label, n]) => {
      const on = filter === k;
      const href = `${base}${qs({ filter: k === 'all' ? null : k })}`;
      return `<a class="chip${on ? ' chip-on' : ''}" href="${esc(href)}"${k === 'mine' && !owner ? ' title="用 ?owner=姓名 指定当前身份"' : ''}>${esc(
        label
      )}<span class="chip-n">${n}</span></a>`;
    })
    .join('');

  const rows = sorted
    .map((f) => {
      const left = f.daysLeft;
      const cls = left !== null && left < 0 ? 'days-bad' : left !== null && left <= 7 ? 'days-warn' : '';
      return `<tr class="${left !== null && left < 0 ? 'overdue' : ''}">
      <td><a href="#${esc(f.id)}">${esc(f.id)}</a></td>
      <td>${esc(f.title)}</td>
      <td>${esc((f.scope?.countries || []).join('/'))} × ${esc((f.scope?.hsPrefixes || []).join('/'))}</td>
      <td class="ta-r">${f.impactUsdCached ? fmt(f.impactUsdCached) : esc(f.impactDisplay || '—')}</td>
      <td class="nowrap" title="${esc(f.displayTier)}">${esc(tierLabel(f.displayTier))}</td>
      <td><span class="pill pill-${f.status === 'resolved' ? 'resolved' : f.status === 'in_review' ? 'progress' : 'open'}" title="${esc(f.status)}">${esc(statusLabel(f.status))}</span></td>
      <td>${esc(f.owner || '—')}</td>
      <td class="nowrap">${esc(f.reviewDue || '—')}</td>
      <td class="${cls} nowrap">${left === null ? '—' : left < 0 ? `逾期 ${-left} 天` : `剩 ${left} 天`}</td>
      <td class="nowrap">${
        (f.relatedReports || []).length
          ? `<a href="/quote/${esc(f.relatedReports[0])}/report">${f.relatedReports.length} 份</a>`
          : '—'
      }</td>
    </tr>`;
    })
    .join('');

  const cards = sorted
    .map(
      (f) => `<article class="uc uc-${esc(f.displayTier)}" id="${esc(f.id)}" data-exclusive-group="G-232-301" data-unresolved-id="${esc(f.id)}">
      <header class="uc-head">
        <span class="uc-tier" title="${esc(f.displayTier)}">${esc(tierLabel(f.displayTier))}</span>
        <h3>${esc(f.title)}</h3>
        <span class="uc-id">${esc(f.id)}</span>
        <span class="pill pill-${f.status === 'resolved' ? 'resolved' : 'open'}" title="${esc(f.status)}">${esc(statusLabel(f.status))}</span>
      </header>
      <div class="uc-impact" data-unresolved-impact>${
        f.impactUsdCached ? `若该事实成立，则单票影响 <b>${fmt(f.impactUsdCached)}</b> 美元` : esc(f.impactDisplay || '不进入金额')
      }</div>
      <dl class="uc-dl">
        <dt>当前口径</dt><dd>${esc(f.currentBasis)}</dd>
        <dt>反事实</dt><dd>${esc(f.counterBasis || '—')}</dd>
        <dt>复核动作</dt><dd>${esc(f.reviewAction)}</dd>
        <dt>关闭条件</dt><dd>${esc(f.closeCriteria)}</dd>
        <dt>责任 / 期限</dt><dd>${esc(f.owner || '—')} · ${esc(f.reviewDue || '—')}${f.dueSetBy ? `（${esc(dueByText(f.dueSetBy))}）` : ''}</dd>
        ${f.dependsOn ? `<dt>依赖关系</dt><dd>本条只在 ${esc(f.dependsOn)} 成立时才影响金额${f.riskNote ? `；<span class="muted">内部：${esc(f.riskNote)}</span>` : ''}</dd>` : ''}
      </dl>
      ${
        f.subItems
          ? `<ul class="uc-subs">${f.subItems
              .map((s) => `<li><b>${esc(s.id)}</b> ${esc(s.title)}：${esc(s.reportText)}<span class="muted">｜建议：${esc(s.suggestAction)}</span></li>`)
              .join('')}</ul>`
          : ''
      }
      <div class="uc-actions no-print" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-action="assign" data-id="${esc(f.id)}" ${readonly ? 'disabled title="演示环境不可写"' : ''}>派单给我</button>
        <button class="btn btn-sm btn-ghost" data-action="resolve" data-id="${esc(f.id)}" ${readonly ? 'disabled title="演示环境不可写"' : ''}>提交证据并关闭</button>
        <span class="muted small">${readonly ? '演示只读：写操作已置灰（不隐藏，因为这是一个真实功能）' : '每次状态变更都会写审计（谁/何时/为什么/证据）'}</span>
      </div>
    </article>`
    )
    .join('');

  const body = `
<div class="toolbar">
  <h2 style="margin-right:6px">待核中心</h2>
  <span class="muted small">结论层面的异常件：有 ID、有人、有期限、有闭环证据</span>
  <div class="spacer"></div>
  ${readonly ? '<a class="btn btn-sm btn-ghost" href="/admin/notify">待核日报</a>' : ''}
  ${
    readonly || !ops.length
      ? ''
      : `<label class="op-pick"><span>以谁的身份操作</span>
    <select id="opPicker">
      <option value="">未选择</option>
      ${ops.map((o) => `<option value="${esc(o.key)}">${esc(o.name)}${o.role ? ` · ${esc(o.role)}` : ''}</option>`).join('')}
    </select></label>`
  }
  ${readonly ? '<span class="tag tag-mid">演示只读 · 数据为预置样例</span>' : '<span class="tag">内网 · HTTP Basic</span>'}
  ${readonly ? '<span class="muted small">今日 ' + esc(today) + '（可用 ?asOf= 观察逾期降级）</span>' : ''}
</div>
<div class="chips" style="margin:14px 0 0">${chips}</div>
<div class="stat-grid">
  <div class="stat"><div class="k">待核项</div><div class="v">${sorted.length}</div></div>
  <div class="stat"><div class="k">未闭环</div><div class="v">${open}</div></div>
  <div class="stat"><div class="k">当前筛选下影响金额</div><div class="v">${fmt(totalImpact)}</div></div>
  <div class="stat"><div class="k">已逾期</div><div class="v">${overdueCount}</div></div>
</div>
<div class="card">
  <table class="tbl">
    <caption>逾期久的排前面，同档按影响金额；≤7 天标黄，逾期标红</caption>
    <thead><tr><th>ID</th><th>一句话问题</th><th>影响范围</th><th class="ta-r">影响金额</th><th>分级</th><th>状态</th><th>负责人</th><th>复核期限</th><th>剩余</th><th>关联报告</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10" class="muted">这个筛选下没有待核项。</td></tr>'}</tbody>
  </table>
  <p class="muted small" style="margin-top:10px">影响金额不得相加：互斥项取可达状态最大值。此处“合计”仅用于排序，不是“总不确定性”。</p>
</div>
<div class="card">
  <h3 style="margin-bottom:12px">逐条详情（问题 / 当前取值 / 反事实 / 影响 / 怎么核 / 关闭条件）</h3>
  <div class="unres-list">${cards || '<p class="muted">这个筛选下没有待核项。</p>'}</div>
</div>`;
  return layout({ title: '待核中心', body, active: 'unresolved', script: '/js/unresolved.js', wide: true });
}

export function paramsPage(ctx) {
  const { params, versions = [], drafts = [], operators = [], tab = 'current' } = ctx;

  const paramRows = (params.raw.tariffs || [])
    .concat(params.raw.measures || [])
    .slice(0, 40)
    .map(
      (p) => `<tr>
      <td>${esc(p.country)}</td>
      <td>${esc(p.hsPrefix || (p.hsPrefixes || []).join('|') || '*')}</td>
      <td>${esc(p.measureType || 'MFN')}</td>
      <td class="ta-r">${p.rate ? pct(p.rate, 2) : '—'}</td>
      <td>${esc(p.confidence)}</td>
      <td>${esc(p.validFrom || p.effectiveFrom || '—')}</td>
      <td>${p.sourceUrl ? '<a href="' + esc(p.sourceUrl) + '" target="_blank" rel="noopener">来源</a>' : '<span class="neg">缺来源</span>'}</td>
    </tr>`
    )
    .join('');

  const draftCards = drafts.length
    ? drafts
        .map((d) => {
          const changes = (d.applied || [])
            .map((a) =>
              a.action
                ? `<li>${esc(a.collection)} · ${esc(a.key)} · ${esc(a.action)}</li>`
                : `<li>${esc(a.collection)} · ${esc(a.key)} · <code>${esc(a.field)}</code>：
             <span class="neg">${esc(String(a.from))}</span> → <span class="pos">${esc(String(a.to))}</span></li>`
            )
            .join('');
          const published = d.status === 'published';
          const golden = d.lastGolden
            ? d.lastGolden.passed
              ? `<span class="tag tag-green">黄金用例通过 ${d.lastGolden.total || 38} 项</span>`
              : `<span class="tag tag-red">黄金用例失败 ${d.lastGolden.failed || (d.lastGolden.failedCases || []).length} 项</span>`
            : '<span class="tag">未跑回归</span>';
          return `<article class="draft-card" data-draft="${esc(d.id)}">
      <header class="draft-head">
        <b>${esc(d.targetVersion)}</b>
        <span class="muted small">基于 ${esc(d.baseVersion)} · 提案人 ${esc(d.author)}</span>
        ${published ? '<span class="tag tag-green">已发布</span>' : '<span class="tag tag-mid">待发布</span>'}
        ${golden}
      </header>
      <ul class="draft-changes small">${changes || '<li class="muted">无改动</li>'}</ul>
      ${d.note ? `<p class="muted small">说明：${esc(d.note)}</p>` : ''}
      ${
        published
          ? `<p class="muted small">已于 ${esc(String(d.publishedAt || '').slice(0, 16).replace('T', ' '))} 由 ${esc(d.reviewer || '')} 发布。</p>`
          : `<form class="publish-form" data-id="${esc(d.id)}" style="margin-top:10px">
        <label class="muted small">复核人
          <select name="reviewer">
            <option value="">选择复核人</option>
            ${operators.map((o) => `<option value="${esc(o.key)}">${esc(o.name)}${o.role ? ` · ${esc(o.role)}` : ''}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-sm" type="submit">发布（先跑黄金用例）</button>
        <span class="draft-result small"></span>
      </form>`
      }
    </article>`;
        })
        .join('')
    : '<p class="muted">还没有草稿。改参数要先出草稿，再让另一个人批。</p>';

  const historyRows = versions.length
    ? versions
        .map(
          (v, i) => `<tr>
      <td>${esc(v.file)}${i === 0 ? ' <span class="tag tag-green">当前</span>' : ''}</td>
      <td>${esc(v.version)}</td>
      <td>${esc(v.asOf || '—')}</td>
      <td class="muted small">${esc(String(v.mtime || '').slice(0, 16).replace('T', ' '))}</td>
      <td class="muted small">${Object.entries(v.counts || {}).map(([k, n]) => `${k} ${n}`).join(' · ')}</td>
      <td>${
        i === 0
          ? '<span class="muted small">基准</span>'
          : `<a class="small" href="/admin/params/diff?a=${encodeURIComponent(v.file)}&b=${encodeURIComponent(versions[0].file)}">与当前对比</a>`
      }</td>
    </tr>`
        )
        .join('')
    : '';

  const tabOf = (k, label) => `<a class="chip${tab === k ? ' chip-on' : ''}" href="/admin/params?tab=${k}">${label}</a>`;

  const tabs = `<div class="chips" style="margin:14px 0 0">
    ${tabOf('current', '当前版本')}${tabOf('drafts', `待发布草稿${drafts.filter((d) => d.status !== 'published').length ? ` ${drafts.filter((d) => d.status !== 'published').length}` : ''}`)}${tabOf('history', '历史版本')}
  </div>`;

  const currentPane = `
<div class="stat-grid" style="margin-top:16px">
  <div class="stat"><div class="k">当前参数版本</div><div class="v" style="font-size:15px">${esc(params.version)}</div></div>
  <div class="stat"><div class="k">引擎版本</div><div class="v" style="font-size:15px">${esc(params.raw.engineVersion)}</div></div>
  <div class="stat"><div class="k">知识库截止</div><div class="v" style="font-size:15px">${esc(params.asOf)}</div></div>
  <div class="stat"><div class="k">前端可入口国家</div><div class="v" style="font-size:15px">${params.raw.countries.filter((c) => c.entryEnabled).length}</div></div>
</div>
<table class="tbl" style="margin-top:16px">
  <caption>参数行（节选）：每条必须同时有 source_url + confidence + valid_from，缺一条自检就起不来</caption>
  <thead><tr><th>国家</th><th>HS</th><th>措施</th><th class="ta-r">税率</th><th>置信度</th><th>生效</th><th>来源</th></tr></thead>
  <tbody>${paramRows}</tbody>
</table>`;

  const draftPane = `
<div class="card" style="margin-top:16px;border:1px solid var(--line)">
  <h3 style="margin-top:0">提一个新草稿</h3>
  <p class="muted small">草稿只写进 <code>data/runtime/drafts/</code>，线上参数不动。发布时才会生成新版本文件。</p>
  <form id="draftForm" class="form-grid" style="margin-top:12px">
    <div class="field"><label>基线版本</label>
      <select name="baseFile">${versions.map((v) => `<option value="${esc(v.file)}">${esc(v.file)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>改哪张表</label>
      <select name="collection">
        <option value="tariffs">tariffs（关税）</option>
        <option value="measures">measures（附加措施）</option>
        <option value="taxSteps">taxSteps（国内税）</option>
        <option value="charges">charges（规费）</option>
        <option value="compliance">compliance（合规）</option>
      </select>
    </div>
    <div class="field"><label>那一行（主键）</label><input name="key" placeholder="US|870891"></div>
    <div class="field"><label>改哪个字段</label><input name="field" placeholder="rate" value="rate"></div>
    <div class="field"><label>改成</label><input name="to" placeholder="0.03"></div>
    <div class="field"><label>说明</label><input name="note" placeholder="依据 CBP 某公告上调"></div>
    <div class="field"><label>以谁的身份提</label>
      <select name="author">${operators.map((o) => `<option value="${esc(o.key)}">${esc(o.name)}</option>`).join('')}</select>
    </div>
  </form>
  <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
    <button class="btn btn-sm" id="draftBtn" type="button">生成草稿</button>
    <span class="small" id="draftOut"></span>
  </div>
</div>
<div style="margin-top:16px">
  <h3>草稿列表</h3>
  ${draftCards}
</div>`;

  const historyPane = `
<div class="card" style="margin-top:16px">
  <table class="tbl">
    <caption>每次发布生成一个新文件，旧文件永远保留——历史报告要靠它复现（K2）</caption>
    <thead><tr><th>文件</th><th>版本号</th><th>知识库截止</th><th>写入时间</th><th>集合规模</th><th></th></tr></thead>
    <tbody>${historyRows}</tbody>
  </table>
</div>`;

  const body = `
<div class="card">
  <h2>参数治理</h2>
  <p class="muted small">改参数不是"编辑一个 JSON"：先出草稿 → 另一个人复核 → 发布前强制跑黄金用例 → 通过才生成新版本。任何一步不过，线上参数一个字节都不动。</p>
  ${tabs}
  ${tab === 'drafts' ? draftPane : tab === 'history' ? historyPane : currentPane}
</div>`;
  return layout({ title: '参数治理', body, active: '', wide: true, script: '/js/params.js', assistant: '' });
}

export function paramsDiffPage(a, b, diff, today) {
  const sec = (title, list, render) =>
    list.length
      ? `<h3>${title}<span class="muted small" style="font-weight:400;margin-left:8px">${list.length} 条</span></h3>
      <table class="tbl"><thead><tr><th>集合</th><th>主键</th><th>内容</th></tr></thead><tbody>${list.map(render).join('')}</tbody></table>`
      : '';

  const body = `
<div class="card">
  <h2>版本对比</h2>
  <p class="muted small"><code>${esc(a)}</code> → <code>${esc(b)}</code>。绿色是新增/提高，红色是删除/降低。</p>
  ${
    diff.meta.length
      ? `<h3>元信息</h3><table class="tbl"><thead><tr><th>字段</th><th>旧</th><th>新</th></tr></thead><tbody>${diff.meta
          .map((m) => `<tr><td><code>${esc(m.field)}</code></td><td class="neg">${esc(String(m.from))}</td><td class="pos">${esc(String(m.to))}</td></tr>`)
          .join('')}</tbody></table>`
      : ''
  }
  ${
    diff.changed.length
      ? `<h3>改动<span class="muted small" style="font-weight:400;margin-left:8px">${diff.changed.length} 条</span></h3>
  <table class="tbl"><thead><tr><th>集合</th><th>主键</th><th>字段</th><th>旧</th><th>新</th></tr></thead><tbody>
  ${diff.changed
    .map((c) =>
      Object.entries(c.fields)
        .map(
          ([f, v]) => `<tr><td>${esc(c.collection)}</td><td>${esc(c.key)}</td><td><code>${esc(f)}</code></td>
        <td class="neg">${esc(String(v.from))}</td><td class="pos">${esc(String(v.to))}</td></tr>`
        )
        .join('')
    )
    .join('')}
  </tbody></table>`
      : ''
  }
  ${sec('新增', diff.added, (x) => `<tr><td>${esc(x.collection)}</td><td>${esc(x.key)}</td><td class="pos small">${esc(JSON.stringify(x.item).slice(0, 120))}</td></tr>`)}
  ${sec('删除', diff.removed, (x) => `<tr><td>${esc(x.collection)}</td><td>${esc(x.key)}</td><td class="neg small">${esc(JSON.stringify(x.item).slice(0, 120))}</td></tr>`)}
  ${
    !diff.changed.length && !diff.added.length && !diff.removed.length && !diff.meta.length
      ? '<p class="muted">两个版本没有差异。</p>'
      : ''
  }
  <p style="margin-top:16px"><a href="/admin/params?tab=history">返回历史版本</a></p>
</div>`;
  return layout({ title: '版本对比', body, active: '', wide: true, assistant: '' });
}

export function calibratePage(report) {
  const exp = report.expected || {};
  const dutyTotal = D.of(exp.duty ?? 0).add(D.of(exp.surtax ?? 0));
  const vat = D.of(exp.refundableVat ?? 0);
  const taxTotal = D.of(exp.taxTotal ?? 0);
  const nonRefund = taxTotal.sub(vat);
  const remedy = exp.remedy && exp.remedy.applicable && !exp.remedy.incomplete ? exp.remedy : null;
  const preDate = report.input?.dates?.entryDate || '';

  const baseRow = (k, v, note = '') =>
    `<tr><td>${esc(k)}</td><td class="ta-r nowrap">${v}</td><td class="muted small">${esc(note)}</td></tr>`;

  const body = `
<div class="card">
  <h2>校准：照税单填一遍</h2>
  <p class="muted small">按税单上的行逐项填，不要只填一个总数——逐行对照才能说清差在哪。校准只用于改进参数与文案，<b>不会改变这份报告的历史金额</b>。</p>

  <table class="tbl" style="margin-top:14px">
    <caption>预演基准（填的时候照这个对）</caption>
    <thead><tr><th>行</th><th class="ta-r">预演值 USD</th><th>说明</th></tr></thead>
    <tbody>
      ${baseRow('关税（含附加措施）', fmt(dutyTotal), '基础关税 + 301/232 等附加')}
      ${baseRow('不可退国内税', fmt(nonRefund), '真正进成本的税')}
      ${baseRow('可退增值税', fmt(vat), '只影响现金，不进成本')}
      ${baseRow('规费', fmt(exp.charges ?? 0), 'MPF/HMF 等')}
      ${remedy ? baseRow('AD/CVD 保证金', fmt(remedy.deposit), `真实成本按最终税率 ${fmt(remedy.final)} 计`) : ''}
      <tr><td>真实成本</td><td class="ta-r nowrap"><b>${fmt(exp.landedCost ?? 0)}</b></td><td class="muted small">真实成本口径</td></tr>
      <tr><td>需备现金</td><td class="ta-r nowrap"><b>${fmt(exp.cashRequired ?? 0)}</b></td><td class="muted small">含可退增值税垫付</td></tr>
    </tbody>
  </table>

  <form id="calForm" class="form-grid" style="margin-top:18px">
    <div class="field"><label>实缴关税（含附加措施）</label><input name="actualDuty" inputmode="decimal" placeholder="${fmt(dutyTotal)}"></div>
    <div class="field"><label>实缴国内税（合计）</label><input name="actualTax" inputmode="decimal" placeholder="${fmt(taxTotal)}"></div>
    <div class="field"><label>其中可退增值税（可选）</label><input name="actualVat" inputmode="decimal" placeholder="${fmt(vat)}"></div>
    <div class="field"><label>实缴规费</label><input name="actualCharges" inputmode="decimal" placeholder="${fmt(exp.charges ?? 0)}"></div>
    ${
      remedy
        ? `<div class="field"><label>实缴 AD/CVD 保证金</label><input name="actualAd" inputmode="decimal" placeholder="${fmt(remedy.deposit)}"></div>`
        : ''
    }
    <div class="field"><label>实际清关日</label><input name="actualEntryDate" type="date" value="${esc(preDate)}"></div>
  </form>
  <p class="muted small" style="margin-top:8px">留空的行按预演值算——只改你确定的那几行，归因才准。</p>

  <div style="margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <button class="btn" id="calBtn" type="button">逐行比对并归因</button>
    <span class="muted small">归因四类：参数错 / 输入错 / 政策变 / 口径理解错</span>
  </div>
  <div id="calOut" style="margin-top:16px"></div>
</div>
<script>window.__REPORT_ID__ = ${JSON.stringify(report.reportId)};</script>`;
  return layout({ title: '校准', body, active: 'reports', script: '/js/calibrate.js' });
}

/* ---------------- 预演准确率看板（M4 的另一半） ---------------- */

function trendSvg(weekly) {
  const W = 660;
  const H = 180;
  const PADL = 46;
  const PADR = 16;
  const PADT = 16;
  const PADB = 34;
  const n = weekly.length;
  const vals = weekly.map((w) => w.avgPct).filter((v) => v !== null && v !== undefined);
  if (!vals.length) {
    return `<p class="muted small" style="margin:18px 0">还没有足够的数据画趋势。上传 3 张以上税单后会出现折线。</p>`;
  }
  const maxV = Math.max(0.01, ...vals) * 1.15;
  const x = (i) => PADL + (n <= 1 ? 0 : (i * (W - PADL - PADR)) / (n - 1));
  const y = (v) => H - PADB - (v / maxV) * (H - PADT - PADB);

  const grid = [0, 0.5, 1]
    .map((k) => {
      const v = maxV * k;
      const yy = y(v).toFixed(1);
      return `<line x1="${PADL}" y1="${yy}" x2="${W - PADR}" y2="${yy}" stroke="#e6eef1" stroke-width="1"/>
      <text x="${PADL - 8}" y="${Number(yy) + 4}" text-anchor="end" font-size="10" fill="#7b8f98">${(v * 100).toFixed(1)}%</text>`;
    })
    .join('');

  const segments = [];
  let cur = [];
  weekly.forEach((w, i) => {
    if (w.avgPct === null || w.avgPct === undefined) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else {
      cur.push([x(i), y(w.avgPct)]);
    }
  });
  if (cur.length) segments.push(cur);

  const lines = segments
    .map(
      (seg) =>
        `<polyline fill="none" stroke="#0f4d5c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${seg
          .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
          .join(' ')}"/>`
    )
    .join('');

  const dots = weekly
    .map((w, i) =>
      w.avgPct === null || w.avgPct === undefined
        ? ''
        : `<circle cx="${x(i).toFixed(1)}" cy="${y(w.avgPct).toFixed(1)}" r="3.4" fill="#0f4d5c"/>
      <text x="${x(i).toFixed(1)}" y="${(y(w.avgPct) - 9).toFixed(1)}" text-anchor="middle" font-size="10" fill="#42565f">${(w.avgPct * 100).toFixed(1)}%</text>`
    )
    .join('');

  const labels = weekly
    .map(
      (w, i) =>
        `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#7b8f98">${w.end.slice(5)}</text>`
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="每周边差率趋势">
    ${grid}${lines}${dots}${labels}
  </svg>`;
}

export function calibrationPage(stats, queue = []) {
  const w = stats.windows;
  const fmtPct = (v) => (v === null || v === undefined ? '—' : pct(v, 1));
  const sector = (v) => (v === null ? '' : v < 0.015 ? 'green' : v < 0.05 ? 'amber' : 'red');

  const countryRows = stats.byCountry.length
    ? stats.byCountry
        .map(
          (c) => `<tr>
      <td>${esc(c.name)}</td>
      <td class="ta-r">${c.count}</td>
      <td class="ta-r"><span class="tag tag-${sector(c.avgPct)}">${fmtPct(c.avgPct)}</span></td>
      <td class="ta-r muted">${fmtPct(c.maxPct)}</td>
    </tr>`
        )
        .join('')
    : `<tr><td colspan="4" class="muted">还没有数据</td></tr>`;

  const attrRows = stats.byAttribution.length
    ? stats.byAttribution
        .map(
          (a) => `<tr>
      <td>${esc(a.key)}</td>
      <td class="ta-r">${a.count}</td>
      <td class="ta-r muted">${pct(a.share, 0)}</td>
    </tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="muted">还没有数据</td></tr>`;

  const pending = queue.filter((q) => q.status === 'pending');
  const queueRows = pending.length
    ? pending
        .map(
          (q) => `<tr>
      <td>${esc(q.id)}</td>
      <td><a href="/quote/${esc(q.reportId)}/report">${esc(String(q.reportId).slice(0, 8))}</a></td>
      <td>${esc(q.line)}</td>
      <td class="ta-r ${q.diff > 0 ? 'neg' : 'pos'}">${q.diff > 0 ? '+' : ''}${fmt(q.diff)}</td>
      <td>${esc(q.suspectParam || '—')}</td>
      <td class="small muted">${esc(String(q.createdAt || '').slice(0, 10))}</td>
    </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="muted">队列是空的。校准里判定为「参数错」的行会自动进这里。</td></tr>`;

  const body = `
<div class="card">
  <h2>预演准确率</h2>
  <p class="lead-concl" data-headline>${esc(stats.headline)}</p>
  <div class="stat-grid" style="margin:16px 0">
    <div class="stat"><span class="stat-k">近 30 天</span><span class="stat-v">${w.d30.count} 票</span><p class="muted small">平均偏差 ${fmtPct(w.d30.avgPct)}</p></div>
    <div class="stat"><span class="stat-k">近 90 天</span><span class="stat-v">${w.d90.count} 票</span><p class="muted small">平均偏差 ${fmtPct(w.d90.avgPct)}</p></div>
    <div class="stat"><span class="stat-k">上一周期（30–59 天前）</span><span class="stat-v">${w.d30prev.count} 票</span><p class="muted small">平均偏差 ${fmtPct(w.d30prev.avgPct)}</p></div>
    <div class="stat"><span class="stat-k">待复核参数</span><span class="stat-v">${pending.length} 条</span><p class="muted small">来自校准归因「参数错」</p></div>
  </div>

  <h3 style="margin-top:6px">每周边差率</h3>
  <p class="muted small">纵轴是平均绝对偏差（|实缴 − 预演| ÷ 真实成本）。越低越好，断点是那一周没有校准。</p>
  ${trendSvg(stats.weekly)}

  <div class="two-col" style="margin-top:18px">
    <div>
      <h3>按国家</h3>
      <table class="tbl"><thead><tr><th>国家</th><th class="ta-r">票数</th><th class="ta-r">平均偏差</th><th class="ta-r">最差</th></tr></thead><tbody>${countryRows}</tbody></table>
    </div>
    <div>
      <h3>按归因</h3>
      <table class="tbl"><thead><tr><th>归因</th><th class="ta-r">票数</th><th class="ta-r">占比</th></tr></thead><tbody>${attrRows}</tbody></table>
      <p class="muted small" style="margin-top:10px">「口径理解错」占比高说明问题在文案，不在参数——这类不该去改税率。</p>
    </div>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>参数复核队列</h2>
  <p class="muted small">校准判定为「参数错」的行会自动进来。复核人决定是否开新版本；新版本发布前必须跑过黄金用例。</p>
  <table class="tbl" style="margin-top:12px">
    <thead><tr><th>编号</th><th>报告</th><th>行</th><th class="ta-r">差额 USD</th><th>疑似参数</th><th>入队日</th></tr></thead>
    <tbody>${queueRows}</tbody>
  </table>
</div>`;
  return layout({ title: '预演准确率', body, active: 'calibration' });
}

/* ---------------- 批量试算 ---------------- */

export function batchPage(params) {
  const asOf = params?.asOf || '';
  const body = `
<div class="card">
  <h2>批量试算</h2>
  <p class="muted small">一次最多 200 行。同样的内容重复提交会拿回同一份报告，不会重复落库。每一行都走和单票一样的引擎，不是估算公式。</p>

  <div class="field" style="margin-top:14px">
    <label>贴 CSV（第一行可以是表头）</label>
    <textarea id="csvBox" data-asof="${esc(asOf)}" rows="9" spellcheck="false" placeholder="country,hsCode,fob,freight,qty,channel,declarationDate
HU,8708.91,48000,2400,1200,B2B,${esc(asOf)}
US,8708.91,48000,2400,1200,B2B,${esc(asOf)}
BR,8708.91,10000,0,1,B2B,${esc(asOf)}"></textarea>
  </div>
  <p class="muted small" style="margin-top:6px">
    必填列：<code>country</code>（国家代码）、<code>hsCode</code>、<code>fob</code>、<code>qty</code>、<code>channel</code>（B2B / B2C）、<code>declarationDate</code>（申报日，决定适用哪一档税率和 AD 分支）。<br>
    选填列：<code>freight</code>（运费，缺省 0）、<code>entryDate</code>（放行日，缺省等于申报日）、<code>exportDate</code>。<br>
    留空的 <code>country</code> 沿用上一行（真实表格常见合并单元格）；留空的 <code>declarationDate</code> 按参数基准日 ${esc(asOf)} 处理，预览里会显示出来，请确认后再提交。
  </p>

  <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <button class="btn btn-ghost" id="previewBtn" type="button">解析预览</button>
    <button class="btn" id="submitBtn" type="button" disabled>提交试算</button>
    <span class="muted small" id="batchHint">先贴数据再解析</span>
  </div>

  <div id="batchPreview" style="margin-top:16px"></div>
  <div id="batchOut" style="margin-top:16px"></div>
</div>`;
  return layout({ title: '批量试算', body, active: 'new', script: '/js/batch.js' });
}

/* ---------------- 政策日历（M5 的独立视图） ---------------- */

export function calendarPage(params, today) {
  const raw = params.raw;
  const items = [];

  for (const e of raw.policyCalendar || []) {
    items.push({ date: String(e.date).slice(0, 10), label: e.label, kind: e.type === 'version' ? '版本提醒' : '政策生效', country: '', sourceUrl: e.sourceUrl });
  }
  for (const m of raw.measures || []) {
    if (m.effectiveFrom) {
      items.push({
        date: String(m.effectiveFrom).slice(0, 10),
        label: `${m.label} 生效`,
        kind: '措施',
        country: m.country,
        sourceUrl: m.sourceUrl,
        measureType: m.measureType,
      });
    }
  }
  for (const c of raw.charges || []) {
    if (c.validFrom) {
      items.push({ date: String(c.validFrom).slice(0, 10), label: `${c.label} 起适用`, kind: '规费', country: c.country, sourceUrl: c.sourceUrl });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));

  const spans = (raw.measures || [])
    .filter((m) => m.inTransitRule && m.inTransitRule.shipBy && m.inTransitRule.enterBy)
    .map((m) => ({
      label: m.label,
      country: m.country,
      shipBy: String(m.inTransitRule.shipBy).slice(0, 10),
      enterBy: String(m.inTransitRule.enterBy).slice(0, 10),
      note: m.note || '',
    }));

  const kindOf = (d) => (d <= today ? 'in' : diffDays(today, d) <= 30 ? 'soon' : 'far');
  const KIND_TEXT = { in: '已生效', soon: '30 天内', far: '更远' };

  const rowOf = (it) => {
    const k = kindOf(it.date);
    const simulate = addDays(it.date, 3);
    return `<li class="cal-row cal-${k}">
      <span class="cal-date">${esc(it.date)}</span>
      <span class="cal-dot"></span>
      <div class="cal-body">
        <div class="cal-label">${esc(it.label)}</div>
        <div class="cal-meta">
          <span class="tag tag-${k === 'in' ? 'green' : k === 'soon' ? 'amber' : ''}">${KIND_TEXT[k]}</span>
          ${it.country ? `<span class="muted small">${esc(it.country)}</span>` : ''}
          <span class="muted small">${esc(it.kind)}</span>
          ${it.sourceUrl ? `<a class="small" href="${esc(it.sourceUrl)}" target="_blank" rel="noopener">来源</a>` : '<span class="muted small">无一手来源</span>'}
          ${
            k !== 'in'
              ? `<a class="small cal-sim" href="/quote/new?country=${encodeURIComponent(it.country || 'US')}&exportDate=${simulate}">如果晚 3 天发货会怎样</a>`
              : ''
          }
        </div>
      </div>
    </li>`;
  };

  const groups = ['in', 'soon', 'far'].map((k) => ({ k, rows: items.filter((it) => kindOf(it.date) === k) }));
  const list = groups
    .filter((g) => g.rows.length)
    .map(
      (g) => `<div class="cal-group">
    <h3>${KIND_TEXT[g.k]}<span class="muted small" style="font-weight:400;margin-left:8px">${g.rows.length} 条</span></h3>
    <ul class="cal-list">${g.rows.map(rowOf).join('')}</ul>
  </div>`
    )
    .join('');

  const spanCards = spans.length
    ? spans
        .map(
          (s) => `<div class="cal-span">
      <div class="cal-span-head"><b>${esc(s.label)}</b><span class="muted small">${esc(s.country)} · 在途豁免</span></div>
      <div class="cal-span-bar">
        <span class="cal-span-end"><b>${esc(s.shipBy)}</b><small>装船截止</small></span>
        <span class="cal-span-mid"><i></i><em>豁免窗口</em><i></i></span>
        <span class="cal-span-end"><b>${esc(s.enterBy)}</b><small>申报截止</small></span>
      </div>
      <p class="muted small">两个日期都满足才豁免：<b>装船 ≤ ${esc(s.shipBy)} 且 申报 ≤ ${esc(s.enterBy)}</b>。只满足一个不算。${
            s.note ? esc(s.note) : ''
          }</p>
    </div>`
        )
        .join('')
    : '<p class="muted">当前参数库里没有带在途豁免的措施。</p>';

  const body = `
<div class="card">
  <h2>政策日历</h2>
  <p class="muted small">今天是 ${esc(today)}。这里只列参数库里有出处的日期；没有一手来源的会明确标出来，不猜。</p>
  <div class="stat-grid" style="margin:16px 0">
    ${groups
      .map((g) => `<div class="stat"><div class="k">${KIND_TEXT[g.k]}</div><div class="v">${g.rows.length}</div></div>`)
      .join('')}
    <div class="stat"><div class="k">在途豁免窗口</div><div class="v">${spans.length}</div></div>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h3>在途豁免：两个日期夹一个窗口</h3>
  <p class="muted small" style="margin-bottom:14px">这类规则最容易被漏看——它不是"某天生效"，而是"某天之前装船、并在此后几天内申报"才不算新税。画成一条线会误导，所以两端日期都摆出来。</p>
  ${spanCards}
</div>

<div class="card" style="margin-top:16px">
  <h3>时间轴</h3>
  ${list}
</div>`;
  return layout({ title: '政策日历', body, active: 'calendar' });
}

/* ---------------- 看懂外贸（视频栏目） ---------------- */

/**
 * 视频栏目。
 *
 * 这个页面最容易做成"内容农场"——一堆外链卡片，和产品没有关系。
 * 所以三条设计约束：
 * 1. 每条视频都必须回答"跟你要算的这票有什么关系"，答不上来的就不收（hook 可以为空，但必须是有意留空）
 * 2. 播放器不预加载：不点不产生任何第三方请求，断网也能看目录
 * 3. 内容坏了要说出来：整块读不出来、单条校验不过，都要在页面上留下痕迹，不能变成空白栏目让人以为没内容
 */
export function learnPage(content) {
  const c = content || { ok: false, reason: '栏目内容还没导入', meta: {}, groups: [], videos: [], dropped: [] };
  const totalSec = c.videos.reduce((s, v) => s + v.seconds, 0);
  const totalText = totalSec >= 3600 ? `${Math.floor(totalSec / 3600)} 小时 ${Math.round((totalSec % 3600) / 60)} 分` : `${Math.round(totalSec / 60)} 分钟`;
  const snap = c.meta?.statSnapshotAt || c.meta?.compiledAt || '';

  if (!c.ok) {
    return layout({
      title: '看懂外贸',
      active: 'learn',
      body: `<div class="card">
  <h2>看懂外贸</h2>
  <p class="muted">这个栏目的内容还没导进来：${esc(c.reason || '暂无可播放的条目')}。</p>
  <p class="muted small">这不是网络问题，其他页面照常能用。想现在就弄明白术语，右下角问老周，他能直接讲。</p>
  <p><a class="btn btn-ghost" href="/quote/new">先去算一票</a></p>
</div>`,
    });
  }

  const card = (v) => `<article class="lv${v.featured ? ' lv-featured' : ''}" data-learn-card data-bvid="${esc(v.bvid)}">
  <div class="lv-player" data-player>
    <img class="lv-cover" src="${esc(v.cover || '')}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add('lv-cover-broken')">
    <button class="lv-play" type="button" data-play="${esc(v.bvid)}" data-src="${esc(v.playerUrl)}" aria-label="播放：${esc(v.title)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
      <span>播放</span>
    </button>
    <span class="lv-dur">${esc(v.durationText)}</span>
    ${v.featured ? '<span class="lv-pick">建议先看这条</span>' : ''}
  </div>
  <div class="lv-body">
    <h4 class="lv-title">${esc(v.title)}</h4>
    <div class="lv-meta">
      <span>${esc(v.author)}</span>
      <span class="lv-sep">·</span>
      <span>${esc(String(v.publishedAt || '').slice(0, 4))}</span>
      <span class="lv-sep">·</span>
      <span>${esc(v.playText)}次播放</span>
    </div>
    <p class="lv-take"><b>看完能答上</b>${esc(v.takeaway)}</p>
    ${v.hook ? `<p class="lv-hook"><b>跟你要算的这票有什么关系</b>${esc(v.hook)}</p>` : ''}
    <div class="lv-foot">
      <a class="lv-out" href="${esc(v.watchUrl)}" target="_blank" rel="noopener noreferrer">打不开？去原站看 ↗</a>
      <span class="lv-tags">${(v.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</span>
    </div>
  </div>
</article>`;

  const groups = c.groups
    .map((g) => {
      // 每组挑一条当主课通栏，剩下的两两并排。不这么排，5 条的分组最后一行会孤零零挂一张卡。
      const feat = g.videos.filter((v) => v.featured);
      const rest = g.videos.filter((v) => !v.featured);
      const pick = feat[0] || rest.shift();
      return `<section class="learn-group">
  <div class="learn-group-head">
    <h3>${esc(g.title)}</h3>
    <span class="muted small">${esc(g.sub || '')} · ${g.videos.length} 条</span>
  </div>
  ${g.why ? `<p class="learn-group-why">${esc(g.why)}</p>` : ''}
  <div class="learn-grid">${card(pick)}${rest.map(card).join('')}</div>
</section>`;
    })
    .join('');

  const droppedNote = c.dropped?.length
    ? `<p class="small muted" style="margin-top:8px">另有 ${c.dropped.length} 条内容没通过校验，已跳过，不影响上面的条目。</p>`
    : '';

  const body = `
<div class="card learn-head">
  <div class="learn-eyebrow">视频栏目 · ${c.videos.length} 条 · 合计约 ${esc(totalText)}${snap ? ` · 数据抓取于 ${esc(snap)}` : ''}</div>
  <h2>看懂外贸</h2>
  <p class="learn-lede">术语、流程、税制这几块，看别人讲一遍比自己摸索快得多，所以挑出来放在这儿。<br>
  但讲解给的是<b>框架</b>，不是<b>你这票的数</b>——落到要报出去的那个价，还得自己算一遍。</p>
  <div class="learn-rules">
    <div class="lp"><b>① 先分清价里含什么</b><span>FOB 只管到船上，CIF 把运费和保险也算进价里。同一个报价数，术语不同，到岸成本能差出一截。</span></div>
    <div class="lp"><b>② 视频给框架，参数给数</b><span>视频里出现的税率、费用、时限只能当背景；要让它们变成钱，得回到参数库和这一票的输入。</span></div>
    <div class="lp"><b>③ 看完就试一遍</b><span>每条下面都能直接跳去录入页，拿同一票货换个术语算两遍，看金额差在哪一格。</span></div>
  </div>
</div>

${groups}

<div class="card learn-about">
  <h3>关于这些视频</h3>
  <p class="muted small">全部来自哔哩哔哩的公开内容，版权归原作者所有。这里只做了挑选和排序，没有复制、搬运或改写视频内容，也不代表作者为这个工具背书。</p>
  <p class="muted small">播放量和发布年份是 ${esc(snap || '入库时')} 抓的快照，会变；视频也可能被作者下架或设为私密，遇到打不开，点卡片右下角的「去原站看」，或直接搜标题。</p>
  <p class="muted small">视频里讲到的税率、时限、费用，一律只能当背景知识。这个工具的报告里，每个数字都带出处、置信度和适用日期；两边不一致时，以你报关行最终确认的为准，不以任何一边为准。</p>
  <p class="muted small">想弄明白的没在这个列表里？右下角问老周，或者让他按你这票的具体情况讲。</p>
  ${droppedNote}
</div>
<div class="learn-offline" id="learnOffline" hidden>现在没联网，播放器打不开。目录和文字都还在，联网后再点播放就行。</div>`;

  return layout({ title: '看懂外贸', body, active: 'learn', script: '/js/learn.js' });
}
