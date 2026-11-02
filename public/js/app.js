export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export function track(event, props = {}) {
  try {
    const body = JSON.stringify({ event, props });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
    else fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

/** 分段按钮 */
document.addEventListener('click', (e) => {
  const b = e.target.closest('.seg button');
  if (!b) return;
  const seg = b.closest('.seg');
  $$('button', seg).forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  const hidden = seg.parentElement.querySelector('input[type=hidden]');
  if (hidden) {
    hidden.value = b.dataset.v;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

export const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const s = Math.abs(Number(n)).toFixed(2);
  const [i, f] = s.split('.');
  return (Number(n) < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
};

export const pct = (n, d = 2) => `${(Number(n) * 100).toFixed(d)}%`;
