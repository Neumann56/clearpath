/**
 * 视频栏目的失效检查（联网跑，不进 verify.js）。
 *
 * 为什么要单独一个脚本：videos.json 里的东西会在我们不知情的时候变坏——
 * 作者删稿、转私密、版权下架、改标题、改封面。页面上不会有任何报错，
 * 用户点开是一片空白，我们还以为栏目好着。
 *
 * 只在需要时手动跑（建议每季度一次，或发现有人反馈"点不开"时）：
 *   node scripts/check-videos.js            # 只报告，改任何东西
 *   node scripts/check-videos.js --write    # 顺手把播放量、标题刷新回 videos.json
 *
 * 有失效条目就 exit 1，方便挂到定时任务上。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'data', 'content', 'videos.json');
const WRITE = process.argv.includes('--write');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const dead = [];
const changed = [];
let titleNotes = 0;

for (const v of raw.videos) {
  let data = null;
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(v.bvid)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
    });
    const j = await r.json();
    if (j.code === 0) data = j.data;
  } catch (e) {
    // 网络不通跟视频失效是两件事，别混着报
    console.log(`?  ${v.id} 请求失败（${e.message}），跳过`);
    continue;
  }

  if (!data) {
    dead.push(v);
    console.log(`✗ ${v.id} ${v.bvid} 取不到，可能已删除或转私密`);
    await sleep(400);
    continue;
  }

  const dur = data.duration;
  const view = data.stat && data.stat.view;
  // 标题在这份文件里是有意改写过的展示标题（去掉竖线、统一标点），所以跟平台对不上是正常的，
  // 只作提示。真正要报警的是时长变了——那通常意味着作者换了片子或者重剪过。
  const titleDiff = data.title && data.title !== v.title;
  const durChanged = Math.abs(dur - v.seconds) > 2;

  if (durChanged) changed.push({ v, field: 'seconds', from: v.seconds, to: dur });
  if (view && view !== v.play) changed.push({ v, field: 'play', from: v.play, to: view });
  if (titleDiff) titleNotes += 1;

  const flag = durChanged ? '!' : '✓';
  console.log(
    `${flag} ${v.id} ${v.bvid} ${dur}s 播放 ${view}${durChanged ? `｜时长变了：${v.seconds}s → ${dur}s` : ''}${
      titleDiff ? '｜标题与入库时不同（展示标题是改写过的，正常）' : ''
    }`
  );
  await sleep(400);
}

if (WRITE) {
  // 只回写能核到的字段，核不到的保持原样——宁可留着旧数，也别被一次网络抖动清空
  const byId = new Map(changed.map((c) => [`${c.v.id}|${c.field}`, c.to]));
  for (const v of raw.videos) {
    // 标题不回写：本地标题是改写过的展示文案，覆盖了反而丢掉改写
    if (byId.has(`${v.id}|seconds`)) v.seconds = byId.get(`${v.id}|seconds`);
    if (byId.has(`${v.id}|play`)) v.play = byId.get(`${v.id}|play`);
  }
  raw.meta = { ...(raw.meta || {}), statSnapshotAt: today };
  fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  console.log(`\n已回写 ${changed.length} 处变更，抓取日更新为 ${today}。`);
}

console.log(`\n共 ${raw.videos.length} 条：失效 ${dead.length} 条，时长或播放量有变化 ${changed.length} 处，标题不同 ${titleNotes} 条。`);
if (dead.length) {
  console.log('失效的这几条要么换视频，要么从 videos.json 里删掉——页面上它们会变成点不开的卡片。');
  process.exit(1);
}
