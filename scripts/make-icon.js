/**
 * 把品牌稿 4 号（三点折线 + 箭头）做成小程序头像。
 *
 * 跑法：node scripts/make-icon.js
 * 产出 out/icon/：
 *   icon-512.png      完整锁定版（图形 + 通途 CLEARPATH），交微信后台用这张
 *   icon-mark-512.png 纯图形版（只留三点和箭头），缩到小尺寸时更清楚
 *   icon-144.png      微信建议的 144 尺寸
 *   preview.png       128 / 80 / 40 / 26 四档对照，判断缩下去还认不认得出
 *
 * 为什么是裁切重排而不是照着画矢量：
 * 这个标记的深蓝粗棒末端是被圆形「挖」出凹缺口的（不是平头、不是圆头），
 * 箭头尾部也是一段贴合绿点的凹弧。手画很容易画成普通圆头线，一眼就假。
 * 原图是 1024 的平面色块，裁切后缩到 512 掉不下去，所以直接用原像素最保真。
 *
 * 取景框是量出来的，不是估的（scripts/extract-logo.js 的产物）：
 *   图形 bbox x 249..778 / y 202..468，三颗点圆心 (295,423) (442,248) (586,423) 半径 46
 *   加字标后整体 bbox y 202..820 —— 整体接近正方形，正好塞得进方头像
 *
 * 满幅方图，不自己切圆角：微信会切，自己切会双重圆角、边缘露白。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 品牌稿在应用目录之外（上一级），所以按脚本自身位置找，不依赖当前工作目录。
// 之前写成相对路径，从 通途_app 里跑就 ENOENT，从仓库根跑又好——这种「看你在哪跑」的路径最容易坑人。
const SRC = path.resolve(
  import.meta.dirname,
  '../../通途CLEARPATH品牌视觉_assets/57f7651c-miora_text_to_image-1792327518303-0-51e2a3e3b2b7.png'
);
const OUT = path.resolve(import.meta.dirname, '../out/icon');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');

// 量出来的取景框（源图坐标系）。留约 10% 余量，贴着边会显得局促。
// 完整锁定版本身近似正方形，直接方裁；纯图形版是 1.84:1 的宽条，
// 方裁一定会切到下面的「通途」，所以走拍平（letterbox）——补底色，不拉伸。
const BG = '#f3ede3'; // 从源图左上角取的，与设计稿底色一致
const FRAMES = {
  lockup: { x: 165, y: 163, side: 700 },
  mark: { x: 225, y: 178, w: 578, h: 314 },
};

const b64 = fs.readFileSync(SRC).toString('base64');

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>', { waitUntil: 'load' });

/**
 * 把源图的一块矩形缩放进 size×size 的画布，保持比例、居中，空处补底色。
 *
 * imageSmoothingQuality='high' 是必需的：默认缩放在色块边缘会出锯齿，
 * 缩到 40px 时那些锯齿正好落在圆点轮廓上，看起来像脏点。
 */
const render = (frame, size) => page.evaluate(async ({ dataUri, f, s, bg }) => {
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const c = document.getElementById('c');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 先铺底色：宽条图形放进方画布时，上下留白必须是底色，
  // 留透明会变成「白边」，放到微信列表里就是一个白框。
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);
  const sw = f.w || f.side;
  const sh = f.h || f.side;
  const k = Math.min(s / sw, s / sh);
  const dw = sw * k;
  const dh = sh * k;
  ctx.drawImage(img, f.x, f.y, sw, sh, (s - dw) / 2, (s - dh) / 2, dw, dh);
  return c.toDataURL('image/png');
}, { dataUri: 'data:image/png;base64,' + b64, f: frame, s: size, bg: BG });

const save = (dataUri, name) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUri.split(',')[1], 'base64'));
};

save(await render(FRAMES.lockup, 512), 'icon-512.png');
save(await render(FRAMES.mark, 512), 'icon-mark-512.png');
// 144 档直接从源图重采样，不是把 512 再压一次——二次缩放会多掉一层锐度
save(await render(FRAMES.lockup, 144), 'icon-144.png');
save(await render(FRAMES.mark, 144), 'icon-mark-144.png');

// 对照图：同一张图放四个真实尺寸，只用它判断小尺寸能不能认
const cells = async (frame, label) => {
  const items = [];
  for (const s of [128, 80, 40, 26]) items.push({ s, uri: await render(frame, s) });
  return `<div class="row"><div class="lb">${label}</div>${items.map((o) =>
    `<div class="cell"><img src="${o.uri}" width="${o.s}" height="${o.s}"><span>${o.s}px</span></div>`
  ).join('')}</div>`;
};

const previewPage = await browser.newPage();
await previewPage.setViewport({ width: 860, height: 460, deviceScaleFactor: 2 });
await previewPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#f5f7f9;font:12px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#6c7a86}
  .row{display:flex;align-items:flex-end;gap:36px;padding:20px 34px 6px}
  .lb{width:120px;color:#3d4a55;font-size:13px;padding-bottom:24px}
  .cell{text-align:center}
  .cell img{display:block;border-radius:22%;margin:0 auto 8px;box-shadow:0 1px 3px rgba(16,30,40,.10)}
</style></head><body>
${await cells(FRAMES.lockup, '完整锁定版')}
${await cells(FRAMES.mark, '纯图形版')}
</body></html>`, { waitUntil: 'load' });
await previewPage.screenshot({ path: path.join(OUT, 'preview.png'), fullPage: true });
await previewPage.close();

await browser.close();

for (const f of ['icon-512.png', 'icon-mark-512.png', 'icon-144.png', 'icon-mark-144.png', 'preview.png']) {
  console.log(`✓ ${f.padEnd(20)} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1)} KB`);
}
