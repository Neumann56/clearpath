import { $ } from '/js/app.js';

const KEY_STORE = 'tt.operatorKey';
const remember = (k) => {
  try {
    localStorage.setItem(KEY_STORE, k);
  } catch {
    /* 隐私模式忽略 */
  }
};

function humanError(code, message) {
  const map = {
    E_GOLDEN_FAILED: '黄金用例没通过，已拒绝发布——线上参数一个字节都没动。',
    E_REVIEWER_IS_AUTHOR: '提案人不能自己批准，换一个人复核。',
    E_DRAFT_PUBLISHED: '这份草稿已经发布过了。',
    E_VERSION_EXISTS: '目标版本文件已存在，请换基线重新提草稿。',
    E_OPERATOR_INVALID: '操作人标识无效，刷新页面重选身份。',
    E_PATCH_KEY_NOT_FOUND: '找不到这一行参数，检查主键写法（如 US|870891）。',
    E_PATCH_BAD_COLLECTION: '不认识的参数表名。',
    E_DRAFT_EMPTY: '草稿里没有改动。',
  };
  return map[code] || message || code || '操作失败';
}

/* 生成草稿 */
const draftBtn = $('#draftBtn');
draftBtn?.addEventListener('click', async () => {
  const form = $('#draftForm');
  const out = $('#draftOut');
  if (!form) return;
  const v = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
  const key = v('author');

  if (!key) {
    out.className = 'small neg';
    out.textContent = '先选"以谁的身份提"。';
    return;
  }
  if (!v('key') || !v('field') || !v('to')) {
    out.className = 'small neg';
    out.textContent = '主键、字段、新值都要填。';
    return;
  }

  draftBtn.disabled = true;
  out.className = 'small muted';
  out.textContent = '正在生成草稿…';
  remember(key);

  try {
    const r = await fetch('/api/admin/params/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operator-Key': key },
      body: JSON.stringify({
        baseFile: v('baseFile'),
        collection: v('collection'),
        key: v('key'),
        field: v('field'),
        to: v('to'),
        note: v('note'),
      }),
    });
    const d = await r.json();
    if (!d.ok) {
      out.className = 'small neg';
      out.textContent = humanError(d.code, d.message);
      return;
    }
    out.className = 'small pos';
    out.textContent = `草稿 ${d.draft.targetVersion} 已生成（还没上线）。`;
    location.href = '/admin/params?tab=drafts';
  } catch (e) {
    out.className = 'small neg';
    out.textContent = `生成失败：${String(e.message || e)}`;
  } finally {
    draftBtn.disabled = false;
  }
});

/* 发布草稿：点下去先跑黄金用例，跑不过就不发 */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('.publish-form');
  if (!form) return;
  e.preventDefault();

  const id = form.dataset.id;
  const sel = form.elements.reviewer;
  const key = sel ? sel.value : '';
  const result = form.querySelector('.draft-result');
  const btn = form.querySelector('button');

  if (!key) {
    result.className = 'draft-result small neg';
    result.textContent = '先选复核人。';
    return;
  }

  btn.disabled = true;
  btn.textContent = '正在跑黄金用例…';
  result.className = 'draft-result small muted';
  result.textContent = '发布前会先跑黄金用例，需要几秒。';
  remember(key);

  try {
    const r = await fetch('/api/admin/params/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operator-Key': key },
      body: JSON.stringify({ draftId: id }),
    });
    const d = await r.json();
    if (!d.ok) {
      result.className = 'draft-result small neg';
      const cases = d.golden?.failedCases?.length ? `（失败：${d.golden.failedCases.slice(0, 3).join('；')}）` : '';
      result.textContent = `${humanError(d.code, d.message)}${cases}`;
      btn.disabled = false;
      btn.textContent = '发布（先跑黄金用例）';
      return;
    }
    result.className = 'draft-result small pos';
    result.textContent = `已发布 ${d.version}，黄金用例 ${d.golden.total} 项通过。刷新后生效。`;
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    result.className = 'draft-result small neg';
    result.textContent = `发布失败：${String(err.message || err)}`;
    btn.disabled = false;
    btn.textContent = '发布（先跑黄金用例）';
  }
});
