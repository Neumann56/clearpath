# 追赶菜鸟：通途 MVP 补齐计划

> 写作时间：2026-10-22 23:25　基线版本：参数库 `kb-2026.10.21` / 引擎 `0.1.0`
> 本文是"明天开工即可执行"的清单，不写愿景，每条都有改哪个文件、怎么验、依赖什么。

---

## 0. 先说清楚"跟菜鸟差不多"能到什么程度

菜鸟的能力有三块是**结构性无法追平**的，不要在这上面耗时间：

| 追不平的 | 原因 |
| --- | --- |
| 申报状态回传、清关进度 | 我们没有申报权，也不做申报代理 |
| 商品库驱动的批量归类 | 它有几千万 SKU 的申报回流，我们只有 6 国参数表 |
| 账单驱动对账 | 它自己出账单，我们只能等用户上传 |

**能追平的是七个模式的"可感知部分"**——也就是用户和评委在界面上能摸到的那一层。目标定成：

- M1/M2/M3：已达标，保持，别改坏
- M4/M5/M6/M7：从"有形态"补到"有闭环"

判据不是"功能像"，而是这四个问题都能当场演示出来：
1. 一条待核项逾期 31 天，**系统主动通知了谁**？
2. 上传一张真实税单，**归因落到哪一行、进没进复核队列**？
3. 最近 20 票预演，**平均偏差多少、趋势在上还是下**？
4. 参数改一条税率，**谁提的、谁批的、黄金用例过没过**？

---

## 1. 基线（每次开工前先跑一遍，确认没被改坏）

一条命令跑完四项：

```bash
cd 通途_app
node scripts/verify.js
```

期望输出：

```
✓ 黄金用例 + 全部测试     54 通过 / 0 失败
✓ 文案门禁            通过 · 15 段全部就位 · 0 命中
✓ 性能              p50 0.3ms / p95 0.6ms（预算 400ms）
✓ 参数版本            参数 kb-2026.10.22 · 报告 50 份 · 待核 5 项
```

拆开单项跑：

```bash
node --test                               # 期望 # pass 54 / # fail 0
node scripts/copy-lint.js                 # 期望 15 段就位、0 命中
node scripts/perf.js                      # 期望 p95 ≤ 400ms
node scripts/seed-demo.js                 # 重建演示数据（50 报告 / 11 条校准记录）
curl -s --noproxy '*' http://127.0.0.1:4173/healthz   # 期望 200
```

四项有一个不对，先修基线，不要往下做。

> **别写 `node --test tests/`。** 在 Node 22.22.2 + Windows 下，传目录参数会被当成单个模块加载，
> 结果是 `# tests 1 / # fail 1` 而不是真的失败。用 `node --test`（自动发现）或 `node --test "tests/*.test.js"`。

---

## 2. Day 1（明天）：把 M6 的提醒和 M4 的闭环补上

这两件都只动现有文件，不引入新依赖，一个白天能做完并验证。

### D1-1 逾期提醒（M6 最硬的一刀）

**现状**：`lib/unresolved.js` 的 `degradeOf()` / `daysLeft()` 只在页面渲染时算一次，没人打开就没人知道。`grep -rn "notify|webhook|cron|setInterval"` 全空。

**要做**：

- 新增 `scripts/notify.js`，纯 Node 内置 `fetch`，零依赖：
  - 读 `data/runtime/unresolved.json`，用 `reseatDue(facts, today)` 重算降级
  - 分三桶：`overdue`（daysLeft < 0）、`dueSoon`（0 ≤ daysLeft ≤ 3）、`red`（degrade 为红）
  - 生成一段纯文本摘要（不是 HTML，企业微信/飞书/钉钉都吃 text）
  - `POST` 到 `process.env.WEBHOOK_URL`；未配置时**只打印到 stdout 并 exit 0**（断网可跑，不许抛错）
- 摘要格式固定，便于断言：

