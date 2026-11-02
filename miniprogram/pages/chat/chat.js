const api = require('../../utils/api.js');
const llm = require('../../utils/llm.js');
const persona = require('../../utils/persona.js');
const share = require('../../utils/share.js');

Page({
  data: {
    msgs: [],
    input: '',
    busy: false,
    scrollTo: '',
    suggestions: ['增值税为什么退不掉', 'DDP 该不该接', 'FOB 还是 CIF'],
  },

  onLoad() {
    this.seq = 0;
    this.push(
      'bot',
      '我是老周，做了十二年外贸。\n\n这票货上的事都能问：税率为什么是这个数、报关行要什么材料、客户压价怎么回。\n我手上只有系统算好的数，只转述不重算——给不出出处的金额，我不给。'
    );
    wx.setNavigationBarTitle({ title: '问老周' });
  },

  push(role, text) {
    this.seq += 1;
    const msgs = this.data.msgs.concat([{ id: this.seq, role: role, text: text }]);
    this.setData({ msgs: msgs, scrollTo: 'm' + this.seq });
    return this.seq;
  },

  update(id, text) {
    const msgs = this.data.msgs.map(function (m) {
      return m.id === id ? Object.assign({}, m, { text: text }) : m;
    });
    this.setData({ msgs: msgs, scrollTo: 'm' + id });
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onChip(e) {
    this.ask(e.currentTarget.dataset.q);
  },

  onSend() {
    this.ask(this.data.input);
  },

  ask(raw) {
    const self = this;
    const q = String(raw || '').trim();
    if (!q || this.data.busy) return;
    this.setData({ input: '', busy: true });
    this.push('user', q);
    const botId = this.push('bot', '');

    // 先查事实：这一步不调模型、不花钱，只要几十毫秒。
    // 查不到就照常问，模型会给通行说法，而不是硬编一个数。
    api
      .post('/api/assistant/prefetch', { question: q })
      .then(function (out) {
        self.talk(q, out && out.kind === 'facts' ? out.facts : null, botId);
      })
      .catch(function () {
        self.talk(q, null, botId);
      });
  },

  /**
   * 走到这里才碰模型。流式还是整段，由 utils/llm.js 按通道决定，页面不管。
   */
  talk(question, facts, botId) {
    const self = this;
    const sys = persona.systemPrompt(facts);
    const history = this.data.msgs
      .filter(function (m) {
        return (m.role === 'user' || m.role === 'bot') && String(m.text || '').trim();
      })
      .slice(-7)
      .map(function (m) {
        return { role: m.role === 'bot' ? 'assistant' : 'user', content: m.text };
      });

    const messages = [{ role: 'system', content: sys }]
      .concat(history)
      .concat([{ role: 'user', content: question }]);

    llm
      .say(messages, function (acc) {
        self.update(botId, acc);
      })
      .then(function (text) {
        self.finish(botId, text);
      })
      .catch(function (err) {
        // 断网、没配额、云开发没开通都会走到这。给一段能用的兜底，别留空白气泡。
        self.update(botId, persona.OFFLINE + '\n\n（' + ((err && err.message) || '没接上') + '）');
        self.setData({ busy: false });
      });
  },

  finish(botId, acc) {
    if (!String(acc || '').trim()) {
      this.update(botId, '我这边没接上话，你再说一遍试试。');
    }
    this.setData({ busy: false });
  },

  onShareAppMessage() {
    return {
      title: '问老周：税率为什么是这个数、客户压价怎么回',
      path: share.HOME + '?from=chat',
    };
  },

  onShareTimeline() {
    return share.timeline('index');
  },
});
