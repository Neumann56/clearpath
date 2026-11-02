/**
 * 双口径金额卡。首页、报告页、历史页共用这一个。
 *
 * **这个组件故意不提供任何"合计"属性。**
 * 真实成本（landedCost）和需备现金（cashRequired）是两个不同口径：
 * 前者算毛利，后者算现金流。把它们加起来没有任何业务含义，
 * 但界面上并排放两个数，人就很容易手一滑写个 total。
 * 所以从组件契约上就不给这条路——想加也没有字段可加。
 *
 * 现金缺口（gap）也在这里，因为它必须紧贴在"需备现金"下面出现，
 * 隔到别处去就变成了另一个数字，读者会以为又要加一次。
 */
Component({
  options: {
    // 组件样式不外泄、也不吃页面样式。
    // 好处是改全局不会把别处改坏；代价是这里要自带全量样式，值抄自 app.wxss。
    styleIsolation: 'isolated',
  },

  properties: {
    /** 已格式化好的字符串，例如 "52,134.48"。组件内不做任何运算。 */
    landed: { type: String, value: '—' },
    cash: { type: String, value: '—' },
    /** ≠ 那一行的说明 */
    note: { type: String, value: '两个数永不相加。可退的增值税只影响现金，不进成本。' },
    /** 是否显示缺口条 */
    gap: { type: Boolean, value: false },
    gaptext: { type: String, value: '' },
    gapsub: { type: String, value: '' },
    /** 'lg' 首页/报告页  'md' 卡片内嵌 */
    size: { type: String, value: 'lg' },
  },
});
