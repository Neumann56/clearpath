/**
 * 参数治理（M7 的"可辩护"部分）
 *
 * 三条不许松的规则：
 *   1. 改参数不直接改线上文件 —— 先出草稿，线上继续按旧版本算
 *   2. 发布前强制跑黄金用例 —— 用例不过就不许发布（K2：参数更新不得改历史报告，
 *      但也意味着新参数必须先把"已知正确的票"算对，否则新票就不可信了）
 *   3. 提草稿的人不能自己批 —— 和待核项一样的双人规则
 *
 * 零依赖：跑用例用 child_process.execFileSync 调 node --test，不引测试框架。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PARAMS_DIR, RUNTIME_DIR, APP_ROOT, compareParamsFile } from './params.js';

export const DRAFTS_DIR = path.join(RUNTIME_DIR, 'drafts');
const GOLDEN_TEST = path.join(APP_ROOT, 'tests', 'golden.test.js');

/** 每个集合用什么做主键（决定 diff 是"新增"还是"改了一条"）
 *
 * charges / compliance 都用 id 优先：这两类一条记录可以挂一组国家（countries 数组），
 * 按 `${r.country}|${r.code}` 取键会得到 `undefined|undefined`，五条记录撞成同一个键，
 * 参数治理页的 diff 会把它们互相覆盖掉——改了哪条看不见。
 */
const KEY_OF = {
  tariffs: (r) => `${r.country || ''}|${r.hsPrefix || r.hsCode || ''}`,
  measures: (r) => `${r.country || ''}|${r.measureType || ''}`,
  taxSteps: (r) => `${r.country || ''}|${r.seq ?? ''}|${r.code || ''}`,
  charges: (r) => r.id || `${r.country || ''}|${r.lineCode || r.code || ''}`,
  compliance: (r) => r.id || `${r.country || ''}|${r.code || ''}`,
  fta: (r) => `${r.code || r.name || ''}`,
  countries: (r) => `${r.code || ''}`,
  dualUse: (r) => `${r.hsPrefix || r.code || ''}`,
};

const COLLECTIONS = Object.keys(KEY_OF);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function listVersions() {
  let files = [];
  try {
    files = fs.readdirSync(PARAMS_DIR).filter((f) => /^kb-.*\.json$/.test(f));
  } catch {
    return [];
  }
  return files
    .sort(compareParamsFile)
    .map((f) => {
      const full = path.join(PARAMS_DIR, f);
      const st = fs.statSync(full);
      let meta = {};
      try {
        const raw = readJson(full);
        meta = { version: raw.paramsVersion, asOf: raw.asOf, engineVersion: raw.engineVersion };
      } catch {
        meta = { version: f, broken: true };
      }
      const counts = {};
      try {
        const raw = readJson(full);
        for (const c of COLLECTIONS) counts[c] = (raw[c] || []).length;
      } catch {
        /* 坏文件不阻塞列表 */
      }
      return { file: f, size: st.size, mtime: st.mtime.toISOString(), counts, ...meta };
    })
    .reverse(); // 新的在前
}

/** 字段级 diff：改了的要能看到 oldRate → newRate，不是只说"变了" */
export function diffVersions(fileA, fileB) {
  const a = readJson(path.isAbsolute(fileA) ? fileA : path.join(PARAMS_DIR, fileA));
  const b = readJson(path.isAbsolute(fileB) ? fileB : path.join(PARAMS_DIR, fileB));
  const out = { added: [], removed: [], changed: [], meta: [] };

  for (const k of ['paramsVersion', 'asOf', 'engineVersion', 'productVersion', 'hsVersion', 'insuranceDefaultRate']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.meta.push({ field: k, from: a[k] ?? null, to: b[k] ?? null });
  }

  for (const coll of COLLECTIONS) {
    const la = a[coll] || [];
    const lb = b[coll] || [];
    const mapA = new Map(la.map((r) => [KEY_OF[coll](r), r]));
    const mapB = new Map(lb.map((r) => [KEY_OF[coll](r), r]));

    for (const [key, rb] of mapB) {
      const ra = mapA.get(key);
      if (!ra) {
        out.added.push({ collection: coll, key, item: rb });
        continue;
      }
      const fields = {};
      const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
      for (const f of keys) {
        if (f === '_note') continue;
        const va = JSON.stringify(ra[f]);
        const vb = JSON.stringify(rb[f]);
        if (va !== vb) fields[f] = { from: ra[f] ?? null, to: rb[f] ?? null };
      }
      if (Object.keys(fields).length) out.changed.push({ collection: coll, key, fields });
    }
    for (const [key, ra] of mapA) {
      if (!mapB.has(key)) out.removed.push({ collection: coll, key, item: ra });
    }
  }
  return out;
}

