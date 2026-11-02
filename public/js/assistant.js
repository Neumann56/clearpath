// 通途 AI 助手「老周」：外贸业务经理。
// 只做三件事——解释报告里的数、把用户的话翻译成表单字段、把单据图片读成表单字段。
// 不算数；也不替人"猜"图上的数字。
import {
  reportSystemPrompt,
  FORM_SYSTEM_PROMPT,
  GENERAL_SYSTEM_PROMPT,
  generalSystemPrompt,
  SUGGEST_REPORT,
  SUGGEST_FORM,
  SUGGEST_GENERAL,
  FORM_FIELD_LABELS,
} from './assistant-prompt.js';
import { DOC_SYSTEM_PROMPT, adjudicate, peerCandidates, FORM_FIELD_LABELS as DOC_LABELS } from './doc-intake.js';
import { isSafeChatLink } from './product-map.js';

// 云服务（免密钥 LLM）的宿主。它的 publishableKey 带来源白名单：
// 托管域名和 localhost 能直连，换成自建服务器（IP / 自有域名）会 403 access_denied，
// 而且是浏览器端就挡掉了，服务端日志里一个字都没有。
const CLOUD_HOST = 'https://clearpath-duty.app.workbuddy.host';

/** 当前来源在白名单里就直连；不在就走本站的 /.cloud/ 同源转发（见 server.js）。 */
function cloudEndpoint() {
  const h = location.hostname;
  const allowed = location.origin === CLOUD_HOST || h === 'localhost' || h === '127.0.0.1' || h === '::1';
  return allowed ? CLOUD_HOST : location.origin;
}

const CFG = {
  endpoint: cloudEndpoint(),
  publishableKey: 'wbpk_xzALIWOaSl9ZyFGLoP0YE0_rV733Xt23PWq0FwvBuXARvlqYdPExNWe',
  cdn: 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js',
  modelPref: ['deepseek-v4.1-flash', 'glm-5.3', 'hunyuan-chat'],
  // 读图必须用能看图的模型。目录里没有 vision 标记（缺标记 ≠ 不支持），
  // 下面这几个是实测能读出图上数字的，按"读数稳"排序：
  // deepseek 最保守（图上没有就留空），glm-5v 更容易把"买方是公司"推断成 B2B。
  visionA: ['deepseek-v4.1-flash', 'glm-5v-turbo', 'kimi-k2.5'],
  visionB: ['glm-5v-turbo', 'kimi-k2.5', 'hy4-preview'],
  maxHistory: 16,
  // 长边压到 1600：再大模型也看不清更多，只是把请求拖慢
  maxSide: 1600,
  maxBytes: 12 * 1024 * 1024,
};

/** 报告页贴图提问时的补充规则：图只当旁证，读不清就得说读不清。 */
const IMAGE_QA_RULE = `【用户发了图】
用户可能贴的是税单、货代回复、报关回执或者聊天截图，想让你结合这票解释。
- 图上的数字只当旁证，不要拿它去覆盖报告里已经算好的金额；真对不上，就说"图上这个数和报告里的 X 不一样，可能是口径或时点不同"，并指出差多少。
- 图上看不清、或者压根没写的信息，直接说看不到，不要猜。
- 不要因为图上有数就做加减得出新结论，算数交给引擎。`;

/** 通用模式下贴图：手上没有这票的数，不能假装能算，要把人带到能算的地方去。 */
const IMAGE_GENERAL_RULE = `【用户发了图，但你手上没有这票的数据】
- 先说清图上是什么（发票 / 装箱单 / 报关单 / 询价截图 / 看着不像单据）。
- 是单据就把能明确读到的关键信息念给他：品名、HS 编码、数量、金额、日期。读不清的地方直接说读不清，不要给一个"看起来对"的数字。
- 然后告诉他：要算这票，去「新预演」页把这张图再发一次，我会直接把表单填好。不要在这里估税。
- 一张单上有多个品名、多个 HS 编码时，说明"一票一编码，得拆成几票分别算"。
- 不做任何加减。`;

const root = document.getElementById('tt-assistant');
if (root) boot(root);

