import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PARAMS_DIR = path.join(APP_ROOT, 'data', 'params');
export const RUNTIME_DIR = path.join(APP_ROOT, 'data', 'runtime');

const digits = (hs) => String(hs || '').replace(/\D/g, '');

/**
 * 当前生效的参数文件。
 * 优先 TT_PARAMS_FILE（草稿发布前的回归就是靠它指向草稿），
 * 否则取 data/params 下文件名排序最后的 kb-*.json（新版本天然排后面）。
 */
/**
 * 参数文件排序。
 *
 * 不能直接按文件名字典序：同一天发第二个版本会叫 `kb-2026.10.24-2.json`，
 * 而 '-' (0x2D) 排在 '.' (0x2E) 前面——按字典序会把新版本判成旧的，
 * 结果就是"发布成功、线上没变"，而且一声不响。这里按 日期 + 序号 数值比。
 */
export function compareParamsFile(a, b) {
  const rank = (f) => {
    const m = /^kb-(\d{4})\.(\d{2})\.(\d{2})(?:-(\d+))?\.json$/.exec(f);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 1)] : [0, 0, 0, 0];
  };
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < 4; i++) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return a.localeCompare(b);
}

/** 从文件名列表里挑出最新的一个 */
export function pickLatestParamsFile(files) {
  const list = (files || []).filter((f) => /^kb-.*\.json$/.test(f)).sort(compareParamsFile);
  return list.length ? list[list.length - 1] : null;
}

export function currentParamsFile() {
  if (process.env.TT_PARAMS_FILE) return path.resolve(process.env.TT_PARAMS_FILE);
  let files = [];
  try {
    files = fs.readdirSync(PARAMS_DIR);
  } catch {
    files = [];
  }
  return path.join(PARAMS_DIR, pickLatestParamsFile(files) || 'kb-2026.10.21.json');
}

export function loadParams(file) {
  const full = file ? (path.isAbsolute(file) ? file : path.join(PARAMS_DIR, file)) : currentParamsFile();
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const idx = buildIndex(raw);
  return { raw, idx, file: path.basename(full), version: raw.paramsVersion, asOf: raw.asOf };
}

