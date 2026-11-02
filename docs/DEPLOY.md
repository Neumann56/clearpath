# 上线与分享

## 现在线上的地址

```
https://clearpath-duty.app.workbuddy.host/?sharecode=FA7USO4LQJ
```

**分享时必须连 `?sharecode=FA7USO4LQJ` 一起发。**
少了这一段，打开是 403 页面「链接不完整」——服务本身好好跑着，但对方看到的是打不开。这是平台加的访问口令，不是 bug。

只发 `https://clearpath-duty.app.workbuddy.host/` 给别人 = 对方打不开。这一条最容易出错。

## 重新发布

代码改完要重新发布才会生效（本地改了不等于线上改了）：

1. 先确认本地基线是绿的：`node scripts/verify.js`
2. 在对话里说一句「重新发布」/「同步到线上」
3. 发布完成后跑一次线上巡检：

```bash
node scripts/check-online.js              # 全量，含老周真实调用模型，约 30–60 秒
node scripts/check-online.js --no-ai      # 快检，跳过模型调用
```

分享链接不会变——重新发布是覆盖同一个应用的同一个地址。

## 线上巡检在查什么

`scripts/check-online.js` 只验"别人拿到链接能不能用"，不验"服务器活着"：

| 检查 | 为什么不能省 |
| --- | --- |
| 无 sharecode 被挡下 | 确认访问控制在，不是裸奔 |
| 样式表生效 | CSS 200 不代表生效，路径错了会是白板 |
| **老周回话** | 走浏览器直连云服务，**域名一换 Origin 就可能被拦**，而服务器日志里一条错都没有 |
| 各栏目真渲染 | `/learn` 要数到卡片、`/quote/new` 要数到控件，不能只看 200 |
| 后台接口已锁 | `/api/admin/params` 对匿名访客必须 401 |

要联网，所以**故意不放进 `verify.js`**——基线必须能断网跑。

## 两个已经验证过的坑

**1. 绑定地址**
托管环境只给一个 `PORT`，反向代理从外部连进来。`server.js` 里本地默认绑 `127.0.0.1`（避免 Windows 防火墙弹窗），靠"有没有被注入 `PORT`"来区分：

```js
const DEPLOYED = Boolean(process.env.PORT);
const HOST = process.env.HOST || (DEPLOYED ? '0.0.0.0' : '127.0.0.1');
```

绑错的症状是**一直 502 且没有任何报错信息**，很容易被误判成"平台挂了"。

**2. 401 会打崩巡检脚本**
`/api/admin/params` 的 401 带 `WWW-Authenticate: Basic`，浏览器会弹认证框：

- `page.goto` → 抛 `ERR_INVALID_AUTH_CREDENTIALS`
- 页面里 `fetch` → 卡到 `Runtime.callFunctionOn timed out`

所以这一步改成 Node 侧直接 `fetch`。

## 数据边界（重要）

- 托管环境的文件系统里带着发布那一刻的 `data/runtime/`：71 份报告、4 项待核、参数版本 `kb-2026.10.24-5`
- 别人新算的报告写在**运行环境本地文件**里，不是数据库
- 所以：**当作演示、评审、给客户看报价口径，完全够用**；要当长期业务系统存真实单据，这一层得换成外部数据库

## 停止分享

对我说一声「下线」即可，链接立即失效。要恢复就重新发布（地址不变）。

## 后台

`/admin/params`、`/api/admin/*` 对匿名访客返回 401（提示需要内网账号），别人改不了参数库。默认口令在 `server.js` 的 `ADMIN` 常量里，正式对外前应改成环境变量注入。
