/**
 * 通途小程序 · 唯一配置点。
 *
 * **导入微信开发者工具后，第一件事是看这个文件。**
 * 整个包只在这里决定"数据从哪儿来"，其它文件一律不许写死地址。
 *
 * ─────────────────────────────────────────────────────────
 * MODE 三档，改一个字母就整套切换：
 *
 *   'direct'  —— 小程序直接请求后端 REST。
 *                开发者工具里勾了「不校验合法域名」就能跑，http 也行。
 *                **正式版不能用**：微信要求 https + 已备案域名。
 *
 *   'proxy'   —— 经云函数转发。小程序端只调 wx.cloud.callFunction，
 *                云函数在服务端再去请求后端。
 *                **这条路不需要备案域名，也不需要 https**
 *                ——因为微信的「request 合法域名」只约束小程序端自己发起的
 *                网络请求，云开发通道不受该白名单约束。
 *                想让陌生用户真的用上，就得走这档。
 *
 *   'mock'    —— 一个请求都不发，只读 utils/demo.js 里的示例单。
 *                评审现场断网、或者后端挂了，切到这档仍能演示完整流程。
 *                代价是所有数字都是样例，首页会挂黄条说明。
 *
 * ─────────────────────────────────────────────────────────
 * 切到 'proxy' 要补两样东西（缺一个会在首页直接告诉你缺哪个，不会白屏）：
 *   1. 微信开发者工具里点「云开发」开通，拿到环境 ID，填进 CLOUD.envId
 *   2. 右键 cloudfunctions/apiProxy → 上传并部署（云端安装依赖）
 */

const MODE = 'direct';

/** 后端地址。direct 档用它；proxy 档是云函数在用，小程序端碰不到。 */
const BASE_URL = 'http://47.123.4.136:8080';

/** 云开发。只有 MODE === 'proxy' 时才读。 */
const CLOUD = {
  envId: '', // 例：'tantu-3gxxxxxxxxxx'
  fn: 'apiProxy',
};

/** 老周的模型通道。direct 档经后端 /.cloud/ 同源转发，不暴露 key 给浏览器端的跨域限制。 */
const LLM = {
  path: '/.cloud/llm/chat/completions',
  key: 'wbpk_xzALIWOaSl9ZyFGLoP0YE0_rV733Xt23PWq0FwvBuXARvlqYdPExNWe',
  model: 'deepseek-v4.1-flash',
};

module.exports = { MODE, BASE_URL, CLOUD, LLM };
