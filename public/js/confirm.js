import { $, $$, fmt, pct, track } from '/js/app.js';

const body = $('#confirmBody');
const hint = $('#confirmHint');
const btn = $('#confirmBtn');

const input = JSON.parse(sessionStorage.getItem('tt_input') || 'null');
const pre = JSON.parse(sessionStorage.getItem('tt_precheck') || 'null');
const parseInfo = JSON.parse(sessionStorage.getItem('tt_parse') || 'null');
// 预检没过的原因。旧流程会把错误存在这里再跳过来，不读它就会显示成"没有找到草稿"——
// 用户照着"没有找到草稿"去重填一遍，可真正的问题是税率没入库，怎么填都一样。
const preErr = JSON.parse(sessionStorage.getItem('tt_precheck_error') || 'null');

let chosenBranch = pre?.branches?.find((b) => b.isDefault)?.branchId || null;

function errView(code, message) {
  body.innerHTML = `<div class="bar bar-red"><b>${code}</b> ${message}</div>
  <p class="muted small" style="margin-top:12px">没有生成任何报告。改完可以重试。</p>
  <a class="btn btn-ghost" style="margin-top:8px" href="/quote/new">返回修改</a>`;
  btn.style.display = 'none';
  hint.textContent = '';
}

if (preErr) {
  sessionStorage.removeItem('tt_precheck_error');
  errView(preErr.code || 'E_PRECHECK_FAILED', preErr.message || '预检没通过，请检查填写内容。');
} else if (!input || !pre) {
  // 草稿只活在当前标签页里，这里几乎只有两种来路：直接打开了这个地址，或者按了刷新
  errView(
    'E_DRAFT_MISSING',
    '这一页要从「新预演」点「下一步」进来。草稿只存在当前标签页，直接打开或刷新都会丢，重填一遍即可。'
  );
} else if (pre.state === 'blocked') {
  body.innerHTML = `<div class="bar bar-red"><b>已阻断</b> ${pre.access?.flags?.[0]?.label || '命中禁止性规定'}。本票不出任何金额。</div>`;
  btn.textContent = '仍要生成阻断说明';
} else {
  render();
}

