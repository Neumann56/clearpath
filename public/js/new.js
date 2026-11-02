import { $, $$, track } from '/js/app.js';

const form = $('#quoteForm');
const hint = $('#formHint');
const submit = $('#submitBtn');
const demoBtn = $('#demoBtn');

const FIELDS = ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate'];

/** 字段变了要标在哪一栏 —— 日期错误可能出在"出口日期"，它不在 FIELDS 里 */
const LABELS = {
  country: '目的国',
  hsCode: 'HS 编码',
  fob: 'FOB 货值',
  freight: '运费',
  qty: '数量',
  channel: '渠道',
  declarationDate: '申报日期',
  exportDate: '出口日期',
};

/** 品类目录由服务端渲染时注入，跟后端认品名用的是同一份表，不另抄一份 */
const CATALOG = Array.isArray(window.__HS_CATALOG__) ? window.__HS_CATALOG__ : [];

/* ---------- 品类下拉 ----------
 * 不用原生 <datalist>：它要打一个字才展开，点框没反应，各浏览器还不一致。
 * 这里自己实现，规则和上面 rules.hsCode 一致——只负责挑，仍然允许手打编码/品名。
 */
const combo = $('.combo[data-combo="hs"]');
const comboList = combo ? combo.querySelector('.combo-list') : null;
const comboInput = combo ? combo.querySelector('input[name="hsCode"]') : null;
const comboItems = comboList ? [...comboList.querySelectorAll('li[data-hs]')] : [];
const comboEmpty = comboList ? comboList.querySelector('.combo-empty') : null;
let comboActive = -1;
/** 选中时我们自己派发 input 事件，这时不该再按"用户在打字"把列表打开一次 */
let comboPicking = false;

/** 6 位码点分显示：870891 → 8708.91（与 lib/render.js 的 hsFmt 同一口径） */
function hsFmtJs(h) {
  const d = String(h || '').replace(/\D/g, '');
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.');
}

function comboVisible() {
  return comboItems.filter((li) => !li.hidden);
}

function comboFilter(q) {
  const text = String(q || '').trim().toLowerCase();
  // 纯数字（含 8708.91 这种带点的）只按编码比：写 8708 却把"汽配"也列出来，看着像没筛
  const byCode = /^[\d.\s]+$/.test(text);
  const num = text.replace(/\D/g, '');
  let hit = 0;
  for (const li of comboItems) {
    const ok = !text
      ? true
      : byCode
        ? (li.dataset.hs || '').includes(num)
        : (li.dataset.name || '').toLowerCase().includes(text) ||
          (li.dataset.kw || '').toLowerCase().includes(text);
    li.hidden = !ok;
    li.classList.remove('on');
    if (ok) hit += 1;
  }
  if (comboEmpty) comboEmpty.hidden = hit > 0;
  comboActive = -1;
}