function boot(host) {
  const raw = host.dataset.context;
  const mode = raw === 'form' ? 'form' : raw === 'report' ? 'report' : 'general';
  const report = (() => {
    try {
      return window.__REPORT__ ? JSON.parse(window.__REPORT__) : null;
    } catch {
      return null;
    }
  })();

  const storeKey = `tt.assistant.${mode}.${report?.reportId || 'new'}`;
  const state = { cloud: null, model: null, busy: false, controller: null, sdkFailed: false, warming: null };

  let history = [];
  try {
    history = JSON.parse(sessionStorage.getItem(storeKey) || '[]');
  } catch {
    history = [];
  }
  const persist = () => {
    try {
      const slim = history
        .slice(-CFG.maxHistory)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 3000) }));
      sessionStorage.setItem(storeKey, JSON.stringify(slim));
    } catch {
      /* 隐私模式下忽略 */
    }
  };

  host.innerHTML = renderShell(mode);
  const $ = (s) => host.querySelector(s);
  const msgs = $('.ta-msgs');
  const form = $('.ta-form');
  const input = $('.ta-text');
  const sendBtn = $('.ta-send');
  const stopBtn = $('.ta-stop');
  const fileInput = $('.ta-file');
  const attachBtn = $('.ta-attach');
  const preview = $('.ta-preview');

  // 待发送的图片（只留在内存里，不写 sessionStorage —— 单据图片不该被顺手缓存下来）
  let shot = null;

  paintHistory();
  paintSuggestions();
  setStatus('idle');

  // ---------- 外壳 ----------
  $('.ta-fab').addEventListener('click', () => {
    const open = host.classList.toggle('open');
    if (open) {
      input.focus();
      warmup();
    }
  });
  $('.ta-close').addEventListener('click', () => host.classList.remove('open'));

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) takeImage(f);
  });

  // 截图直接粘进来是外贸场景里最顺手的路径
  input.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const f = item.getAsFile();
    if (f) takeImage(f);
  });

  // 拖进来
  const panel = $('.ta-panel');
  panel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    panel.classList.add('dragging');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
  panel.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    panel.classList.remove('dragging');
    if (!f) return;
    e.preventDefault();
    takeImage(f);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (state.busy) return;
    if (!text && !shot) return;
    input.value = '';
    if (shot) {
      const s = shot;
      shot = null;
      askWithImage(s, text);
    } else {
      ask(text);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  stopBtn.addEventListener('click', () => {
    state.controller?.abort();
  });

  // ---------- 单据图片 ----------
  $('.ta-thumb-x').addEventListener('click', () => {
    shot = null;
    preview.hidden = true;
    sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() && !shot;
  });

  /** 解码 → 缩放 → 重新编码。压完通常 100–300KB，够模型看清，也不拖慢请求。 */
  async function compress(file) {
    const bmp = await decode(file);
    const w0 = bmp.width || bmp.naturalWidth;
    const h0 = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, CFG.maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // 透明 PNG 直接转 JPEG 会变成黑底，先铺一层白
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    let q = 0.82;
    let url = canvas.toDataURL('image/jpeg', q);
    // 请求体别失控：超过约 1.5MB 就降质量重来
    while (url.length > 2_000_000 && q > 0.4) {
      q -= 0.12;
      url = canvas.toDataURL('image/jpeg', q);
    }
    return url;
  }

  async function decode(file) {
    if (window.createImageBitmap) {
      try {
        // from-image：手机拍的图带 EXIF 方向，不按它转会把发票拍倒
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        /* 老浏览器退回 <img> */
      }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  async function takeImage(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      push('bot', '这个格式我读不了。截图、拍照的 JPG 或 PNG 都行；iPhone 的 HEIC 请先在相册里转成 JPG 再发。', 'note');
      return;
    }
    if (file.size > CFG.maxBytes) {
      push('bot', `这张图 ${(file.size / 1048576).toFixed(1)}MB，太大了，传上去也看不清。截小一点或者重拍一张再来。`, 'note');
      return;
    }
    try {
      const dataUrl = await compress(file);
      shot = { dataUrl, name: file.name || '粘贴的截图', bytes: Math.round((dataUrl.length * 3) / 4) };
      $('.ta-thumb').src = dataUrl;
      $('.ta-thumb-name').textContent = shot.name;
      $('.ta-thumb-size').textContent = `${Math.round(shot.bytes / 1024)} KB · 长边压到 ${CFG.maxSide}`;
      preview.hidden = false;
      sendBtn.disabled = false;
      input.focus();
    } catch {
      push('bot', '这张图我打不开，换一张试试？', 'note');
    }
  }

  function pushUserImage(s, note) {
    msgs.querySelector('.ta-chips')?.remove();
    const div = document.createElement('div');
    div.className = 'ta-msg ta-user ta-user-img';
    div.innerHTML = `<img src="${s.dataUrl}" alt="单据">${note ? `<span>${esc(note)}</span>` : ''}`;
    msgs.appendChild(div);
    scrollToEnd();
    return div;
  }

  /**
   * 拿一组候选模型挨个试，取第一个能读出 JSON 的。前面那个看不了图就换下一个。
   * 必须回报"实际用的是哪个"：第二家要据此避开同名模型，否则交叉核对自己跟自己核，永远一致。
   */
  async function extractOnce(models, dataUrl, signal) {
    let lastErr = null;
    for (const model of models) {
      if (signal?.aborted) break;
      try {
        let acc = '';
        const stream = state.cloud.llm.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: DOC_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: '看这张单据，把能确定的字段读出来。看不清的不要填。' },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
            },
          ],
          stream: true,
          temperature: 0.1,
          signal,
        });
        for await (const chunk of stream) {
          const d = chunk.choices?.[0]?.delta;
          if (d?.content) acc += d.content;
        }
        const parsed = parseLooseJson(acc);
        if (parsed) return { data: parsed, model };
        lastErr = new Error('E_BAD_JSON');
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        // 这个模型看不了图（request_invalid_parameter）或暂时不可用，换下一个
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async function askWithImage(s, note) {
    // 一张图是两家模型各读一次，按两次额度记
    if (!throttle(2)) return;
    pushUserImage(s, note);
    if (!(await ensureReady())) {
      push('bot', offlineText(), 'note');
      return;
    }
    // 只有录入页有表单可填。其余页面发图就当问答处理，不去填一个不存在的表单。
    if (mode !== 'form') return askReport(note, s.dataUrl);

    const bubble = push('bot', '<span class="ta-dots">正在看图…</span>', 'stream');
    state.busy = true;
    state.controller = new AbortController();
    setStatus('busy');
    try {
      const first = await extractOnce(CFG.visionA, s.dataUrl, state.controller.signal);
      if (!first) throw new Error('E_NO_VISION');
      bubble.innerHTML = '<span class="ta-dots">再让另一个模型读一遍，两边对一下…</span>';
      // 第二家必须换一个模型。第一家若降级到了备选，第二家的候选里要把它剔掉，
      // 否则就成了同一个模型自己核自己——一致是假的。
      let b = null;
      let peerModel = null;
      const altA = peerCandidates(CFG.visionB, first.model);
      if (altA.length) {
        try {
          const second = await extractOnce(altA, s.dataUrl, state.controller.signal);
          if (second) {
            b = second.data;
            peerModel = second.model;
          }
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          b = null; // 第二家挂了就退化成单模型，只填引文能核实的
        }
      }
      // 支持哪些市场由参数库决定，页面上那个国家下拉就是它的镜子。
      // 这里从 DOM 读，而不是在代码里再抄一份清单——抄一份就会忘同步（这次就忘了）。
      const countryOptions = [...document.querySelectorAll('select[name="country"] option')]
        .map((o) => o.value)
        .filter(Boolean);
      const out = adjudicate(first.data, b, countryOptions.length ? { countries: countryOptions } : {});
      out.models = { primary: first.model, secondary: peerModel };
      const put = fillForm(out.fill);
      renderDoc(out, bubble, put);
      const n = Object.keys(out.fill).length;
      history.push(
        { role: 'user', content: `[发了一张单据] ${note || ''}`.trim() },
        { role: 'assistant', content: out.notDoc ? '这张看不出是外贸单据' : `从单据里填了 ${n} 项，另有 ${out.confirm.length} 项等你确认` }
      );
      persist();
    } catch (err) {
      const kind = classify(err);
      bubble.classList.remove('ta-stream');
      if (kind === 'aborted') {
        bubble.innerHTML = '<p>（已停止）</p>';
      } else if (String(err?.message) === 'E_NO_VISION') {
        bubble.className = 'ta-msg ta-bot ta-note';
        bubble.innerHTML =
          '<p>眼下能用的几个模型都看不了图，这次没用上。你可以直接用文字告诉我：国家、货值、数量、什么时候报关，我照样能填。</p>';
      } else {
        bubble.classList.add('ta-err');
        bubble.innerHTML = errorText(kind);
      }
    } finally {
      state.busy = false;
      state.controller = null;
      setStatus(state.model ? 'idle' : 'offline');
    }
  }

  function seenText(seen) {
    return (
      {
        invoice: '这是一张发票',
        packing_list: '这是一张装箱单',
        customs: '这是一份报关单',
        inquiry: '这是客户的询价',
      }[seen] || '这张单据'
    );
  }

  function showVal(field, v) {
    if (v == null || v === '') return '—';
    if (field === 'fob' || field === 'freight' || field === 'qty') {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
      const [i, f] = s.split('.');
      return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
    }
    if (field === 'hsCode') {
      const d = String(v);
      return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.');
    }
    return String(v);
  }

  function whyText(c) {
    if (c.reason === 'conflict') return '两个模型读出来的不一样，你点一个对的';
    if (c.reason === 'single') return '只有一个模型读出来，你确认一下';
    if (c.reason === 'inferred') return '发票上不会印这个，是根据买方看出来的，你确认一下';
    if (c.reason === 'no_evidence') return '读到了，但图上找不到原话';
    if (c.reason === 'weak_evidence') return '读到的数和图上的原话对不上';
    if (c.reason === 'rejected') return `这个值不像真的${c.got ? `（读到 ${c.got}）` : ''}`;
    return '需要你确认';
  }

  function confirmRow(c) {
    const label = DOC_LABELS[c.field] || c.field;
    if (!c.candidates.length) {
      return `<div class="ta-cand-row" data-field="${esc(c.field)}"><b>${esc(label)}</b><span class="ta-cand-why">${esc(whyText(c))}</span></div>`;
    }
    const btns = c.candidates
      .map(
        (v) =>
          `<button type="button" class="ta-cand" data-pick="${esc(c.field)}" data-val="${esc(String(v))}">${esc(showVal(c.field, v))}</button>`
      )
      .join('<span class="ta-or">/</span>');
    return `<div class="ta-cand-row" data-field="${esc(c.field)}"><b>${esc(label)}</b>${btns}<span class="ta-cand-why">${esc(whyText(c))}</span></div>`;
  }

  function renderDoc(out, bubble, put) {
    state.lastDoc = out;
    if (out.notDoc) {
      bubble.className = 'ta-msg ta-bot ta-note';
      bubble.innerHTML =
        '<p>这张我看不出是外贸单据。发票、装箱单、报关单、客户询价的截图都行 —— 也可能是拍得太糊了，重拍一张试试。</p><p class="ta-note-line">也可以直接用文字说：发哪个国家、货值多少、多少件、什么时候报关。</p>';
      return;
    }
    // 面板上说"填了"的，必须真的进了表单。不一致就如实说，不能让用户以为已经填好。
    const written = new Set(put || []);
    const filled = Object.keys(out.fill).filter((f) => written.has(DOC_LABELS[f]) || written.has(f));
    const parts = [];
    parts.push(
      `<p>${esc(seenText(out.seen))}。${
        filled.length
          ? '能对上的我先填进去了，每一项后面都附了图上的原话，你扫一眼对不对。'
          : '图上能确定的字段不多，下面列出来的都需要你补。'
      }</p>`
    );
    if (filled.length) {
      parts.push(`<p class="ta-ok">已填 ${filled.length} 项</p>`);
      parts.push(
        `<ul class="ta-ev">${filled
          .map(
            (f) =>
              `<li><b>${esc(DOC_LABELS[f] || f)}</b><span class="ta-ev-v">${esc(showVal(f, out.fill[f]))}</span><q class="ta-ev-q">${esc(
                out.fillEvidence[f]
              )}</q></li>`
          )
          .join('')}</ul>`
      );
    }
    if (out.multiLine) {
      const codes = out.multiLine.codes.map((c) => esc(showVal('hsCode', c))).join('、');
      parts.push(
        `<div class="ta-multi"><p><b>这张单有 ${out.multiLine.count} 行、${out.multiLine.codes.length} 个 HS 编码。</b>` +
          `一票只能对一个编码，所以我没把编码和数量合起来填——合出来的是一个不存在的品名，税率会用错。</p>` +
          `<p class="ta-note-line">读到：${codes}。要算准，按品名拆成 ${out.multiLine.codes.length} 票分别试算。</p>` +
          `<p><a class="ta-link" href="/quote/batch">去批量试算，一次贴几行</a></p></div>`
      );
    }
    if (out.confirm.length) {
      parts.push(
        `<div class="ta-confirm"><p class="ta-miss">这 ${out.confirm.length} 项我没把握，没敢填（读错了会把整份报告算错）：</p>${out.confirm
          .map(confirmRow)
          .join('')}</div>`
      );
    }
    if (out.missing.length) {
      // 多品名时编码和数量是"故意不填"，不能并进"图上没有"
      const miss = out.multiLine ? out.missing.filter((m) => m !== 'hsCode' && m !== 'qty') : out.missing;
      if (miss.length) {
        parts.push(`<p class="ta-note-line">图上没有：${miss.map((m) => esc(DOC_LABELS[m] || m)).join('、')}</p>`);
      }
    }
    // 读到了却没进表单，必须说出来，不能让人以为已经填好
    const lost = Object.keys(out.fill).length - filled.length;
    if (lost > 0) {
      parts.push(`<p class="ta-miss">有 ${lost} 项读到了但页面上没找到对应的输入框，请你手动补一下。</p>`);
    }
    if (out.single) parts.push('<p class="ta-note-line">这次只有一个模型能用上，所以我把关得紧一些。</p>');
    else parts.push('<p class="ta-note-line">这张图我让两个模型各读了一遍，只有两边读数一致、且图上能找到原话的，我才填。</p>');
    // 多品名那句已经在上面的提示卡里说过了，不重复
    const restNotes = out.multiLine ? out.notes.filter((n) => !/行.*个不同的 HS 编码/.test(n)) : out.notes;
    if (restNotes.length) parts.push(`<p class="ta-note-line">${restNotes.map(esc).join('；')}</p>`);
    bubble.innerHTML = parts.join('');
  }

  function acceptCandidate(btn) {
    const field = btn.dataset.pick;
    const raw = btn.dataset.val;
    const v = ['fob', 'freight', 'qty'].includes(field) ? Number(raw) : raw;
    fillForm({ [field]: v });
    const row = btn.closest('.ta-cand-row');
    if (row) {
      row.innerHTML = `<b>${esc(DOC_LABELS[field] || field)}</b><span class="ta-cand-why ta-ok">已按你选的填上：${esc(
        showVal(field, v)
      )}</span>`;
    }
  }

  msgs.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      acceptCandidate(pick);
      return;
    }
    const chip = e.target.closest('[data-q]');
    if (chip && !state.busy) ask(chip.dataset.q);
    const faq = e.target.closest('[data-faq]');
    if (faq) ask(faq.dataset.faq);
  });

  // ---------- SDK ----------
  function loadSdk() {
    if (window.WorkBuddyCloud) return Promise.resolve(true);
    if (state.sdkFailed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = CFG.cdn;
      s.async = true;
      s.onload = () => resolve(!!window.WorkBuddyCloud);
      s.onerror = () => {
        state.sdkFailed = true;
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }

  async function warmup() {
    if (state.model || state.sdkFailed) return;
    if (state.warming) return state.warming;
    state.warming = (async () => {
      const ok = await loadSdk();
      if (!ok) {
        setStatus('offline');
        state.sdkFailed = true;
        return;
      }
      try {
        state.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
          endpoint: CFG.endpoint,
          publishableKey: CFG.publishableKey,
        });
        const models = (await state.cloud.llm.models.list()) || [];
        const usable = models.filter((m) => m.disabled !== true);
        if (!usable.length) {
          setStatus('nomodel');
          return;
        }
        const byPref = CFG.modelPref.map((id) => usable.find((m) => m.id === id)).find(Boolean);
        state.model = (byPref || usable[0]).id;
        setStatus('idle');
      } catch (err) {
        setStatus(classify(err));
      } finally {
        state.warming = null;
      }
    })();
    return state.warming;
  }

  // ---------- 提问 ----------
  function throttle(n = 1) {
    const now = Date.now();
    state.stamps = (state.stamps || []).filter((t) => now - t < 60_000);
    if (state.stamps.length + n > 8) {
      push('bot', '问得有点快，歇一分钟再问 —— 后台额度是按次数算的（识一张图算两次）。', 'note');
      return false;
    }
    for (let i = 0; i < n; i++) state.stamps.push(now);
    return true;
  }

  async function ask(text) {
    if (!throttle()) return;
    if (mode === 'form') return askForm(text);
    return askReport(text);
  }

  /** 上一轮命中的外贸常识主题。用户接着说"那这个怎么弄"时要靠它接住。 */
  let kbIds = [];

  /**
   * 当前能算哪些市场/品类。
   *
   * 现取不写死：参数库每加一个国家它就过期，而过期的清单比没有清单更坏——
   * 用户问"能算越南吗"，照旧清单说不能，这单可能就丢了。
   * 取不到就留 null，prompt 里不注入，老周会退化成"你去下拉里看"。
   */
  let coverage = null;
  if (mode === 'general') {
    Promise.all([
      fetch('/api/meta/countries').then((r) => r.json()).catch(() => null),
      fetch('/api/meta/hs').then((r) => r.json()).catch(() => null),
      fetch('/healthz').then((r) => r.json()).catch(() => null),
    ])
      .then(([cr, hr, hz]) => {
        const cn = (cr?.countries || []).filter((c) => c.entryEnabled).map((c) => `${c.name}${c.code}`);
        const cats = (hr?.results || []).filter((x) => x.inKb).map((x) => x.name);
        if (cn.length) coverage = { countries: cn, categories: cats, asOf: hz?.paramsVersion || '' };
      })
      .catch(() => {});
  }

  /** 闲聊/报告两种问答共用一条流式链路，只换 system prompt。 */
  function qaBase(question, facts = null) {
    if (mode !== 'general') return reportSystemPrompt(report);
    const { prompt, ids } = generalSystemPrompt(question || '', kbIds, coverage, facts);
    kbIds = ids;
    return prompt;
  }

  /**
   * 问服务端要"这票的已知事实"。
   *
   * 只读接口，不打模型、不花额度。任何失败都返回 null：预取挂了不该让对话报错，
   * 退化成纯常识回答就行（"手上没有这票的数就不许给数"那条硬规则还在兜底）。
   * 2.5 秒超时是防服务端卡住把首字拖到十几秒——那种卡顿在演示里最致命。
   */
  async function prefetchFacts(question) {
    const q = String(question || '').trim();
    if (q.length < 4) return null;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 2500) : null;
    try {
      const r = await fetch('/api/assistant/prefetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: ac ? ac.signal : undefined,
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (d && d.kind === 'facts') return d.facts;
      // 品名对上多个编码时不替用户选，让老周反问是哪一种
      if (d && d.kind === 'ambiguous' && d.candidates?.length) {
        const names = d.candidates.map((c) => `${c.name}（${c.hs}）`).join('、');
        return { 歧义: `「${d.country?.name || '这个国家'}」方向能对上多个品类：${names}。先问清是哪一种，不要替他挑。` };
      }
      return null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function ensureReady() {
    if (!state.model && !state.sdkFailed) await warmup();
    return !!state.model;
  }

  async function askReport(text, img) {
    push('user', text || '看一下这张图');
    // 预取与模型预热并行：预取只是一次本地查表，不该额外拉长首字时间
    const [ready, facts] = await Promise.all([
      ensureReady(),
      mode === 'general' && !img ? prefetchFacts(text) : Promise.resolve(null),
    ]);
    if (!ready) {
      push('bot', offlineText(), 'note');
      return;
    }
    const bubble = push('bot', '', 'stream');
    const base = qaBase(text, facts);
    const sys = img ? `${base} \n\n${mode === 'general' ? IMAGE_GENERAL_RULE : IMAGE_QA_RULE}` : base;
    const ctx = history.slice(-CFG.maxHistory).map((h) => ({ role: h.role, content: h.content }));
    const userContent = img
      ? [
          { type: 'text', text: text || '看看这张图，跟这票有什么关系。' },
          { type: 'image_url', image_url: { url: img, detail: 'high' } },
        ]
      : text;
    let acc = '';
    state.busy = true;
    state.controller = new AbortController();
    setStatus('busy');
    try {
      const stream = state.cloud.llm.chat.completions.create({
        model: state.model,
        messages: [{ role: 'system', content: sys }, ...ctx, { role: 'user', content: userContent }],
        stream: true,
        temperature: 0.6,
        signal: state.controller.signal,
      });
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) {
          acc += d.content;
          bubble.innerHTML = renderText(acc);
          scrollToEnd();
        }
      }
      if (!acc.trim()) {
        bubble.textContent = '我这边没接上话，你再说一遍试试。';
        bubble.classList.add('ta-note');
      } else {
        history.push({ role: 'user', content: text }, { role: 'assistant', content: acc });
        persist();
      }
    } catch (err) {
      const kind = classify(err);
      if (kind === 'aborted') {
        bubble.innerHTML = renderText(acc || '（已停止）');
        if (acc) {
          history.push({ role: 'user', content: text }, { role: 'assistant', content: acc });
          persist();
        }
      } else {
        bubble.innerHTML = renderText(acc) + errorText(kind);
        bubble.classList.add('ta-err');
      }
    } finally {
      state.busy = false;
      state.controller = null;
      setStatus(state.model ? 'idle' : 'offline');
      sendBtn.disabled = false;
    }
  }

  async function askForm(text) {
    push('user', text);
    if (!(await ensureReady())) {
      push('bot', offlineText(), 'note');
      return;
    }
    const bubble = push('bot', '<span class="ta-dots">正在识别…</span>', 'stream');
    state.busy = true;
    state.controller = new AbortController();
    setStatus('busy');
    let acc = '';
    try {
      const stream = state.cloud.llm.chat.completions.create({
        model: state.model,
        messages: [
          { role: 'system', content: FORM_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        stream: true,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        signal: state.controller.signal,
      });
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) acc += d.content;
      }
      const parsed = parseLooseJson(acc);
      if (!parsed || !parsed.fields) {
        bubble.textContent = '我没听明白这句，换个说法再试一次？比如「500 台散热器发匈牙利，货值 4.8 万美金」。';
        bubble.classList.add('ta-note');
      } else {
        const filled = fillForm(parsed.fields);
        const missing = (parsed.missing || []).filter(Boolean);
        const notes = (parsed.notes || []).filter(Boolean);
        bubble.innerHTML = formReplyHtml(parsed.say, filled, missing, notes);
        history.push({ role: 'user', content: text }, { role: 'assistant', content: parsed.say || '已识别' });
        persist();
      }
    } catch (err) {
      const kind = classify(err);
      bubble.innerHTML = kind === 'aborted' ? '（已停止）' : errorText(kind);
      if (kind !== 'aborted') bubble.classList.add('ta-err');
    } finally {
      state.busy = false;
      state.controller = null;
      setStatus(state.model ? 'idle' : 'offline');
    }
  }

  function fillForm(fields) {
    const el = document.querySelector('form.form-grid') || document.querySelector('main form');
    const done = [];
    const inputs = el?.elements;
    for (const [k, v] of Object.entries(fields || {})) {
      if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
      if (k === 'channel') {
        const btn = document.querySelector(`.seg button[data-v="${cssEsc(String(v))}"]`);
        if (btn) {
          btn.click();
          done.push('渠道');
        }
        continue;
      }
      const field = inputs && inputs[k];
      if (field && 'value' in field) {
        field.value = String(v);
        if (FORM_FIELD_LABELS[k]) done.push(FORM_FIELD_LABELS[k]);
      }
    }
    el?.dispatchEvent(new Event('input', { bubbles: true }));
    el?.dispatchEvent(new Event('change', { bubbles: true }));
    return done;
  }

  // ---------- 渲染 ----------
  function paintHistory() {
    if (!history.length) {
      msgs.innerHTML =
        mode === 'form'
          ? `<div class="ta-hint">把客户的询盘直接粘给我，或者说个大概，我帮你填。有发票、装箱单的话，点「单据」或者直接 Ctrl+V 粘进来。看不准的地方我不会瞎填，会留空问你。</div>`
          : mode === 'report'
            ? `<div class="ta-hint">这票我看过了。哪块拿不准直接问 —— 关税怎么算的、现金缺口为什么这么大、232 会不会落到你头上，都行。数我只照着报告说，不自己编。</div>`
            : `<div class="ta-hint">我是老周，干外贸十二年。这套工具怎么用、两个口径为什么不能相加、什么单子容易算不准，都可以问我。<br>要算具体某一票，去「新预演」，有发票直接拍照或粘给我。</div>`;
      return;
    }
    msgs.innerHTML = history.map((h) => `<div class="ta-msg ta-${h.role}">${renderText(h.content)}</div>`).join('');
    scrollToEnd();
  }

  function paintSuggestions() {
    const list = mode === 'form' ? SUGGEST_FORM : mode === 'report' ? SUGGEST_REPORT : SUGGEST_GENERAL;
    msgs.insertAdjacentHTML(
      'beforeend',
      `<div class="ta-chips">${list.map((s) => `<button type="button" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`
    );
  }

  function push(who, text, cls) {
    msgs.querySelector('.ta-chips')?.remove();
    const div = document.createElement('div');
    div.className = `ta-msg ta-${who}${cls ? ' ta-' + cls : ''}`;
    div.innerHTML = renderText(text);
    msgs.appendChild(div);
    scrollToEnd();
    return div;
  }

  function scrollToEnd() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setStatus(k) {
    // 生成中不允许被预热/降级流程改写状态，否则"停止"按钮会闪掉、外部误判为已结束
    if (state.busy && k !== 'busy') return;
    stopBtn.hidden = k !== 'busy';
    host.dataset.state = k;
    const badge = $('.ta-state');
    const map = { idle: '', busy: '正在想…', offline: '离线', nomodel: '模型不可用', auth: '未授权', quota: '额度用完', gateway: '服务暂不可用' };
    if (badge) badge.textContent = map[k] || '';
  }

  function formReplyHtml(say, filled, missing, notes) {
    const parts = [];
    if (say) parts.push(`<p>${esc(say)}</p>`);
    if (filled.length) parts.push(`<p class="ta-ok">已填：${filled.map(esc).join('、')}</p>`);
    if (missing.length) parts.push(`<p class="ta-miss">还差：${missing.map((m) => esc(FORM_FIELD_LABELS[m] || m)).join('、')}</p>`);
    if (notes.length) parts.push(`<p class="ta-note-line">${notes.map(esc).join('；')}</p>`);
    if (!parts.length) parts.push('<p>这句我没拆出可用信息，补充一下国家和货值？</p>');
    return parts.join('');
  }
}

// ---------- 错误与降级 ----------
function classify(err) {
  if (!err) return 'gateway';
  if (err.name === 'AbortError') return 'aborted';
  const code = String(err?.error?.code || '');
  if (code.startsWith('auth_')) return 'auth';
  if (code.startsWith('quota_')) return 'quota';
  if (code.startsWith('request_')) return 'request';
  if (code.startsWith('gateway_') || code.startsWith('model_')) return 'gateway';
  return 'gateway';
}

function errorText(kind) {
  const map = {
    auth: '<p class="ta-err-line">这台机器还没被授权调用 AI（可能是访问地址不是发布域名）。下面几个常见问题我先给你答了。</p>',
    quota: '<p class="ta-err-line">今天的 AI 额度用完了，明天再来。下面几个常见问题可以先看。</p>',
    request: '<p class="ta-err-line">这次提问没能发出去，换个说法再试一次。</p>',
    gateway: '<p class="ta-err-line">模型服务这会儿不稳，稍后再问一次。下面几个常见问题先顶一下。</p>',
  };
  return `<div class="ta-fallback">${map[kind] || map.gateway}${faqHtml()}</div>`;
}

function offlineText() {
  return `<p class="ta-err-line">现在连不上 AI（可能断网，或者浏览器拦了外部脚本）。下面几个问题是不用联网也能答的。</p><div class="ta-fallback">${faqHtml()}</div>`;
}

function faqHtml() {
  const faq = [
    ['真实成本和需备现金，到底看哪个？', '真实成本算的是这单赚不赚，需备现金算的是清关时要先垫多少钱。两个数永远不能相加，也不能互相替代。'],
    ['为什么报告里没有"总计"？', '因为把钱加在一起没有意义：可退的增值税要先垫但会退回来，反倾销保证金也是先交后退。加总出来的数既不是成本也不是现金。'],
    ['待核项是什么？', '是还没核实、但会影响金额的事实。报告按"不计入"处理，同时告诉你万一成立会多出多少钱。'],
    ['这个数能直接拿去报关吗？', '不能。我们不做申报，最终口径在货代和报关行手里。这份报告是给你判断要不要接单、要不要先备钱用的。'],
    ['HS 编码我拿不准怎么办？', '先按最可能的编码算一版，同时让货代或报关行书面确认。编码差一位，税率和管制条件都可能变。'],
  ];
  return `<p class="ta-faq-title">常见问题</p>${faq
    .map(([q, a]) => `<div class="ta-faq"><b>${esc(q)}</b><span>${esc(a)}</span></div>`)
    .join('')}`;
}

// ---------- 工具 ----------
// 站内链接白名单，和"指路规矩"一起放在 product-map.js 里——
// 规则和校验分成两处，迟早会漂移。
function renderText(s) {
  const raw = String(s == null ? '' : s);
  return esc(raw)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]{1,40})\]\((\/[^)\s]{0,300})\)/g, (m, text, path) => {
      if (!isSafeChatLink(path)) return m; // 不安全就原样留着，绝不变链接
      return `<a class="ta-go" href="${path}">${text}</a>`;
    })
    .replace(/\n/g, '<br>');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function parseLooseJson(text) {
  if (!text) return null;
  const t = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function renderShell(mode) {
  const isForm = mode === 'form';
  const isReport = mode === 'report';
  const sub = isForm ? ' · 帮你填表' : isReport ? ' · 已看过这票' : ' · 有问必答';
  const ph = isForm
    ? '拍张发票发我，或者直接说：500 台散热器发匈牙利，货值 4.8 万美金'
    : isReport
      ? '比如：这个现金缺口为什么这么大'
      : '比如：真实成本和要备现金，为什么要分两个数';
  return `
<button class="ta-fab" type="button" aria-label="问业务经理">
  <span class="ta-fab-avatar">周<i class="ta-fab-dot"></i></span>
  <span class="ta-fab-body">
    <b class="ta-fab-text">问老周</b>
    <small>外贸 12 年</small>
  </span>
</button>
<section class="ta-panel" role="dialog" aria-label="外贸业务经理">
  <header class="ta-head">
    <span class="ta-avatar">周</span>
    <div class="ta-who">
      <b>老周</b>
      <small>外贸业务经理 · 12 年${sub}</small>
    </div>
    <span class="ta-state"></span>
    <button class="ta-close" type="button" aria-label="关闭">×</button>
  </header>
  <div class="ta-msgs"></div>
  <form class="ta-form">
    <div class="ta-preview" hidden>
      <img class="ta-thumb" alt="待识别的单据">
      <div class="ta-thumb-meta"><b class="ta-thumb-name"></b><span class="ta-thumb-size"></span></div>
      <button class="ta-thumb-x" type="button" aria-label="移除这张图">×</button>
    </div>
    <textarea class="ta-text" rows="2" placeholder="${ph}"></textarea>
    <div class="ta-actions">
      <button class="ta-attach" type="button" title="上传发票 / 装箱单 / 报关单">单据</button>
      <button class="ta-stop" type="button" hidden>停止</button>
      <button class="ta-send" type="submit">发送</button>
    </div>
    <input class="ta-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
  </form>
</section>`;
}