```
【通途待核日报】2026-10-23
逾期 2 项：
 - UF-01 T1 分叉 · 逾期 5 天 · 影响 6,327.00 美元 · owner 待指定
 - UF-03 T3 脚注 · 逾期 12 天 · 不影响金额
3 天内到期 1 项：
 - UF-02 T2 影响 · 剩 2 天 · 影响 12,654.00 美元 · owner 张三
红档 1 项：UF-03（>90 天未核）
合计：5 项待核，其中 2 项已逾期。
```

- `server.js` 加 `GET /admin/notify/preview`（Basic 认证）返回同一段文本，方便答辩现场**不配 webhook 也能演示**
- 加 `POST /admin/notify/send` 手动触发一次（同样 Basic 认证）

**验收**：

```bash
node scripts/notify.js                      # 无 WEBHOOK_URL 时应打印摘要并 exit 0
curl -s --noproxy '*' -u admin:tantu2026 http://127.0.0.1:4173/admin/notify/preview
```

摘要里的金额必须是 `fmt()` 格式化后的（带千分位、两位小数），不许出现 `6327`。

**不许做**：不要引入 node-cron、不要开常驻定时器。定时交给系统计划任务，脚本本身要能被调用一次就退出（否则后台任务管理会乱）。

---

### D1-2 校准归因：从"猜总差额"改成"逐行对照"（M4 核心）

**现状**：`server.js:291` 用 `Math.abs(Math.abs(total) - Math.abs(u.impactUsd || 0)) < 1` 拿**总差额**去撞某个待核项的影响金额。真实税单上不可能精确命中，这套逻辑只在演示数据里生效。

**要做**：

1. `calibratePage()`（`lib/render.js:423`）表单改成逐项录入，与报告的三行一一对应：

| 输入 | 对应报告字段 |
| --- | --- |
| 实缴关税 | `expected.duty` |
| 实缴国内税 | `expected.taxTotal` |
| 实缴规费 | `expected.charges` |
| 实缴 AD/CVD（可选） | `expected.adRemedy` |
| 实缴增值税/可退税（可选） | 只进 cashRequired，不进 landedCost |

2. `POST /api/report/:id/calibrate` 改成**逐行归因**，每行独立判定：

```
每行：diff = actual - predicted
  |diff| < 0.01           → 无偏差
  该行命中某个待核项的 impact 行 → 归因「参数错」，挂 factId
  该行 base 里含某条 params 的 rate，且 diff / base ≈ 某条候选税率 → 归因「参数错（疑似税率错）」
  日期变了                              → 归因「输入错」
  该国存在未关闭的 T1/T2 待核项           → 归因「政策变」
  只有 landedCost 对不上而 cashRequired 对得上（或反之）→ 归因「口径理解错」
```

3. 返回结构从 `{diff, total, attribution}` 升级成：

```json
{
  "lines": [
    { "key": "duty", "predicted": 8500, "actual": 9020, "diff": 520,
      "attribution": "参数错", "factId": "UF-01",
      "note": "关税行高出 520.00，接近 232 档位差额的一半，建议核 8708.91 归类" }
  ],
  "total": 520,
  "landedCostDiff": 520,
  "cashRequiredDiff": 780,
  "primaryAttribution": "参数错",
  "routedTo": ["UF-01"]
}
```

4. **真正进队列**：归因为「参数错」时，调用 `linkReports()` 之外再写一条 `calibration_queue` 记录（`data/runtime/calib_queue.json`），字段：`reportId / line / diff / suspectParam / createdAt / status: 'pending'`。这是"参数复核队列"的最小实现，别再只 append 一行 jsonl 就结束。

**验收**（新增 `tests/closure.test.js`）：

- 造一票美国 branch B，实缴关税比预演高 520 → `lines[0].attribution === '参数错'`，且 `calib_queue.json` 多一条 pending
- 只把 `actualEntryDate` 改早 3 天 → `primaryAttribution === '输入错'`，队列不增
- 只填 `actualTax` 使 cashRequired 对上而 landedCost 对不上 → `primaryAttribution === '口径理解错'`

**不许做**：校准**不得反向修改这份报告的历史金额**（K4）。`loadReport()` 之后只读，写操作一律只写新文件。

---

### D1-3 预演准确率看板（M4 的另一半）

**现状**：`calibrations.jsonl` 只增不读，没有任何聚合。

