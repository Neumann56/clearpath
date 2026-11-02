/**
 * 预演准确率统计（M4 的另一半）
 *
 * M4 的价值不在"能对账"，而在"准确率随时间上升"。
 * 所以要有一个能回答"最近 20 票平均偏差多少、趋势在上还是下"的东西。
 *
 * 只读 calibrations.jsonl，不写。
 */
import { addDays } from './engine/dates.js';
import { pct } from './decimal.js';

/** 一条记录的平均绝对偏差率（没有 diffPct 的老记录用 diff / 预演成本兜底） */
function pctOf(rec) {
  if (typeof rec.diffPct === 'number' && Number.isFinite(rec.diffPct)) return Math.abs(rec.diffPct);
  const base = rec.predicted?.landedCost;
  const diff = rec.landedCostDiff;
  if (typeof diff === 'number' && base) return Math.abs(diff / base);
  return null;
}

const dayOf = (iso) => String(iso || '').slice(0, 10);

function inRange(rec, from, to) {
  const d = dayOf(rec.at);
  return d >= from && d <= to;
}

function summarize(records) {
  const vals = records.map(pctOf).filter((v) => v !== null);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const max = vals.length ? Math.max(...vals) : null;
  return { count: records.length, avgPct: avg, maxPct: max, valued: vals.length };
}

/**
 * @param records readCalibrations() 的结果
 * @param today YYYY-MM-DD
 */
export function calibrationStats(records, today, { weeks = 8 } = {}) {
  const all = (records || []).filter((r) => r && r.at);
  const d30from = addDays(today, -29);
  const d60from = addDays(today, -59);
  const d90from = addDays(today, -89);

  const w30 = all.filter((r) => inRange(r, d30from, today));
  const prev30 = all.filter((r) => inRange(r, d60from, addDays(d30from, -1)));
  const w90 = all.filter((r) => inRange(r, d90from, today));

  const s30 = summarize(w30);
  const sPrev30 = summarize(prev30);
  const s90 = summarize(w90);

  const deltaPct = s30.avgPct !== null && sPrev30.avgPct !== null ? s30.avgPct - sPrev30.avgPct : null;

  // 按国家
  const byCountryMap = new Map();
  for (const r of w90) {
    const key = r.country || '??';
    if (!byCountryMap.has(key)) byCountryMap.set(key, { key, name: r.countryName || key, records: [] });
    byCountryMap.get(key).records.push(r);
  }
  const byCountry = [...byCountryMap.values()]
    .map((g) => ({ key: g.key, name: g.name, ...summarize(g.records) }))
    .sort((a, b) => b.count - a.count || (b.avgPct ?? 0) - (a.avgPct ?? 0));

  // 按归因
  const byAttrMap = new Map();
  for (const r of w90) {
    const key = r.primaryAttribution || '未归因';
    byAttrMap.set(key, (byAttrMap.get(key) || 0) + 1);
  }
  const byAttribution = [...byAttrMap.entries()]
    .map(([key, count]) => ({ key, count, share: w90.length ? count / w90.length : 0 }))
    .sort((a, b) => b.count - a.count);

  // 按周（最后一周含今天）
  const weekly = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = addDays(today, -7 * i);
    const start = addDays(end, -6);
    const rows = all.filter((r) => inRange(r, start, end));
    const s = summarize(rows);
    weekly.push({ start, end, count: s.count, avgPct: s.avgPct });
  }

  return {
    today,
    windows: {
      d30: { from: d30from, ...s30, deltaPct },
      d30prev: { from: d60from, to: addDays(d30from, -1), ...sPrev30 },
      d90: { from: d90from, ...s90 },
    },
    byCountry,
    byAttribution,
    weekly,
    headline: headlineOf(s30, sPrev30, deltaPct),
  };
}

function headlineOf(s30, sPrev30, delta) {
  if (s30.count === 0) {
    return sPrev30.count
      ? `近 30 天没有新的校准记录，上一周期有 ${sPrev30.count} 票。`
      : '还没有校准记录。上传第一张税单后，这里才会开始出数。';
  }
  const base = `近 30 天 ${s30.count} 票，平均绝对偏差 ${pct(s30.avgPct ?? 0, 1)}`;
  if (sPrev30.count === 0 || delta === null) {
    return `${base}。样本还少，先不要拿它下结论。`;
  }
  const dir = delta < 0 ? '下降' : delta > 0 ? '上升' : '持平';
  const tail =
    delta === 0
      ? '，与上一周期持平。'
      : `，较上一周期${dir} ${pct(Math.abs(delta), 1).replace('%', '')} 个百分点。`;
  const warn = delta > 0 ? '偏差在扩大，先查最近入队的参数项。' : s30.count < 5 ? '样本仍偏少，先别当成结论。' : '';
  return base + tail + (warn ? warn : '');
}
