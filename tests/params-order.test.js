/**
 * 参数版本选取的守门测试。
 *
 * 背景（真实踩过的坑）：同一天发布第二个版本时，文件名会是
 * `kb-2026.10.24-2.json`，而 '-' 的字典序排在 '.' 前面。
 * 原实现直接 `files.sort()` 取最后一个，于是"发布了但线上没变"——
 * 参数治理最不能出现的就是这种一声不响的失效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLatestParamsFile, compareParamsFile } from '../lib/params.js';

const pick = (files) => pickLatestParamsFile(files);

test('版本选取：同一天的第二版必须胜过第一版', () => {
  assert.equal(pick(['kb-2026.10.24.json', 'kb-2026.10.24-2.json']), 'kb-2026.10.24-2.json');
  assert.equal(
    pick(['kb-2026.10.22.json', 'kb-2026.10.24.json', 'kb-2026.10.24-2.json']),
    'kb-2026.10.24-2.json'
  );
});

test('版本选取：序号按数值比，不是按字符比（-10 要大于 -9）', () => {
  assert.equal(pick(['kb-2026.10.24-9.json', 'kb-2026.10.24-10.json']), 'kb-2026.10.24-10.json');
  assert.ok(compareParamsFile('kb-2026.10.24-10.json', 'kb-2026.10.24-9.json') > 0);
});

test('版本选取：日期新的永远赢，跟序号无关', () => {
  assert.equal(pick(['kb-2026.10.24-9.json', 'kb-2026.11.01.json']), 'kb-2026.11.01.json');
});

test('版本选取：忽略非参数文件和坏名字，空目录返回 null', () => {
  assert.equal(
    pick(['kb-2026.10.24.json', 'unresolved.seed.json', 'readme.txt', 'kb-broken.json']),
    'kb-2026.10.24.json'
  );
  assert.equal(pick([]), null);
  assert.equal(pick(undefined), null);
});