**要做**：

- `GET /api/admin/calibration/stats` 返回：近 30/90 天票数、平均绝对偏差率（`|diff| / landedCost`）、按国家分组、按归因分组、偏差率的时间序列（按周）
- 新页面 `/admin/calibration`：一张趋势折线 + 一张分组表。用内联 SVG 画，不引 ECharts（零依赖）
- 页面顶部一句话结论由数据生成，例如：`近 30 天 18 票，平均偏差 2.4%，较上一周期下降 0.7 个百分点。` —— 偏差扩大时要写"上升"，别恒定正向措辞

**验收**：把 `tests/closure.test.js` 里造的 3 次校准喂进去，看板显示 `3 票`，平均偏差率非空，且能分国家。

---

### D1-4 待核中心加"我的待办"（M6 的入口）

**现状**：所有待核项一个池子，只能按影响金额排序。

**要做**：

- `unresolvedPage()` 顶部加 4 个筛选 chip：`全部 / 已逾期 / 我负责的 / 无 owner`
- owner 从 `?owner=` 取（MVP 无登录，先用 query 模拟，注释里写清"待账号体系接入后换成会话身份"）
- 表格默认排序改为：`逾期天数降序 → 影响金额降序`

**验收**：`/admin/unresolved?owner=张三` 只显示 owner 为张三的项；`?filter=overdue` 只显示 daysLeft < 0。

---

## 3. Day 2：M7 的几个硬要求 + M5 独立视图

### D2-1 meta 接口补缓存（30 分钟）

`server.js:201` 两个 meta 路由现在走 `send()`，**没有任何 Cache-Control**（静态资源反而有）。补：

- `Cache-Control: public, max-age=300, stale-while-revalidate=600`
- 响应体加 `ETag`（用 `params.version` 的 sha1 前 16 位），命中 `If-None-Match` 返回 304

**验收**：`curl -I` 两次，第二次带 `If-None-Match` 应得 304。

### D2-2 批量试算（补"批量"这块能力缺口）

**要做**：

- `POST /api/quote/batch`：body 为 `{ rows: [{country, hsCode, fob, freight, qty, channel}], forceBranch? }`，逐票跑 `runScenario()`，返回 `{ ok, failed, results: [{ index, reportId, landedCost, cashRequired, state, error }] }`
- 用 `Map` 去重 fingerprint，同一票重复提交返回同一个 reportId
- 单次上限 200 行，超过返回 `E_BATCH_TOO_LARGE`（这是限流的最小实现）
- `/reports` 页加"批量导入"入口：一个 textarea 贴 CSV，**粘贴即预览前 5 行解析结果**，确认后才提交

**验收**：一次提交 10 行，返回 10 个 reportId，`/reports` 能看到这 10 票；再提交同样 10 行，reportId 不变。

### D2-3 政策日历独立页（M5）

**要做**：

- 新页 `/calendar`：把所有 `policyCalendar` 条目 + 每条 measure 的 `effectiveFrom` + 在途豁免窗口（`shipBy` / `enterBy`）画成一条按时间排序的轴
- 在途豁免必须画成**两个日期夹一个区间**（PRD §2.3 M5 硬要求，一条线画会误导）
- 按"今天"实时区分：已生效 / 已过期 / 未来 30 天内 / 更远
- 每条旁边给"如果晚 3 天发货"的推演入口（链接到 `/quote/new?shipBy=...` 预填）

**验收**：`/calendar` 上今天之前的措施标"已生效"，在途豁免区间可见两端日期，点推演能带参跳转到录入页。

### D2-4 双人复核身份不能伪造（安全，必做）

**现状**：`server.js:391` `actor: body.actor || ADMIN.user` —— 请求体里随便填个名字就能绕过 `E_REVIEWER_IS_AUTHOR`。对一个主打"能辩护"的产品，这是致命漏洞。

**要做**：

- `data/runtime/operators.json`：`{ "ops-alice": {name, role}, "ops-bob": {...} }`（MVP 用固定表 + `X-Operator-Key` 头，不做完整登录）
- `transition()` 的 `actor` 改为**服务端从请求头解析**，不再接受 body 里的 actor
- 非法 key 返回 `401 E_OPERATOR_INVALID`
- 审计表 `actor` 存 `ops-alice`，展示层映射成姓名

