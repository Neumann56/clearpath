#!/usr/bin/env node
/**
 * 打部署包：生成一个能直接 scp 到服务器解压的 tar.gz。
 *
 * 为什么要排掉这几类：
 *   out/        回归截图，13M，线上用不到
 *   logs/       本机的运行日志，带上去会污染新环境
 *   data/runtime/ 里既有演示报告也有本机设备 cookie 记录 —— 保留（演示要用），
 *                  但 drafts/ 是本机填了一半的草稿，带上去只是垃圾
 *   node_modules / .git  本机环境
 *
 * 用法：node scripts/pack-deploy.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const target = path.join(OUT_DIR, 'tantu-deploy.tar.gz');

const EXCLUDE = [
  'out',
  'logs',
  'node_modules',
  '.git',
  '.workbuddy',
  'tests',
  '数据调研',
  'out/tmp',
];

// 注意：这里必须传相对路径。Windows 的 tar 会把 `C:\...` 里的冒号当成 rsh 主机分隔符，
// 报 "Cannot connect to C: resolve failed" 而不是说路径有问题。
const REL_TARGET = 'out/tantu-deploy.tar.gz';
const args = ['-czf', REL_TARGET, ...EXCLUDE.flatMap((e) => ['--exclude', `./${e}`, '--exclude', `${e}`]), '.'];
execFileSync('tar', args, { cwd: ROOT, stdio: 'inherit' });

const size = fs.statSync(target).size;
console.log(`\n✓ ${path.relative(ROOT, target)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log('\n下一步（把 <服务器IP> 换成你的实例公网 IP）：');
console.log(`  scp ${path.relative(ROOT, target)} root@<服务器IP>:/tmp/`);
console.log('  ssh root@<服务器IP>');
console.log('  tar -xzf /tmp/tantu-deploy.tar.gz -C /opt/tantu && bash /opt/tantu/deploy/install.sh');
