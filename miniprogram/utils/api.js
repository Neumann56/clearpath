/**
 * 请求层。**所有页面只能从这里发请求，不许自己调 wx.request。**
 *
 * 为什么必须收成一个口子：
 *   - 换通道（直连 / 云函数 / 离线）只改 config.js 一个值，页面一行不用动
 *   - 设备号只在这里生成，漏一处历史就是空的
 *   - 错误只在这里分类，页面拿到的永远是"人话 + 一个 code"
 *
 * 错误分成三类，页面按 kind 决定怎么显示，不要自己去猜 statusCode：
 *   net   连不上（域名没配 / 断网 / 服务没起）—— 提示怎么修
 *   biz   服务端明确拒绝（400/409/503）—— 原话显示，别改成"计算失败"
 *   mode  通道没配好（云开发没开通 / envId 没填）—— 说清缺什么
 */
const { MODE, BASE_URL, CLOUD } = require('../config.js');

// ---------------------------------------------------------------- 设备号

/**
 * 报告按设备隔离。小程序没有浏览器那种 cookie 自动往返，
 * 所以靠这个头自己带。**只生成一次并持久化**，否则每次进来历史都是空的。
 */
function deviceId() {
  let did = wx.getStorageSync('tt_did');
  if (!did || !/^[A-Za-z0-9-]{8,40}$/.test(did)) {
    did = 'mp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
    wx.setStorageSync('tt_did', did);
  }
  return did;
}

// ---------------------------------------------------------------- 错误

function mkErr(kind, code, message, extra) {
  const e = new Error(message);
  e.kind = kind;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const NET_MSG = '连不上服务器。检查 config.js 里的地址，以及开发者工具是否勾了「不校验合法域名」。';

// ---------------------------------------------------------------- 通道

/** 云函数返回 {status, body}，和 wx.request 的成功响应同形，后面处理逻辑就能共用。 */
function viaCloud(path, method, data) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(mkErr('mode', 'E_NO_CLOUD', '这个微信版本不支持云开发，升级微信后再试'));
      return;
    }
    if (!CLOUD.envId) {
      reject(
        mkErr('mode', 'E_NO_CLOUD_ENV', '还没填云开发环境 ID：打开 config.js 把 CLOUD.envId 补上，并把 cloudfunctions/apiProxy 上传部署')
      );
      return;
    }
    wx.cloud.callFunction({
      name: CLOUD.fn,
      data: { path, method, data: data || null, did: deviceId() },
      success(res) {
        const r = res && res.result;
        if (!r || typeof r.status !== 'number') {
          reject(mkErr('biz', 'E_CLOUD_SHAPE', '云函数没按约定返回结果，检查 apiProxy 是否部署成功'));
          return;
        }
        resolve({ statusCode: r.status, data: r.body });
      },
      fail(e) {
        reject(mkErr('net', 'E_CLOUD_FAIL', '云函数没调通：' + ((e && e.errMsg) || '未知原因')));
      },
    });
  });
}

function viaDirect(path, method, data, timeout) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      timeout,
      header: { 'content-type': 'application/json', 'x-device-id': deviceId() },
      success(res) {
        resolve(res);
      },
      fail(e) {
        reject(mkErr('net', 'E_NETWORK', NET_MSG, { raw: (e && e.errMsg) || '' }));
      },
    });
  });
}

function viaMock(path) {
  // 离线档：只有少数接口有真数据，其它一律 404，让页面自己走降级分支。
  // 这里故意不"编"一份通用响应——编出来的空对象会让页面以为成功。
  return Promise.reject(mkErr('mode', 'E_MOCK', '离线演示模式：没有联网，' + path + ' 不发请求'));
}

// ---------------------------------------------------------------- 主流程

function handle(res) {
  const body = res.data;
  if (res.statusCode >= 200 && res.statusCode < 300) return body;
  const msg = (body && (body.message || body.reason)) || '服务器返回 ' + res.statusCode;
  throw mkErr('biz', (body && body.code) || 'E_HTTP_' + res.statusCode, msg, {
    status: res.statusCode,
    payload: body,
  });
}

function once(path, method, data, timeout) {
  if (MODE === 'mock') return viaMock(path);
  const p = MODE === 'proxy' ? viaCloud(path, method, data) : viaDirect(path, method, data, timeout);
  return p.then(handle);
}

/**
 * 发请求。
 *
 * 自动重试一次，但**只对安全请求重试**：
 *   - GET 天然幂等
 *   - POST 必须显式传 idempotent: true（后端的 /api/quote 有幂等键，重发不会算两遍）
 * 不加这个限制的话，网络抖一下可能生成两份报告。
 */
function req(path, opts) {
  const o = opts || {};
  const method = o.method || 'GET';
  const timeout = o.timeout || 12000;
  const canRetry = o.retry === false ? false : method === 'GET' || o.idempotent === true;

  return once(path, method, o.data, timeout).catch((err) => {
    const retriable = err.kind === 'net' || err.code === 'E_CLOUD_FAIL';
    if (!canRetry || !retriable) throw err;
    return once(path, method, o.data, timeout);
  });
}

module.exports = {
  MODE,
  deviceId,
  get: (p, o) => req(p, Object.assign({ method: 'GET' }, o || {})),
  post: (p, data, o) => req(p, Object.assign({ method: 'POST', data }, o || {})),
  BASE_URL,
  /** 电脑版报告的完整地址。proxy/mock 档没有可对外分享的地址，返回空串。 */
  pageUrl: (p) => (MODE === 'mock' ? '' : BASE_URL + p),
};