**验收**：`curl -X PATCH /api/unresolved/UF-01 -H 'X-Operator-Key: bogus'` 得 401；用同一个人 key 提交再发布，得 `E_REVIEWER_IS_AUTHOR`；换另一个 key 可成功。

---

## 4. Day 3：参数治理做成真交互（最大一块，单独排一天）

**现状**：`/admin/params` 是一张只读表 + `public/js/params.js` 里 7 行代码，点发布**恒弹**"发布被拒绝"的 alert。参数治理是答辩必问项，目前答不了。

**要做**：

1. `lib/paramsStore.js`（新文件）
   - `listVersions()`：扫 `data/params/kb-*.json`，按版本号排序
   - `diffVersions(a, b)`：按 `(country, hsPrefix, measureType)` 为 key 做增/删/改，**改要出 `oldRate → newRate`**
   - `createDraft(baseVersion, patches, author)`：写 `data/runtime/drafts/<id>.json`，不碰线上参数
   - `publish(draftId, reviewer)`：`author === reviewer` 抛 `E_REVIEWER_IS_AUTHOR`；发布前**强制跑黄金用例**，失败抛 `E_GOLDEN_FAILED` 并返回失败用例名
2. `/admin/params` 三个 tab：`当前版本` / `待发布草稿` / `历史版本`
3. `/admin/params/diff?a=X&b=Y` 真实 diff 视图（红删绿增）
4. 发布按钮改成真表单：选草稿 → 显示 diff → 输入复核人 key（走 D2-4 的 `X-Operator-Key`）→ 提交

**验收**：造一个把美国 MFN 从 2.5% 改成 3% 的草稿 → 发布时黄金用例 E（70,862.40）失败 → 返回 `E_GOLDEN_FAILED` 且**线上参数没变**；authors 与 reviewer 相同 → `E_REVIEWER_IS_AUTHOR`；换人且改成不影响用例的字段 → 发布成功，`kb-2026.10.2x.json` 新增且旧版本还在。

---

## 5. Day 4+：按剩余时间挑，不要全做

| 项 | 价值 | 成本 | 建议 |
| --- | --- | --- | --- |
| 多币种（`data/params/fx.json` + `fmt(v, ccy)` + 录入页币种选择） | 高（真实场景必备，现在 26 处硬编码"美元"） | 中 | **做** |
| HS 归类候选与品名优化（`lib/classify.js`，按品名给 3 个候选码 + 各自风险提示） | 中（比菜鸟差最直观的一块） | 中 | 能做就做，做不了就在答辩里明说"归类是下一版" |
| 账号 / 组织 / 角色 | 中 | 高 | **不做**，MVP 用设备 Cookie + operator key 够演示 |
| 前端 E2E 自动化（把手工 puppeteer 脚本固化成 `tests/e2e/`） | 中（现在零前端测试） | 中 | 有时间再做 |

---

## 6. 不许破坏的约束（每改一处都要回头对照）

1. **双口径永不相加**：`landedCost` 与 `cashRequired` 不许出现任何"合计"；不许引入 `totalCost` / `landedTotal` / `finalCost` 这类别名
2. **K4 不可变**：参数更新、校准、分支切换都不得改历史报告金额，只许标注
3. **15 段结构**：`1,2,2.5,3,4,4.5,5,5.5,6,7,8,8.5,9,10,11`，`data-report-section` 顺序不许动
4. **不可达状态不许出数**：`blocked` / `needs_confirmation` 时 `expected` 必须 `null`
5. **互斥组不许求和**：三种可达状态分开列，禁止单条 max、禁止相加
6. **税率不是钱**：任何比率都走 `toFixedDigits()` / `pct()`，不许过 `toCents()`
7. **零 npm 依赖**：新增能力只用 Node 内置（`fetch` / `crypto` / `fs`）
8. **断网可跑**：所有外部调用（webhook）必须有"未配置则降级"的分支

---

