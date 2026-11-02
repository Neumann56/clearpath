// 移动端（/m）的交互。按 body[data-page] 分发，一个文件管五个页面。
//
// 为什么不用 PC 那套 assistant.js：那是给右下角浮窗写的（多带一个 DOM 容器、
// 拖拽、图片回填、三模式切换）。手机上只要"一条对话流 + 一个输入条"，
// 硬套过来会有大半代码永远不执行，反而更难懂。
import { generalSystemPrompt } from './assistant-prompt.js';
import { isSafeChatLink } from './product-map.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** 设备号：微信内置浏览器对 cookie 不稳，带个 header 兜底（服务端 cookie 优先，无 cookie 才用它） */
const DID = (() => {
  const k = 'tt_mp_did';
  let v = localStorage.getItem(k);
  if (!v || !/^[A-Za-z0-9-]{8,40}$/.test(v)) {
    v = 'mp-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(k, v);
  }
  return v;
})();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-device-id': DID, ...(opts.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || '请求失败');
    err.code = body && body.code;
    err.payload = body;
    throw err;
  }
  return body;
}

const go = (url) => {
  location.href = url;
};

function toast(text, ms = 2200) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `position:fixed;z-index:99;left:50%;bottom:96px;transform:translateX(-50%);
    max-width:80%;padding:10px 15px;border-radius:10px;font-size:13.5px;line-height:1.5;
    background:rgba(20,26,31,.92);color:#fff;text-align:center;transition:opacity .2s`;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ============================ 首页 ============================ */

function initHome() {
  const ta = $('#nl');
  const goBtn = $('#go');
  const hint = $('#parseHint');
  if (!ta || !goBtn) return;

  for (const c of $$('#chips .chip')) {
    c.addEventListener('click', () => {
      ta.value = c.dataset.fill || '';
      ta.focus();
    });
  }

  let busy = false;
  goBtn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      toast('先用一句话说清这票货');
      return;
    }
    if (busy) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = '正在读…';
    hint.hidden = true;
    try {
      const out = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text }) });
      const d = out.draft || {};
      const q = new URLSearchParams();
      for (const k of ['country', 'hsCode', 'fob', 'freight', 'qty', 'channel', 'declarationDate']) {
        if (d[k] !== undefined && d[k] !== null && d[k] !== '') q.set(k, d[k]);
      }
      // 编码有多种可能时不替用户选，带到录入页让他自己定
      if (Array.isArray(out.candidates) && out.candidates.length > 1) {
        q.set('ambiguous', '1');
      }
      go(`/m/new?${q.toString()}`);
    } catch (e) {
      hint.hidden = false;
      hint.textContent = e.message || '没能读懂这句话，换成逐项填也一样快。';
      hint.style.color = 'var(--red)';
      goBtn.disabled = false;
      goBtn.textContent = '试算这票货';
      busy = false;
    }
  });
}

/* ============================ 录入 ============================ */

