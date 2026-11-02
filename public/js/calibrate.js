import { $, fmt, track } from '/js/app.js';

const form = $('#calForm');
const out = $('#calOut');

const ATTR_CLASS = {
  参数错: 'red',
  输入错: 'amber',
  政策变: 'amber',
  口径理解错: 'red',
  无偏差: 'green',
  未填: '',
};

const signed = (v) => (v > 0 ? '+' : v < 0 ? '' : '') + fmt(v);
const diffClass = (v) => (Math.abs(v) < 0.01 ? '' : v > 0 ? 'neg' : 'pos');

$('#calBtn')?.addEventListener('click', async () => {
  const id = window.__REPORT_ID__;
  if (!id || !form) return;

  const val = (n) => (form.elements[n] ? form.elements[n].value : '');
  const body = {
    actualDuty: val('actualDuty'),
    actualTax: val('actualTax'),
    actualVat: val('actualVat'),
    actualCharges: val('actualCharges'),
    actualAd: val('actualAd'),
    actualEntryDate: val('actualEntryDate'),
  };

  const btn = $('#calBtn');
  btn.disabled = true;
  btn.textContent = '正在比对…';
  try {
    const r = await fetch(`/api/report/${id}/calibrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) {
      out.innerHTML = `<div class="bar bar-red">比对失败：${d.message || d.code || ''}</div>`;
      return;
    }
    track('EV_CALIBRATE_UPLOAD', { diffPct: d.landedCostDiff, attribution: d.primaryAttribution });

    const rows = d.lines
      .map((l) => {
        const cls = ATTR_CLASS[l.attribution] || '';
        return `<tr>
      <td>${l.label}</td>
      <td class="ta-r nowrap muted">${l.predictedText}</td>
      <td class="ta-r nowrap">${l.actualText}</td>
      <td class="ta-r nowrap ${diffClass(l.diff)}">${l.diff === 0 && l.key === 'entryDate' ? '—' : signed(l.diff)}</td>
      <td><span class="tag tag-${cls}">${l.attribution}</span></td>
      <td class="small">${l.note || '—'}${l.factId ? ` <a href="/demo/unresolved#${l.factId}">${l.factId}</a>` : ''}</td>
    </tr>`;
      })
      .join('');

    const queued = (d.queued || []).filter((q) => q.added);
    const dup = (d.queued || []).filter((q) => !q.added);

    out.innerHTML = `
  <table class="tbl">
    <caption>逐行对照（实缴 − 预演）</caption>
    <thead><tr><th>行</th><th class="ta-r">预演</th><th class="ta-r">实缴</th><th class="ta-r">差额</th><th>归因</th><th>依据</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="dual two" style="margin-top:16px">
    <div class="dual-cell">
      <span class="dual-k">真实成本差</span>
      <span class="dual-v ${diffClass(d.landedCostDiff)}">${signed(d.landedCostDiff)}</span>
      <span class="dual-h">实缴算出来 ${d.actualLandedCostText}</span>
    </div>
    <div class="dual-cell">
      <span class="dual-k">需备现金差</span>
      <span class="dual-v ${diffClass(d.cashRequiredDiff)}">${signed(d.cashRequiredDiff)}</span>
      <span class="dual-h">实缴算出来 ${d.actualCashRequiredText}</span>
    </div>
  </div>
  <p class="muted small" style="margin-top:8px">两个口径分开比、不相加：差额不同是正常的（可退增值税与保证金只动其中一边）。</p>

  <div class="uc" style="margin-top:16px">
    <header class="uc-head"><span class="uc-tier">这次差异的归因</span><h3>${d.primaryAttribution}</h3></header>
    <div class="uc-impact">${d.note}</div>
    <dl class="uc-dl">
      ${
        queued.length
          ? `<dt>已入复核队列</dt><dd>${queued
              .map((q) => `${q.line}（${q.id}）`)
              .join('、')}<br><span class="muted small">复核人在参数页决定是否开新版本；黄金用例不过则不许发布。</span></dd>`
          : ''
      }
      ${
        dup.length
          ? `<dt>已在队列里</dt><dd>${dup.map((q) => `${q.line}（${q.id}）`).join('、')} — 同一票同一行不重复入队</dd>`
          : ''
      }
      ${d.routedTo?.length ? `<dt>关联待核</dt><dd>${d.routedTo.map((f) => `<a href="/demo/unresolved#${f}">${f}</a>`).join('、')}</dd>` : ''}
      <dt>不会发生什么</dt><dd>这份报告的金额不会被改。参数更新只影响以后的新票。</dd>
    </dl>
  </div>
  <p class="muted small" style="margin-top:12px">${d.disclaimer}</p>`;
  } catch (e) {
    out.innerHTML = `<div class="bar bar-red">请求失败：${String(e.message || e)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '逐行比对并归因';
  }
});
