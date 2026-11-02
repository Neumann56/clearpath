import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR, readJsonSafe } from './params.js';
import { diffDays } from './engine/dates.js';

export const DEFAULT_DUE_DAYS = { T0_BLOCK: 7, T1_BRANCH: 30, T2_IMPACT: 90, T3_FOOTNOTE: 180, T4_INTERNAL: 180 };

const FACTS_FILE = path.join(RUNTIME_DIR, 'unresolved.json');
const AUDIT_FILE = path.join(RUNTIME_DIR, 'unresolved_audit.jsonl');

function seedPath() {
  return path.join(RUNTIME_DIR, '..', 'params', 'unresolved.seed.json');
}

export function loadFacts() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!fs.existsSync(FACTS_FILE)) {
    const seed = readJsonSafe(seedPath(), []);
    fs.writeFileSync(FACTS_FILE, JSON.stringify(seed, null, 2), 'utf8');
    return seed;
  }
  return readJsonSafe(FACTS_FILE, []);
}

export function saveFacts(facts) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2), 'utf8');
}

export function audit(factId, fromStatus, toStatus, actor, reason, evidenceUrl, actorKey = null) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const line = JSON.stringify({
    factId,
    fromStatus,
    toStatus,
    actor,
    actorKey,
    reason,
    evidenceUrl: evidenceUrl || null,
    at: new Date().toISOString(),
  });
  fs.appendFileSync(AUDIT_FILE, line + '\n', 'utf8');
}

export function readAudit(factId) {
  try {
    const rows = fs
      .readFileSync(AUDIT_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return factId ? rows.filter((r) => r.factId === factId) : rows;
  } catch {
    return [];
  }
}

export function daysLeft(fact, today) {
  if (!fact.reviewDue) return null;
  return diffDays(today, fact.reviewDue);
}

/**
 * 逾期降级（PRD §6.8.3）：金额永不改变，改变的只是横幅与默认预选（§6.8.4 裁法）。
 */
export function degradeOf(fact, today) {
  const overdue = fact.reviewDue ? diffDays(fact.reviewDue, today) : 0;
  const tier = fact.displayTier;
  if (fact.status === 'resolved') return { level: 'none', overdue: 0, reason: '' };
  if (overdue <= 30) return { level: 'none', overdue: Math.max(0, overdue), reason: '' };
  if (overdue <= 90) return { level: 'yellow', overdue, reason: `该结论已 ${overdue} 天未复核，建议尽快核实` };
  if (tier === 'T1_BRANCH' && overdue > 180) {
    return { level: 'expired', overdue, reason: `该结论已 ${overdue} 天未复核，不再预选默认分支，请手动选择` };
  }
  return { level: 'red', overdue, reason: `该结论已 ${overdue} 天未复核，仅供参考` };
}

export function worstDegrade(facts, today) {
  const order = { none: 0, yellow: 1, red: 2, expired: 3 };
  let worst = { level: 'none', overdue: 0, reason: '' };
  for (const f of facts) {
    const d = degradeOf(f, today);
    if (order[d.level] > order[worst.level]) worst = d;
  }
  return { degraded: worst.level !== 'none', ...worst };
}

const TRANSITIONS = {
  open: ['in_review', 'superseded'],
  in_review: ['resolved', 'open'],
  resolved: [],
  expired: ['open'],
  superseded: [],
};

/** 状态机 + 强制审计（谁、何时、为什么、证据） */
export function transition({ factId, toStatus, actor, actorKey = null, reason, evidenceUrl }) {
  if (!actor) throw new Error('E_ACTOR_REQUIRED');
  if (!reason) throw new Error('E_REASON_REQUIRED');
  const facts = loadFacts();
  const fact = facts.find((f) => f.id === factId);
  if (!fact) throw new Error('E_FACT_NOT_FOUND');
  const allowed = TRANSITIONS[fact.status] || [];
  if (!allowed.includes(toStatus) && !(fact.status === 'expired' && toStatus === 'open')) {
    throw new Error(`E_TRANSITION_INVALID ${fact.status} -> ${toStatus}`);
  }
  if (toStatus === 'resolved' && !evidenceUrl && !fact.evidenceUrl) {
    throw new Error('E_EVIDENCE_REQUIRED');
  }
  // 双人复核：提交人与关闭人不能是同一人（BR / §5.9）
  // 两道都查：谁建的、谁派单核实的。任一同人都不许自己关。
  if (toStatus === 'resolved') {
    if (fact.createdBy && fact.createdBy === actor) throw new Error('E_REVIEWER_IS_AUTHOR');
    if (fact.reviewedBy && fact.reviewedBy === actor) throw new Error('E_REVIEWER_IS_AUTHOR');
  }
  const from = fact.status;
  fact.status = toStatus;
  if (evidenceUrl) fact.evidenceUrl = evidenceUrl;
  if (toStatus === 'in_review') {
    fact.owner = fact.owner || actor;
    fact.reviewedBy = actor;
  }
  fact.updatedAt = new Date().toISOString();
  if (toStatus === 'resolved') fact.resolvedAt = new Date().toISOString();
  saveFacts(facts);
  audit(factId, from, toStatus, actor, reason, evidenceUrl, actorKey);
  return fact;
}

export function reseatDue(facts, today) {
  return facts.map((f) => {
    if (f.status === 'expired') return f;
    const d = degradeOf(f, today);
    return { ...f, degrade: d, daysLeft: daysLeft(f, today) };
  });
}

/**
 * 报告生成后，把它挂到命中的待核项上。
 * 待核中心的"关联报告"不能是摆设：运营要能从一条待核直接跳到"哪几份报价被它影响了"。
 * 只保留最近 5 份，避免一条待核膨胀成几百个链接。
 */
export function linkReports(facts, report) {
  const ids = (report?.unresolved || []).map((u) => u.id).filter(Boolean);
  if (!ids.length) return false;
  let changed = false;
  for (const f of facts) {
    if (!ids.includes(f.id)) continue;
    const list = Array.isArray(f.relatedReports) ? f.relatedReports : [];
    if (list.includes(report.reportId)) continue;
    f.relatedReports = [report.reportId, ...list].slice(0, 5);
    changed = true;
  }
  return changed;
}

export const CSV_COLUMNS = [
  'id', 'title', 'category', 'display_tier', 'blocking', 'scope_countries', 'scope_hs_prefixes',
  'current_value', 'counter_value', 'current_basis', 'counter_basis', 'impact_rule', 'impact_usd_cached',
  'review_action', 'close_criteria', 'owner', 'review_due', 'status', 'created_by',
];

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  const missing = CSV_COLUMNS.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`E_CSV_HEADER_MISSING ${missing.join(',')}`);
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      displayTier: row.display_tier,
      blocking: row.blocking === 'true',
      scope: { countries: row.scope_countries.split('|').filter(Boolean), hsPrefixes: row.scope_hs_prefixes.split('|').filter(Boolean) },
      currentBasis: row.current_basis,
      counterBasis: row.counter_basis,
      impactRule: JSON.parse(row.impact_rule || '{}'),
      impactUsdCached: row.impact_usd_cached || null,
      reviewAction: row.review_action,
      closeCriteria: row.close_criteria,
      owner: row.owner,
      reviewDue: row.review_due,
      status: row.status || 'open',
      createdBy: row.created_by,
    };
  });
}
