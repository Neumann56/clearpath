#!/usr/bin/env node
/**
 * 把通途部署到已开好的 ECS / 云服务器上（一条命令做完）。
 *
 *   node scripts/deploy-aliyun.js                       # 用默认目标
 *   node scripts/deploy-aliyun.js --host 1.2.3.4        # 换机器
 *   node scripts/deploy-aliyun.js --port 8080           # 换端口
 *   node scripts/deploy-aliyun.js --probe               # 只看环境，不动手
 *
 * 前提：本机公钥已经在服务器上（~/.ssh/authorized_keys）。
 *
 * 为什么先探查再部署：这台机器可能已经跑着别的东西。80 被占、已经装过
 * 一次、磁盘快满——这三种情况下闷头部署的后果分别是服务起不来、
 * 覆盖掉别人的配置、装到一半失败。先看一眼的成本是两秒。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const HOST = argOf('--host', '47.123.4.136');
const PORT = argOf('--port', '80');
const KEY = argOf('--key', path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_tantu_aliyun'));
const USER = argOf('--user', 'root');
const PROBE_ONLY = args.includes('--probe');
const APP = '/opt/tantu';

const SSH_BASE = ['-i', KEY, '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
const ssh = (cmd, { quiet = false } = {}) =>
  execFileSync('ssh', [...SSH_BASE, `${USER}@${HOST}`, cmd], {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });

const say = (s) => console.log(`\n\x1b[1;36m==> ${s}\x1b[0m`);
const ok = (s, d = '') => console.log(`\x1b[32m✓\x1b[0m ${s}${d ? '  ' + d : ''}`);
const bad = (s, d = '') => console.log(`\x1b[31m✗\x1b[0m ${s}${d ? '  ' + d : ''}`);

// ---------- 1. 连通性 ----------
say('1/5 连接服务器');
try {
  const who = ssh('echo "$(whoami)@$(hostname) $(. /etc/os-release && echo $PRETTY_NAME)"').trim();
  ok('SSH 通了', who);
} catch (e) {
  bad('SSH 连不上');
  console.error('\n  如果提示 Permission denied (publickey)，说明本机公钥没加到服务器上。');
  console.error('  把下面这段加到服务器的 ~/.ssh/authorized_keys 后重试：\n');
  try {
    console.error('  ' + fs.readFileSync(`${KEY}.pub`, 'utf8').trim() + '\n');
  } catch {
    console.error('  （找不到公钥文件 ' + KEY + '.pub）\n');
  }
  process.exit(1);
}

// ---------- 2. 探查环境 ----------
say('2/5 探查环境（不装东西）');
const env = ssh(`
  echo "---OS---"; . /etc/os-release && echo $ID $VERSION_ID
  echo "---NODE---"; command -v node >/dev/null && node -v || echo none
  echo "---PORT${PORT}---"; (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E ":${PORT}\\b" || echo free
  echo "---PORTS-COMMON---"; (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | tr '\\n' ' '
  echo ""
  echo "---APP---"; [ -d ${APP} ] && echo "exists $(du -sh ${APP} 2>/dev/null | cut -f1)" || echo absent
  echo "---DISK---"; df -h / | tail -1 | awk '{print $4" free"}'
  echo "---MEM---"; free -m | awk '/Mem:/{print $2"MB total, "$7"MB available"}'
  echo "---NGINX---"; command -v nginx >/dev/null && echo installed || echo none
  echo "---TANTU-PID---"; systemctl show -p MainPID --value tantu 2>/dev/null || echo 0
  echo "---PORT-PID---"; (ss -lntp 2>/dev/null) | grep -E ":${PORT}\\b" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true
`);
const line = (k) => (env.match(new RegExp(`---${k}---([\\s\\S]*?)(?=---|$)`)) || [, ''])[1].trim();
const os = line('OS');
const nodeV = line('NODE');
const portState = line(`PORT${PORT}`);
const appState = line('APP');
const disk = line('DISK');
const mem = line('MEM');
const nginx = line('NGINX');
const tantuPid = line('TANTU-PID');
const portPid = line('PORT-PID');
// 端口被占不一定是冲突：上一次部署的 tantu 自己就占着这个端口，
// 重发布时必然撞上。认出"这是我自己"，否则第二次发布永远失败。
const ours = portState !== 'free' && portPid && tantuPid && portPid === tantuPid;

ok('系统', os);
ok('Node', nodeV === 'none' ? '未安装（脚本会自动装 22）' : nodeV);
ok(
  `端口 ${PORT}`,
  portState === 'free' ? '空闲' : ours ? '本机 tantu 在用（重发布，装完会重启）' : `被占用 → ${portState.split('\n')[0]}`
);
ok('已部署过', appState === 'absent' ? '没有，这是首次' : `${appState}（会先备份 data）`);
ok('磁盘', disk);
ok('内存', mem);
ok('nginx', nginx === 'none' ? '没装（直接用 Node 对外）' : '已装（可考虑走反代 + HTTPS）');

if (portState !== 'free' && !ours) {
  bad(`端口 ${PORT} 被别的程序占用，换个端口重跑`);
  console.error(`\n  node scripts/deploy-aliyun.js --host ${HOST} --port 8080\n`);
  process.exit(1);
}
if (PROBE_ONLY) {
  console.log('\n（--probe 只探查，没有动手）');
  process.exit(0);
}

// ---------- 3. 打包上传 ----------
say('3/5 打包并上传');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack-deploy.js')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const TAR = path.join(ROOT, 'out', 'tantu-deploy.tar.gz');
const sizeMB = (fs.statSync(TAR).size / 1024 / 1024).toFixed(1);
execFileSync('scp', [...SSH_BASE, TAR, `${USER}@${HOST}:/tmp/tantu-deploy.tar.gz`], { stdio: ['ignore', 'ignore', 'inherit'] });
ok('已上传', `${sizeMB} MB → /tmp/tantu-deploy.tar.gz`);

// ---------- 4. 备份 + 解压 + 安装 ----------
say('4/5 备份旧数据并安装');
const install = ssh(`
  set -e
  if [ -d ${APP}/data ]; then
    BK=/root/tantu-backup-$(date +%F-%H%M%S).tar.gz
    tar -czf "$BK" -C ${APP} data
    echo "BACKUP=$BK"
  fi
  mkdir -p ${APP}
  tar -xzf /tmp/tantu-deploy.tar.gz -C ${APP}
  bash ${APP}/deploy/install.sh --port ${PORT}
`, { quiet: false });
console.log(install);

// ---------- 5. 从外面验一遍 ----------
say('5/5 从本机验证');
// 刚重启的服务有一两秒不在监听状态，一次不通就报"公网访问不通"会把人误导到安全组上去。
// 这里给 20 秒的窗口，只在窗口内一直不通才认定是端口没放行。
const probeOnce = () => {
  try {
    // 不用 -o /dev/null：execFileSync 在 Windows 上调的是系统自带 curl，那个 /dev/null 不存在，
    // 每次都静默失败返回 000 —— 之前的"公网访问不通"就是这么误报出来的。
    // 让 body 走 stdout，最后一行是状态码。
    const out = execFileSync(
      'curl',
      ['-s', '-m', '8', '--noproxy', '*', '-w', '\n%{http_code}', `http://${HOST}${PORT === '80' ? '' : ':' + PORT}/healthz`],
      { encoding: 'utf8' }
    );
    return out.trim().split('\n').pop().trim();
  } catch {
    return '000';
  }
};
let code = '000';
for (let i = 0; i < 10; i++) {
  code = probeOnce();
  if (code === '200') break;
  await new Promise((r) => setTimeout(r, 2000));
}
const reachable = code === '200';
if (reachable) ok('/healthz', '200');
if (!reachable) {
  bad(`公网访问不通（连续 20 秒都是 ${code}）`);
  console.error('\n  服务大概率已经起来了，是阿里云「防火墙/安全组」没放行端口。');
  console.error(`  控制台 → ECS → 实例 → 安全组 → 入方向 → 放行 TCP ${PORT}\n`);
}

console.log(`\n\x1b[1m访问地址：\x1b[0m http://${HOST}${PORT === '80' ? '' : ':' + PORT}`);
console.log(`\x1b[1m编辑链接：\x1b[0m http://${HOST}${PORT === '80' ? '' : ':' + PORT}/quote/new`);
console.log('\n部署完第一件事：点右下角问老周一句「FOB 和 CIF 差在哪」，');
console.log('能正常回话才算全通（他走浏览器直连云服务，换 Origin 是唯一可能静默失效的地方）。\n');
