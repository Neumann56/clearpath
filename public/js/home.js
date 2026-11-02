import { $, $$, track } from '/js/app.js';

const nl = $('#nl');
const go = $('#go');

$$('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    nl.value = c.dataset.fill;
    nl.focus();
  })
);

nl?.addEventListener('input', () => track('EV_QUOTE_START', { entryMode: 'nl' }), { once: true });

go?.addEventListener('click', async () => {
  const text = nl.value.trim();
  if (!text) {
    nl.focus();
    return;
  }
  go.disabled = true;
  go.textContent = '解析中…';
  try {
    const r = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    sessionStorage.setItem('tt_parse', JSON.stringify({ text, ...d }));
    const q = new URLSearchParams();
    if (d.draft.country) q.set('country', d.draft.country);
    if (d.draft.hsCode) q.set('hsCode', d.draft.hsCode);
    if (d.draft.fob) q.set('fob', d.draft.fob);
    if (d.draft.freight) q.set('freight', d.draft.freight);
    if (d.draft.qty) q.set('qty', d.draft.qty);
    if (d.draft.channel) q.set('channel', d.draft.channel);
    if (d.draft.declarationDate) q.set('declarationDate', d.draft.declarationDate);
    location.href = '/quote/new?' + q.toString();
  } catch {
    go.disabled = false;
    go.textContent = '试试看';
  }
});