function comboHighlight(i, scroll) {
  comboItems.forEach((li) => li.classList.remove('on'));
  comboActive = i;
  if (i < 0) return;
  const li = comboItems[i];
  if (!li) return;
  li.classList.add('on');
  if (scroll && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
}

function comboOpen() {
  if (!combo || !comboList || comboList.hidden === false) return;
  comboFilter(comboInput.value);
  comboList.hidden = false;
  combo.dataset.open = '1';
  comboInput.setAttribute('aria-expanded', 'true');
}

function comboClose() {
  if (!combo || !comboList || comboList.hidden) return;
  comboList.hidden = true;
  combo.dataset.open = '0';
  comboInput.setAttribute('aria-expanded', 'false');
  comboActive = -1;
  comboItems.forEach((li) => li.classList.remove('on'));
}

function comboChoose(li) {
  if (!li || !comboInput) return;
  // 填编码而不是品名：编码是唯一确定的，不会二次触发"归到哪一码"的判断，
  // 用户也能一眼看出自己选的是哪一条。
  comboInput.value = hsFmtJs(li.dataset.hs);
  comboClose();
  comboInput.focus();
  // onChange 要触发（表单靠它重算差项），但不能再被自己的 input 监听打开一次列表
  comboPicking = true;
  comboInput.dispatchEvent(new Event('input', { bubbles: true }));
  comboInput.dispatchEvent(new Event('change', { bubbles: true }));
  comboPicking = false;
}

if (combo && comboList && comboInput) {
  const toggle = (e) => {
    if (e) e.preventDefault();
    if (comboList.hidden) comboOpen();
    else comboClose();
  };

  comboInput.addEventListener('click', () => comboOpen());
  const comboBtn = combo.querySelector('.combo-btn');
  if (comboBtn) {
    // 按钮不能抢焦点：一抢走输入框就 blur → 列表刚开又被关掉，看着像"点了没反应"
    comboBtn.addEventListener('mousedown', (e) => e.preventDefault());
    comboBtn.addEventListener('click', toggle);
  }
  comboInput.addEventListener('input', () => {
    if (comboPicking) return;
    comboActive = -1;
    comboFilter(comboInput.value);
    if (comboList.hidden) comboOpen();
  });

  // 用 mousedown + preventDefault：先保住输入框焦点，click 才不会因为 blur 把列表关掉
  comboList.addEventListener('mousedown', (e) => e.preventDefault());
  comboList.addEventListener('click', (e) => {
    const li = e.target.closest ? e.target.closest('li[data-hs]') : null;
    if (li) comboChoose(li);
  });

  comboInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (comboList.hidden) return comboOpen();
      const vis = comboVisible();
      if (!vis.length) return;
      const at = vis.indexOf(comboItems[comboActive]);
      comboHighlight(comboItems.indexOf(vis[Math.min(at + 1, vis.length - 1)]), true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (comboList.hidden) return comboOpen();
      const vis = comboVisible();
      if (!vis.length) return;
      const at = vis.indexOf(comboItems[comboActive]);
      comboHighlight(comboItems.indexOf(vis[Math.max(at - 1, 0)]), true);
    } else if (e.key === 'Enter') {
      if (!comboList.hidden && comboActive >= 0) {
        e.preventDefault();
        comboChoose(comboItems[comboActive]);
      }
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      comboClose();
    }
  });

  comboInput.addEventListener('blur', () => comboClose());
  document.addEventListener('click', (e) => {
    if (!combo.contains(e.target)) comboClose();
  });
}

function val(name) {
  const el = form.elements[name];
  return el ? String(el.value || '').trim() : '';
}

export function collect() {
  const input = {
    country: val('country'),
    hsCode: val('hsCode'),
    fob: val('fob'),
    freight: val('freight') || 0,
    qty: val('qty'),
    channel: val('channel'),
    declarationDate: val('declarationDate'),
    exportDate: val('exportDate') || null,
    entryDate: val('entryDate') || null,
    liquidationDate: val('liquidationDate') || null,
    insurance: val('insurance') || null,
    metalContentPct: val('metalContentPct') || null,
    shipmentsPerYear: val('shipmentsPerYear') || null,
    amortizationYears: val('amortizationYears') || null,
    adDepositRate: val('adDepositPct') ? Number(val('adDepositPct')) / 100 : null,
    adFinalRate: val('adFinalPct') ? Number(val('adFinalPct')) / 100 : null,
    areaSqm: val('areaSqm') || null,
    endUserType: val('endUserType') || 'civil',
  };
  const cm = val('chargesMode');
  if (cm === 'all') input.enableCharges = true;
  else if (cm) input.enabledCharges = [cm];
  return input;
}

/**
 * 品名能不能认，判断逻辑与后端 resolveHsInput 保持一致：
 * 唯一命中才算，多个命中必须让人自己挑（猜错品类 = 用错税目）。
 */
function matchByName(text) {
  const low = text.toLowerCase();
  return CATALOG.filter((c) => (c.kw || []).some((k) => k && low.includes(String(k).toLowerCase())));
}

const rules = {
  country: (v) => (v ? null : '请选择目的国'),
  hsCode: (v) => {
    if (!v) return '请填写 HS 编码或品名';
    const d = v.replace(/\D/g, '');
    if (d.length >= 6 && d.length <= 10) return null;
    if (d.length > 0) return `HS 编码只填了 ${d.length} 位，需要 6–10 位`;
    const hits = matchByName(v);
    if (hits.length === 1) return null;
    if (hits.length > 1) {
      return `「${v}」能对上 ${hits.map((c) => c.name).join('、')}，请写清是哪个，或直接填编码`;
    }
    return CATALOG.length
      ? `没认出「${v}」，可填：${CATALOG.map((c) => c.name).join('、')}`
      : '没认出这个品名，请改填 6–10 位 HS 编码';
  },
  fob: (v) => (Number(v) > 0 ? null : '货值必须是大于 0 的数字'),
  freight: (v) => (v !== '' && Number(v) >= 0 ? null : '请填运费，可为 0'),
  qty: (v) => (Number(v) > 0 ? null : '数量必须大于 0'),
  channel: (v) => (v ? null : '请选择渠道'),
  declarationDate: (v) => (v ? null : '请填申报日期'),
};