function initNew() {
  const form = $('#qf');
  if (!form) return;

  const el = (id) => document.getElementById(id);
  const countryText = el('countryText');
  const sheet = el('sheetMask');
  const submitBtn = el('submitBtn');
  const est = el('est');

  let channel = ($$('#segChannel button.on')[0] || {}).dataset?.v || '';
  let chargesMode = ($$('#segCharges button.on')[0] || {}).dataset?.v || '';

  // ---- 国家弹层 ----
  countryText.addEventListener('click', () => {
    sheet.classList.add('on');
  });
  el('sheetX').addEventListener('click', () => sheet.classList.remove('on'));
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.classList.remove('on');
  });
  for (const op of $$('.sheet-op', sheet)) {
    op.addEventListener('click', () => {
      countryText.value = op.dataset.name || '';
      countryText.dataset.code = op.dataset.code || '';
      sheet.classList.remove('on');
      scheduleEstimate();
    });
  }

  // ---- 品类快捷 ----
  for (const c of $$('#hsChips .chip')) {
    c.addEventListener('click', () => {
      el('hsCode').value = c.dataset.hs || c.dataset.name || '';
      $$('#hsChips .chip').forEach((x) => (x.style.background = ''));
      c.style.background = 'var(--brand-soft)';
      scheduleEstimate();
    });
  }

  // ---- 分段控件 ----
  for (const seg of $$('.seg')) {
    for (const b of $$('button', seg)) {
      b.addEventListener('click', () => {
        $$('button', seg).forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        if (seg.id === 'segChannel') channel = b.dataset.v || '';
        if (seg.id === 'segCharges') chargesMode = b.dataset.v || '';
        scheduleEstimate();
      });
    }
  }

  // ---- 收集 ----
  function collect() {
    const num = (id) => {
      const v = el(id)?.value;
      if (v === '' || v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const input = {
      country: countryText.dataset.code || '',
      hsCode: (el('hsCode').value || '').trim(),
      fob: num('fob'),
      freight: num('freight'),
      qty: num('qty'),
      channel,
      dates: {},
    };
    const dd = el('declarationDate').value;
    if (dd) input.dates.declarationDate = dd;
    const ed = el('exportDate')?.value;
    if (ed) input.dates.exportDate = ed;
    const ins = num('insurance');
    if (ins !== null) input.insurance = ins;
    const mc = num('metalContentPct');
    if (mc !== null) input.metalContentPct = mc;
    const ar = num('areaSqm');
    if (ar !== null) input.areaSqm = ar;
    if (chargesMode) input.chargesMode = chargesMode;
    return input;
  }

  /** 必填齐了才试算。缺项时返回缺哪几项，而不是一句「还差 N 项」。 */
  function missingOf(input) {
    const miss = [];
    if (!input.country) miss.push('目的国');
    if (!input.hsCode) miss.push('HS 编码或品名');
    if (!input.fob || input.fob <= 0) miss.push('FOB 货值');
    if (input.freight === null || input.freight < 0) miss.push('运费（没有就填 0）');
    if (!input.qty || input.qty <= 0) miss.push('数量');
    if (!input.channel) miss.push('渠道');
    if (!input.dates.declarationDate) miss.push('申报日期');
    return miss;
  }

  let timer = null;
  function scheduleEstimate() {
    clearTimeout(timer);
    timer = setTimeout(estimate, 420);
  }

  let lastEst = null;
  async function estimate() {
    const input = collect();
    const miss = missingOf(input);
    if (miss.length) {
      est.innerHTML = `<span style="color:var(--muted)">还差：${miss.join('、')}</span>`;
      return;
    }
    try {
      const out = await api('/api/quote/precheck', { method: 'POST', body: JSON.stringify({ input }) });
      const e = out.expected;
      if (!e) {
        est.innerHTML = '<span style="color:var(--amber)">这票算不出数，提交后看原因</span>';
        lastEst = null;
        return;
      }
      lastEst = out;
      est.innerHTML = `<span>真实成本 <b>${money(e.landedCost)}</b></span><span>需备现金 <b>${money(e.cashRequired)}</b></span>`;
    } catch (e2) {
      // 试算是辅助，失败不该打断录入——只在底部提示一句，用户仍可直接提交
      est.innerHTML = `<span style="color:var(--muted)">暂时估不出来，可以直接提交</span>`;
    }
  }

  for (const id of ['hsCode', 'fob', 'freight', 'qty', 'declarationDate']) {
    el(id)?.addEventListener('input', scheduleEstimate);
    el(id)?.addEventListener('change', scheduleEstimate);
  }

  let submitting = false;
  submitBtn.addEventListener('click', async () => {
    if (submitting) return;
    const input = collect();
    const miss = missingOf(input);
    if (miss.length) {
      toast(`还差：${miss.join('、')}`);
      return;
    }
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '正在算…';
    try {
      const report = await api('/api/quote', { method: 'POST', body: JSON.stringify({ input }) });
      go(`/m/report/${report.reportId}`);
    } catch (e) {
      // 服务端说的是人话，直接显示；不改成"计算失败，请重试"把原因吃掉
      toast(e.message || '没算成，检查一下填的数');
      submitBtn.disabled = false;
      submitBtn.textContent = '算出这票的账';
      submitting = false;
    }
  });

  if ($('#ambiguous')) toast('这个编码有多种可能，请确认后再提交');
  estimate();
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  const s = Math.abs(n).toFixed(2);
  const [i, f] = s.split('.');
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
}

/* ============================ 看懂外贸 ============================ */

function initLearn() {
  for (const card of $$('.vcard[data-watch]')) {
    card.addEventListener('click', async () => {
      const url = card.dataset.watch || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast('链接已复制，粘到浏览器打开');
      } catch {
        // 微信内置浏览器常把 clipboard 关掉，退化成可选中展示
        toast(url, 4000);
      }
    });
  }
}

/* ============================ 老周 ============================ */

const CLOUD_HOST = 'https://clearpath-duty.app.workbuddy.host';
const PUB_KEY = 'wbpk_xzALIWOaSl9ZyFGLoP0YE0_rV733Xt23PWq0FwvBuXARvlqYdPExNWe';
const CDN = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const MODEL_PREF = ['deepseek-v4.1-flash', 'glm-5.3', 'hunyuan-chat'];

const OFFLINE = `现在连不上 AI（网络或者额度的问题），但这几个不用联网也能答：

· FOB 是离岸价，只管货上了船；CIF 加了海运费和保险。报价前先问清客户要哪个术语。
· 可退的进口增值税只占现金、不进成本，把它当成本算，毛利会被虚减。
· 反倾销、301、232 这几类措施会互斥，不是简单叠加，要看申报日和商品范围。

等在网的时候再问我具体的数。`;

const session = { cloud: null, model: '', warming: null, history: [], busy: false };

