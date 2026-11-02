const api = require('../../utils/api.js');
const share = require('../../utils/share.js');

Page({
  data: {
    loading: true,
    err: '',
    groups: [],
    count: 0,
    compiledAt: '',
  },

  onLoad() {
    const self = this;
    api
      .get('/api/learn')
      .then(function (v) {
        if (!v || !v.ok) {
          self.setData({ loading: false, err: (v && v.reason) || '内容还没导进来', groups: [] });
          return;
        }
        self.setData({
          loading: false,
          err: '',
          count: v.count || 0,
          compiledAt: (v.meta && v.meta.compiledAt) || '',
          groups: self.decorate(v.groups || []),
        });
      })
      .catch(function (err) {
        self.setData({ loading: false, err: err.message || '取不到视频清单', groups: [] });
      });
  },

  /**
   * 给每条视频标上它在数组里的下标，同时预置 dead = false。
   *
   * 为什么需要：封面是 B 站图床的图，对站外请求可能返 403。
   * 微信 image 组件加载失败**不会报错也不会留白提示**，只留一块灰底——
   * 看起来像"这页没做完"。所以要在 binderror 里把它标成 dead，
   * 模板换成文字占位，至少标题和要点还读得到。
   */
  decorate(groups) {
    return groups.map(function (g, gi) {
      return Object.assign({}, g, {
        videos: (g.videos || []).map(function (v, vi) {
          return Object.assign({}, v, { gi: gi, vi: vi, dead: false });
        }),
      });
    });
  },

  onCoverErr(e) {
    const d = e.currentTarget.dataset;
    // 用 setData 的路径写法，只改这一个字段，不触发整页重渲
    this.setData({ ['groups[' + d.gi + '].videos[' + d.vi + '].dead']: true });
  },

  /**
   * 小程序里放不了 B 站播放器：
   * 没有 iframe，web-view 需要配置业务域名并备案，比赛前来不及。
   * 所以这里只做一件事——把原站链接复制给用户，让他用浏览器打开。
   * 这是真实限制，界面上的说法不能含糊，不能说"点击播放"。
   */
  openVideo(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success() {
        wx.showModal({
          title: '链接已复制',
          content: '小程序里放不了 B 站播放器。把链接粘到浏览器（或 B 站 App）就能看这一条。',
          showCancel: false,
          confirmText: '知道了',
        });
      },
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    return share.general('learn');
  },

  onShareTimeline() {
    return share.timeline('learn');
  },
});
