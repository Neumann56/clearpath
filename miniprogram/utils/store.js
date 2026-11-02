/**
 * 轻量全局态。**不引第三方状态库**——小程序包就 2MB，为三个字段装一套框架不值。
 *
 * 分层原则（守住这条，页面之间就不会互相污染）：
 *   页面 data     只放"这一屏要显示的东西"，离开页面就该丢
 *   storage       跨页交接 + 需要活过重启的（设备号、草稿、缓存）
 *   app.globalData 只在内存里的热点数据（覆盖数字、参数版本），重启就重拉
 *
 * 跨页交接为什么非走 storage：`wx.switchTab` **不能带 query**，
 * 传过去参数会静默消失，不报错。所以首页"一句话录入"的结果放进 tt_draft，
 * 由「预演」tab 的 onShow 取走。
 */

const CACHE_TTL = 30 * 60 * 1000; // 半小时。参数库一天最多更新一次，这个时长足够。

function getApp_() {
  try {
    return getApp();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 覆盖数字

/** 首页和录入页都要这份数据。取过一次就缓存，别每次进页面都打一遍接口。 */
function coverage() {
  const app = getApp_();
  if (app && app.globalData.coverage) return app.globalData.coverage;

  const box = wx.getStorageSync('tt_cov');
  if (box && box.at && Date.now() - box.at < CACHE_TTL && box.v) {
    if (app) app.globalData.coverage = box.v;
    return box.v;
  }
  return null;
}

function setCoverage(v) {
  const app = getApp_();
  if (app) app.globalData.coverage = v;
  try {
    wx.setStorageSync('tt_cov', { at: Date.now(), v });
  } catch (e) {
    // 存不下不影响使用，下次重拉而已
  }
}

// ---------------------------------------------------------------- 参数版本

/**
 * 参数版本变了，说明税率/规费被改过。
 * 界面不用重建，但"最近一票"这种缓存要作废，否则会显示一个已经不成立的价格。
 */
function paramsVersion(v) {
  const app = getApp_();
  if (v === undefined) return (app && app.globalData.paramsVersion) || wx.getStorageSync('tt_ver') || '';
  if (app) app.globalData.paramsVersion = v;
  const old = wx.getStorageSync('tt_ver');
  if (old && old !== v) wx.removeStorageSync('tt_last');
  wx.setStorageSync('tt_ver', v);
  return v;
}

// ---------------------------------------------------------------- 最近一票

function lastReport(r) {
  if (r === undefined) return wx.getStorageSync('tt_last') || null;
  try {
    wx.setStorageSync('tt_last', r);
  } catch (e) {
    /* 存不下就算了，首页会退回去拉接口 */
  }
  return r;
}

module.exports = { coverage, setCoverage, paramsVersion, lastReport };