function cloudEndpoint() {
  const h = location.hostname;
  const allowed = location.origin === CLOUD_HOST || h === 'localhost' || h === '127.0.0.1' || h === '::1';
  return allowed ? CLOUD_HOST : location.origin;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('E_SDK_LOAD'));
    document.head.appendChild(s);
  });
}

async function warmup() {
  if (session.cloud) return true;
  if (session.warming) return session.warming;
  session.warming = (async () => {
    try {
      if (!window.WorkBuddyCloud) await loadScript(CDN);
      session.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cloudEndpoint(),
        publishableKey: PUB_KEY,
      });
      const models = (await session.cloud.llm.models.list()) || [];
      const usable = models.filter((m) => m.disabled !== true);
      if (!usable.length) throw new Error('E_NO_MODEL');
      const pref = MODEL_PREF.map((id) => usable.find((m) => m.id === id)).find(Boolean);
      session.model = (pref || usable[0]).id;
      return true;
    } catch {
      session.cloud = null;
      session.warming = null;
      return false;
    }
  })();
  return session.warming;
}

function initChat() {
  const log = $('#log');
  const ta = $('#q');
  const send = $('#send');
  if (!log || !ta || !send) return;

  const scroll = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  function add(cls, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${cls}`;
    const bub = document.createElement('div');
    bub.className = 'bub';
    bub.textContent = text;
    wrap.appendChild(bub);
    log.appendChild(wrap);
    scroll();
    return bub;
  }

  /** 只放行站内路径与 http(s)，渲染前过一遍白名单——不信任模型给的 href */
  function renderRich(text) {
    return text.split(/(\[[^\]]+\]\([^)]+\))/g).map((seg) => {
      const m = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!m) return document.createTextNode(seg);
      const [, label, href] = m;
      if (!isSafeChatLink(href)) return document.createTextNode(label);
      const a = document.createElement('a');
      a.textContent = label;
      a.href = href;
      return a;
    });
  }

  function setBubble(bub, text) {
    bub.textContent = '';
    for (const node of renderRich(text)) bub.appendChild(node);
  }

  let kbIds = [];
  async function ask(question) {
    if (session.busy) return;
    const q = String(question || '').trim();
    if (!q) return;
    session.busy = true;
    send.disabled = true;
    ta.value = '';
    add('user', q);

    const bub = add('bot', '');
    bub.textContent = '…';

    // 事实预取和模型预热并行：预取只要几十毫秒，等它再热模型就白白多花两秒
    const [factsRes, ok] = await Promise.all([
      api('/api/assistant/prefetch', { method: 'POST', body: JSON.stringify({ question: q }) })
        .catch(() => null),
      warmup(),
    ]);

    if (!ok) {
      bub.textContent = OFFLINE;
      session.busy = false;
      send.disabled = false;
      scroll();
      return;
    }

    const facts = factsRes && factsRes.kind === 'facts' ? factsRes.facts : null;
    const sys = generalSystemPrompt(q, kbIds, null, facts);
    kbIds = sys.ids || [];

    let acc = '';
    try {
      const stream = session.cloud.llm.chat.completions.create({
        model: session.model,
        messages: [
          { role: 'system', content: sys.prompt },
          ...session.history.slice(-8),
          { role: 'user', content: q },
        ],
        stream: true,
        temperature: 0.6,
      });
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) {
          acc += d.content;
          setBubble(bub, acc);
          scroll();
        }
      }
      if (!acc.trim()) {
        bub.textContent = '我这边没接上话，你再说一遍试试。';
      } else {
        session.history.push({ role: 'user', content: q }, { role: 'assistant', content: acc });
      }
    } catch {
      bub.textContent = acc.trim() ? acc + '\n\n（说到一半断了）' : OFFLINE;
    } finally {
      session.busy = false;
      send.disabled = false;
      scroll();
    }
  }

  send.addEventListener('click', () => ask(ta.value));
  ta.addEventListener('keydown', (e) => {
    // 手机上回车就是换行，不抢；桌面上 Ctrl/Cmd+Enter 发送
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ask(ta.value);
    }
  });
  for (const c of $$('#chips .chip')) {
    c.addEventListener('click', () => ask(c.dataset.q || c.textContent));
  }

  // 进页面就预热，用户真正提问时能少等一到两秒；失败无所谓，提问时会再试
  warmup();
}

/* ============================ 启动 ============================ */

const PAGE = document.body.dataset.page;
if (document.querySelector('#nl')) initHome();
if (document.querySelector('#qf')) initNew();
if (document.querySelector('.vcard[data-watch]')) initLearn();
if (document.querySelector('#log')) initChat();

window.addEventListener('pageshow', () => {
  // 从报告页返回时恢复底部按钮态（部分浏览器会把 disabled 状态带回来）
  const b = document.getElementById('submitBtn');
  if (b) {
    b.disabled = false;
    b.textContent = '算出这票的账';
  }
});
