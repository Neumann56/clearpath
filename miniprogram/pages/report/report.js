const api = require('../../utils/api.js');
const F = require('../../utils/fmt.js');
const demo = require('../../utils/demo.js');
const share = require('../../utils/share.js');

/**
 * 给每一行补一个序号，供 wx:key 使用。
 * 不能用 k 当 key：同一份报告里出现两条「关税」是很正常的事（不同税目），
 * 重复 key 不报错，只会让某几行渲染错位——最难查的那类问题。
 */
function idx(arr) {
  return arr.map(function (x, i) {
    return Object.assign({ i: i }, x);
  });
}

/**
 * 把后端报告转成 wxml 能直接铺开的结构。
 *
 * wxml 里不能调函数、不能做复杂判断，所有格式化必须在这里做完。
 * 好处是模板里全是 {{}}，一眼能看出哪块对应哪个数；
 * 坏处是加字段要改两处——所以这里只做「展示整形」，不做任何计算。
 */
function buildView(r) {
  const e = r.expected || null;
  const unresolved = r.unresolved || [];
  // 同一条 D 级参数会同时出现在 dataGaps 和 unresolved 里，手机上会重复两遍。
  // 待核项那条更全（带复核动作和截止日），所以缺口里同 id 的不再列。
  const ids = {};
  unresolved.forEach(function (u) {
    if (u.id) ids[u.id] = 1;
  });
  const gaps = (r.dataGaps || []).filter(function (g) {
    return !g.factId || !ids[g.factId];
  });

  const lines = [];
  if (e) {
    lines.push({ k: 'CIF 到岸价', sub: 'FOB + 运费 + 保险', v: F.money(e.cif), cls: '' });
    (e.dutyBreakdown || []).forEach(function (d) {
      if (d.skipped) return;
      const tag = d.confidence ? F.confText(d.confidence) : '';
      lines.push({
        k: d.label || '关税',
        tag: tag,
        tagCls: d.confidence || '',
        sub: d.baseText ? '基数 ' + d.baseText + ' · ' + F.money(d.base) : '',
        v: d.pending ? '待定' : F.money(d.amount),
        cls: '',
      });
    });
    (e.taxChain || []).forEach(function (t) {
      lines.push({
        k: t.name || t.label || '税',
        tag: t.refundable ? '可抵扣' : '',
        tagCls: 'high',
        sub: F.pct(t.rate) + ' × ' + F.money(t.base) + (t.note ? ' · ' + F.plain(t.note) : ''),
        v: F.money(t.amount),
        cls: '',
      });
    });
    (e.chargeLines || []).forEach(function (c) {
      if (!c.included) return;
      lines.push({ k: c.label || '规费', sub: c.baseText || '', v: F.money(c.amount), cls: '' });
    });
    (e.compliance || []).forEach(function (c) {
      if (!c.amount) return;
      lines.push({ k: c.label || '认证成本', sub: '按票摊销', v: F.money(c.amount), cls: '' });
    });
    if (e.remedy && !e.remedy.incomplete) {
      lines.push({
        k: '贸易救济 · ' + (e.remedy.type || ''),
        sub: '按最终口径计入成本',
        v: F.money(e.remedy.final),
        cls: '',
      });
    }
  }

  const warns = [];
  gaps.forEach(function (g) {
    warns.push({ title: g.field || '数据缺口', meta: g.reason || '', act: g.suggestAction ? '怎么办：' + g.suggestAction : '', cls: 'gap' });
  });
  unresolved.forEach(function (u) {
    const meta = [];
    if (u.reviewDue) meta.push('要在 ' + String(u.reviewDue).slice(0, 10) + ' 前核清');
    meta.push(u.impactUsd ? '影响约 ' + F.money(u.impactUsd) + ' 美元' : '影响金额未量化');
    warns.push({
      title: u.title || u.id,
      meta: meta.join(' · '),
      act: u.reviewAction ? '怎么核：' + u.reviewAction : '',
      cls: '',
    });
  });

  const actions = (r.actions || []).map(function (a) {
    const sub = [];
    if (a.who) sub.push(a.who);
    if (a.days) sub.push('提前 ' + a.days);
    if (a.note) sub.push(a.note);
    return { k: a.label, tag: a.mandatory ? '强制' : '', tagCls: 'low', sub: sub.join(' · ') };
  });

  // 两个总数分行列出，**不做合计行**。它们不是一个口径，加起来没有含义。
  const totals = [];
  if (e) {
    totals.push({ k: '真实成本', v: F.money(e.landedCost), tot: true });
    totals.push({ k: '需备现金', v: F.money(e.cashRequired), tot: true });
  }

  const range = [];
  if (r.range) {
    range.push({ k: '最好情况', v: F.money(r.range.best), cls: 'q' });
    range.push({ k: '按现在参数', v: F.money(r.range.expected), cls: '' });
    range.push({ k: '最坏情况', v: F.money(r.range.worst), cls: '', tag: '报价按这个', tagCls: 'low' });
    if (r.range.worstExtra) range.push({ k: '最坏比现在多', v: F.money(r.range.worstExtra), cls: 'neg' });
  }

  const sens = (r.sensitivity || []).map(function (s) {
    return {
      k: s.label,
      sub: s.change || '',
      v: (s.delta >= 0 ? '+' : '') + F.money(s.delta),
      cls: s.delta >= 0 ? 'neg' : 'pos',
    };
  });

  const assume = (r.assumptions || []).map(function (a) {
    return {
      k: a.field,
      tag: a.confidence ? F.confText(a.confidence) : '',
      tagCls: a.confidence || '',
      sub: a.note || '',
      v: a.value === null || a.value === undefined ? '—' : String(a.value),
      cls: 'q',
    };
  });

  const time = (r.timeline || []).map(function (t) {
    return {
      date: String(t.date || '').slice(5),
      label: t.label,
      meta: t.relation === 'past' ? '已过' : t.relation === 'future' ? '未到' : '',
      cls: t.relation === 'past' ? 'in' : '',
    };
  });

  return {
    stateText: F.stateText(r.state),
    stateCls: F.stateClass(r.state),
    title: (r.input && (r.input.countryName || r.input.country) || '') + ' · ' + F.hsText(r.input && r.input.hsCode),
    sub: (r.input && r.input.dates && r.input.dates.declarationDate || '') + ' 申报 · 参数版本 ' + ((r.meta && r.meta.paramsVersion) || ''),
    hasExpected: Boolean(e),
    landed: e ? F.money(e.landedCost) : '—',
    cash: e ? F.money(e.cashRequired) : '—',
    dualNote: e
      ? '两个数永不相加。' + (e.refundableVat ? '其中可退增值税 ' + F.money(e.refundableVat) + ' 只占现金，不进成本。' : '本票没有可退的进口环节税。')
      : '这份报告算不出来：' + ((r.warnings && r.warnings[0]) || '缺关键输入，或命中了不允许出数的规则。') + ' 宁可不出数，也不给一个看起来像答案的 0。',
    hasGap: Boolean(e && e.cashGap > 0),
    gapAmount: e ? '现金缺口 ' + F.money(e.cashGap) : '',
    gapRatio: e ? F.pct(e.cashGapRatio, 1) + ' 要先垫' : '',
    lines: idx(lines),
    totals: idx(totals),
    totalLanded: e ? F.money(e.landedCost) : '',
    totalCash: e ? F.money(e.cashRequired) : '',
    warns: idx(warns),
    noWarn: warns.length === 0,
    actions: idx(actions),
    noAction: actions.length === 0,
    range: idx(range),
    sens: idx(sens),
    assume: idx(assume),
    time: idx(time),
    reportId: r.reportId,
    isDemo: Boolean(r.isDemo),
  };
}