## 7. 已经踩过的坑，别踩第二遍

| 坑 | 症状 | 记法 |
| --- | --- | --- |
| `toNumber()` 按分舍入 | 12.5% 显示成 13.00% | 比率和金额走两条精度路径 |
| 内部规范文案漏到界面 | 屏幕上出现"UI 必须表达依赖关系" | seed 里 `internalNote` 不渲染 |
| HTTP 头写中文 | Basic 认证 500 而不是 401 | 响应头只能 latin1 |
| `writeHead` 后 `setHeader` | ERR_HTTP_HEADERS_SENT | 先算完 header 再 writeHead |
| 后台任务反复 "failed" | 只是被 `taskkill` 主动杀 | 换代码前先停服务，属正常 |
| 本机代理拦 curl | 502 upstream | 所有本地请求加 `--noproxy '*'` |

---

## 8. Day 1–3 完成情况（已验证）

```bash
cd 通途_app && node scripts/verify.js
```

| 项 | 交付物 | 当场能演示什么 |
| --- | --- | --- |
| D1-1 逾期提醒 | `lib/notify.js` · `scripts/notify.js` · `/admin/notify` | `node scripts/notify.js --today=2027-09-01` 打印「已失效 1 项：UF-01（284 天未复核…）」+「红档 4 项」，三桶分明；未配 `WEBHOOK_URL` 只打印不报错 |
| D1-2 逐行归因 | `lib/calibrate.js` · `public/js/calibrate.js` | 实缴关税 +520 → 归因「参数错」+ 自动入队 `CQ-0001`；只改日期 → 「输入错」不入队；HU 多缴可退增值税 → 「口径理解错」（landed ±0 / cash +1000） |
| D1-3 准确率看板 | `lib/calibStats.js` · `/admin/calibration` | 「近 30 天 7 票，平均绝对偏差 2.8%，较上一周期下降 3.7 个百分点」，内联 SVG 折线含断点 |
| D1-4 我的待办 | `unresolvedPage` 四 chip | `?owner=运营 C&filter=mine` 只剩 UF-03/UF-04；`?filter=overdue&asOf=2027-09-01` 出 5 项 |
| D2-1 meta 缓存 | `sendCached()` | `/api/meta/countries` 二次请求带 `If-None-Match` → 304 |
| D2-2 批量试算 | `/quote/batch` · `public/js/batch.js` | 粘 CSV → 预览前 5 行 → 200 行上限、重复行按指纹去重 |
| D2-3 政策日历 | `calendarPage` · `/calendar` | 在途豁免画两日期夹区间；每条未来项带「晚 3 天发货会怎样」跳转 |
| D2-4 身份不可伪造 | `lib/operators.js` · `requireOperator()` | body 带 `actor` → `E_ACTOR_FROM_BODY`；alice 派单 alice 自关 → `E_REVIEWER_IS_AUTHOR`；bob 关 → 通过 |
| D3 参数治理 | `lib/paramsStore.js` · `/admin/params` | 草稿改美国 MFN 2.5%→3% → 发布时黄金用例 E/I 失败 → 拒发且线上无变化；只改文案 → 换人复核 → `kb-2026.10.22` 生成，旧版本保留 |

测试存量：`tests/golden.test.js` 38 项 + `tests/closure.test.js` 10 项 + `tests/params-governance.test.js` 6 项 = **54 项全绿**。

---

## 9. 下一件该做的事（Day 4+）

按 §5 的顺序，优先**多币种**（现在 26 处硬编码「美元」，是真实场景最挡路的一块）：

1. 新建 `data/params/fx.json`，只存汇率与生效日
2. `fmt(v, ccy)` 走一张独立的币种符号表；比率仍走 `pct()`，两者不混
3. 双口径金额字段加 `currency`，**报告落库时冻结当时汇率**（等于把 K4 从金额延伸到汇率）
4. 录入页加币种下拉，切换只影响显示与录入，不改已出报告

**验收**：同一票分别按 USD / EUR 录入，`landedCost` 与 `cashRequired` 折算后金额一致、`/healthz` 的 `paramsVersion` 不变、历史报告金额一个字不动。
