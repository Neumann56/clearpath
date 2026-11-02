const api = require('../../utils/api.js');
const F = require('../../utils/fmt.js');
const demo = require('../../utils/demo.js');
const share = require('../../utils/share.js');

Page({
  data: {
    loading: true,
    err: '',
    demoMode: false,
    list: [],
  },

  onShow() {
    this.load();
  },

  load() {
    const self = this;
    this.setData({ loading: true });
    api
      .get('/api/reports')
      .then(function (out) {
        const raw = (out && out.reports) || [];
        self.setData({ loading: false, err: '', list: raw.map(self.fmt), demoMode: false });
      })
      .catch(function (err) {
        // 连不上时给一票演示数据，并明确标注——否则新用户会以为"我没算过"
        self.setData({
          loading: false,
          demoMode: true,
          err: err.message || '',
          list: [self.fmt(demo.report)],
        });
      });
  },

  fmt(r) {
    let cls = 'a';
    if (r.state === 'complete') cls = 'g';
    else if (r.state === 'blocked') cls = 'r';
    return {
      id: r.reportId,
      country: r.countryName || r.country || '',
      hs: F.hsText(r.hsCode),
      landed: F.money(r.landedCost),
      cash: F.money(r.cashRequired),
      state: F.stateText(r.state),
      when: String(r.createdAt || '').slice(0, 16).replace('T', ' '),
      cls: cls,
    };
  },

  open(e) {
    wx.navigateTo({ url: '/pages/report/report?id=' + e.currentTarget.dataset.id });
  },

  goNew() {
    wx.switchTab({ url: '/pages/new/new' });
  },

  onShareAppMessage() {
    return share.general('reports');
  },

  onShareTimeline() {
    return share.timeline('reports');
  },
});
