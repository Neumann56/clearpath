import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { loadParams, validateParams, RUNTIME_DIR, APP_ROOT, readJsonSafe } from './lib/params.js';
import { buildReport, toApi } from './lib/report.js';
import { loadFacts, reseatDue, transition, audit, parseCsv, saveFacts, readAudit, linkReports } from './lib/unresolved.js';
import { parseText, hsMeta } from './lib/parse.js';
import { buildDigest, bucketFacts, sendDigest } from './lib/notify.js';
import { resolveOperator, operatorList, operatorName } from './lib/operators.js';
import { calibrate, appendCalibration, enqueueParamReview, readQueue, readCalibrations } from './lib/calibrate.js';
import { calibrationStats } from './lib/calibStats.js';
import { listVersions, listDrafts, createDraft, publish, diffVersions } from './lib/paramsStore.js';
import { runScenario, normalizeShipment, hsDisplay } from './lib/engine/quote.js';
import {
  layout, esc, homePage, newPage, confirmPage, reportPage, reportsPage, printPage,
  unresolvedPage, paramsPage, paramsDiffPage, calibratePage, calibrationPage, batchPage, calendarPage,
  learnPage, marketPage, shopGuidePage, guidePage, aboutPage,
} from './lib/render.js';
import { loadTrend, marketView, marketIndex } from './lib/market.js';
import { loadLearnContent, defaultLearnPath } from './lib/learn.js';
import { prefetch } from './lib/assistant-agent.js';
import { coverageView, calendarView, learnView, REGION_LABEL } from './lib/api-views.js';
// mReport 这个名字下面已经被 `/quote/:id/report` 那个 matcher 占用了，
// 直接用同名会撞 TDZ（Cannot access before initialization），所以这里起个不重名的别名。
import { mHome, mNew, mReport as mReportPage, mReports, mCalendar, mLearn, mChat } from './lib/mobile.js';

const PORT = Number(process.env.PORT || 4173);
// 本地双击启动默认只监听回环：绑 0.0.0.0 会触发 Windows 防火墙弹窗，演示时容易卡在这一步。
// 但托管环境（平台注入 PORT）必须绑 0.0.0.0，否则反向代理连不进来、分享链接是空的——
// 而且它不会报错，只会一直 502。所以用"有没有被注入 PORT"来区分这两种场景。
const DEPLOYED = Boolean(process.env.PORT);
const HOST = process.env.HOST || (DEPLOYED ? '0.0.0.0' : '127.0.0.1');
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const ADMIN = {
  user: process.env.ADMIN_USER || 'admin',
  pass: process.env.ADMIN_PASS || 'tantu2026',
};

const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const REPORTS_DIR = path.join(RUNTIME_DIR, 'reports');
const INDEX_FILE = path.join(RUNTIME_DIR, 'index.json');
const IDEMP_FILE = path.join(RUNTIME_DIR, 'idempotency.json');
const EVENTS_FILE = path.join(RUNTIME_DIR, 'events.jsonl');
const CAL_FILE = path.join(RUNTIME_DIR, 'calibrations.jsonl');
const ARCHIVE_DIR = path.join(RUNTIME_DIR, 'archives');

for (const d of [RUNTIME_DIR, REPORTS_DIR, ARCHIVE_DIR]) fs.mkdirSync(d, { recursive: true });

// 视频栏目是静态内容，启动时读一次。改 data/content/videos.json 后重启生效。
// 读不出来不抛错：栏目页会自己显示"内容没导进来"，其余页面照常。
const LEARN = loadLearnContent(defaultLearnPath(APP_ROOT));
if (!LEARN.ok) console.warn(`[learn] 视频栏目未加载：${LEARN.reason}`);
if (LEARN.dropped.length) console.warn(`[learn] ${LEARN.dropped.length} 条内容未通过校验：`, LEARN.dropped.map((d) => `${d.id}(${d.why})`).join('、'));

// ---------- 启动自检：参数错误 fail-fast；待核项不影响启动（§6.10） ----------
let params = loadParams(); // 发布后热重载：发布即生效，不用重启服务
const paramErrors = validateParams(params.raw);
if (paramErrors.length) {
  console.error('参数自检失败，拒绝启动：');
  for (const e of paramErrors) console.error(' -', e);
  process.exit(1);
}
console.log(`[通途] 参数版本 ${params.version} · 引擎 ${params.raw.engineVersion} · asOf ${params.asOf}`);

// ---------- 存储 ----------
const cryptoJson = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
/**
 * 幂等指纹：对整个 input 做确定性哈希，而不是挑字段。
 *
 * 曾经是白名单（只取 country/hs/fob/freight/qty/日期/含量/AD），
 * 结果新增 areaSqm 时忘了加——两票面积不同的光伏单被算成同一票，
 * 第二票直接返回第一票的报告，金额一模一样还不报错。
 * 白名单的失效方式是静默的：加字段的人不知道要来这里登记。
 * 所以改成"除噪声字段外全量纳入"，加新字段不需要再改这里。
 */
const fingerprint = (input) => {
  const noise = new Set(['idempotencyKey', 'initialBranch']);
  const norm = {};
  for (const k of Object.keys(input).sort()) {
    if (noise.has(k)) continue;
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    norm[k] = v;
  }
  return cryptoJson(norm);
};

