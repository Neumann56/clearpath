/**
 * 空态 / 错误态。三件事必须同时出现：说清是什么、说清下一步、给一个能点的按钮。
 * 只写「暂无数据」等于把人晾在那儿。
 */
Component({
  options: { styleIsolation: 'isolated' },

  properties: {
    icon: { type: String, value: '·' },
    text: { type: String, value: '' },
    action: { type: String, value: '' },
  },

  methods: {
    onAct() {
      this.triggerEvent('act');
    },
  },
});
