// 通途 · 到岸成本预演（微信小程序）
const { MODE, BASE_URL } = require('./config.js');

App({
  globalData: {
    mode: MODE,
    baseUrl: BASE_URL,
    // 参数版本与覆盖数字在 utils/store.js 里读写，这里只做内存缓存位
    paramsVersion: '',
    coverage: null,
    // 上一次失败的请求留在这里，页面可以显示"为什么连不上"而不是干等
    lastError: '',
  },

  onLaunch() {
    // 设备号：报告按设备隔离，小程序没有 cookie 自动往返，靠这个头。
    // 只生成一次并持久化，否则每次进来历史都是空的。
    let did = wx.getStorageSync('tt_did');
    if (!did || !/^[A-Za-z0-9-]{8,40}$/.test(did)) {
      did = 'mp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
      wx.setStorageSync('tt_did', did);
    }

    // 冷启动时顺手把参数版本拉下来。不做任何阻断——
    // 拿不到就空着，页面各自有兜底，不该因为一个版本号卡住开场。
    this.pingVersion();
    this.watchUpdate();
  },

  pingVersion() {
    const self = this;
    wx.request({
      url: BASE_URL + '/healthz',
      method: 'GET',
      timeout: 6000,
      success(res) {
        const b = res && res.data;
        if (b && b.paramsVersion) {
          self.globalData.paramsVersion = b.paramsVersion;
          const store = require('./utils/store.js');
          store.paramsVersion(b.paramsVersion);
        }
      },
      fail(e) {
        self.globalData.lastError = (e && e.errMsg) || 'healthz 失败';
      },
    });
  },

  /**
   * 小程序有灰度更新机制：用户装着旧包时，新版本在后台下好了也不会自动生效。
   * 不接这个回调，常见现象是"我明明发了新版，他们看到的还是老的"，
   * 而且这种问题只在真机上出现，开发者工具里永远正常。
   */
  watchUpdate() {
    if (!wx.getUpdateManager) return;
    const um = wx.getUpdateManager();
    um.onUpdateReady(function () {
      wx.showModal({
        title: '有新版本',
        content: '更新后更准一些。现在重启就到新版本。',
        confirmText: '重启',
        success(r) {
          if (r.confirm) um.applyUpdate();
        },
      });
    });
  },
});
