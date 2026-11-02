/**
 * 把 seed 的字段同步进运行时待核库（data/runtime/unresolved.json）。
 *
 * 为什么需要：运行时库是"数据库"，首次启动才从 seed 复制；改了 seed 的文案
 * （比如依赖说明）不会自动反映到已存在的库。这个脚本按 id 合并：
 *   - seed 提供事实定义与说明文案
 *   - 运行时保留状态机字段（status / evidence* / reviewedBy），不覆盖人工处理结果
 *
 * 用法：node scripts/sync-facts.js [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME = path.join(process.cwd(), 'data', 'runtime', 'unresolved.json');
const SEED = path.join(process.cwd(), 'data', 'params', 'unresolved.seed.json');
const DRY = process.argv.includes('--dry');

// 这些字段属于人工处理结果，seed 不得覆盖
const KEEP = ['status', 'evidenceUrl', 'evidenceNote', 'reviewedBy', 'reviewedAt'];

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const runtime = fs.existsSync(RUNTIME) ? JSON.parse(fs.readFileSync(RUNTIME, 'utf8')) : [];

const byId = new Map(runtime.map((f) => [f.id, f]));
let added = 0;
let updated = 0;

for (const s of seed) {
  const cur = byId.get(s.id);
  if (!cur) {
    byId.set(s.id, { ...s });
    added += 1;
    continue;
  }
  const merged = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(s)) {
    if (KEEP.includes(k)) continue;
    if (JSON.stringify(cur[k]) !== JSON.stringify(v)) {
      merged[k] = v;
      changed = true;
    }
  }
  if (changed) {
    byId.set(s.id, merged);
    updated += 1;
  }
}

const out = [...byId.values()];
console.log(`seed=${seed.length} runtime=${runtime.length} → ${out.length}（新增 ${added} / 更新 ${updated}）${DRY ? ' [dry]' : ''}`);
if (!DRY) {
  fs.mkdirSync(path.dirname(RUNTIME), { recursive: true });
  fs.writeFileSync(RUNTIME, JSON.stringify(out, null, 2), 'utf8');
  console.log('已写入', path.relative(process.cwd(), RUNTIME));
}