function saveReport(report, did) {
  fs.writeFileSync(path.join(REPORTS_DIR, `${report.reportId}.json`), JSON.stringify(report, null, 2), 'utf8');
  const idx = readJsonSafe(INDEX_FILE, []);
  idx.unshift({
    reportId: report.reportId,
    createdAt: report.createdAt,
    did: did || null,
    country: report.input.country,
    hsCode: report.input.hsCode,
    landedCost: report.expected?.landedCost ?? null,
    cashRequired: report.expected?.cashRequired ?? null,
    state: report.state,
    paramsVersion: report.meta.paramsVersion,
  });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx.slice(0, 500), null, 2), 'utf8');
}

function loadReport(id) {
  const f = path.join(REPORTS_DIR, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  return readJsonSafe(f, null);
}

function listReports(did) {
  const idx = readJsonSafe(INDEX_FILE, []);
  return did ? idx.filter((r) => r.did === did) : idx;
}

/** 演示样例：seed-demo 预置的报告（did=demo）。只读，不算进用户历史。 */
function listDemoReports() {
  const idx = readJsonSafe(INDEX_FILE, []);
  const seen = new Set();
  return idx
    .filter((r) => r.did === 'demo' && r.demoKey)
    .filter((r) => (seen.has(r.demoKey) ? false : seen.add(r.demoKey)))
    .slice(0, 4);
}

function recordEvent(ev) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...ev, ts: new Date().toISOString() }) + '\n', 'utf8');
}

// ---------- HTTP helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
/** 静态型 JSON：带 ETag 与长缓存，命中 If-None-Match 回 304（省流量也省冷启动） */
function sendCached(req, res, body, cacheKey = '') {
  const raw = JSON.stringify(body);
  const etag = `"${crypto.createHash('sha1').update(cacheKey + '|' + raw).digest('hex').slice(0, 16)}"`;
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(',').map((x) => x.trim()).includes(etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    ETag: etag,
  });
  return res.end(raw);
}

const sendHtml = (res, html, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('E_BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('E_BODY_INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), decodeURIComponent(kv.slice(i + 1).trim())];
      })
  );
}

