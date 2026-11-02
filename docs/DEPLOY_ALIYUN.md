# 部署到阿里云

> 前提说明：买服务器、开安全组、备案都要在**你的阿里云账号**里操作，我这边没有你账号的权限。
> 所以这份文档的目标是：**把你要点的地方压到最少，其余全部脚本化**。
> 买完之后，真正的部署只有三条命令。

## 一、买什么（300 元够用一年还有余）

| 项目 | 推荐 | 价格 | 说明 |
| --- | --- | --- | --- |
| 轻量应用服务器 | 2 核 2G，40G SSD，200M 峰值，不限流量 | **68 元/年**（新用户，不用抢） | 秒杀价 38 元看运气，68 元随时能买。这个项目零 npm 依赖、常驻内存约 60MB，2核2G 属于严重富余 |
| 域名（可选） | .com / .cn | 55–80 元/年 | 只在你要"看起来正式"时才需要。**不买也能用 IP 访问** |
| SSL 证书 | Let's Encrypt 或阿里云免费证书 | 0 元 | 有域名才用得上 |
| ICP 备案 | — | 0 元，但要 **7–20 个工作日** | 见下面第三节，这是唯一会卡住你的东西 |

**地域选国内**（杭州/上海/北京/广州都行），别选香港：香港 2核2G 要 39 元/月 = 468 元/年，超预算，而且延迟比国内高。

买的时候注意两个选项：
- 镜像选 **Ubuntu 22.04** 或 **Debian 12**（脚本按这两个写的）
- 买完先别急着配别的，直接进下一步

## 二、部署（三条命令）

### 1. 在我这边打包

```bash
node scripts/pack-deploy.js
```

生成 `out/tantu-deploy.tar.gz`，约 0.7 MB。已经排掉了回归截图、日志、测试、本机草稿。
里面带着最新参数库 `kb-2026.10.24-5` 和 71 份演示报告。

### 2. 上传并执行

把 `<服务器IP>` 换成你实例的公网 IP（控制台首页就有）：

```bash
scp out/tantu-deploy.tar.gz root@<服务器IP>:/tmp/
ssh root@<服务器IP>
mkdir -p /opt/tantu && tar -xzf /tmp/tantu-deploy.tar.gz -C /opt/tantu && bash /opt/tantu/deploy/install.sh
```

`install.sh` 自己会做完这些，不用你插手：

- 检查 Node，版本不够就从国内镜像装 Node 22 到 `/usr/local`（**不改 apt 源**）
- 建一个 `tantu` 专用账号跑服务，不用 root 裸跑
- 装 systemd 服务，开机自启、崩溃 3 秒后自动重启
- 起服务并轮询 `/healthz`，**通过才算成功**；没通过直接把日志打给你看
- 最后打印访问地址

### 3. 打开安全组

浏览器打不开**先查这里**，90% 的"部署失败"都是这个：

阿里云控制台 → 轻量服务器 → 你的实例 → **防火墙** → 添加规则 → 放行 **80**（TCP）。

端口没放行时，服务器内部 `curl` 是通的、服务日志干干净净，但外面连不进来——
这种情况下你会以为服务挂了，其实只是门没开。

然后访问 `http://<服务器IP>` 即可。

## 三、备案这件事（唯一会卡时间的地方）

**国内服务器用域名访问，必须 ICP 备案。** 备案期间域名不能用，只影响域名，不影响 IP 访问。

- 备案在阿里云控制台「ICP 代备案系统」提交，免费，7–20 个工作日
- 需要：域名已实名认证满 3 天、服务器是阿里云国内节点、主体证件
- 个人主体备案的网站**不能有经营性内容**（收钱、卖货）。这个东西是计税工具，不属于经营性，但个案例子要说清楚是"个人技术工具"

**不想等备案怎么办**：先用 `http://<服务器IP>` 访问，功能完全一样，只是地址不好看、没有 https。

## 四、要不要上 HTTPS

只在你有备案域名之后才有意义：

```bash
apt update && apt install -y nginx certbot python3-certbot-nginx
# Node 退到内网，交给 nginx 对外
sed -i 's|^Environment=HOST=.*|Environment=HOST=127.0.0.1|; s|^Environment=PORT=.*|Environment=PORT=4173|' /etc/systemd/system/tantu.service
systemctl daemon-reload && systemctl restart tantu

# nginx 反代 + 自动签证书
cat > /etc/nginx/sites-available/tantu <<'EOF'
server {
  listen 80;
  server_name your-domain.com;
  location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF
ln -sf /etc/nginx/sites-available/tantu /etc/nginx/sites-enabled/tantu
nginx -t && systemctl reload nginx
certbot --nginx -d your-domain.com
```

**改完 systemd 一定要 `daemon-reload`**，不然改了等于没改。

## 五、一个必须验的风险：老周还通不通

