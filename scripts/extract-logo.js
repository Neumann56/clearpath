/**
 * 从品牌视觉原图里量出标记的精确几何与配色。
 *
 * 跑法：node scripts/extract-logo.js
 * 产出：out/icon/logo-geometry.json
 *
 * 为什么不用肉眼估：这个标记要重画成矢量再缩到 40px，
 * 圆点半径差 2px、棒子角度差 2° 在 40px 下就会歪。
 * 直接从像素里算质心和面积，比重画时凭感觉摆点可靠得多。
 *
 * 注意：原图下方的「通途 CLEARPATH」字标也是深蓝，必须限定 y 范围排除掉，
 * 否则深蓝区域的质心会被字标拖到画面下半部分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SRC = path.resolve(
  '通途CLEARPATH品牌视觉_assets/57f7651c-miora_text_to_image-1792327518303-0-51e2a3e3b2b7.png'
);
const OUT = path.resolve('out/icon');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const require = createRequire('C:/Users/Neumann/.workbuddy/binaries/node/workspace/');
const puppeteer = require('puppeteer-core');

const b64 = fs.readFileSync(SRC).toString('base64');
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server'],
});
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>', { waitUntil: 'load' });

const geo = await page.evaluate(async (dataUri) => {
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const c = document.getElementById('c');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const W = c.width, H = c.height;
  const px = ctx.getImageData(0, 0, W, H).data;

  const at = (x, y) => {
    const i = (y * W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const hex = ([r, g, b]) =>
    '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

  // 只在标记所在的上半部分取样，避开下方字标
  const MARK_BOTTOM = Math.round(H * 0.48);

  const rules = {
    red: (r, g, b) => r > 130 && g < 90 && b < 90,
    yellow: (r, g, b) => r > 180 && g > 120 && b < 110 && r - b > 100,
    green: (r, g, b) => g > 100 && r < 110 && b < 130 && g - r > 40,
    navy: (r, g, b) => r < 70 && g < 80 && b > 45 && b < 140,
  };

  const out = { size: [W, H], markBottom: MARK_BOTTOM, bg: null, marks: {} };
  out.bg = hex(at(6, 6));

  for (const [name, test] of Object.entries(rules)) {
    let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    let sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < MARK_BOTTOM; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (!test(r, g, b)) continue;
        n++; sx += x; sy += y; sr += r; sg += g; sb += b;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    out.marks[name] = n === 0 ? null : {
      pixels: n,
      centroid: [Math.round(sx / n), Math.round(sy / n)],
      // 圆点的等效半径：面积 / π 开方。棒子不是圆，这个值对它没意义，仅供参考
      areaRadius: Math.round(Math.sqrt(n / Math.PI)),
      bbox: [minX, minY, maxX, maxY],
      color: hex([Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]),
    };
  }
  return out;
}, 'data:image/png;base64,' + b64);

await browser.close();

// 把三个圆点按 y 分上下、x 分左右，方便重画时按名字取用
const m = geo.marks;
const dots = ['red', 'yellow', 'green'].filter((k) => m[k]);
const report = {
  source: path.basename(SRC),
  canvas: geo.size,
  background: geo.bg,
  dots: Object.fromEntries(dots.map((k) => [k, {
    center: m[k].centroid,
    radius: m[k].areaRadius,
    color: m[k].color,
    bbox: m[k].bbox,
  }])),
  navy: m.navy ? { bbox: m.navy.bbox, pixels: m.navy.pixels, color: m.navy.color } : null,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'logo-geometry.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
