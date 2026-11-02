const api = require('../../utils/api.js');
const demo = require('../../utils/demo.js');
const share = require('../../utils/share.js');

Page({
  data: {
    loading: true,
    demoMode: false,
    today: '',
    note: '',
    months: [],
    spans: [],
  },

  onLoad() {
    this.load();
  },

  load() {
    const self = this;
    api
      .get('/api/calendar')
      .then(function (v) {
        self.apply(v, false);
      })
      .catch(function () {
        self.apply(demo.calendar, true);
      });
  },

  apply(v, isDemo) {
    const byMonth = {};
    const order = [];
    (v.items || []).forEach(function (it) {
      const m = String(it.date).slice(0, 7);
      if (!byMonth[m]) {
        byMonth[m] = [];
        order.push(m);
      }
      byMonth[m].push({
        date: String(it.date).slice(5),
        label: it.label,
        kind: it.kind,
        country: it.countryName || '',
        state: it.state,
      });
    });
    const months = order.map(function (m) {
      return { key: m, title: m.replace('-', ' 年 ') + ' 月', items: byMonth[m] };
    });
    this.setData({
      loading: false,
      demoMode: isDemo,
      today: v.today || '',
      note: v.note || '',
      months: months,
      spans: v.spans || [],
    });
  },

  onShareAppMessage() {
    return share.general('calendar');
  },

  onShareTimeline() {
    return share.timeline('calendar');
  },
});
