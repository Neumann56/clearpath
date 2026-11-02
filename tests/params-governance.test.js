/**
 * 参数治理测试：改参数不是"编辑一个 JSON"，是一条有门禁的流程。
 * 这里验的是门禁本身——草稿不碰线上、用例不过不许发、提案人不能自批。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAMS_DIR } from '../lib/params.js';
import { createDraft, publish, diffVersions, listDrafts, runGolden } from '../lib/paramsStore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'kb-2026.10.21.json';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-params-'));
const paramsDir = path.join(tmp, 'params');
const draftsDir = path.join(tmp, 'drafts');
fs.mkdirSync(paramsDir, { recursive: true });
fs.copyFileSync(path.join(PARAMS_DIR, BASE), path.join(paramsDir, BASE));

const dirs = { paramsDir, draftsDir };

test('diff 能看出 rate 从 0.025 改成 0.03（不是只说"变了"）', () => {
  const a = JSON.parse(fs.readFileSync(path.join(paramsDir, BASE), 'utf8'));
  const b = JSON.parse(JSON.stringify(a));
  const t = b.tariffs.find((x) => x.country === 'US');
  t.rate = '0.03';
  b.paramsVersion = 'kb-test.2';
  const fileB = path.join(paramsDir, 'kb-test.2.json');
  fs.writeFileSync(fileB, JSON.stringify(b, null, 2));

  const d = diffVersions(path.join(paramsDir, BASE), fileB);
  assert.ok(d.changed.length >= 1);
  const row = d.changed.find((c) => c.collection === 'tariffs' && c.key === 'US|870891');
  assert.ok(row, '应能定位到 US/8708 这条关税');
  assert.equal(row.fields.rate.from, '0.025');
  assert.equal(row.fields.rate.to, '0.03');
  assert.ok(d.meta.some((m) => m.field === 'paramsVersion'));
});

test('草稿不碰线上参数（createDraft 只写 drafts 目录）', () => {
  const before = fs.readdirSync(paramsDir).sort();
  const rec = createDraft(
    {
      baseFile: BASE,
      patches: [{ collection: 'charges', key: 'US|MPF', field: 'note', to: '财年调整，10 月复核（草稿）' }],
      author: '运营 A',
      authorKey: 'ops-alice',
      note: '只改文案',
      today: '2026-10-23',
      ...dirs,
    }
  );
  assert.equal(rec.status, 'draft');
  assert.equal(rec.targetFile, 'kb-2026.10.23.json');
  assert.deepEqual(fs.readdirSync(paramsDir).sort(), before, '线上参数目录不该有任何变化');
  assert.ok(fs.existsSync(path.join(draftsDir, `${rec.id}.json`)));
  assert.equal(listDrafts(draftsDir).length, 1);
});

test('提案人不能自己批（E_REVIEWER_IS_AUTHOR）', () => {
  const rec = createDraft({
    baseFile: BASE,
    patches: [{ collection: 'charges', key: 'US|HMF', field: 'note', to: 'x' }],
    author: '运营 A',
    authorKey: 'ops-alice',
    today: '2026-10-24',
    ...dirs,
  });
  assert.throws(() => publish(rec.id, { key: 'ops-alice', name: '运营 A' }, dirs), /E_REVIEWER_IS_AUTHOR/);
});

test('黄金用例不过就拒绝发布，且线上一个文件都不多', () => {
  const before = fs.readdirSync(paramsDir).sort();
  // 把美国最惠国税率从 2.5% 改成 3%：美国几张黄金票一定算不对
  const rec = createDraft({
    baseFile: BASE,
    patches: [{ collection: 'tariffs', key: 'US|870891', field: 'rate', to: '0.03' }],
    author: '运营 A',
    authorKey: 'ops-alice',
    note: '假设 CBP 上调 MFN',
    today: '2026-10-25',
    ...dirs,
  });

  let err = null;
  try {
    publish(rec.id, { key: 'ops-bob', name: '运营 B' }, dirs);
  } catch (e) {
    err = e;
  }
  assert.ok(err, '应抛错');
  assert.match(String(err.message), /E_GOLDEN_FAILED/);
  assert.ok(err.golden, '应带回失败详情');
  assert.ok(err.golden.failedCases.length > 0, '应指出哪几条用例失败');
  assert.deepEqual(fs.readdirSync(paramsDir).sort(), before, '拒绝发布时线上参数不得变动');

  // 草稿被标记了失败记录，便于事后追责
  const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, `${rec.id}.meta.json`), 'utf8'));
  assert.equal(meta.status, 'draft');
  assert.equal(meta.lastGolden.passed, false);
});

test('只改不影响用例的字段 → 换人复核可以发布，旧版本还在', () => {
  const before = fs.readdirSync(paramsDir).sort();
  const rec = createDraft({
    baseFile: BASE,
    patches: [{ collection: 'charges', key: 'US|HMF', field: 'note', to: '费率未变，仅补充复核说明' }],
    author: '运营 A',
    authorKey: 'ops-alice',
    note: '补充说明，不改数',
    today: '2026-10-26',
    ...dirs,
  });

  const out = publish(rec.id, { key: 'ops-carol', name: '运营 C' }, dirs);
  assert.equal(out.targetFile, 'kb-2026.10.26.json');
  assert.ok(out.golden.passed, '发布前应通过黄金用例');

  const after = fs.readdirSync(paramsDir).sort();
  assert.ok(after.length === before.length + 1);
  assert.ok(after.includes(BASE), '旧版本必须保留，历史报告要靠它复现');
  assert.ok(after.includes('kb-2026.10.26.json'));

  const raw = JSON.parse(fs.readFileSync(path.join(paramsDir, 'kb-2026.10.26.json'), 'utf8'));
  assert.equal(raw.paramsVersion, 'kb-2026.10.26');
  assert.equal(raw.charges.find((c) => c.code === 'HMF' && c.country === 'US').note, '费率未变，仅补充复核说明');

  const meta = JSON.parse(fs.readFileSync(path.join(draftsDir, `${rec.id}.meta.json`), 'utf8'));
  assert.equal(meta.status, 'published');
  assert.equal(meta.reviewer, '运营 C');
  assert.equal(meta.reviewerKey, 'ops-carol');

  // 已发布的草稿不许再发一次
  assert.throws(() => publish(rec.id, { key: 'ops-bob', name: '运营 B' }, dirs), /E_DRAFT_PUBLISHED/);
});

test('黄金用例在临时参数目录上能独立跑通（回归门禁本身可用）', () => {
  const r = runGolden(path.join(paramsDir, BASE));
  assert.equal(r.passed, true, `基线应通过，实际失败：${(r.failedCases || []).join('；')}`);
  assert.ok(r.total >= 38, `基线用例数应 ≥ 38，实际 ${r.total}`);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
