#!/usr/bin/env bash
#
# 通途 CLEARPATH · 服务器端一键安装
#
# 前提：代码已经解压到 /opt/tantu（或本脚本所在目录的上一级）
# 用法：
#   bash deploy/install.sh              # 默认绑 80 端口，直接 http://IP 访问
#   bash deploy/install.sh --port 8080  # 换端口（80 被占用或不想动 80）
#
# 这个脚本只做三件事：装 Node、装服务、起来验证。
# 不改 apt 源、不装 nginx、不动系统里别的东西。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="tantu"
PORT=80

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "要用 root 跑：sudo bash $0"

say "1/6 检查 Node 版本"
NODE_BIN="$(command -v node || true)"
need_install=1
if [[ -n "$NODE_BIN" ]]; then
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$major" -ge 20 ]]; then
    echo "已有 Node $("$NODE_BIN" -v)，跳过安装"
    need_install=0
  else
    echo "现有 Node $("$NODE_BIN" -v) 太旧（要 >= 20）"
  fi
fi

if [[ $need_install -eq 1 ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NARCH="linux-x64" ;;
    aarch64|arm64) NARCH="linux-arm64" ;;
    *) die "不认识的架构：$ARCH" ;;
  esac

  # 国内机器访问 nodejs.org 经常很慢，先走镜像；都不行再报错让人手动装
  for V in v22.11.0 v20.18.0; do
    for BASE in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
      URL="$BASE/$V/node-$V-$NARCH.tar.xz"
      echo "尝试 $URL"
      if curl -fsSL --connect-timeout 10 --max-time 180 "$URL" -o /tmp/node.tar.xz; then
        tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
        ln -sf /usr/local/bin/node /usr/bin/node 2>/dev/null || true
        ln -sf /usr/local/bin/npm /usr/bin/npm 2>/dev/null || true
        rm -f /tmp/node.tar.xz
        echo "已安装 Node $(/usr/local/bin/node -v) 到 /usr/local"
        NODE_BIN=/usr/local/bin/node
        need_install=0
        break 2
      fi
    done
  done
  [[ $need_install -eq 0 ]] || die "Node 下载失败。请手动装 Node 20+ 后重跑本脚本。"
fi

say "2/6 创建运行账号"
getent group "$SERVICE_NAME" >/dev/null || groupadd --system "$SERVICE_NAME"
id -u "$SERVICE_NAME" >/dev/null 2>&1 || useradd --system --gid "$SERVICE_NAME" --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_NAME"
echo "账号 $SERVICE_NAME 就绪"

say "3/6 准备目录"
# 运行期要写这三个地方；不预先建好，ProtectSystem 下服务起不来
mkdir -p "$APP_DIR/data/runtime/reports" "$APP_DIR/data/runtime/archives" "$APP_DIR/data/runtime/drafts" "$APP_DIR/logs"
# 草稿是本机填了一半的东西，不该带到线上
rm -rf "$APP_DIR/data/runtime/drafts"/* 2>/dev/null || true
chown -R "$SERVICE_NAME:$SERVICE_NAME" "$APP_DIR/data" "$APP_DIR/logs"
echo "目录就绪：$APP_DIR/data/runtime"

say "4/6 安装 systemd 服务（端口 $PORT）"
sed "s|^Environment=PORT=.*|Environment=PORT=$PORT|" "$APP_DIR/deploy/tantu.service" > "/etc/systemd/system/$SERVICE_NAME.service"
# ExecStart 里的 node 路径必须写绝对路径（systemd 不读 shell 的 PATH）
NODE_PATH_REAL="/usr/local/bin/node"
[[ -x "$NODE_PATH_REAL" ]] || NODE_PATH_REAL="$(command -v node)"
[[ -n "$NODE_PATH_REAL" && -x "$NODE_PATH_REAL" ]] || die "找不到可执行的 node，安装步骤可能没成功"
sed -i "s|^ExecStart=.*|ExecStart=$NODE_PATH_REAL server.js|" "/etc/systemd/system/$SERVICE_NAME.service"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
echo "服务已启动"

say "5/6 等它起来"
ok=0
for i in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/tmp/tantu-health.json 2>/dev/null; then
    ok=1
    break
  fi
done

if [[ $ok -eq 1 ]]; then
  echo "健康检查通过：$(cat /tmp/tantu-health.json)"
else
  echo "健康检查没通过，以下是最近日志："
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  die "服务没起来。日志见上。"
fi

say "6/6 完成"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<你的公网IP>')"
cat <<EOF

  访问地址：  http://$PUBLIC_IP$( [[ "$PORT" != "80" ]] && echo ":$PORT" )

  常用命令：
    systemctl status $SERVICE_NAME      看状态
    systemctl restart $SERVICE_NAME     重启（改了服务端代码后必须重启）
    journalctl -u $SERVICE_NAME -f      看实时日志

  如果浏览器打不开，先查阿里云控制台的「防火墙 / 安全组」有没有放行 $PORT 端口。
  这一步和服务器内部无关——端口没放行，服务跑得好好的，外面也连不进来。

EOF