/** 把错误挂到某一栏下面；没有该栏就只在提示条里说 */
function markField(name, err, force) {
  const el = form.elements[name];
  const field = el && el.closest ? el.closest('.field') : null;
  if (!field) return;
  const box = field.querySelector('.err');
  field.classList.toggle('invalid', !!err && force);
  if (err && force) {
    if (box) box.textContent = err;
    else {
      const d = document.createElement('div');
      d.className = 'err';
      d.textContent = err;
      field.appendChild(d);
    }
  } else if (box) box.remove();
}

/**
 * @param {boolean} show 是否把错误标红到字段上。
 *   不点击提交时也标——前提是这一栏已经有输入。
 *   一进页面就把六个空栏全部刷红，看起来像"你全填错了"。
 */
function validate(show = false) {
  const issues = [];

  for (const name of FIELDS) {
    const el = form.elements[name];
    if (!el) continue;
    const err = rules[name] ? rules[name](val(name)) : null;
    if (err) issues.push({ name, text: `${LABELS[name]}（${err}）`, short: LABELS[name] });
    // 有输入才即时标红；空栏等用户点提交或开始填了再说
    markField(name, err, show || !!val(name));
  }

  // 日期先后：出口 → 清关（放行）→ 申报，反了就是填错，不能靠猜帮他纠正
  const ex = val('exportDate');
  const decl = val('declarationDate');
  const entry = val('entryDate') || decl;
  if (ex && entry && ex > entry) {
    const against = val('entryDate') ? '放行日' : '申报日';
    const msg = `出口日期 ${ex} 晚于${against} ${entry}：货先出口、后进口清关，请检查是否填反`;
    issues.push({ name: 'exportDate', text: `出口日期（晚于${against} ${entry}）`, short: '出口日期' });
    markField('exportDate', msg, show || !!ex);
  } else {
    markField('exportDate', null, false);
  }

  submit.disabled = issues.length > 0;
  if (!issues.length) {
    hint.textContent = '必填已齐，可以进入确认';
    hint.classList.remove('warn');
  } else {
    // 只说"还差 2 项"等于让人对着六个框挨个试——必须说是哪两项
    hint.textContent = `还差 ${issues.length} 项：${issues.map((i) => i.text).join('；')}`;
    hint.classList.add('warn');
  }
  return issues.length === 0;
}

let t;
form?.addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(() => validate(false), 400);
});
form?.addEventListener('change', () => validate(false));

form?.addEventListener('submit', (e) => e.preventDefault());

demoBtn?.addEventListener('click', () => {
  const demo = {
    country: 'US', hsCode: '8708.91', fob: 48000, freight: 2400, qty: 1200, channel: 'B2B',
    declarationDate: '2026-10-20', exportDate: '2026-10-05', metalContentPct: 0.62,
  };
  for (const [k, v] of Object.entries(demo)) {
    const el = form.elements[k];
    if (el) el.value = v;
  }
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'B2B'));
  form.elements.channel.value = 'B2B';
  validate(false);
  track('EV_QUOTE_START', { entryMode: 'form' });
});

submit?.addEventListener('click', async () => {
  if (!validate(true)) return;
  const input = collect();
  sessionStorage.setItem('tt_input', JSON.stringify(input));
  track('EV_QUOTE_SUBMIT', { country: input.country, hs6: String(input.hsCode).replace(/\D/g, '').slice(0, 6), channel: input.channel, hasExportDate: !!input.exportDate });
  submit.disabled = true;
  submit.textContent = '预检中…';
  try {
    const r = await fetch('/api/quote/precheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    const d = await r.json();
    if (!r.ok) {
      // 预检没过就留在这一页说清楚：跳到确认页再报错，用户得先猜原因、再点回来改，多绕一圈
      submit.disabled = false;
      submit.textContent = '下一步：确认';
      hint.classList.add('warn');
      hint.textContent = `预检没通过：${d.message || d.code || '请检查填写内容'}`;
      // 预检自己认得出是哪个字段，就把红字挂到那一栏
      if (d.field && form.elements[d.field]) markField(d.field, d.message || '这里有问题', true);
      return;
    }
    sessionStorage.setItem('tt_precheck', JSON.stringify(d));
    location.href = '/quote/confirm';
  } catch {
    submit.disabled = false;
    submit.textContent = '下一步：确认';
    hint.textContent = '预检失败，请重试';
    hint.classList.add('warn');
  }
});

validate(false);
