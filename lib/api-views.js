/**
 * 给「微信小程序 / 移动端 H5」用的 JSON 视图层。
 *
 * 为什么单独开一个文件：server.js 里的 calendarPage / learnPage 是把数据和版面
 * 搅在一起的 HTML 字符串，小程序一个字节都拿不到。这里只做「参数 → 纯 JSON」，
 * 不含任何标签，PC 页与手机端共用同一份口径。
 *
 * 一条规矩：这里出现的每个数字都要能追回 params 原始字段，
 * 不许为了让首页好看临时编一个统计值。手机屏幕小，反而更容易把假数字当真。
 */
import { matchCharges } from './params.js';
// 编码格式化只允许有一份实现：录入页、报告、手机端看到的「8708.91」必须是同一个串，
// 各写一份迟早出现 8708.9 / 870891 两种写法。
import { hsDisplay } from './engine/quote.js';

/** 7 个分区的中文名。参数库里存的是 EU / AMERICAS 这种枚举，界面上不许出现。 */
export const REGION_LABEL = {
  EU: '欧盟',
  EUROPE_NON_EU: '欧洲其他',
  ASIA: '亚洲',
  MIDDLE_EAST: '中东',
  AMERICAS: '美洲',
  AFRICA: '非洲',
  OCEANIA: '大洋洲',
};