const nextVersionLabel = (today, dir = PARAMS_DIR) => {
  const base = `kb-${today.slice(0, 10).replace(/-/g, '.')}`;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(base));
  } catch {
    files = [];
  }
  if (!files.length) return { label: base, file: `${base}.json` };
  let n = 2;
  while (files.includes(`${base}-${n}.json`)) n++;
  return { label: `${base}-${n}`, file: `${base}-${n}.json` };
};

/**
 * 造草稿。patches 形如：
 *   { collection:'tariffs', key:'US|8708', field:'rate', to:'0.03' }
 *   { collection:'tariffs', field:'__add', to:{...} }
 *   { collection:'tariffs', key:'US|8708', field:'__remove' }
 */
export function createDraft({ baseFile, patches = [], author = '未署名', authorKey = null, note = '', today, paramsDir = PARAMS_DIR, draftsDir = DRAFTS_DIR }) {
  if (!patches.length) throw new Error('E_DRAFT_EMPTY 草稿里没有改动');
  const basePath = path.join(paramsDir, baseFile);
  const raw = readJson(basePath);
  const applied = [];

  for (const p of patches) {
    const coll = String(p.collection || '');
    if (!COLLECTIONS.includes(coll)) throw new Error(`E_PATCH_BAD_COLLECTION 不认识的集合：${coll}`);
    raw[coll] = raw[coll] || [];

    if (p.field === '__add') {
      raw[coll].push(p.to);
      applied.push({ collection: coll, key: KEY_OF[coll](p.to), action: '新增' });
      continue;
    }

    const idx = raw[coll].findIndex((r) => KEY_OF[coll](r) === p.key);
    if (idx < 0) throw new Error(`E_PATCH_KEY_NOT_FOUND 找不到 ${coll} / ${p.key}`);

    if (p.field === '__remove') {
      const [rm] = raw[coll].splice(idx, 1);
      applied.push({ collection: coll, key: p.key, action: '删除', item: rm });
      continue;
    }

    const before = raw[coll][idx][p.field];
    raw[coll][idx][p.field] = p.to;
    applied.push({ collection: coll, key: p.key, field: p.field, from: before ?? null, to: p.to });
  }

  const { label, file } = nextVersionLabel(today || new Date().toISOString().slice(0, 10), paramsDir);
  raw.paramsVersion = label;

  fs.mkdirSync(draftsDir, { recursive: true });
  const id = `draft-${Date.now().toString(36)}`;
  const draftPath = path.join(draftsDir, `${id}.json`);
  const record = {
    id,
    createdAt: new Date().toISOString(),
    baseFile,
    baseVersion: readJson(basePath).paramsVersion,
    targetVersion: label,
    targetFile: file,
    author,
    authorKey,
    note,
    patches,
    applied,
    status: 'draft',
  };
  fs.writeFileSync(draftPath, JSON.stringify(raw, null, 2), 'utf8');
  fs.writeFileSync(path.join(draftsDir, `${id}.meta.json`), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function listDrafts(draftsDir = DRAFTS_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return readJson(path.join(draftsDir, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getDraft(id, draftsDir = DRAFTS_DIR) {
  return listDrafts(draftsDir).find((d) => d.id === id) || null;
}

export function draftPathOf(id, draftsDir = DRAFTS_DIR) {
  return path.join(draftsDir, `${id}.json`);
}

/** 跑黄金用例。返回 {passed, total, failedCases[]} */
export function runGolden(paramsFile, { timeoutMs = 120000 } = {}) {
  if (!fs.existsSync(GOLDEN_TEST)) return { passed: false, total: 0, failedCases: [], error: 'E_GOLDEN_MISSING' };
  // 必须摘掉 NODE_TEST_CONTEXT：子进程若继承它，node 会以"被父 runner 调度"的模式启动，
  // --test 不产出汇总行，结果看起来像 0 项通过（这次踩过）。
  const env = { ...process.env, TT_PARAMS_FILE: paramsFile };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', GOLDEN_TEST], {
    cwd: APP_ROOT,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const passM = /^# pass (\d+)/m.exec(out);
  const failM = /^# fail (\d+)/m.exec(out);
  const total = passM ? Number(passM[1]) : 0;
  const fail = failM ? Number(failM[1]) : 0;
  const failedCases = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { passed: r.status === 0 && fail === 0, total, failed: fail, failedCases, tail: out.slice(-1500) };
}

/**
 * 发布：双人复核 + 黄金用例门禁 + 写新版本文件。
 * 任何一步不过，线上参数一个字节都不动。
 */
export function publish(draftId, reviewer = {}, { paramsDir = PARAMS_DIR, draftsDir = DRAFTS_DIR } = {}) {
  const record = getDraft(draftId, draftsDir);
  if (!record) throw new Error('E_DRAFT_NOT_FOUND 草稿不存在');
  if (record.status === 'published') throw new Error('E_DRAFT_PUBLISHED 这份草稿已经发布过了');

  if (!reviewer.key) throw new Error('E_OPERATOR_INVALID 缺少复核人身份');
  if (record.authorKey && reviewer.key === record.authorKey) {
    throw new Error('E_REVIEWER_IS_AUTHOR 提案人不能自己批准，需要另一个人复核');
  }

  const src = draftPathOf(draftId, draftsDir);
  if (!fs.existsSync(src)) throw new Error('E_DRAFT_BODY_MISSING 草稿正文丢了');

  // 发布前强制回归：不通过就不许上线
  const golden = runGolden(src);
  if (!golden.passed) {
    record.lastGolden = { at: new Date().toISOString(), ...golden, tail: undefined };
    fs.writeFileSync(path.join(draftsDir, `${draftId}.meta.json`), JSON.stringify(record, null, 2), 'utf8');
    const e = new Error(
      `E_GOLDEN_FAILED 黄金用例未通过（${golden.failed || golden.failedCases.length} 项失败），已拒绝发布：${
        golden.failedCases.slice(0, 3).join('；') || '见服务端日志'
      }`
    );
    e.golden = golden;
    throw e;
  }

  const target = path.join(paramsDir, record.targetFile);
  if (fs.existsSync(target)) throw new Error(`E_VERSION_EXISTS 目标版本已存在：${record.targetFile}`);
  fs.copyFileSync(src, target);

  record.status = 'published';
  record.publishedAt = new Date().toISOString();
  record.reviewer = reviewer.name || reviewer.key;
  record.reviewerKey = reviewer.key;
  record.lastGolden = { at: new Date().toISOString(), passed: true, total: golden.total };
  fs.writeFileSync(path.join(draftsDir, `${draftId}.meta.json`), JSON.stringify(record, null, 2), 'utf8');

  return { record, targetFile: record.targetFile, version: record.targetVersion, golden };
}

/** 给前端下拉用的基版本列表 */
export function baseVersions() {
  return listVersions().map((v) => ({ file: v.file, version: v.version, asOf: v.asOf, mtime: v.mtime }));
}
