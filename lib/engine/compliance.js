import { D } from '../decimal.js';

/**
 * 合规成本必须摊到单票，否则量纲不可比（v2 §6）：
 * perShipment = (onetime + annual × years) / (shipmentsPerYear × years) + perShipment
 * 缺 shipmentsPerYear 时不得静默按 1 算而不留痕 → 产出 assumption。
 */
/**
 * 办理周期的说法。
 *
 * 标签要求、木材合法性尽职调查这类"要做但没有审批流程"的事，周期是 0 天。
 * 直接拼出"0–0 天"，看起来像参数没填，用户会去追问"到底要多久"。
 */
function daysText(c) {
  const d = c.leadTimeDays;
  if (!Array.isArray(d) || d.length < 2) return '-';
  if (Number(d[0]) === 0 && Number(d[1]) === 0) return '不涉及办理周期';
  return `${d[0]}–${d[1]} 天`;
}

export function computeCompliance({ country, channel, params, shipment }) {
  const all = params?.idx?.compliance || [];
  const hs = String(shipment?.hsDigits || '').replace(/\D/g, '');
  const fits = all.filter(
    (c) =>
      (c.countries || []).includes(country) &&
      (c.channels || []).includes(channel) &&
      // 认证是按品类走的：印尼 SNI 管光伏，不代表管 T 恤；韩国 KC 管汽配，不代表管木家具。
      // 只按国家过滤，卖 T 恤的人会被要求去办 SNI，卖光伏的人反而不一定看到该看的证。
      // 没写 hsPrefixes 的老记录按"全品类适用"处理，避免历史报告口径被悄悄改掉。
      (!Array.isArray(c.hsPrefixes) ||
        c.hsPrefixes.length === 0 ||
        c.hsPrefixes.some((p) => p === '*' || hs.startsWith(String(p).replace(/\D/g, ''))))
  );

  const shipmentsPerYear = shipment.shipmentsPerYear ?? null;
  const years = shipment.amortizationYears ?? 1;
  const effectiveShipments = shipmentsPerYear ?? 1;
  const totalShipments = D.of(effectiveShipments).mul(D.of(years));

  const items = [];
  const assumptions = [];
  const actions = [];
  let total = D.of(0);

  for (const c of fits) {
    if (c.mandatory === false) {
      actions.push({
        id: c.id,
        label: c.label,
        mandatory: false,
        who: '出口商',
        days: daysText(c),
        note: `${c.note || ''}（默认不计，可选加回）`,
        confidence: c.confidence,
        sourceUrl: c.sourceUrl,
      });
      continue;
    }

    const onetime = D.of(c.onetime || 0);
    const annual = D.of(c.annual || 0);
    const per = D.of(c.perShipment || 0);
    const amortized = onetime.add(annual.mul(D.of(years))).div(totalShipments).add(per);

    if (amortized.isZero()) {
      actions.push({
        id: c.id,
        label: c.label,
        mandatory: true,
        who: '出口商 / 制造商',
        days: daysText(c),
        // 参数里的说明不能丢：办证方是谁、哪个环节会卡、有没有替代路径，全在 note 里。
        // 之前这里被一句固定的"成本未入库"覆盖掉，等于把最有用的信息换成了免责声明。
        note: c.note ? `${c.note}（成本未入库，仅进入「要办的事」，不计入金额）` : '该类要求成本未入库，仅进入「要办的事」，不计入金额',
        confidence: c.confidence,
        sourceUrl: c.sourceUrl,
      });
      continue;
    }

    total = total.add(amortized);
    items.push({
      id: c.id,
      label: c.label,
      onetime,
      annual,
      perShipment: per,
      amount: amortized,
      shipmentsPerYear: effectiveShipments,
      years,
      trigger: c.trigger,
      confidence: c.confidence,
      sourceUrl: c.sourceUrl,
      note: c.note || '',
    });
    actions.push({
      id: c.id,
      label: c.label,
      mandatory: true,
      who: '出口商 / 制造商',
      days: daysText(c),
      note: [c.trigger === 'first_placing_on_market' ? '义务锚在首次在成员国市场投放' : '', c.note || '']
        .filter(Boolean)
        .join('；'),
      confidence: c.confidence,
      sourceUrl: c.sourceUrl,
    });

    if (annual.gt(0) && shipmentsPerYear === null) {
      assumptions.push({
        field: 'shipmentsPerYear',
        value: 1,
        note: `${c.label} 年费按 1 票/年摊，实际多票时每票成本更低`,
      });
    }
  }

  return { items, total, assumptions, actions };
}
