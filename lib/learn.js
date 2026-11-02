/**
 * 「看懂外贸」视频栏目的内容层。
 *
 * 这里只管三件事：把 data/content/videos.json 读出来、逐条校验、算好展示用的派生字段。
 * 不做任何网络请求——视频列表是静态内容，页面打开时不该有第三方请求。
 *
 * 一条原则贯穿全文件：**坏数据不要静默丢弃，也不要整块崩掉**。
 * 单条不合格就摘掉它并把原因带回去给页面显示；整个文件读不出来才降级成空栏目。
 * 理由是同一件事——用户看到空白栏目，会以为是"没有内容"，而不是"内容坏了"。
 */
import fs from 'node:fs';
import path from 'node:path';

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const REQUIRED = ['id', 'bvid', 'title', 'author', 'seconds', 'group', 'takeaway'];

/** 秒数 → 「4:58」「36:41」。超过一小时加小时位。 */
export function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 站内播放器地址。autoplay 一律关掉——用户点的是"这条"，不是"帮我把声音打开"。 */
export function playerUrl(bvid) {
  return `https://player.bilibili.com/player.html?isOutside=true&bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&danmaku=0&autoplay=0`;
}

/** 打不开播放器时的兜底：直接去原站。永远和播放按钮一起给出，不做单点依赖。 */
export function watchUrl(bvid) {
  return `https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`;
}

/**
 * 播放量写成「11.8 万」。这个数会过期，所以页面必须把抓取日一起印出来，
 * 否则半年后它还理直气壮地写着昨天的数字——这类"看起来是事实"的陈旧数据比不显示更坏。
 */
export function playText(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

function checkOne(v, groupIds) {
  for (const k of REQUIRED) {
    if (v[k] === undefined || v[k] === null || v[k] === '') return `缺字段 ${k}`;
  }
  if (!BVID_RE.test(String(v.bvid))) return '视频编号格式不对';
  if (!groupIds.has(v.group)) return `分组 ${v.group} 不存在`;
  if (!(Number(v.seconds) > 0)) return '时长不合法';
  return '';
}

/**
 * @param {string} file 内容文件绝对路径
 * @param {object} [deps] 测试注入用：{ readFile }
 * @returns {{ok:boolean, reason:string, meta:object, groups:Array, videos:Array, dropped:Array}}
 */
export function loadLearnContent(file, deps = {}) {
  const read = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const empty = { ok: false, reason: '', meta: {}, groups: [], videos: [], dropped: [] };

  let raw;
  try {
    raw = JSON.parse(read(file));
  } catch (e) {
    // 文件不存在和 JSON 坏了要分开说：一个是要去补内容，一个是要去修格式
    const missing = e && (e.code === 'ENOENT' || /ENOENT/.test(String(e.message)));
    return { ...empty, reason: missing ? '内容文件还没放进来' : '内容文件格式有问题，没能读出来' };
  }

  if (!raw || !Array.isArray(raw.videos) || !raw.videos.length) {
    return { ...empty, reason: '内容文件里还没有视频' };
  }

  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter((g) => g && g.id && g.title);
  const groupIds = new Set(groups.map((g) => g.id));
  const seenId = new Set();
  const seenBvid = new Set();
  const videos = [];
  const dropped = [];

  for (const v of raw.videos) {
    const why = checkOne(v || {}, groupIds);
    if (why) {
      dropped.push({ id: (v && v.id) || '(无 id)', why });
      continue;
    }
    // 同一个视频重复入库，页面上就是两张一模一样的卡；同一 id 重复则锚点会撞
    if (seenBvid.has(v.bvid)) {
      dropped.push({ id: v.id, why: '同一个视频重复收录' });
      continue;
    }
    if (seenId.has(v.id)) {
      dropped.push({ id: v.id, why: 'id 重复' });
      continue;
    }
    seenBvid.add(v.bvid);
    seenId.add(v.id);
    videos.push({
      ...v,
      seconds: Number(v.seconds),
      durationText: durationText(v.seconds),
      playText: playText(v.play),
      playerUrl: playerUrl(v.bvid),
      watchUrl: watchUrl(v.bvid),
    });
  }

  // 分组顺序按配置来，空组不出现在页面上
  const filled = groups
    .map((g) => ({ ...g, videos: videos.filter((v) => v.group === g.id) }))
    .filter((g) => g.videos.length);

  return {
    ok: filled.length > 0,
    reason: filled.length ? '' : '内容文件里没有一条通过校验',
    meta: raw.meta || {},
    groups: filled,
    videos,
    dropped,
  };
}

/** 服务端启动时读一次就够：内容不会在进程里变。路由层直接取这个。 */
export function defaultLearnPath(root = process.cwd()) {
  return path.join(root, 'data', 'content', 'videos.json');
}