/** 两个 YYYY-MM-DD 之间差几天。只用于「已生效 / 30 天内 / 更远」的分档。 */
function diffDays(from, to) {
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function countryNameMap(params) {
  const m = new Map();
  for (const c of params.raw.countries || []) m.set(c.code, c.name);
  return m;
}

/**
 * 覆盖范围。首页那行「68 个市场 × 6 个品类」就是这么来的。
 *
 * 注意 chargesMarkets 是**逐个市场真跑 matchCharges** 数出来的，不是查表猜的：
 * 参数库里 13 条规费记录里有几条 country 为空（欧盟共用一条），
 * 直接 count(country) 会数成 9，和实际能算的 35 个市场差两倍多。
 */
export function coverageView(params) {
  const raw = params.raw || {};
  const supported = (raw.countries || []).filter((c) => c.supported);
  const entry = (raw.countries || []).filter((c) => c.entryEnabled);
  const catalog = raw.hsCatalog || [];

  const byRegion = new Map();
  for (const c of supported) {
    const k = c.region || 'OTHER';
    byRegion.set(k, (byRegion.get(k) || 0) + 1);
  }

  let chargesMarkets = 0;
  for (const c of supported) {
    try {
      if (matchCharges(params.idx, c.code).length) chargesMarkets += 1;
    } catch {
      // 单个市场索引异常不该让整个覆盖接口挂掉；少算一个市场比整页 500 好
    }
  }

  const certCodes = new Set();
  for (const rec of raw.compliance || []) {
    for (const code of rec.countries || []) if (code) certCodes.add(code);
  }
  const supportedCodes = new Set(supported.map((c) => c.code));
  const complianceMarkets = [...certCodes].filter((c) => supportedCodes.has(c)).length;

  return {
    paramsVersion: params.version,
    paramsFile: params.file,
    asOf: params.asOf,
    productVersion: raw.productVersion || '',
    engineVersion: raw.engineVersion || '',
    hsVersion: raw.hsVersion || '',
    markets: {
      total: supported.length,
      entryEnabled: entry.length,
      byRegion: [...byRegion.entries()]
        .map(([id, count]) => ({ id, label: REGION_LABEL[id] || id, count }))
        .sort((a, b) => b.count - a.count),
    },
    categories: catalog.map((c) => ({ hs: String(c.hs), hsDisplay: hsDisplay(c.hs), name: c.name })),
    cells: supported.length * catalog.length,
    chargesMarkets,
    complianceMarkets,
    insuranceDefaultRate: raw.insuranceDefaultRate ?? null,
  };
}

/**
 * 政策日历。
 *
 * 三个来源合到一起：政策节点（policyCalendar）、贸易措施生效日（measures）、
 * 规费适用起始（charges）。日历页原来在 render.js 里各自拼 HTML，
 * 这里改成先出数据、谁要谁自己画——小程序和 H5 就不必各写一遍筛选逻辑。
 */
export function calendarView(params, today) {
  const raw = params.raw || {};
  const names = countryNameMap(params);
  const day = String(today || params.asOf || '').slice(0, 10);
  const items = [];

  for (const e of raw.policyCalendar || []) {
    const date = String(e.date || '').slice(0, 10);
    if (!date) continue;
    items.push({
      date,
      label: e.label || '',
      kind: e.type === 'version' ? '版本提醒' : '政策生效',
      country: '',
      countryName: '',
      sourceUrl: e.sourceUrl || '',
    });
  }

  for (const m of raw.measures || []) {
    if (!m.effectiveFrom) continue;
    const date = String(m.effectiveFrom).slice(0, 10);
    items.push({
      date,
      label: `${m.label || '贸易措施'} 生效`,
      kind: '贸易措施',
      country: m.country || '',
      countryName: names.get(m.country) || m.country || '',
      sourceUrl: m.sourceUrl || '',
      measureType: m.measureType || '',
    });
  }

  for (const c of raw.charges || []) {
    if (!c.validFrom) continue;
    const date = String(c.validFrom).slice(0, 10);
    items.push({
      date,
      label: `${c.label || '规费'} 起适用`,
      kind: '规费',
      country: c.country || '',
      countryName: names.get(c.country) || c.country || '',
      sourceUrl: c.sourceUrl || '',
    });
  }

  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // 分档只用在配色上：已生效=灰、30 天内=黄、更远=蓝。
  // 没有日期的一律 far，不假装它快到期。
  const withState = items.map((it) => {
    const d = diffDays(day, it.date);
    const state = d === null ? 'far' : d <= 0 ? 'in' : d <= 30 ? 'soon' : 'far';
    return { ...it, daysFromToday: d, state };
  });

  // 在途豁免的船期/申报双截止，是和日历分开的一件事：
  // 它不是一个日期，而是一段窗口，画成单个点会误导人。
  const spans = (raw.measures || [])
    .filter((m) => m.inTransitRule && m.inTransitRule.shipBy && m.inTransitRule.enterBy)
    .map((m) => ({
      label: m.label || '',
      country: m.country || '',
      countryName: names.get(m.country) || m.country || '',
      shipBy: String(m.inTransitRule.shipBy).slice(0, 10),
      enterBy: String(m.inTransitRule.enterBy).slice(0, 10),
      note: m.note || '',
    }));

  return {
    today: day,
    paramsVersion: params.version,
    count: withState.length,
    items: withState,
    spans,
    // 日历的第一句话必须是这个：不然用户会以为「没列出来 = 没风险」
    note: '只收录参数库里已入库的节点。没列出来不代表没有变化，只代表还没调研到。',
  };
}

/**
 * 「看懂外贸」栏目数据。
 *
 * 直接把 loadLearnContent 的结果转成 JSON，不做二次加工：
 * 校验、去重、降级都在 learn.js 里做完了，这里再算一遍就会有两套口径。
 * 播放交给客户端——H5 用 iframe，小程序只能复制链接去浏览器，
 * 所以 playerUrl 和 watchUrl 两个都给。
 */
export function learnView(learn) {
  if (!learn || !learn.ok) {
    return {
      ok: false,
      reason: (learn && learn.reason) || '内容还没导进来',
      meta: {},
      groups: [],
      count: 0,
    };
  }
  return {
    ok: true,
    reason: '',
    meta: learn.meta || {},
    count: learn.videos.length,
    dropped: learn.dropped || [],
    groups: learn.groups.map((g) => ({
      id: g.id,
      title: g.title,
      sub: g.sub || '',
      why: g.why || '',
      videos: g.videos.map((v) => ({
        id: v.id,
        bvid: v.bvid,
        title: v.title,
        author: v.author,
        seconds: v.seconds,
        durationText: v.durationText,
        playText: v.playText,
        group: v.group,
        featured: Boolean(v.featured),
        takeaway: v.takeaway || '',
        answer: v.answer || '',
        cover: v.cover || '',
        playerUrl: v.playerUrl,
        watchUrl: v.watchUrl,
      })),
    })),
  };
}
