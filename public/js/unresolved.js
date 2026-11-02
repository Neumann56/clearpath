import { $ } from '/js/app.js';

const KEY_STORE = 'tt.operatorKey';

const keyOf = () => {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
};

const authHeaders = () => {
  const k = keyOf();
  return k ? { 'Content-Type': 'application/json', 'X-Operator-Key': k } : { 'Content-Type': 'application/json' };
};

const needKey = () => {
  alert('先在页面顶部的「以谁的身份操作」里选一个人。身份由服务端识别，请求里填名字不管用。');
};

// 身份选择器：存本地，页面刷新后仍是同一个人
const picker = $('#opPicker');
if (picker) {
  const saved = keyOf();
  if (saved && [...picker.options].some((o) => o.value === saved)) picker.value = saved;
  picker.addEventListener('change', () => {
    try {
      localStorage.setItem(KEY_STORE, picker.value);
    } catch {
      /* 隐私模式下不持久化，但本次仍然生效 */
    }
    location.reload();
  });
}

document.addEventListener('click', async (e) => {
  const assign = e.target.closest('[data-action=assign]');
  if (assign) {
    if (!keyOf()) return needKey();
    const id = assign.dataset.id;
    assign.disabled = true;
    const r = await fetch(`/api/unresolved/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'in_review', reason: '派单给我，今天开始核实' }),
    });
    const d = await r.json();
    assign.disabled = false;
    if (d.ok) location.reload();
    else alert(d.message || '操作失败');
    return;
  }

  const resolve = e.target.closest('[data-action=resolve]');
  if (resolve) {
    if (!keyOf()) return needKey();
    const id = resolve.dataset.id;
    const url = prompt('粘贴证据链接（公告 / 税则 / 报关回执），必填：');
    if (!url) return;
    const reason = prompt('一句话结论（支持当前取值还是要改成反事实？）') || '';
    const r = await fetch(`/api/unresolved/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'resolved', reason: reason || '已取得一手来源', evidenceUrl: url }),
    });
    const d = await r.json();
    if (d.ok) location.reload();
    else alert(d.message || '操作失败（关闭需第二人，且必须带证据）');
  }
});