Page({
  data: {
    loading: true,
    err: '',
    demoMode: false,
    v: null,
    open: { money: true, todo: true, action: false, more: false, time: false },
  },

  onLoad(q) {
    this.id = q.id || '';
    this.load();
  },

  load() {
    const self = this;
    if (!this.id || this.id.indexOf('demo') === 0) {
      this.setData({ loading: false, demoMode: true, v: buildView(demo.report) });
      return;
    }
    api
      .get('/api/report/' + this.id)
      .then(function (r) {
        self.setData({ loading: false, v: buildView(r), err: '' });
        wx.setNavigationBarTitle({ title: (r.input.countryName || '') + ' ' + F.hsText(r.input.hsCode) });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          err: err.message || '这份报告打不开',
        });
      });
  },

  toggle(e) {
    const k = e.currentTarget.dataset.k;
    const open = Object.assign({}, this.data.open);
    open[k] = !open[k];
    this.setData({ open: open });
  },

  goPrint() {
    // 完整报告（逐行来源链接、打印存档）在电脑版。小程序里只给一个可复制的地址。
    const self = this;
    const url = api.pageUrl('/quote/' + this.id + '/report');
    if (!url) {
      wx.showModal({
        title: '这份报告只在手机上看',
        content: '当前是云函数转发 / 离线模式，没有可以直接打开的电脑版地址。切回直连模式后才有。',
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: '完整报告在电脑版',
      content: '逐行来源和打印存档要用电脑打开。要复制这份报告的地址吗？',
      confirmText: '复制地址',
      success(r) {
        if (r.confirm) {
          wx.setClipboardData({ data: api.pageUrl('/quote/' + self.id + '/report') });
        }
      },
    });
  },

  goBack() {
    wx.switchTab({ url: '/pages/reports/reports' });
  },

  // 分享落点是首页，不是这份报告：报告按设备隔离，朋友点进来设备号不同，
  // 只会看到一个打不开的空白页。详见 utils/share.js 的注释。
  onShareAppMessage() {
    return share.report(this.data.v);
  },

  onShareTimeline() {
    return share.timeline('index');
  },
});
