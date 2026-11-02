const api = require('../../utils/api.js');
const F = require('../../utils/fmt.js');
const demo = require('../../utils/demo.js');
const store = require('../../utils/store.js');
const share = require('../../utils/share.js');
const { MODE } = require('../../config.js');

const CHIPS = [
  { label: '汽配 → 匈牙利', fill: '8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到匈牙利，10 月 20 日申报' },
  { label: '汽配 → 美国', fill: '8708.91 汽配 1200 件，FOB 48000 美元，运费 2400，运到美国，10 月 20 日申报' },
  { label: '光伏 → 巴西', fill: '8541.43 光伏组件 500 件，FOB 10000 美元，运到巴西，10 月 20 日申报' },
];

Page({
  data: {
    text: '',
    chips: CHIPS,
    busy: false,
    hint: '',
    demoMode: false,
    mockMode: MODE === 'mock',
    fromShare: '',
    sample: null,
    catText: '',
    markets: 0,
    cats: 0,
    cells: 0,
    charges: 0,
  },

  onLoad(q) {
    // 分享进来的落地页。朋友圈 query 只能带字符串，别指望别的。
    const from = (q && q.from) || '';
    if (from) this.setData({ fromShare: from });
  },

  onShow() {
    this.loadCoverage();
    this.loadSample();
  },

  // ------------------------------------------------------------ 覆盖数字

  loadCoverage() {
    const self = this;
    // 这份数据首页和录入页都要，取过就不要再打一遍接口
    const cached = store.coverage();
    if (cached) {
      this.applyCoverage(cached, false);
      return;
    }
    api
      .get('/api/meta/coverage')
      .then(function (c) {
        store.setCoverage(c);
        self.applyCoverage(c, false);
      })
      .catch(function () {
        // 取不到就用演示值，但顶部会挂黄条说明
        self.applyCoverage(demo.coverage, true);
      });
  },

  applyCoverage(c, isDemo) {
    const cats = (c.categories || []).map(function (x) {
      return x.name;
    });
    const patch = {
      markets: c.markets ? c.markets.total : 0,
      cats: (c.categories || []).length,
      cells: c.cells || 0,
      charges: c.chargesMarkets || 0,
      catText: cats.join('、'),
    };
    if (isDemo) patch.demoMode = true;
    this.setData(patch);
  },

  // ------------------------------------------------------------ 最近一票

  loadSample() {
    const self = this;
    const last = store.lastReport();
    if (last) this.setData({ sample: last });

    api
      .get('/api/reports')
      .then(function (out) {
        const list = (out && out.reports) || [];
        if (!list.length) {
          // 新用户没有历史：拿一票样例顶着，但标明是样例，不冒充他的
          self.setSample(demo.report, '样例');
          return;
        }
        const r = list[0];
        const s = {
          landedCost: F.money(r.landedCost),
          cashRequired: F.money(r.cashRequired),
          note: '你最近算过的一票 · 点开看完整报告',
        };
        store.lastReport(s);
        self.setData({ sample: s, demoMode: false });
      })
      .catch(function (err) {
        // 连不上：有缓存就继续显示缓存，没有就上样例。两种情况都挂黄条。
        if (!last) self.setSample(demo.report, '演示样例');
        self.setData({ demoMode: true });
        getApp().globalData.lastError = (err && err.message) || '';
      });
  },

  setSample(report, tag) {
    const e = report.expected || {};
    this.setData({
      sample: {
        landedCost: F.money(e.landedCost),
        cashRequired: F.money(e.cashRequired),
        note: tag + '：' + (report.input.countryName || '') + ' · ' + F.hsText(report.input.hsCode) + ' · 点开看完整报告',
      },
    });
  },

  // ------------------------------------------------------------ 交互

  onInput(e) {
    this.setData({ text: e.detail.value, hint: '' });
  },

  onChip(e) {
    this.setData({ text: e.currentTarget.dataset.fill, hint: '' });
  },

  onGo() {
    const self = this;
    const text = (this.data.text || '').trim();
    if (!text) {
      this.setData({ hint: '先用一句话说清这票货' });
      return;
    }
    if (this.data.busy) return;
    this.setData({ busy: true, hint: '' });

    api
      .post('/api/parse', { text: text }, { idempotent: true })
      .then(function (out) {
        const d = (out && out.draft) || {};
        // 结果经 storage 交给「预演」tab：tabBar 页面不能带 query，
        // 用 switchTab 传参是无效的（不报错，只是参数没了）。
        wx.setStorageSync('tt_draft', {
          country: d.country || '',
          hsCode: d.hsCode || '',
          fob: d.fob,
          freight: d.freight,
          qty: d.qty,
          channel: d.channel || '',
          declarationDate: d.declarationDate || '',
          ambiguous: (out.candidates || []).length > 1,
        });
        self.setData({ busy: false });
        wx.switchTab({ url: '/pages/new/new' });
      })
      .catch(function (err) {
        self.setData({ busy: false, hint: err.message || '没能读懂这句话，换成逐项填也一样快。' });
      });
  },

  goDemo() {
    wx.navigateTo({ url: '/pages/report/report?id=demo' });
  },

  goNew() {
    wx.switchTab({ url: '/pages/new/new' });
  },

  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
  },

  goLearn() {
    wx.switchTab({ url: '/pages/learn/learn' });
  },

  // 分享只陈述事实，不做诱导（微信对诱导分享处罚很重，详见 utils/share.js）
  onShareAppMessage() {
    return share.general('index');
  },

  onShareTimeline() {
    return share.timeline('index');
  },
});
