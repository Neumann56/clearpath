const api = require('../../utils/api.js');
const F = require('../../utils/fmt.js');
const demo = require('../../utils/demo.js');
const share = require('../../utils/share.js');

const REGION_ORDER = ['EU', 'EUROPE_NON_EU', 'ASIA', 'MIDDLE_EAST', 'AMERICAS', 'AFRICA', 'OCEANIA'];

function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

Page({
  data: {
    ready: false,
    demoMode: false,
    err: '',

    countryLabels: [],
    countryIdx: -1,
    countryName: '',
    countryCode: '',

    hsCode: '',
    cats: [],
    fob: '',
    freight: '',
    qty: '',
    channel: '',
    declarationDate: today(),

    showAdv: false,
    exportDate: '',
    insurance: '',
    metalContentPct: '',
    areaSqm: '',
    chargesMode: '',

    estCost: '—',
    estCash: '—',
    estMsg: '还差：目的国、HS 编码或品名、FOB 货值、运费、数量、渠道',
    submitting: false,
  },

  onLoad() {
    this.loadCountries();
  },

  onShow() {
    // 首页「一句话录入」把结果放 storage 里交过来（tabBar 页面不能带 query）。
    // 国家要等列表就绪才能算出下标，没就绪就先挂起，由 buildCountries 回调消费。
    const draft = wx.getStorageSync('tt_draft');
    if (draft && (draft.country || draft.hsCode || draft.fob)) {
      wx.removeStorageSync('tt_draft');
      if (this.data.ready) this.applyDraft(draft);
      else this._pending = draft;
    }
  },

  applyDraft(draft) {
    const patch = {};
    if (draft.hsCode) patch.hsCode = F.hsText(draft.hsCode);
    if (draft.fob !== undefined && draft.fob !== null) patch.fob = String(draft.fob);
    if (draft.freight !== undefined && draft.freight !== null) patch.freight = String(draft.freight);
    if (draft.qty !== undefined && draft.qty !== null) patch.qty = String(draft.qty);
    if (draft.channel) patch.channel = draft.channel;
    if (draft.declarationDate) patch.declarationDate = draft.declarationDate;

    if (draft.country) {
      const idx = this.data.countryLabels.findIndex(function (x) {
        return x.code === draft.country;
      });
      if (idx >= 0) {
        patch.countryIdx = idx;
        patch.countryCode = this.data.countryLabels[idx].code;
        patch.countryName = this.data.countryLabels[idx].name;
      }
    }
    this.setData(patch);
    if (draft.ambiguous) {
      wx.showToast({ title: '编码有多种可能，请确认', icon: 'none', duration: 2600 });
    }
    this.estimate();
  },

  loadCountries() {
    const self = this;
    api
      .get('/api/meta/countries')
      .then(function (out) {
        self.buildCountries((out && out.countries) || []);
      })
      .catch(function () {
        // 连不上时给一份最小可用清单，别让整页填不了
        self.setData({ demoMode: true, err: '' });
        self.buildCountries([
          { code: 'HU', name: '匈牙利', region: 'EU', regionLabel: '欧盟', entryEnabled: true },
          { code: 'US', name: '美国', region: 'AMERICAS', regionLabel: '美洲', entryEnabled: true },
          { code: 'BR', name: '巴西', region: 'AMERICAS', regionLabel: '美洲', entryEnabled: true },
          { code: 'DE', name: '德国', region: 'EU', regionLabel: '欧盟', entryEnabled: true },
        ]);
      });

    api
      .get('/api/meta/coverage')
      .then(function (c) {
        const cats = (c.categories || []).map(function (x) {
          return { name: x.name, hs: x.hsDisplay };
        });
        self.setData({ cats: cats });
      })
      .catch(function () {
        self.setData({
          cats: demo.coverage.categories.map(function (x) {
            return { name: x.name, hs: x.hsDisplay };
          }),
        });
      });
  },

  buildCountries(all) {
    const usable = all.filter(function (c) {
      return c.entryEnabled !== false;
    });
    const sorted = usable.slice().sort(function (a, b) {
      const ia = REGION_ORDER.indexOf(a.region);
      const ib = REGION_ORDER.indexOf(b.region);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    const labels = sorted.map(function (c) {
      return {
        label: (c.regionLabel || c.region || '其他') + ' · ' + c.name,
        code: c.code,
        name: c.name,
      };
    });
    this.setData({ countryLabels: labels, ready: true });
    if (this._pending) {
      const d = this._pending;
      this._pending = null;
      this.applyDraft(d);
    }
  },

  onCountry(e) {
    const i = Number(e.detail.value);
    const c = this.data.countryLabels[i];
    if (!c) return;
    this.setData({ countryIdx: i, countryCode: c.code, countryName: c.name });
    this.estimate();
  },

  onHs(e) {
    this.setData({ hsCode: e.detail.value });
    this.estimate();
  },

  onCat(e) {
    this.setData({ hsCode: e.currentTarget.dataset.hs });
    this.estimate();
  },

  onNum(e) {
    const key = e.currentTarget.dataset.k;
    const patch = {};
    patch[key] = e.detail.value;
    this.setData(patch);
    this.estimate();
  },

  onChannel(e) {
    this.setData({ channel: e.currentTarget.dataset.v });
    this.estimate();
  },

  onCharges(e) {
    this.setData({ chargesMode: e.currentTarget.dataset.v });
    this.estimate();
  },

  onDate(e) {
    this.setData({ declarationDate: e.detail.value });
    this.estimate();
  },

  onAdvDate(e) {
    this.setData({ exportDate: e.detail.value });
  },

  toggleAdv() {
    this.setData({ showAdv: !this.data.showAdv });
  },

  collect() {
    const d = this.data;
    const num = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const input = {
      country: d.countryCode,
      hsCode: String(d.hsCode || '').trim(),
      fob: num(d.fob),
      freight: num(d.freight),
      qty: num(d.qty),
      channel: d.channel,
      dates: {},
    };
    if (d.declarationDate) input.dates.declarationDate = d.declarationDate;
    if (d.exportDate) input.dates.exportDate = d.exportDate;
    const ins = num(d.insurance);
    if (ins !== null) input.insurance = ins;
    const mc = num(d.metalContentPct);
    if (mc !== null) input.metalContentPct = mc;
    const ar = num(d.areaSqm);
    if (ar !== null) input.areaSqm = ar;
    if (d.chargesMode) input.chargesMode = d.chargesMode;
    return input;
  },

  /** 缺什么就说什么，不写「还差 N 项」——那是让人挨个试。 */
  missing(input) {
    const m = [];
    if (!input.country) m.push('目的国');
    if (!input.hsCode) m.push('HS 编码或品名');
    if (!input.fob || input.fob <= 0) m.push('FOB 货值');
    if (input.freight === null || input.freight < 0) m.push('运费（没有就填 0）');
    if (!input.qty || input.qty <= 0) m.push('数量');
    if (!input.channel) m.push('渠道');
    if (!input.dates.declarationDate) m.push('申报日期');
    return m;
  },

  estimate() {
    const self = this;
    const input = this.collect();
    const miss = this.missing(input);
    if (miss.length) {
      this.setData({ estCost: '—', estCash: '—', estMsg: '还差：' + miss.join('、') });
      return;
    }
    this.setData({ estMsg: '正在估…' });

    clearTimeout(this._t);
    this._t = setTimeout(function () {
      api
        .post('/api/quote/precheck', { input: input })
        .then(function (out) {
          const e = out && out.expected;
          if (!e) {
            self.setData({ estCost: '—', estCash: '—', estMsg: '这票算不出数，提交后看原因' });
            return;
          }
          self.setData({
            estCost: F.money(e.landedCost),
            estCash: F.money(e.cashRequired),
            estMsg: '',
          });
        })
        .catch(function (err) {
          // 试算只是辅助，失败不打断录入：说清原因，让人仍能提交
          self.setData({ estCost: '—', estCash: '—', estMsg: err.message || '暂时估不出来，可以直接提交' });
        });
    }, 450);
  },

  onSubmit() {
    const self = this;
    if (this.data.submitting) return;
    const input = this.collect();
    const miss = this.missing(input);
    if (miss.length) {
      wx.showToast({ title: '还差：' + miss.join('、'), icon: 'none', duration: 2600 });
      return;
    }
    this.setData({ submitting: true });
    api
      .post('/api/quote', { input: input })
      .then(function (report) {
        self.setData({ submitting: false });
        wx.navigateTo({ url: '/pages/report/report?id=' + report.reportId });
      })
      .catch(function (err) {
        self.setData({ submitting: false });
        // 服务端给的是人话，直接显示；不要统一改成「计算失败」
        wx.showModal({ title: '没算成', content: err.message || '检查一下填的数', showCancel: false });
      });
  },

  onShareAppMessage() {
    return share.general('index');
  },

  onShareTimeline() {
    return share.timeline('index');
  },
});
