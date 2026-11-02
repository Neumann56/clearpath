import { track } from '/js/app.js';
import { renderReport } from '/js/report-view.js';

const report = JSON.parse(window.__REPORT__ || 'null');
const root = document.querySelector('.rp');

function paint(branchId) {
  if (!report) return;
  const wrap = document.querySelector('main.wrap');
  const tmp = document.createElement('div');
  tmp.innerHTML = renderReport(report, { branchId });
  wrap.replaceChild(tmp.firstElementChild, document.querySelector('.rp'));
  // 切换后保持滚动位置，并把当前视图标签置顶显示
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', async (e) => {
  // 手风琴：同时只开一条
  const toggle = e.target.closest('[data-action=toggle-row]');
  if (toggle) {
    const id = toggle.dataset.target;
    const detail = document.querySelector(`[data-detail="${id}"]`);
    const opened = toggle.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.detail-row').forEach((r) => (r.hidden = true));
    document.querySelectorAll('.exp').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (!opened) {
      detail.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      track('EV_ROW_EXPAND', { lineCode: toggle.closest('tr')?.dataset.line || id });
    }
    return;
  }

  const sw = e.target.closest('[data-action=switch-branch]');
  if (sw) {
    const to = sw.dataset.branch;
    const from = report.viewBranch || report.branches?.find((b) => b.isDefault)?.branchId;
    if (to === from) return;
    track('EV_BRANCH_SWITCH', { from, to });
    paint(to);
    return;
  }

  if (e.target.closest('[data-action=export]')) {
    const r = await fetch(`/api/report/${report.reportId}/export`, { method: 'POST' });
    const d = await r.json();
    track('EV_EXPORT', { format: 'json+snapshot' });
    alert(
      d.ok
        ? `存档件已生成（含报告 + 参数快照哈希 + 分支快照）：\n${d.path}\n\n文件名与页脚带分支标识；争议时以首版存档为准。`
        : '导出失败'
    );
    return;
  }

  if (e.target.closest('[data-action=print]')) track('EV_PRINT', { format: 'print' });
  if (e.target.closest('[data-action=calibrate]')) track('EV_CALIBRATE_UPLOAD', { stage: 'open' });
});

// 首屏埋点：EV_REPORT_VIEW 已由服务端记录，这里补一次前端交互信号
const dual = document.querySelector('[data-basis=landedCost]');
dual?.addEventListener('mouseenter', () => track('EV_DUAL_BASIS_HOVER', {}), { once: true });