function ensureDevice(req, res) {
  const c = cookies(req);
  if (c.tt_did) return c.tt_did;
  // 小程序没有浏览器的 cookie 自动往返：wx.request 不会替你保存 Set-Cookie。
  // 所以允许它用 X-Device-Id 头自带设备号，否则历史报告在手机上永远是空的。
  // 只收「字母数字加短横、8–40 位」，避免有人拿这个头塞别的东西进去。
  const h = String(req.headers['x-device-id'] || '').trim();
  if (/^[A-Za-z0-9-]{8,40}$/.test(h)) return h;
  const did = 'dev-' + crypto.randomUUID().slice(0, 8);
  res.setHeader('Set-Cookie', `tt_did=${did}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return did;
}

function checkBasic(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (u === ADMIN.user && p === ADMIN.pass) return true;
  }
  return false;
}

/**
 * 写操作的身份：必须由服务端解析，绝不接受 body.actor。
 * 否则同一个浏览器改个名字就能绕过 E_REVIEWER_IS_AUTHOR。
 */
// 服务端错误码 → 人话（前端直接弹 message，不该让人看到 E_ 开头的串）
const ERR_TEXT = {
  E_REVIEWER_IS_AUTHOR: '自己派单核实的项不能自己关闭。关闭需要另一个人复核——这正是"每笔结论都能被追问"的前提。',
  E_TRANSITION_INVALID: '这个状态跳转不允许（比如已关闭的项不能直接重新打开）。',
  E_EVIDENCE_REQUIRED: '关闭必须附证据链接：公告、税则原文或报关回执。',
  E_REASON_REQUIRED: '必须写一句话结论：支持当前取值，还是要改成反事实。',
  E_FACT_NOT_FOUND: '待核项不存在，可能已被合并或删除。',
  E_ACTOR_REQUIRED: '缺少操作人身份。',
};

function requireOperator(req, res) {
  const op = resolveOperator(req, checkBasic(req) ? ADMIN.user : null);
  if (!op || op.invalid) {
    send(res, 401, {
      code: 'E_OPERATOR_INVALID',
      message: op?.invalid ? `操作人标识无效：${op.key}` : '需要有效的操作人身份（X-Operator-Key 请求头）',
    });
    return null;
  }
  return op;
}

function requireAdmin(req, res) {
  if (checkBasic(req)) return true;
  // realm 必须是 ASCII：HTTP 头按 latin1 编码，写中文会抛 ERR_INVALID_CHAR（表现为 500 而不是 401）
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tongtu Admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要内网账号。演示请走 /demo/unresolved');
  return false;
}

function serveStatic(req, res, p) {
  const rel = p.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': rel.startsWith('js/') || rel.startsWith('css/') ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

// ---------- 业务 ----------
function factsForToday(asOfOverride) {
  const today = asOfOverride && /^\d{4}-\d{2}-\d{2}$/.test(asOfOverride) ? asOfOverride : params.asOf;
  const facts = reseatDue(loadFacts(), today);
  return { facts, today };
}

function createReport(input, initialBranch) {
  const facts = loadFacts();
  const reportId = crypto.randomUUID();
  const res = buildReport({ input, params, facts, reportId, today: params.asOf });
  if (!res.ok) return res;
  const report = res.report;
  if (initialBranch && report.branches && report.branches.some((b) => b.branchId === initialBranch)) {
    // 落库：确认页选择的分支（不改金额，只记 initial_branch_used）
    report.initialBranchUsed = initialBranch;
  }
  report.snapshotHash = cryptoJson({ expected: report.expected, meta: report.meta });
  return { ok: true, report };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const did = ensureDevice(req, res);

  if (p === '/api/meta/countries') {
    return sendCached(
      req,
      res,
      {
        // region 是给移动端分组用的：68 个国家平铺在一个 picker 里没人找得到
        countries: params.raw.countries.map((c) => ({
          code: c.code,
          name: c.name,
          supported: c.supported,
          entryEnabled: c.entryEnabled,
          region: c.region || '',
          regionLabel: REGION_LABEL[c.region] || c.region || '',
        })),
        paramsVersion: params.version,
        asOf: params.asOf,
      },
      params.version
    );
  }

  if (p === '/api/meta/hs') {
    const q = url.searchParams.get('q') || '';
    return sendCached(req, res, { results: hsMeta(params, q) }, `${params.version}|hs|${q}`);
  }

  // ---------- 移动端（小程序 / H5）专用：这三块原先只有服务端渲染的 HTML，取不到数据 ----------
  // 覆盖范围：首页「68 个市场 × 6 个品类」那行数字的唯一来源
  if (p === '/api/meta/coverage') {
    return sendCached(req, res, coverageView(params), `${params.version}|coverage`);
  }

  // 政策日历。today 可传，用来推演「如果 12 月申报会撞上什么」
  if (p === '/api/calendar') {
    const today = url.searchParams.get('today') || params.asOf;
    return sendCached(req, res, calendarView(params, today), `${params.version}|cal|${today}`);
  }

  // 市场热度：某市场某品类的真实进口额（UN Comtrade 快照）。
  // 这是宏观背景数据，与成本口径完全隔离——不进 landedCost，也不进 cashRequired。
  if (p === '/api/market/trend') {
    const want = String(url.searchParams.get('country') || 'HU').toUpperCase();
    const code = params.raw.countries.some((c) => c.code === want) ? want : 'HU';
    const snap = loadTrend();
    const cacheKey = `${params.version}|mkt|${code}|${snap ? snap.asOf : 'none'}`;
    return sendCached(req, res, marketView(params, snap, code), cacheKey);
  }

  // 「看懂外贸」视频清单。内容是启动时读的静态文件，重启才变更
  if (p === '/api/learn') {
    return sendCached(req, res, learnView(LEARN), `${params.version}|learn`);
  }

  if (p === '/api/parse' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, parseText(body.text || '', params));
  }

  // 老周的事实预取：只读、不打模型、不花额度。
  // 认出问题里的编码/品名+国家就去参数库查，查不到回 { kind: 'none' }，
  // 前端据此退化成纯常识回答——这条链路失败不该影响对话。
  if (p === '/api/assistant/prefetch' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, prefetch(body.question || '', params) || { kind: 'none' });
  }

  if (p === '/api/quote/precheck' && req.method === 'POST') {
    const body = await readBody(req);
    const resv = buildReport({ input: body.input || {}, params, facts: loadFacts(), reportId: 'precheck', today: params.asOf });
    if (!resv.ok) return send(res, resv.errors[0].http || 400, { code: resv.errors[0].code, message: resv.errors[0].message, errors: resv.errors });
    const r = resv.report;
    return send(res, 200, {
      state: r.state,
      entryDateSource: r.entryDateSource,
      expected: r.expected,
      branches: r.branches || null,
      unresolved: r.unresolved,
      assumptions: r.assumptions,
      classification: r.classification,
      range: r.range,
      access: r.access,
      input: r.input,
    });
  }

  if (p === '/api/quote' && req.method === 'POST') {
    const body = await readBody(req);
    const input = body.input || body;
    // 幂等键必须带参数版本：否则参数库里新增了措施/优惠/子目之后，
    // 同一票在 24 小时内仍会命中旧快照，用户看到的是"功能没生效"。
    // 也必须带设备号：幂等是为了防"同一个人重复点提交"，不是跨用户共享结果。
    // 少了 did 会出现——A 算过的票，B 填同样数字拿到 A 的 reportId，
    // 而 B 的历史列表里没有它（那份报告的 did 是 A），点进去还能看到 A 的单。
    // 旧报告文件保持不动（K4 只管历史金额），这里只是不再拿它当新请求的答案。
    const key =
      req.headers['idempotency-key'] ||
      body.idempotencyKey ||
      `${fingerprint(input)}@${params.version}@${did}`;
    const store = readJsonSafe(IDEMP_FILE, {});
    const hit = store[key];
    if (hit && Date.now() - hit.at < 24 * 3600 * 1000) {
      const again = loadReport(hit.reportId);
      if (again) return send(res, 200, { ...again, idempotent: true });
    }
    const out = createReport(input, body.initialBranch);
    if (!out.ok) {
      const e = out.errors[0];
      return send(res, e.http || 400, { code: e.code, message: e.message, errors: out.errors });
    }
    saveReport(out.report, did);
    // 闭环：把这份报告挂到它命中的待核项上，待核中心才能点回来
    {
      const f = loadFacts();
      if (linkReports(f, out.report)) saveFacts(f);
    }
    store[key] = { reportId: out.report.reportId, at: Date.now() };
    fs.writeFileSync(IDEMP_FILE, JSON.stringify(store), 'utf8');
    recordEvent({ event: 'EV_QUOTE_SUBMIT', reportId: out.report.reportId, props: { state: out.report.state } });
    return send(res, 200, out.report);
  }

  // 批量试算：商家一次几百个 SKU 是真实场景，一票一票录不现实
  if (p === '/api/quote/batch' && req.method === 'POST') {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return send(res, 400, { code: 'E_BATCH_EMPTY', message: '没有可试算的行' });
    if (rows.length > 200) {
      return send(res, 413, { code: 'E_BATCH_TOO_LARGE', message: `一次最多 200 行，本次 ${rows.length} 行。请分批提交。` });
    }

    const store = readJsonSafe(IDEMP_FILE, {});
    const factsAll = loadFacts();
    let factsDirty = false;
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const input = rows[i] || {};
      try {
        const key = `${fingerprint(input)}@${params.version}@${did}`;
        const hit = store[key];
        if (hit && Date.now() - hit.at < 24 * 3600 * 1000) {
          const again = loadReport(hit.reportId);
          if (again) {
            results.push({
              index: i,
              reportId: again.reportId,
              landedCost: again.expected?.landedCost ?? null,
              cashRequired: again.expected?.cashRequired ?? null,
              state: again.state,
              country: again.input?.country,
              hsCode: again.input?.hsCode,
              idempotent: true,
            });
            continue;
          }
        }
        const out = createReport(input, body.initialBranch);
        if (!out.ok) {
          // 批量场景下只报第一条，会让人改一行提交一次；这里把这一行的全部问题一次说清
          results.push({
            index: i,
            error: {
              code: out.errors[0].code,
              codes: out.errors.map((e) => e.code),
              message: out.errors.map((e) => e.message).join('；'),
            },
          });
          continue;
        }
        saveReport(out.report, did);
        if (linkReports(factsAll, out.report)) factsDirty = true;
        store[key] = { reportId: out.report.reportId, at: Date.now() };
        results.push({
          index: i,
          reportId: out.report.reportId,
          landedCost: out.report.expected?.landedCost ?? null,
          cashRequired: out.report.expected?.cashRequired ?? null,
          state: out.report.state,
          country: out.report.input.country,
          hsCode: out.report.input.hsCode,
        });
      } catch (e) {
        results.push({ index: i, error: { code: 'E_ROW_FAILED', message: String(e.message || e) } });
      }
    }

    if (factsDirty) saveFacts(factsAll);
    fs.writeFileSync(IDEMP_FILE, JSON.stringify(store), 'utf8');
    const okCount = results.filter((r) => !r.error).length;
    recordEvent({ event: 'EV_QUOTE_SUBMIT', props: { batch: rows.length, ok: okCount } });
    return send(res, 200, { ok: okCount, failed: results.length - okCount, results });
  }

  const mReport = p.match(/^\/api\/report\/([0-9a-f-]+)$/);
  if (mReport && req.method === 'GET') {
    const r = loadReport(mReport[1]);
    if (!r) return send(res, 404, { code: 'E_REPORT_NOT_FOUND', message: '报告不存在' });
    return send(res, 200, r);
  }

  if (p === '/api/reports' && req.method === 'GET') {
    // 补上国家中文名：索引里只存了代码（HU / BR），
    // 客户端要自己查一遍才能显示成「匈牙利」，不如这里给全。
    const names = new Map((params.raw.countries || []).map((c) => [c.code, c.name]));
    return send(res, 200, {
      reports: listReports(did).map((r) => ({ ...r, countryName: names.get(r.country) || r.country })),
    });
  }

  if (p === '/api/admin/params' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, { current: params.file, versions: listVersions(), drafts: listDrafts() });
  }

  if (p === '/api/admin/params/draft' && req.method === 'POST') {
    const op = requireOperator(req, res);
    if (!op) return;
    const body = await readBody(req);
    try {
      const rec = createDraft({
        baseFile: body.baseFile || params.file,
        patches: [
          {
            collection: body.collection,
            key: body.key,
            field: body.field,
            to: body.field === '__add' || body.field === '__remove' ? body.to : body.to,
          },
        ],
        author: op.name,
        authorKey: op.key,
        note: body.note || '',
        today: params.asOf,
      });
      return send(res, 200, { ok: true, draft: rec });
    } catch (e) {
      const code = String(e.message).split(' ')[0];
      return send(res, 400, { code, message: String(e.message) });
    }
  }

  if (p === '/api/admin/params/publish' && req.method === 'POST') {
    const op = requireOperator(req, res);
    if (!op) return;
    const body = await readBody(req);
    try {
      const out = publish(body.draftId, { key: op.key, name: op.name });
      // 发布即生效：重新加载最新版本文件；历史报告仍按各自记录的版本复现（K2）
      params = loadParams();
      recordEvent({ event: 'EV_PARAMS_PUBLISH', props: { draftId: body.draftId, version: out.version } });
      return send(res, 200, {
        ok: true,
        version: out.version,
        targetFile: out.targetFile,
        golden: { passed: out.golden.passed, total: out.golden.total },
        note: '新版本已生效：下一次试算就用它；历史报告仍按各自记录的版本复现。',
      });
    } catch (e) {
      const code = String(e.message).split(' ')[0];
      const msg = {
        E_GOLDEN_FAILED: '黄金用例没跑过，已拒绝发布。线上参数没有任何变化。',
        E_REVIEWER_IS_AUTHOR: '提案人不能自己批准，换一个人复核。',
        E_DRAFT_PUBLISHED: '这份草稿已经发布过了。',
        E_VERSION_EXISTS: '目标版本文件已存在，请换基线重新提草稿。',
      }[code];
      return send(res, 400, { code, message: msg || String(e.message), golden: e.golden || null });
    }
  }

  if (p === '/api/admin/calibration/stats' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const today = url.searchParams.get('today') || new Date().toISOString().slice(0, 10);
    const stats = calibrationStats(readCalibrations(), today);
    return send(res, 200, { ...stats, queue: readQueue().filter((q) => q.status === 'pending') });
  }

  const mCal = p.match(/^\/api\/report\/([0-9a-f-]+)\/calibrate$/);
  if (mCal) {
    const r = loadReport(mCal[1]);
    if (!r) return send(res, 404, { code: 'E_REPORT_NOT_FOUND', message: '报告不存在' });

    if (req.method === 'GET') {
      return send(res, 200, {
        reportId: r.reportId,
        predicted: {
          duty: r.expected?.duty ?? null,
          surtax: r.expected?.surtax ?? null,
          taxTotal: r.expected?.taxTotal ?? null,
          refundableVat: r.expected?.refundableVat ?? null,
          charges: r.expected?.charges ?? null,
          adDeposit: r.expected?.remedy?.applicable ? r.expected.remedy.deposit : null,
          landedCost: r.expected?.landedCost ?? null,
          cashRequired: r.expected?.cashRequired ?? null,
        },
        entryDate: r.input?.dates?.entryDate || null,
        queue: readQueue().filter((x) => x.reportId === r.reportId),
      });
    }

    if (req.method !== 'POST') return send(res, 405, { code: 'E_METHOD', message: '只支持 GET/POST' });

    const body = await readBody(req);
    const facts = loadFacts();

    let out;
    try {
      out = calibrate(r, body, { params, facts });
    } catch (e) {
      const code = String(e.code || e.message || 'E_CALIBRATE').split(' ')[0];
      return send(res, 400, { code, message: String(e.message).replace(/^\S+\s*/, '') });
    }

    // 参数错才入队；其它三类只记录，不进复核队列（否则队列会被输入错误淹没）
    const queued = [];
    if (out.primaryAttribution === '参数错') {
      for (const line of out.lines) {
        if (line.attribution !== '参数错') continue;
        const q = enqueueParamReview({
          reportId: r.reportId,
          line: line.key,
          diff: line.diff,
          suspectParam: line.factId || (line.key === 'duty' ? `${r.input.country}/MFN` : null),
          note: line.note,
        });
        queued.push({ line: line.key, id: q.id, added: q.added });
      }
    }

    const record = {
      reportId: r.reportId,
      at: new Date().toISOString(),
      country: r.input?.country,
      countryName: r.input?.countryName,
      hsCode: r.input?.hsCode,
      actual: body,
      predicted: {
        duty: r.expected?.duty ?? null,
        surtax: r.expected?.surtax ?? null,
        taxTotal: r.expected?.taxTotal ?? null,
        refundableVat: r.expected?.refundableVat ?? null,
        charges: r.expected?.charges ?? null,
        landedCost: r.expected?.landedCost ?? null,
        cashRequired: r.expected?.cashRequired ?? null,
      },
      lines: out.lines,
      landedCostDiff: out.landedCostDiff,
      cashRequiredDiff: out.cashRequiredDiff,
      primaryAttribution: out.primaryAttribution,
      routedTo: out.routedTo,
      diffPct: r.expected?.landedCost ? Math.abs(out.landedCostDiff) / r.expected.landedCost : null,
      paramsVersion: params.version,
    };
    appendCalibration(record);
    recordEvent({
      event: 'EV_CALIBRATE_UPLOAD',
      reportId: r.reportId,
      props: { diffPct: record.diffPct, attribution: out.primaryAttribution, lines: out.lines.length },
    });

    return send(res, 200, {
      ...out,
      queued,
      predicted: record.predicted,
      disclaimer: '校准只用于改进参数与文案，不改变这份报告的历史金额。',
    });
  }

  const mExp = p.match(/^\/api\/report\/([0-9a-f-]+)\/export$/);
  if (mExp && req.method === 'POST') {
    const r = loadReport(mExp[1]);
    if (!r) return send(res, 404, { code: 'E_REPORT_NOT_FOUND', message: '报告不存在' });
    const archive = {
      report: r,
      paramsSnapshotHash: params.version,
      branchSnapshot: r.branches ? r.branches.map((b) => ({ branchId: b.branchId, landedCost: b.landedCost, isDefault: b.isDefault })) : null,
      initialBranchUsed: r.initialBranchUsed || r.branches?.find((b) => b.isDefault)?.branchId || null,
      generatedAt: new Date().toISOString(),
    };
    const file = path.join(ARCHIVE_DIR, `${r.reportId}.json`);
    fs.writeFileSync(file, JSON.stringify(archive, null, 2), 'utf8');
    recordEvent({ event: 'EV_EXPORT', reportId: r.reportId, props: { format: 'json+snapshot' } });
    return send(res, 200, { ok: true, path: file.replace(/\\/g, '/'), archiveVersion: 1 });
  }

  if (p === '/api/unresolved' && req.method === 'GET') {
    const { facts, today } = factsForToday(url.searchParams.get('asOf'));
    return send(res, 200, { today, facts });
  }

  if (p === '/api/unresolved' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const facts = loadFacts();
    if (facts.some((f) => f.id === body.id)) return send(res, 409, { code: 'E_FACT_EXISTS', message: 'ID 已存在' });
    facts.push({ ...body, status: body.status || 'open', createdBy: body.createdBy || ADMIN.user });
    saveFacts(facts);
    audit(body.id, null, body.status || 'open', ADMIN.user, body.reason || '新建待核项');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/unresolved/import' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    try {
      const rows = parseCsv(body.csv || '');
      const facts = loadFacts();
      for (const r of rows) {
        const i = facts.findIndex((f) => f.id === r.id);
        if (i >= 0) facts[i] = { ...facts[i], ...r };
        else facts.push(r);
      }
      saveFacts(facts);
      return send(res, 200, { ok: true, imported: rows.length });
    } catch (e) {
      return send(res, 400, { code: 'E_CSV_INVALID', message: String(e.message) });
    }
  }

  const mPatch = p.match(/^\/api\/unresolved\/([A-Za-z0-9-]+)$/);
  if (mPatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const op = requireOperator(req, res);
    if (!op) return;
    const body = await readBody(req);
    if (body.actor) {
      // 明确拒绝而不是静默忽略：让调用方知道这个名字不算数
      return send(res, 400, {
        code: 'E_ACTOR_FROM_BODY',
        message: '操作人身份必须来自 X-Operator-Key 请求头，请求体里的 actor 不被接受',
      });
    }
    try {
      const fact = transition({
        factId: mPatch[1],
        toStatus: body.status,
        actor: op.name,
        actorKey: op.key,
        reason: body.reason,
        evidenceUrl: body.evidenceUrl,
      });
      return send(res, 200, { ok: true, fact });
    } catch (e) {
      const code = String(e.message).split(' ')[0];
      return send(res, 400, { code, message: ERR_TEXT[code] || String(e.message) });
    }
  }

  if (p === '/api/events' && req.method === 'POST') {
    const body = await readBody(req);
    recordEvent({ ...body, did });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { code: 'E_NOT_FOUND', message: '接口不存在' });
}

async function handlePage(req, res, url) {
  const p = url.pathname;
  const did = ensureDevice(req, res);

  // ---------- 移动端（/m）：小程序同款信息架构，服务端渲染 ----------
  // 单独一套模板而不是给 PC 页加媒体查询：手机上要的是"先给两个数、明细折叠"，
  // 和 PC 的表格顺序是反的，用同一份 HTML 硬改只会两头都不好用。
  if (p === '/m' || p === '/m/') {
    // 首页那两个数的占位：优先用这台设备最近算过的一票，没有就用预置样例。
    // 写死一个数字看着省事，但参数一更新它就是假的——宁可显示「—」也不写死。
    const own = listReports(did)[0];
    const demo = own ? null : listDemoReports()[0];
    const pick = own || demo;
    const sample = pick
      ? {
          ...pick,
          isOwn: Boolean(own),
          countryName: (params.raw.countries || []).find((c) => c.code === pick.country)?.name || pick.country,
        }
      : null;
    return sendHtml(res, mHome({ params, coverage: coverageView(params), sample }));
  }

  if (p === '/m/new') {
    const preset = Object.fromEntries(url.searchParams);
    const cn = preset.country ? (params.raw.countries || []).find((c) => c.code === preset.country) : null;
    if (cn) preset.countryName = cn.name;
    return sendHtml(res, mNew({ params, preset }));
  }

  if (p === '/m/chat') return sendHtml(res, mChat());

  if (p === '/m/calendar') {
    const today = url.searchParams.get('today') || new Date().toISOString().slice(0, 10);
    return sendHtml(res, mCalendar({ view: calendarView(params, today) }));
  }

  if (p === '/m/learn') return sendHtml(res, mLearn({ view: learnView(LEARN) }));

  if (p === '/m/reports') {
    return sendHtml(res, mReports({ list: listReports(did), demos: listDemoReports() }));
  }

  const mMobileReport = p.match(/^\/m\/report\/([0-9a-f-]+)$/);
  if (mMobileReport) {
    const r = loadReport(mMobileReport[1]);
    if (!r) {
      return sendHtml(
        res,
        mReports({ list: listReports(did) }),
        404
      );
    }
    recordEvent({ event: 'EV_REPORT_VIEW', reportId: r.reportId, props: { state: r.state, via: 'm' } });
    return sendHtml(res, mReportPage({ report: r }));
  }

  if (p === '/') return sendHtml(res, homePage(params, loadFacts()));
  if (p === '/quote/new') return sendHtml(res, newPage(params, Object.fromEntries(url.searchParams)));

  if (p === '/quote/confirm') return sendHtml(res, confirmPage());

  if (p === '/quote/batch') return sendHtml(res, batchPage(params));

  if (p === '/calendar') return sendHtml(res, calendarPage(params, url.searchParams.get('today') || params.asOf));
  if (p === '/market') {
    const want = String(url.searchParams.get('country') || 'HU').toUpperCase();
    const code = params.raw.countries.some((c) => c.code === want) ? want : 'HU';
    const snap = loadTrend();
    return sendHtml(res, marketPage(params, marketView(params, snap, code), marketIndex(params, snap)));
  }
  if (p === '/shop-guide') return sendHtml(res, shopGuidePage(params));
  if (p === '/guide') return sendHtml(res, guidePage(params));
  if (p === '/about') return sendHtml(res, aboutPage(params));

  if (p === '/learn') return sendHtml(res, learnPage(LEARN));

  const mReport = p.match(/^\/quote\/([0-9a-f-]+)\/report$/);
  if (mReport) {
    const r = loadReport(mReport[1]);
    if (!r) return sendHtml(res, layout({ title: '报告不存在', body: '<div class="card"><h2>报告不存在</h2><p class="muted">链接可能已失效。<a href="/quote/new">重新预演</a></p></div>' }), 404);
    recordEvent({ event: 'EV_REPORT_VIEW', reportId: r.reportId, props: { state: r.state, unresolvedCount: r.unresolved.length } });
    return sendHtml(res, reportPage(r));
  }

  const mPrint = p.match(/^\/quote\/([0-9a-f-]+)\/print$/);
  if (mPrint) {
    const r = loadReport(mPrint[1]);
    if (!r) return sendHtml(res, '<p>报告不存在</p>', 404);
    recordEvent({ event: 'EV_PRINT', reportId: r.reportId, props: { format: 'print' } });
    return sendHtml(res, printPage(r));
  }

  const mCal = p.match(/^\/quote\/([0-9a-f-]+)\/calibrate$/);
  if (mCal) {
    const r = loadReport(mCal[1]);
    if (!r) return sendHtml(res, '<p>报告不存在</p>', 404);
    return sendHtml(res, calibratePage(r));
  }

  if (p === '/reports') return sendHtml(res, reportsPage(listReports(did), listDemoReports()));

  if (p === '/admin/calibration' || p === '/demo/calibration') {
    if (p === '/admin/calibration') {
      if (!requireAdmin(req, res)) return;
    } else if (!DEMO_MODE) {
      // 演示模式关掉时不 404，直接指到需要账号的那个
      res.writeHead(302, { Location: '/admin/calibration' });
      return res.end();
    }
    const today = url.searchParams.get('today') || new Date().toISOString().slice(0, 10);
    const stats = calibrationStats(readCalibrations(), today);
    return sendHtml(res, calibrationPage(stats, readQueue()));
  }

  if (p === '/admin/notify/send' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const { facts, today } = factsForToday(url.searchParams.get('asOf'));
    const out = await sendDigest(buildDigest(facts, today));
    const flag = out.sent ? 'ok' : out.reason === 'unconfigured' ? 'unconfigured' : 'fail';
    res.writeHead(302, { Location: `/admin/notify?result=${flag}&asOf=${encodeURIComponent(today)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (p === '/admin/notify/preview') {
    if (!requireAdmin(req, res)) return;
    const { facts, today } = factsForToday(url.searchParams.get('asOf'));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(buildDigest(facts, today));
  }

  if (p === '/admin/notify') {
    if (!requireAdmin(req, res)) return;
    const { facts, today } = factsForToday(url.searchParams.get('asOf'));
    // 未配 webhook 时这里也是可看的：摘要 + 明确的"未配置"说明
    const configured = !!process.env.WEBHOOK_URL;
    const result = url.searchParams.get('result');
    const banner =
      result === 'ok'
        ? '<p class="ok-banner">已推送。</p>'
        : result === 'unconfigured'
          ? '<p class="warn-banner">没有配 WEBHOOK_URL，这次没有推送（摘要照常生成）。</p>'
          : result === 'fail'
            ? '<p class="warn-banner">推送失败，摘要仍可人工转发。详情看服务端日志。</p>'
            : '';
    return sendHtml(
      res,
      layout({
        title: '待核日报',
        active: 'unresolved',
        body: `<div class="card">
  <h2>待核日报</h2>
  <p class="muted small">每天定时把逾期与临期项推给负责人。逾期只改变提示与默认分支，<b>不改变任何已出报告的金额</b>。</p>
  ${banner}
  <div class="stat-grid" style="margin:14px 0">
    <div class="stat"><span class="stat-k">推送通道</span><span class="stat-v">${
      configured ? '已配置' : '未配置'
    }</span><p class="muted small">${
          configured ? '定时任务会直接推到群里' : '设置 WEBHOOK_URL 后自动推送；现在只能在此预览'
        }</p></div>
    <div class="stat"><span class="stat-k">当前日期</span><span class="stat-v">${esc(today)}</span><p class="muted small">可改用 ?asOf=YYYY-MM-DD 推演其他日期</p></div>
  </div>
  <form class="row-gap" method="get" action="/admin/notify" style="margin-bottom:12px">
    <label class="field" style="max-width:220px"><span>推演日期</span><input type="date" name="asOf" value="${esc(today)}"></label>
    <button class="btn btn-ghost" type="submit">重算</button>
  </form>
  <pre class="digest" data-digest>${esc(buildDigest(facts, today))}</pre>
  <form method="post" action="/admin/notify/send" style="margin-top:12px">
    <button class="btn" type="submit"${configured ? '' : ' disabled title="未配置 WEBHOOK_URL"'}>立即推送一次</button>
    <span class="muted small" style="margin-left:10px">机器调用：<code>node scripts/notify.js</code></span>
  </form>
</div>`,
      })
    );
  }

  if (p === '/admin/unresolved' || p === '/demo/unresolved') {
    if (p === '/admin/unresolved') {
      if (!requireAdmin(req, res)) return;
    } else if (!DEMO_MODE) {
      return sendHtml(res, '<p>演示模式未开启</p>', 404);
    }
    const asOf = url.searchParams.get('asOf');
    const { facts, today } = factsForToday(asOf);
    return sendHtml(
      res,
      unresolvedPage(facts, {
        readonly: p === '/demo/unresolved',
        today,
        filter: url.searchParams.get('filter') || 'all',
        // MVP 无登录：先用 query 模拟当前身份；接账号体系后换成会话身份
        owner: url.searchParams.get('owner') || '',
        baseUrl: p,
        asOf,
        operators: p === '/admin/unresolved' ? operatorList() : [],
      })
    );
  }

  if (p === '/admin/params') {
    if (!requireAdmin(req, res)) return;
    const tab = url.searchParams.get('tab') || 'current';
    return sendHtml(
      res,
      paramsPage({
        params,
        versions: listVersions(),
        drafts: listDrafts(),
        operators: operatorList(),
        tab,
      })
    );
  }

  if (p === '/admin/params/diff') {
    if (!requireAdmin(req, res)) return;
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    if (!a || !b) return sendHtml(res, '<p>需要 a 与 b 两个版本文件</p>', 400);
    try {
      return sendHtml(res, paramsDiffPage(a, b, diffVersions(a, b), params.asOf));
    } catch (e) {
      return sendHtml(res, `<p>对比失败：${esc(String(e.message))}</p>`, 400);
    }
  }

  if (p === '/healthz') {
    const { facts } = factsForToday();
    return send(res, 200, {
      ok: paramErrors.length === 0,
      paramsErrors: paramErrors,
      paramsVersion: params.version,
      engineVersion: params.raw.engineVersion,
      asOf: params.asOf,
      unresolvedOpen: facts.filter((f) => f.status === 'open').length,
      reports: readJsonSafe(INDEX_FILE, []).length,
    });
  }

  return false;
}

/* ---------------- 云服务同源转发 ---------------- */

// 云服务的 publishableKey 带来源白名单：托管域名和 localhost 直连能用，
// 换成自建服务器（IP 或自有域名）会被 403 access_denied。
// 这个 403 拦在**浏览器端**——服务器日志里一条都不会有，表现成"AI 忽然不会说话"。
//
// 这里的做法是把这类来源改成本站同源请求，再由服务端去调：
// 服务端发起的请求不带 Origin，云服务认的是 key 本身。
//
// 边界（想清楚再过）：
//   · 只转发 /.cloud/ 这一个前缀，其余一律不放行
//   · 不带 Origin / Referer / Host / Cookie 过去，不给上游任何本站线索
//   · 不新增任何权限：key 本来就明文写在页面里，这里没有多暴露一分
const CLOUD_ORIGIN = 'https://clearpath-duty.app.workbuddy.host';
const CLOUD_PREFIX = '/.cloud/';
// 读图请求可能带几张照片，前端单张上限 12MB，留一倍余量
const CLOUD_MAX_BODY = 24 * 1024 * 1024;

async function proxyCloud(req, res) {
  // 只放行带了凭证头的请求。没有这个头，上游本来也是 401，
  // 但先在这儿挡住，免得这个端点被当成"任意转发器"来用。
  if (!req.headers['x-wb-webapp-access-key']) {
    return send(res, 400, { code: 'E_CLOUD_NO_KEY', message: '缺少访问凭证' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > CLOUD_MAX_BODY) {
      return send(res, 413, { code: 'E_CLOUD_TOO_LARGE', message: '这次上传的内容太大，少放几张图再试' });
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    // accept-encoding 不能转：Node 的 fetch 会自己解压，把编码声明透传下去会拿到乱码
    if (['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding', 'cookie'].includes(lk)) continue;
    headers[k] = v;
  }
  if (body.length) headers['content-length'] = String(body.length);

  let upstream;
  // 客户端读完就断（SSE 收完整段回答后浏览器会主动 cancel，表现为 ERR_ABORTED），
  // 这时必须把上游连接一起放掉，否则每问一次都漏一个 socket，问几次就把连接池占满。
  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });
  try {
    upstream = await fetch(CLOUD_ORIGIN + req.url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      signal: upstreamAbort.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') return; // 客户端自己走了，没什么可回
    return send(res, 502, { code: 'E_CLOUD_UNREACHABLE', message: 'AI 服务暂时连不上', detail: String(e.message) });
  }

  // 上游是流式返回，必须边收边发；攒完再发的话用户会盯着空白等十几秒
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // 用户中途关掉页面、上游中断：这里没有可补救的，收了就行
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith(CLOUD_PREFIX)) return await proxyCloud(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (serveStatic(req, res, url.pathname)) return;
    const done = await handlePage(req, res, url);
    if (done === false) {
      sendHtml(res, layout({ title: '页面不存在', body: '<div class="card"><h2>页面不存在</h2><p class="muted"><a href="/">回首页</a></p></div>' }), 404);
    }
  } catch (e) {
    const code = String(e.message || 'E_INTERNAL').split(' ')[0];
    if (url.pathname.startsWith('/api/')) {
      send(res, 500, { code, message: '计算失败，请重试', detail: String(e.message) });
    } else {
      sendHtml(res, layout({ title: '出错了', body: `<div class="card"><h2>计算失败（${code}）</h2><p class="muted">已记录，请稍后重试。</p></div>` }), 500);
    }
    console.error('[error]', e);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[通途] 监听 ${HOST}:${PORT}${DEPLOYED ? '（托管环境）' : ''}`);
  console.log(`[通途] 本机打开：http://localhost:${PORT}`);
  console.log(`[通途] 待核中心演示：http://localhost:${PORT}/demo/unresolved`);
});
