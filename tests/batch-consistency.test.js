/**
 * 批量试算页的一致性回归。
 *
 * 曾经的 bug：页面表头写的是 entryDate，而引擎必填的是 declarationDate（申报日）。
 * 两者不是别名——申报日决定适用哪档税率和 AD 分支。结果是照着页面提示贴数据，
 * 每一行都报"请填写申报日期"，功能等于坏的。
 *
 * 这里不加新的逻辑，只钉死一条：页面上给出的示例数据必须真的能算出数。
 * 示例坏了 → 用户第一步就失败 → 这条测试先红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParams } from '../lib/params.js';
import { normalizeShipment } from '../lib/engine/quote.js';
import { batchPage } from '../lib/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const params = loadParams();

/** 从渲染出的 HTML 里取出 textarea 的 placeholder（那就是给人照抄的示例） */
function placeholderOf(html) {
  const m = html.match(/<textarea[^>]*placeholder="([\s\S]*?)"[^>]*>/);
  assert.ok(m, '批量页应该有一个带示例的 textarea');
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 和 public/js/batch.js 的 parseCsv 同规则：认表头、按列名映射、数字转数值 */
function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines[0].split(',').map((c) => c.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const o = {};
    head.forEach((k, j) => {
      o[k] = cells[j] ?? '';
    });
    for (const k of ['fob', 'freight', 'qty']) {
      if (o[k] !== '' && o[k] !== undefined) o[k] = Number(String(o[k]).replace(/,/g, ''));
    }
    return o;
  });
}

const html = batchPage(params);
const exampleRows = parseCsv(placeholderOf(html));

test('批量页示例：表头包含引擎必填的申报日', () => {
  assert.ok(
    placeholderOf(html).split('\n')[0].includes('declarationDate'),
    '示例表头缺 declarationDate —— 引擎会逐行报"请填写申报日期"'
  );
});

test('批量页示例：每一行都能通过引擎的输入校验', () => {
  assert.ok(exampleRows.length >= 2, '示例至少给两行');
  for (const [i, row] of exampleRows.entries()) {
    const out = normalizeShipment(row, params);
    const msgs = (out.errors || []).map((e) => `${e.code} ${e.message}`);
    assert.deepEqual(msgs, [], `示例第 ${i + 1} 行过不了校验：${msgs.join('；')}`);
  }
});

test('批量页示例：申报日不是空值，也不依赖隐式兜底', () => {
  for (const [i, row] of exampleRows.entries()) {
    assert.match(String(row.declarationDate), /^\d{4}-\d{2}-\d{2}$/, `示例第 ${i + 1} 行的申报日不是日期：${row.declarationDate}`);
  }
});

test('批量页：申报日出现在必填说明里，不是只藏在示例里', () => {
  assert.match(html, /<code>declarationDate<\/code>/, '必填说明应点名 declarationDate，否则用户改示例时会删掉它');
  assert.ok(html.includes('data-asof='), '需要把参数基准日传给前端，空申报日才有可展示的兜底值');
});
