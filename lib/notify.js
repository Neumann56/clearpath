/**
 * 待核日报（M6 的"主动触达"那一半）
 *
 * 设计要点：
 * 1. 纯文本，不用 HTML —— 企业微信/飞书/钉钉的 text 消息都能直接吃
 * 2. 只描述、不改金额 —— 逾期只影响横幅和默认预选，不影响任何数（K4）
 * 3. 金额一律走 fmt()，不许出现 6327 这种裸数字
 * 4. 本身不做定时 —— 交给系统计划任务，脚本调用一次就退出
 */
import { fmt } from './decimal.js';
import { diffDays } from './engine/dates.js';
import { degradeOf } from './unresolved.js';

const TIER_SHORT = {
  T0_BLOCK: 'T0 阻断',
  T1_BRANCH: 'T1 分支',
  T2_IMPACT: 'T2 影响',
  T3_FOOTNOTE: 'T3 脚注',
  T4_INTERNAL: 'T4 内部',
};

const tierText = (t) => TIER_SHORT[t] || t || '未分级';

/** 把待核项按"要人做的事"分桶。已关闭的不进日报。 */
export function bucketFacts(facts, today) {
  const open = (facts || []).filter((f) => f.status !== 'resolved' && f.status !== 'superseded');

  const rows = open.map((f) => {
    const left = f.reviewDue ? diffDays(today, f.reviewDue) : null;
    const dg = degradeOf(f, today);
    return { fact: f, left, degrade: dg };
  });

  const byLeftAsc = (a, b) => (a.left ?? 9999) - (b.left ?? 9999);

  const overdue = rows.filter((r) => r.left !== null && r.left < 0).sort(byLeftAsc);
  const dueSoon = rows.filter((r) => r.left !== null && r.left >= 0 && r.left <= 3).sort(byLeftAsc);
  const red = rows.filter((r) => r.degrade.level === 'red').sort((a, b) => b.degrade.overdue - a.degrade.overdue);
  const expired = rows.filter((r) => r.degrade.level === 'expired').sort((a, b) => b.degrade.overdue - a.degrade.overdue);
  const noOwner = rows.filter((r) => !r.fact.owner);

  return { open, rows, overdue, dueSoon, red, expired, noOwner };
}

function lineOf(r, kind) {
  const f = r.fact;
  const when = kind === 'overdue' ? `逾期 ${-r.left} 天` : `剩 ${r.left} 天`;
  const money =
    f.impactUsdCached !== null && f.impactUsdCached !== undefined
      ? `影响 ${fmt(f.impactUsdCached)} 美元`
      : '不影响金额';
  return ` - ${f.id} ${tierText(f.displayTier)} · ${when} · ${money} · owner ${f.owner || '待指定'}`;
}

/**
 * 生成日报正文。today 是 YYYY-MM-DD。
 * 返回字符串，行尾用 \n（webhook 与终端都能直接吃）。
 */
export function buildDigest(facts, today) {
  const b = bucketFacts(facts, today);
  const lines = [`【通途待核日报】${today}`];

  if (b.open.length === 0) {
    lines.push('待核库为空，没有需要处理的事项。');
    return lines.join('\n');
  }

  if (b.overdue.length) {
    lines.push(`逾期 ${b.overdue.length} 项：`);
    for (const r of b.overdue) lines.push(lineOf(r, 'overdue'));
  } else {
    lines.push('没有逾期项。');
  }

  if (b.dueSoon.length) {
    lines.push(`3 天内到期 ${b.dueSoon.length} 项：`);
    for (const r of b.dueSoon) lines.push(lineOf(r, 'dueSoon'));
  } else {
    lines.push('3 天内没有到期项。');
  }

  if (b.expired.length) {
    lines.push(
      `已失效 ${b.expired.length} 项：${b.expired
        .map((r) => `${r.fact.id}（${r.degrade.overdue} 天未复核，不再预选默认分支，需手动选）`)
        .join('、')}`
    );
  }

  if (b.red.length) {
    lines.push(`红档 ${b.red.length} 项：${b.red.map((r) => `${r.fact.id}（${r.degrade.overdue} 天未核）`).join('、')}`);
  }

  if (b.noOwner.length) {
    lines.push(`未指定 owner ${b.noOwner.length} 项：${b.noOwner.map((r) => r.fact.id).join('、')}`);
  }

  lines.push(
    b.overdue.length
      ? `合计：${b.open.length} 项待核，其中 ${b.overdue.length} 项已逾期。`
      : `合计：${b.open.length} 项待核，当前没有逾期项。`
  );
  lines.push('（逾期只影响提示与默认分支，不改变任何已出报告的金额。）');

  return lines.join('\n');
}

/** 按目标平台组包装体；认不出就发最通用的 { text }。 */
export function webhookPayload(digest, url = '') {
  if (/qyapi\.weixin\.qq\.com/.test(url)) return { msgtype: 'text', text: { content: digest } };
  if (/open\.feishu\.cn|larksuite/.test(url)) return { msg_type: 'text', content: { text: digest } };
  if (/oapi\.dingtalk\.com/.test(url)) return { msgtype: 'text', text: { content: digest } };
  return { text: digest };
}

/**
 * 发一次。未配置 webhook 时返回 { sent:false, reason:'unconfigured' }，不抛错。
 * 调用方负责决定要不要打印。
 */
export async function sendDigest(digest, { url = process.env.WEBHOOK_URL, timeoutMs = 8000 } = {}) {
  if (!url) return { sent: false, reason: 'unconfigured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(webhookPayload(digest, url)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) return { sent: false, reason: `http_${res.status}`, detail: body.slice(0, 200) };
    return { sent: true, status: res.status };
  } catch (e) {
    return { sent: false, reason: 'network', detail: String(e && e.message).slice(0, 200) };
  }
}