function buildIndex(raw) {
  const byCountry = (arr) => {
    const m = new Map();
    for (const r of arr || []) {
      const c = r.country || r.countries;
      const keys = Array.isArray(c) ? c : [c];
      for (const k of keys) {
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
    }
    return m;
  };

  const tariffs = byCountry(raw.tariffs);
  for (const [, list] of tariffs) list.sort((a, b) => digits(b.hsPrefix).length - digits(a.hsPrefix).length);

  const taxSteps = byCountry(raw.taxSteps);
  for (const [, list] of taxSteps) list.sort((a, b) => a.seq - b.seq);

  return {
    country: new Map((raw.countries || []).map((c) => [c.code, c])),
    tariffs,
    taxSteps,
    measures: byCountry(raw.measures),
    charges: byCountry(raw.charges),
    compliance: raw.compliance || [],
    fta: raw.fta || [],
    dualUse: raw.dualUse || [],
    policyCalendar: raw.policyCalendar || [],
  };
}

export function matchTariff(idx, country, hs) {
  const key = digits(hs);
  const list = idx.tariffs.get(country) || [];
  return list.find((t) => key.startsWith(digits(t.hsPrefix))) || null;
}

/** 最长前缀匹配的 measures（未生效的也返回，交由引擎判定） */
export function matchMeasures(idx, country, hs) {
  const key = digits(hs);
  const list = idx.measures.get(country) || [];
  return list.filter((m) => (m.hsPrefixes || ['*']).some((p) => p === '*' || key.startsWith(digits(p))));
}

export function matchCharges(idx, country) {
  return idx.charges.get(country) || [];
}

/**
 * 用户填的可能是编码，也可能是品名——录入页上写的就是「HS 编码 / 品名」。
 *
 * 只在**唯一命中**时归一。写"光伏组件"能明确落到 854143，但写"服装"若同时命中
 * 多个品类，就必须返回候选让人自己挑：替他猜一个，用的就是另一个税目的税率，
 * 比拒绝出数危险得多。
 *
 * 返回 matchedBy 让调用方决定要不要留痕：
 *   code          —— 用户直接填了 6 位以上数字，无歧义
 *   partial_code  —— 填了不足 6 位的数字，是笔误不是品名，不该走品名兜底
 *   name          —— 品名唯一命中，须在假设里写明"按哪个品名归到哪一码"
 *   ambiguous     —— 命中多个，交回候选
 *   unknown       —— 没认出来
 */
export function resolveHsInput(params, raw) {
  const text = String(raw || '').trim();
  const num = digits(text);
  if (num.length >= 6) return { digits: num, matchedBy: 'code', candidates: [] };
  if (num.length > 0) return { digits: num, matchedBy: 'partial_code', candidates: [] };

  const catalog = params?.raw?.hsCatalog || [];
  const low = text.toLowerCase();
  const hits = text
    ? catalog.filter((c) => (c.kw || []).some((k) => k && low.includes(String(k).toLowerCase())))
    : [];

  if (hits.length === 1) {
    return { digits: digits(hits[0].hs), matchedBy: 'name', matchedName: hits[0].name, candidates: [] };
  }
  return {
    digits: '',
    matchedBy: hits.length ? 'ambiguous' : 'unknown',
    candidates: hits.map((c) => ({ hs: c.hs, name: c.name })),
  };
}

export function matchDualUse(idx, country, hs) {
  const key = digits(hs);
  return idx.dualUse.filter(
    (d) =>
      (d.countries || []).some((c) => c === '*' || c === country) &&
      (d.hsPrefixes || ['*']).some((p) => p === '*' || key.startsWith(digits(p)))
  );
}

export function taxStepsFor(idx, country) {
  return idx.taxSteps.get(country) || [];
}

/**
 * 参数自检（v2 §9）：启动即跑，失败拒绝启动。
 * 待核项不得导致启动失败（PRD §6.10），只有参数错误才 fail-fast。
 */
export function validateParams(raw) {
  const errs = [];
  const seen = new Set();

  for (const s of raw.taxSteps || []) {
    const key = `${s.country}:${s.taxCode}`;
    if (seen.has(key)) errs.push(`E_TAX_SEQ_DUP ${key}`);
    seen.add(key);

    const steps = (raw.taxSteps || []).filter((x) => x.country === s.country);
    for (const c of s.baseComponents || []) {
      if (typeof c !== 'string') {
        const ref = steps.find((x) => x.taxCode === c.ref);
        if (!ref) errs.push(`E_TAX_REF_UNKNOWN ${s.country}/${s.taxCode} -> ${c.ref}`);
        else if (ref.seq >= s.seq) errs.push(`E_TAX_REF_FORWARD ${s.country}/${s.taxCode} -> ${c.ref}`);
        if (s.inclusive && c.ref === s.taxCode) errs.push(`E_INCLUSIVE_SELF_REF ${s.country}/${s.taxCode}`);
      }
    }
    if (s.rate === undefined || s.rate === null) errs.push(`E_PARAM_RATE_MISSING ${key}`);
    if (!s.sourceUrl) errs.push(`E_SOURCE_REQUIRED ${s.country}/${s.taxCode}`);
    if (!s.confidence) errs.push(`E_CONFIDENCE_REQUIRED ${s.country}/${s.taxCode}`);
  }

  for (const m of raw.measures || []) {
    if (m.measureType === 'SECTION_232' && !m.tier232) errs.push(`E_232_TIER_MISSING ${m.country}/${m.measureType}`);
    if (m.contentAllocation || m.rateContent) errs.push(`E_CONTENT_ALLOCATION_LEGACY ${m.country}/${m.measureType}`);
    if (m.inTransitRule && !(new Date(m.inTransitRule.shipBy) < new Date(m.inTransitRule.enterBy)))
      errs.push(`E_INTRANSIT_RULE_INVALID ${m.country}/${m.measureType}`);
    if (m.confidence !== 'unverified' && !m.sourceUrl) errs.push(`E_SOURCE_REQUIRED ${m.country}/${m.measureType}`);
  }

  for (const c of raw.charges || []) {
    if (!c.validFrom) errs.push(`E_CHARGE_VALIDFROM_MISSING ${c.country}/${c.code}`);
  }

  return errs;
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