function render() {
  const c = pre.classification || {};
  const gaps = (pre.unresolved || []).filter((u) => u.tier === 'T2_IMPACT' || u.tier === 'T4_INTERNAL');
  const branchBlock = pre.branches
    ? `<div class="bc" style="margin-top:10px">
        <div class="bc-head">③ 双分支：同一票货算两遍，两个结果都给出</div>
        ${pre.branches
          .map(
            (b) => `<label class="bc-row ${b.isDefault ? 'is-default' : ''} ${chosenBranch === b.branchId ? 'is-active' : ''}" data-branch-row="${b.branchId}">
          <input type="radio" name="branch" value="${b.branchId}" ${chosenBranch === b.branchId ? 'checked' : ''} />
          <span class="bc-tag">${b.isDefault ? '默认' : '另一分支'}</span>
          <span class="bc-label">若 ${b.condition}，则真实成本 <b>${fmt(b.landedCost)}</b> / 需备现金 ${fmt(b.cashRequired)}</span>
        </label>`
          )
          .join('')}
        <div class="bc-delta">差额 <b>${fmt(Math.abs(pre.branches[1].landedCost - pre.branches[0].landedCost))}</b> 美元
          <span>默认分支 = 不计入未确认的措施。这是产品取舍，不是事实结论。</span></div>
      </div>`
    : '';

  body.innerHTML = `
  <div class="card" style="box-shadow:none">
    <h3>① 归类确认</h3>
    <p class="small muted">系统只给候选，不落库、不生成税率。编码错，后面全错，所以这一步必须由你定。</p>
    <div class="dual" style="grid-template-columns:repeat(2,1fr);margin-top:8px">
      <div class="dual-cell">
        <div class="dual-k">本次采用的编码</div>
        <div class="dual-v" style="font-size:18px">${c.hsCode || input.hsCode}</div>
        <div class="dual-h">${c.source === 'user_input' ? '你提供的编码' : '规则匹配候选'} · HS ${c.hsVersion || ''}</div>
      </div>
      <div class="dual-cell">
        <div class="dual-k">目的国 / 渠道</div>
        <div class="dual-v" style="font-size:18px">${input.country} · ${input.channel}</div>
        <div class="dual-h">CIF ${fmt(pre.expected?.cif || 0)} USD</div>
      </div>
    </div>
    ${
      parseInfo?.candidates?.length > 1
        ? `<div class="small muted" style="margin-top:8px">其他候选：${parseInfo.candidates
            .filter((x) => x.hsCode.replace(/\D/g, '') !== String(input.hsCode).replace(/\D/g, ''))
            .map((x) => `${x.hsCode}（${x.name}）`)
            .join('；') || '无'} <a href="/quote/new">改</a></div>`
        : ''
    }
  </div>

  <div class="card" style="box-shadow:none">
    <h3>② 待确认输入</h3>
    <p class="small muted">“我不确定”不是逃避，是产品的一等公民：它会让报告多一条缺口和一句“这条由你按保守值处理”，比瞎填一个数诚实。</p>
    <table class="tbl" style="margin-top:8px">
      <thead><tr><th>缺什么</th><th>为什么重要</th><th style="width:230px">怎么处理</th></tr></thead>
      <tbody>
      ${
        gaps.length
          ? gaps
              .map(
                (g) => `<tr>
          <td>${g.title}</td>
          <td class="small">${g.impactDisplay || '影响定性结论'}</td>
          <td>
            <a class="btn btn-sm btn-ghost" href="/quote/new">我确认（去填值）</a>
            <button class="btn btn-sm" data-action="accept-gap" data-id="${g.id}">我不确定（按保守值算）</button>
          </td>
        </tr>`
              )
              .join('')
          : '<tr><td colspan="3" class="muted">关键输入已齐，无需确认项。</td></tr>'
      }
      </tbody>
    </table>
  </div>

  <div class="card" style="box-shadow:none">
    <h3>③ 双分支选择</h3>
    ${branchBlock || '<p class="small muted">本票未命中双分支待核项（如 232 归属）。命中时这里会出现两条并列结论和差额。</p>'}
  </div>

  <div class="card" style="box-shadow:none">
    <h3>④ 假设清单预览</h3>
    <p class="small muted">这些会原样写进报告。删除任一条，该行会降级为待确认。</p>
    <ul class="small" style="margin:8px 0 0;padding-left:18px">
      ${
        (pre.assumptions || []).length
          ? pre.assumptions.map((a) => `<li>${a.field} 按 <b>${a.value}</b> 估算（${a.note}）</li>`).join('')
          : '<li class="muted">无额外假设。</li>'
      }
    </ul>
  </div>`;

  $$('input[name=branch]').forEach((r) =>
    r.addEventListener('change', () => {
      const from = chosenBranch;
      chosenBranch = r.value;
      $$('[data-branch-row]').forEach((row) => row.classList.toggle('is-active', row.dataset.branchRow === chosenBranch));
      track('EV_BRANCH_SWITCH', { from, to: chosenBranch, stage: 'confirm' });
    })
  );

  $$('[data-action=accept-gap]').forEach((b) =>
    b.addEventListener('click', () => {
      b.textContent = '已记为假设';
      b.disabled = true;
      track('EV_CONFIRM_ACK', { field: b.dataset.id, choice: 'unknown' });
    })
  );

  hint.textContent = `预检状态：${pre.state}${pre.branches ? ' · 命中双分支（T1）' : ''}`;
}

btn?.addEventListener('click', async () => {
  if (!input) return;
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const r = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, initialBranch: chosenBranch }),
    });
    const d = await r.json();
    if (!r.ok) {
      errView(d.code || 'E_QUOTE_FAILED', d.message || '生成失败');
      return;
    }
    sessionStorage.removeItem('tt_precheck');
    location.href = `/quote/${d.reportId}/report`;
  } catch {
    btn.disabled = false;
    btn.textContent = '生成报告';
    hint.textContent = '生成失败，请重试';
  }
});
