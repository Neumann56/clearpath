/**
 * 通途 · 云函数转发。
 *
 * ─────────────────────────────────────────────────────────
 * 它解决什么问题
 *
 * 微信对小程序**自己发起**的网络请求有硬约束：只能打 https、已 ICP 备案、
 * 且在小程序后台配置过「request 合法域名」的地址。
 * 通途现在的后端是 http://IP:8080 —— 正式版一个请求都发不出去。
 *
 * 但这条白名单**不管云函数**。小程序端调 wx.cloud.callFunction 走的是云开发通道，
 * 云函数在服务端再去请求后端，属于普通服务端出网，不受备案与 https 限制。
 * 于是：小程序 → 云函数（云开发通道，免域名）→ 后端（http 也可）。
 * 这是让陌生用户真的用起来的唯一快路，代价是多一跳延迟和一点云函数调用量。
 *
 * ─────────────────────────────────────────────────────────
 * 两条纪律
 *
 * 1. **路径白名单**。只放 /api/ 开头的 REST。不写白名单，这个函数就是
 *    一台对外开放的转发器，谁拿到 appid 都能拿它当代理刷别人的站。
 * 2. **不转发 cookie / Origin / Referer**。后端有些逻辑看 Origin，
 *    带上反而会被判成跨站。设备号自己带。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 后端地址。改这里，或者给云函数配环境变量 TANTU_BASE。 */
const BASE = process.env.TANTU_BASE || 'http://47.123.4.136:8080';

/** 老周的模型通道。这个 key 是 publishable 级、带来源白名单，客户端本来就有。 */
const LLM_PATH = '/.cloud/llm/chat/completions';
const ACCESS_KEY =
  process.env.WB_ACCESS_KEY || 'wbpk_xzALIWOaSl9ZyFGLoP0YE0_rV733Xt23PWq0FwvBuXARvlqYdPExNWe';

/** 只有这些前缀允许转发。 /.cloud 不在里面——它单独走 llm 分支，且要带 key。 */
const ALLOW = ['/api/'];

function bad(status, message) {
  return { status, body: { ok: false, code: 'E_PROXY', message } };
}

async function proxy(event) {
  const path = String(event.path || '');
  if (!ALLOW.some((p) => path.startsWith(p))) {
    return bad(403, '这个地址不经过转发：' + path);
  }
  // 防止 ../ 之类拼出去的怪路径
  if (path.includes('..')) return bad(400, '路径不合法');

  const method = String(event.method || 'GET').toUpperCase();
  const headers = { 'x-device-id': String(event.did || 'mp-cloud-fn') };
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(event.data || {});
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  init.signal = ctl.signal;

  try {
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      // 后端 502 之类会返回 HTML，别把 HTML 丢给小程序去 JSON.parse
      body = { ok: false, code: 'E_PROXY_BAD_BODY', message: '后端返回的不是 JSON（HTTP ' + res.status + '）' };
    }
    return { status: res.status, body };
  } catch (e) {
    return bad(502, '云函数连不上后端：' + (e && e.message ? e.message : '未知原因'));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 老周的对话。云函数同步把整段收完再返回——callFunction 是一问一答，
 * 没有通道能把增量推回小程序端，所以这里不做流式，界面上是"停顿后整段出现"。
 */
async function llm(event) {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  if (!messages.length) return { ok: false, message: '没有对话内容' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(BASE + LLM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wb-webapp-access-key': ACCESS_KEY },
      body: JSON.stringify({
        model: event.model || 'deepseek-v4.1-flash',
        messages,
        stream: true, // 这个接口只支持流式，非流式直接返 request_invalid_parameter
        temperature: 0.6,
      }),
      signal: ctl.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, message: '模型通道返回 ' + res.status + '：' + t.slice(0, 120) };
    }

    const raw = await res.text();
    let acc = '';
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') break;
      try {
        const obj = JSON.parse(payload);
        const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (d && d.content) acc += d.content;
      } catch (e) {
        /* 分片残行，跳过 */
      }
    }
    if (!acc.trim()) return { ok: false, message: '模型没有返回内容' };
    return { ok: true, text: acc };
  } catch (e) {
    return { ok: false, message: '调模型失败：' + (e && e.message ? e.message : '未知原因') };
  } finally {
    clearTimeout(timer);
  }
}

exports.main = async (event) => {
  const t0 = Date.now();
  const out = event && event.action === 'llm' ? await llm(event) : await proxy(event || {});
  return Object.assign({ ms: Date.now() - t0, base: BASE }, out);
};
