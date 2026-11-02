/**
 * 老周的对话通道。两种实现，页面不用关心走哪种。
 *
 *   direct 档 —— wx.request + enableChunked，边生成边显示（要基础库 2.20.2+）
 *   proxy  档 —— 云函数同步等模型说完，一次性返回
 *
 * 为什么 proxy 档不能流式：`wx.cloud.callFunction` 是一问一答的，
 * 没有 SSE 通道能把增量推回小程序端。所以云函数在服务端把整段话收完再返回，
 * 界面上就是"停顿一下，然后整段出现"。这是真实限制，不假装有打字机效果。
 */

const { MODE, LLM } = require('../config.js');

/** ArrayBuffer → UTF-8 字符串。不能只做 String.fromCharCode：
 *  SSE 里全是中文，按字节转字符会得到一堆乱码，而且看不出来是编码问题。 */
function utf8(buf) {
  const b = new Uint8Array(buf);
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i += 1;
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
      i += 2;
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f));
      i += 3;
    } else {
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      const s = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (s >> 10), 0xdc00 + (s & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function streamDirect(messages, onDelta) {
  const { BASE_URL } = require('../config.js');
  return new Promise((resolve, reject) => {
    let acc = '';
    let buf = '';
    let done = false;

    const task = wx.request({
      url: BASE_URL + LLM.path,
      method: 'POST',
      enableChunked: true,
      timeout: 60000,
      header: { 'content-type': 'application/json', 'x-wb-webapp-access-key': LLM.key },
      data: { model: LLM.model, messages, stream: true, temperature: 0.6 },
      success() {
        if (done) return;
        done = true;
        resolve(acc);
      },
      fail(err) {
        if (done) return;
        done = true;
        reject(new Error('连不上模型：' + ((err && err.errMsg) || '未知原因')));
      },
    });

    // 基础库低于 2.20.2 时 requestTask 上没有这个方法。
    // 这时候必须 abort，否则请求还在跑，用户会看到长久转圈。
    if (typeof task.onChunkReceived !== 'function') {
      done = true;
      if (task && typeof task.abort === 'function') task.abort();
      reject(new Error('当前微信版本不支持流式接收'));
      return;
    }

    task.onChunkReceived(function (res) {
      buf += utf8(res.data);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          if (!done) {
            done = true;
            resolve(acc);
          }
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (d && d.content) {
            acc += d.content;
            onDelta(acc);
          }
        } catch (e) {
          // 分片边界切断了 JSON，等下一片补齐；这里静默跳过是对的
        }
      }
    });
  });
}

function viaCloud(messages) {
  const { CLOUD } = require('../config.js');
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(new Error('这个微信版本不支持云开发'));
      return;
    }
    if (!CLOUD.envId) {
      reject(new Error('还没填云开发环境 ID（config.js 的 CLOUD.envId）'));
      return;
    }
    wx.cloud.callFunction({
      name: CLOUD.fn,
      data: { action: 'llm', model: LLM.model, messages },
      success(res) {
        const r = res && res.result;
        if (!r || !r.ok) {
          reject(new Error((r && r.message) || '云函数没返回内容'));
          return;
        }
        resolve(r.text || '');
      },
      fail(e) {
        reject(new Error('云函数没调通：' + ((e && e.errMsg) || '未知原因')));
      },
    });
  });
}

/**
 * 说一句话。onDelta(累计文本) 在流式档会被反复调用；非流式档只在最后调一次。
 * 返回完整文本。
 */
function say(messages, onDelta) {
  if (MODE === 'proxy') {
    return viaCloud(messages).then((text) => {
      if (onDelta) onDelta(text);
      return text;
    });
  }
  if (MODE === 'mock') return Promise.reject(new Error('离线演示模式'));
  return streamDirect(messages, onDelta || function () {});
}

module.exports = { say, utf8 };