这个项目里，「问老周」走的是浏览器直连云服务（`assistant.js` 里的 `endpoint`），
**不是**你自己的服务器转发。所以换到 `http://<服务器IP>` 之后，发起请求的 Origin 变了。

- 现在已经确认：从 `http://127.0.0.1:4173` 发起的请求是通的（本地实测能正常回话），
  说明云服务**没有做严格的 Origin 白名单**
- 但 `http://47.x.x.x` 这种公网 IP 我没法在本机提前验证

所以部署完，**第一件事是点右下角问老周一句**：

> FOB 和 CIF 差在哪

如果他正常回话 → 全通。
如果回"没连上/离线"那套兜底话术 → 是云服务拒绝了这个 Origin，其余功能都不受影响，
但要让老周回来得把访问方式改成一个被允许的域名。

## 六、日常运维

```bash
systemctl status tantu        # 状态
systemctl restart tantu       # 重启（改了 lib/ 或 server.js 必须重启）
journalctl -u tantu -f        # 实时日志
journalctl -u tantu -n 100    # 最近 100 行

# 数据在哪
ls /opt/tantu/data/runtime/reports    # 报告（JSON）
ls /opt/tantu/data/params             # 参数库版本快照

# 备份（建议挂 crontab 每天跑）
tar -czf /root/tantu-data-$(date +%F).tar.gz -C /opt/tantu data/runtime
```

**数据全在这两个目录里，没有数据库。** 备份就是打包这两个目录，恢复就是解回去重启。

## 七、300 元怎么花

```
轻量 2核2G 一年        68
域名 .com 一年         60   （可选；不买就 0，用 IP 访问）
────────────────────────────
合计                  128   剩 172
```

剩下的留着续费第二年和买域名，够用两年。

## 八、和现在那条托管链接的关系

现在这条 `https://clearpath-duty.app.workbuddy.host/?sharecode=...` 与阿里云部署**互不影响**，
可以同时存在：

| | 托管链接 | 阿里云 |
| --- | --- | --- |
| 上手 | 已有，立即能用 | 要买、要部署，约 30 分钟 |
| 地址 | 长，带 sharecode | `http://IP` 或自己的域名 |
| https | 有 | 有域名才有 |
| 数据归属 | 平台托管环境 | **你自己的盘，随时备份** |
| 长期 | 不确定 | 你说了算 |
| 老周 | 已验证可用 | 需部署后实测 |

**如果只是给别人看一眼，现在这条已经够了。** 阿里云换的是「数据在自己手里 + 可以用自己的域名」，
不是「能不能用」。

---

## 本机这台 ECS 的实际部署（2026-10-25）

### 端口：8080，不是 80

这台机器 **80 已经被「银龄守护」占了**（`/opt/ylsh` + gunicorn 5000 + nginx）。
通途固定跑 8080，两个应用各占一个端口：

```
http://47.123.4.136/       银龄守护（不要动）
http://47.123.4.136:8080/  通途
```

所有命令都要带 `--port 8080`：

```bash
node scripts/deploy-aliyun.js --host 47.123.4.136 --port 8080
```

**为什么不挂 nginx 子路径**：本应用所有 URL 都是绝对路径（`/quote/new`、`/css/app.css`、`/api/...`），
挂到 `/tantu/` 下静态资源和跳转全会打到银龄守护那个站上。要支持 basePath 得改 layout、静态服务、
所有链接，还会把报告 URL 变成 `/tantu/quote/xxx/report`。不如一条安全组规则干净。

### 安全组：只放行 22 和 80，8080 要手动加

入方向 → 手动添加 → **自定义 TCP**、`8080/8080`、`0.0.0.0/0`。
**别选右边的「Web HTTP 流量访问」快捷配置**——那是 80 的预设，点了只会加一条重复的 80 规则。

### 老周（AI）：云服务 key 带来源白名单

`publishableKey` 只允许 **托管域名** 和 **localhost**，其余来源 403：

```
{"error":"access_denied","error_description":"the request origin is not allowed for this client"}
```

这个 403 **拦在浏览器端**，服务器日志里一个字都没有，表现成"AI 忽然不会说话"。
所以 `server.js` 里加了 `/.cloud/` 同源转发：不在白名单里的来源改走本站，由服务端发出（服务端不带 Origin）。

- 只转发 `/.cloud/` 前缀
- 不带 Origin / Referer / Host / Cookie 过去
- 必须带 `x-wb-webapp-access-key` 头才放行，避免被当任意转发器
- 客户端读完 SSE 就断（`ERR_ABORTED`），上游连接会跟着 abort 掉，不漏 socket

### 重发布

```bash
node scripts/deploy-aliyun.js --host 47.123.4.136 --port 8080
node scripts/check-online.js --url http://47.123.4.136:8080 --no-code   # 15 项
```

脚本会先备份 `/opt/tantu/data` 到 `/root/tantu-backup-<时间>.tar.gz`，再解压新包。
端口被自己上一次部署占着不算冲突（按 MainPID 认得出来）。
