/**
 * 明细行列表。报告页的五块内容（钱怎么算的、要办的事、别的可能、时间节点）
 * 长得一样，都是「左边一个名目加注解，右边一个数」，所以收成一个组件。
 *
 * 每一行必须带一个 i（序号），用作 wx:key。
 * 不能用 k 当 key：同一个报告里出现两条「关税」很正常（不同税目），
 * 重复 key 不会报错，只会让某几行渲染错位——最难查的那类问题。
 */
Component({
  options: { styleIsolation: 'isolated' },

  properties: {
    rows: { type: Array, value: [] },
    /** 空的时候显示什么。空着就什么都不显示，由调用方决定要不要给文案。 */
    empty: { type: String, value: '' },
  },
});
