/**
 * 分享文案。
 *
 * 小程序里分享是唯一免费的获客入口，但有两条硬线不能碰：
 *
 *   1. **不能诱导**。"分享给三个好友解锁报告""拉人砍价"这类，
 *      微信按诱导分享处罚，轻则限制分享能力，重则封禁。
 *      所以这里只陈述事实：这票货多少钱，两个数是分开的。
 *
 *   2. **分享不能带别人的报告 id**。报告是按设备隔离的（后端用设备号取报告），
 *      朋友点进来设备号不同，那份报告他打不开，只会看到一个空白页。
 *      所以**所有分享一律落到首页**，由首页给一份示例单。
 *      看起来牺牲了转化，实际是唯一不会当场翻车的做法。
 */

const HOME = '/pages/index/index';

/** 报告页：用两个数说话，不夸、不催、不说"限时"。 */
function report(v) {
  const title = v
    ? v.title + '：真实成本 ' + v.landed + '，报关要押 ' + v.cash
    : '一票货到底花多少钱？真实成本和要备的现金，分开给你算';
  return {
    title: title.length > 42 ? title.slice(0, 41) + '…' : title,
    path: HOME + '?from=report',
  };
}

/** 首页 / 历史 / 看懂 / 日历：讲清这是什么，别用营销口气。 */
function general(which) {
  const map = {
    index: '报价前先算两笔：真实成本、清关要备的现金',
    reports: '每一票的历史金额永久冻结，参数改了也不会变',
    learn: 'FOB、CIF、DDP 到底差在哪，十三条视频讲明白',
    calendar: '哪个月份要留神？外贸政策变动日历',
  };
  return {
    title: map[which] || map.index,
    path: HOME + '?from=' + which,
  };
}

/** 分享到朋友圈。query 是字符串，不能带函数。 */
function timeline(which) {
  return {
    title: general(which).title,
    query: 'from=' + which,
  };
}

module.exports = { report, general, timeline, HOME };
