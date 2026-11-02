// 「看懂外贸」视频栏目的交互层。
//
// 只做一件事：点开才加载播放器。
//
// 为什么不做成页面一打开就嵌 12 个 iframe：
// 1. 12 个第三方播放器 = 12 组外部请求，首屏和内存都撑不住，而且会拖慢整站
// 2. 这个产品要能断网演示。预加载的播放器断网后就是一片白，连目录都看不清
// 3. 用户点的是"这一条"，不是"全部"
//
// 同一时刻只留一个播放器：切到另一条时把上一条卸掉，不然声音会重叠，
// 而且十几条同时缓冲，公司网络里的其他人就别想用了。

const ONLINE_HINT = 'learnOffline';

function setOnlineHint() {
  const el = document.getElementById(ONLINE_HINT);
  if (!el) return;
  // 只在断网时说一句，联网时不打扰
  el.hidden = navigator.onLine !== false;
}

function makeFrame(src, title) {
  const f = document.createElement('iframe');
  f.className = 'lv-frame';
  f.src = src;
  f.title = title || '视频播放器';
  f.setAttribute('frameborder', '0');
  f.setAttribute('scrolling', 'no');
  f.setAttribute('allowfullscreen', 'true');
  f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
  // 播放器里是别人的页面，权限给到最小：能播、能全屏，别的一概不给
  f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
  return f;
}

function resetPlayer(box) {
  const frame = box.querySelector('.lv-frame');
  if (frame) frame.remove();
  const collapse = box.querySelector('.lv-collapse');
  if (collapse) collapse.remove();
  box.classList.remove('is-playing');
  const cover = box.querySelector('.lv-cover');
  if (cover) cover.style.display = '';
  const btn = box.querySelector('.lv-play');
  if (btn) btn.style.display = '';
  const dur = box.querySelector('.lv-dur');
  if (dur) dur.style.display = '';
}

function collapseAll(except) {
  document.querySelectorAll('[data-player]').forEach((box) => {
    if (box !== except) resetPlayer(box);
  });
}

function play(box, btn) {
  const src = btn.dataset.src;
  if (!src) return;

  if (navigator.onLine === false) {
    setOnlineHint();
    return;
  }

  collapseAll(box);

  const cover = box.querySelector('.lv-cover');
  if (cover) cover.style.display = 'none';
  btn.style.display = 'none';
  const dur = box.querySelector('.lv-dur');
  if (dur) dur.style.display = 'none';

  const title = btn.getAttribute('aria-label') || '';
  box.appendChild(makeFrame(src, title));
  box.classList.add('is-playing');

  // 收起就是把播放器卸掉——停不下来，就让它消失，别留着继续放
  const cs = document.createElement('button');
  cs.type = 'button';
  cs.className = 'lv-collapse';
  cs.textContent = '收起';
  cs.addEventListener('click', () => resetPlayer(box));
  box.appendChild(cs);
}

function init() {
  setOnlineHint();
  window.addEventListener('online', setOnlineHint);
  window.addEventListener('offline', setOnlineHint);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    const box = btn.closest('[data-player]');
    if (!box) return;
    e.preventDefault();
    play(box, btn);
  });

  // 卡片封面加载失败（离线、被防盗链）时把 img 藏掉，露出底下的渐变和标题，
  // 不能留一个碎图标——那看起来像整个栏目坏了
  document.querySelectorAll('.lv-cover').forEach((img) => {
    const hide = () => img.classList.add('lv-cover-broken');
    img.addEventListener('error', hide);
    if (img.complete && img.naturalWidth === 0) hide();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
