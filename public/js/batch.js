import { $, fmt, track } from '/js/app.js';

const box = $('#csvBox');
const previewBtn = $('#previewBtn');
const submitBtn = $('#submitBtn');
const hint = $('#batchHint');
const previewOut = $('#batchPreview');
const out = $('#batchOut');

let rows = [];

/**
 * 列清单必须和引擎的输入字段一一对应（lib/engine/quote.js 的 normalizeShipment）。
 * 特别注意 declarationDate：它不是 entryDate 的别名。申报日决定适用哪档税率和 AD 分支，
 * 缺了引擎直接 E_DECLARATION_DATE_REQUIRED —— 所以它是必填列，不能只在表头里放 entryDate。
 */
const HEAD = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate', 'entryDate', 'exportDate'];

/** 预览时显示的列（顺序即阅读顺序，申报日必须露出来） */
const SHOW = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate'];

const REQUIRED = ['country', 'hsCode', 'fob', 'qty', 'channel', 'declarationDate'];

const COL_CN = {
  country: '国家',
  hsCode: 'HS 编码',
  fob: '货值',
  qty: '数量',
  channel: '渠道',
  declarationDate: '申报日',
};

const ASOF = box?.dataset?.asof || '';

/** 极简 CSV：支持逗号/制表符，支持引号包裹。够用就好，不做 RFC4180 全集。 */
function splitLine(line) {
  const delim = line.includes('\t') && !line.includes(',') ? '\t' : ',';
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuote = !inQuote;
    } else if (ch === delim && !inQuote) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rows: [], errors: [] };

  let head = HEAD;
  let start = 0;
  const first = splitLine(lines[0]).map((c) => c.toLowerCase());
  if (first.some((c) => HEAD.map((h) => h.toLowerCase()).includes(c))) {
    // 认表头：按实际列序映射，允许列顺序不同
    head = first.map((c) => HEAD.find((h) => h.toLowerCase() === c) || c);
    start = 1;
  }

  const outRows = [];
  const errors = [];
  let carriedDate = '';
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const o = {};
    head.forEach((k, j) => {
      if (k) o[k] = cells[j] ?? '';
    });
    // 空缺国家沿用上一行（真实表格常见合并单元格）
    if (!o.country && outRows.length) o.country = outRows[outRows.length - 1].country;
    // 空缺申报日：先沿用上一行，再退到参数基准日；预览会把这个日期显示出来
    if (!o.declarationDate) o.declarationDate = carriedDate || ASOF;
    if (o.declarationDate) carriedDate = o.declarationDate;

    for (const k of ['fob', 'freight', 'qty']) {
      if (o[k] !== '' && o[k] !== undefined) o[k] = Number(String(o[k]).replace(/,/g, ''));
    }
    if (!o.channel && outRows.length) o.channel = outRows[outRows.length - 1].channel;

    const missing = REQUIRED.filter((k) => o[k] === '' || o[k] === undefined || o[k] === null);
    if (!missing.length && !(o.fob > 0)) missing.push('fob');
    if (!missing.length && !(o.qty > 0)) missing.push('qty');
    if (!missing.length && !['B2B', 'B2C'].includes(String(o.channel).toUpperCase())) missing.push('channel');
    if (missing.length) {
      errors.push({ line: i + 1, reason: `缺或不合法：${missing.map((k) => COL_CN[k] || k).join('、')}` });
      continue;
    }
    o.channel = String(o.channel).toUpperCase();
    outRows.push(o);
  }
  return { rows: outRows, errors };
}

function renderPreview() {
  if (!rows.length) {
    previewOut.innerHTML = '';
    submitBtn.disabled = true;
    return;
  }
  const head = SHOW;
  const body = rows
    .slice(0, 5)
    .map(
      (r) =>
        `<tr>${head
          .map((k) => `<td class="${typeof r[k] === 'number' ? 'ta-r' : ''}">${r[k] === '' || r[k] === undefined ? '<span class="muted">—</span>' : r[k]}</td>`)
          .join('')}</tr>`
    )
    .join('');
  const filled = rows.filter((r) => r.declarationDate === ASOF).length;
  previewOut.innerHTML = `
  <table class="tbl">
    <caption>预览：共 ${rows.length} 行，下面只显示前 5 行。确认后再提交。</caption>
    <thead><tr>${head.map((h) => `<th class="${h === 'fob' || h === 'freight' || h === 'qty' ? 'ta-r' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  ${filled ? `<p class="muted small" style="margin-top:8px">其中 ${filled} 行的申报日是空的，按参数基准日 ${ASOF} 处理。申报日决定适用哪档税率和 AD 分支，请确认这个日期能不能代表这几票。</p>` : ''}`;
  submitBtn.disabled = rows.length === 0;
}

previewBtn?.addEventListener('click', () => {
  const { rows: r, errors } = parseCsv(box.value);
  rows = r;
  if (errors.length) {
    hint.textContent = `解析出 ${r.length} 行，另有 ${errors.length} 行有问题（已跳过）：${errors
      .slice(0, 3)
      .map((e) => `第 ${e.line} 行 ${e.reason}`)
      .join('；')}`;
  } else {
    hint.textContent = r.length ? `解析出 ${r.length} 行，可以提交` : '没解析到数据';
  }
  renderPreview();
});

submitBtn?.addEventListener('click', async () => {
  if (!rows.length) return;
  submitBtn.disabled = true;
  submitBtn.textContent = '正在逐行试算…';
  out.innerHTML = '';
  try {
    const r = await fetch('/api/quote/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const d = await r.json();
    if (d.code) {
      out.innerHTML = `<div class="bar bar-red">${d.message || d.code}</div>`;
      return;
    }
    track('EV_QUOTE_SUBMIT', { batch: rows.length, ok: d.ok });

    const rowHtml = d.results
      .map((x) => {
        if (x.error) {
          return `<tr><td>${x.index + 1}</td><td colspan="5" class="muted">${x.error.message}</td><td><span class="tag tag-red">未出数</span></td></tr>`;
        }
        return `<tr>
        <td>${x.index + 1}</td>
        <td>${x.country || rows[x.index]?.country || '—'}</td>
        <td>${x.hsCode || rows[x.index]?.hsCode || '—'}</td>
        <td class="ta-r">${fmt(x.landedCost)}</td>
        <td class="ta-r">${fmt(x.cashRequired)}</td>
        <td><a href="/quote/${x.reportId}/report">查看报告</a></td>
        <td>${x.idempotent ? '<span class="tag tag-mid">同一票</span>' : '<span class="tag tag-green">新建</span>'}</td>
      </tr>`;
      })
      .join('');

    out.innerHTML = `
  <div class="bar ${d.failed ? 'bar-amber' : 'bar-green'}" style="margin-bottom:12px">
    成功 ${d.ok} 行${d.failed ? `，${d.failed} 行没出数（原因见下表）` : ''}。
  </div>
  <table class="tbl">
    <caption>批量结果：真实成本与需备现金分两列，不相加</caption>
    <thead><tr><th>#</th><th>国家</th><th>HS</th><th class="ta-r">真实成本</th><th class="ta-r">需备现金</th><th>报告</th><th>落库</th></tr></thead>
    <tbody>${rowHtml}</tbody>
  </table>
  <p class="muted small" style="margin-top:10px"><a href="/reports">去历史报告看这 ${d.ok} 票</a></p>`;
  } catch (e) {
    out.innerHTML = `<div class="bar bar-red">提交失败：${String(e.message || e)}</div>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交试算';
  }
});
