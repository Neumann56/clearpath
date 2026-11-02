// 打印视图：等字体与布局稳定后再调起打印
window.addEventListener('load', () => {
  setTimeout(() => window.print(), 450);
});
