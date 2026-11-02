# 通途 API 清单

> 面向：小程序 / 移动端 H5 / 第三方对接
> 服务端：单进程 Node（零 npm 依赖），默认 `http://127.0.0.1:4173`，线上 `http://47.123.4.136:8080`
> 全部接口返回 JSON（`/healthz` 与 `/.cloud/*` 除外），编码 UTF-8

---

## 零、四条通用约定

**1. 设备标识**

历史报告按设备隔离。浏览器靠 cookie `tt_did` 自动往返；**小程序没有 cookie 自动往返**，必须在请求头带：

```
X-Device-Id: mp-1a2b3c4d
```

规则：`字母/数字/短横`，8–40 位。不带则由服务端生成一个并在响应里 `Set-Cookie`（小程序场景下等于白送，历史列表会是空的）。

**2. 错误格式**

一律 `{ "code": "E_XXX", "message": "人话说明" }`。前端直接弹 `message`，**不要把 `code` 显示给用户**（那是 `E_` 开头的内部串）。

部分接口额外带 `errors: []`（一票多错时一次说清，别让人改一条提交一次）。

**3. 缓存**

`/api/meta/*`、`/api/calendar`、`/api/learn` 走 ETag + `max-age=300`。小程序 `wx.request` 不自动处理 304，可忽略——不影响正确性。

**4. 幂等**

`POST /api/quote` 支持 `Idempotency-Key` 头，或 body 里带 `idempotencyKey`。不传时服务端用「输入指纹 + 参数版本」生成，24 小时内同输入返回同一份报告。

---

## 一、总表

### 查询类（无需鉴权）

| 方法 | 路径 | 用途 | 谁在用 |
| --- | --- | --- | --- |
| GET | `/api/meta/countries` | 68 个市场，含分区 | 录入页、覆盖说明 |
| GET | `/api/meta/hs?q=` | 6 个品类搜索 | 录入页 HS 联想 |
| GET | `/api/meta/coverage` | 覆盖统计（市场数/品类/规费覆盖） | **小程序首页**（新增） |
| GET | `/api/calendar?today=` | 政策日历 | **小程序日历页**（新增） |
| GET | `/api/learn` | 视频栏目数据 | **小程序看懂页**（新增） |
| GET | `/healthz` | 健康检查 | 部署巡检 |

### 计算类（无需鉴权）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/parse` | 一句话 → 结构化草稿 |
| POST | `/api/quote/precheck` | 试算但不落库（确认页用） |
| POST | `/api/quote` | 正式出报告并落库 |
| POST | `/api/quote/batch` | 批量试算（≤200 行） |

### 报告类（按设备隔离）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/report/:id` | 取一份报告全量 JSON |
| GET | `/api/reports` | 本设备历史列表 |
| GET | `/api/report/:id/calibrate` | 校准表单预填 |
| POST | `/api/report/:id/calibrate` | 提交实际清关数 |
| POST | `/api/report/:id/export` | 导出存档 JSON |

### 助手类

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/assistant/prefetch` | 只读事实预取（不调模型、不花钱） |
| ALL | `/.cloud/*` | 云服务同源转发（老周真正调模型的通道） |

### 待核类

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/unresolved?asOf=` | 无 |
| POST | `/api/unresolved` | Basic |
| POST | `/api/unresolved/import` | Basic |
| PATCH | `/api/unresolved/:id` | `X-Operator-Key` |

### 运维类（不面向用户）

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/admin/params` | Basic |
| POST | `/api/admin/params/draft` | `X-Operator-Key` |
| POST | `/api/admin/params/publish` | `X-Operator-Key` |
| GET | `/api/admin/calibration/stats` | Basic |
| POST | `/api/events` | 无（埋点） |

---

## 二、移动端必用的 6 个

### GET /api/meta/coverage

小程序首页那行「68 个市场 × 6 个品类」的唯一来源。**不要写死在客户端**——参数库每加一个市场它就过期，而过期的覆盖清单比没有清单更坏。

```json
{
  "paramsVersion": "kb-2026.10.24-5",
  "asOf": "2026-10-24",
  "hsVersion": "2022",
  "markets": {
    "total": 68,
    "entryEnabled": 68,
    "byRegion": [
      { "id": "EU", "label": "欧盟", "count": 27 },
      { "id": "AMERICAS", "label": "美洲", "count": 11 }
    ]
  },
  "categories": [
    { "hs": "870891", "hsDisplay": "8708.91", "name": "机动车辆零件" }
  ],
  "cells": 408,
  "chargesMarkets": 35,
  "complianceMarkets": 45
}
```

⚠️ `chargesMarkets` 是**逐个市场真跑一遍规费匹配**数出来的，不是 `count(country)`。参数库里欧盟共用一条规费记录（`country` 为空），直接数会得到 9，比真实可算的 35 少两倍多。

### GET /api/calendar?today=2026-10-25

```json
{
  "today": "2026-10-25",
  "count": 22,
  "note": "只收录参数库里已入库的节点。没列出来不代表没有变化，只代表还没调研到。",
  "items": [
    {
      "date": "2026-12-01",
      "label": "HS2027 产品提醒起点（非法定生效日）",
      "kind": "版本提醒",
      "country": "",
      "countryName": "",
      "sourceUrl": "https://...",
      "daysFromToday": 37,
      "state": "far"
    }
  ],
  "spans": [
    {
      "label": "新 301",
      "countryName": "美国",
      "shipBy": "2026-07-24",
      "enterBy": "2026-07-28",
      "note": "两个日期缺一不可"
    }
  ]
}
```

- `state`：`in` 已生效 / `soon` 30 天内 / `far` 更远
- `spans` 是「在途豁免窗口」，**不是日期而是一段区间**，画成单点会误导人，要单独展示
- `today` 可传任意日期做推演

### GET /api/learn

```json
{
  "ok": true,
  "count": 13,
  "meta": { "compiledAt": "2026-10-25", "statSnapshotAt": "2026-10-25", "platform": "哔哩哔哩" },
  "groups": [
    {
      "id": "price",
      "title": "报价怎么报",
      "sub": "贸易术语与价格换算",
      "why": "同样一句「48,000 美元的货」，报 FOB 还是 CIF，到岸成本能差出一条海运费加一笔保险。",
      "videos": [
        {
          "id": "p1", "bvid": "BV1xx411c7mD",
          "title": "…", "author": "…",
          "seconds": 287, "durationText": "4:47", "playText": "11.8 万",
          "featured": true, "takeaway": "看完能分清…",
          "cover": "https://i0.hdslb.com/…",
          "playerUrl": "https://player.bilibili.com/player.html?bvid=…",
          "watchUrl": "https://www.bilibili.com/video/BV1xx411c7mD/"
        }
      ]
    }
  ]
}
```

⚠️ `cover` 必须带 `referrerpolicy="no-referrer"`（H5）。B 站图床对站外 Referer 返 403，**而且浏览器不报错**，表现为封面全空。
⚠️ 小程序没有 iframe，`playerUrl` 用不上；只能给 `watchUrl` 让用户去浏览器。

### POST /api/parse

从一句话里抽出结构化字段。

```jsonc
// 请求
{ "text": "8708.91 散热器 1200 件，FOB 48000 美元，运费 2400，运到美国，10 月 20 日申报" }

// 响应
{
  "draft": { "hsCode": "870891", "country": "US", "fob": 48000, "freight": 2400, "qty": 1200, "declarationDate": "2026-10-20" },
  "candidates": [{ "hsCode": "870891", "name": "机动车辆零件", "inKb": true, "confidence": "high" }],
  "confidence": "high",
  "notes": [],
  "missing": ["channel"]
}
```

- `draft` 直接当 `/api/quote` 的 `input` 用，**缺的项按 `missing` 补**
- `candidates.length > 1` 表示编码有多种可能，**必须让用户选**，不能替猜
- 解析不出就当空草稿，不要用默认值硬填

### POST /api/quote/precheck

试算不落库。确认页用它预览，避免用户点了「生成报告」才发现算不出来。

```jsonc
// 请求
{ "input": { ...同 /api/quote } }

// 响应 200
{ "state": "complete_with_gaps", "expected": {...}, "branches": null, "unresolved": [...], "assumptions": [...], "range": {...} }

// 响应 400
{ "code": "E_FOB_REQUIRED", "message": "货值必须大于 0", "errors": [ ...全部问题... ] }
```

### POST /api/quote

正式出一份报告，落库并计入历史。

```jsonc
// 请求
{
  "input": {
    "country": "HU",
    "hsCode": "8708.91",
    "fob": 48000,
    "freight": 2400,
    "qty": 1200,
    "channel": "B2B",
    "dates": { "declarationDate": "2026-10-20", "exportDate": "2026-10-05" }
  },
  "initialBranch": null
}
```

响应就是完整报告对象（见下节）。**`expected.landedCost` 和 `expected.cashRequired` 永不相加**，界面上也必须分两行。

---

## 三、报告对象的形状

`GET /api/report/:id` 返回的核心字段：

```jsonc
{
  "reportId": "a1b2c3d4-…",
  "createdAt": "2026-10-25T…",
  "state": "complete_with_gaps",     // complete / complete_with_gaps / needs_confirmation / blocked
  "input": { "country": "HU", "hsCode": "8708.91", "fob": 48000, … },

  "expected": {
    "cif": 50616,
    "duty": 1518.48,
    "surtax": 0,
    "charges": 0,
    "refundableVat": 14076.31,       // 可退增值税：只影响现金流，不进 landedCost
    "taxTotal": 14076.31,
    "landedCost": 52134.48,          // 真实成本
    "cashRequired": 66210.79,        // 需备现金
    "cashGap": 14076.31,
    "cashGapRatio": 0.27,
    "cashGapLevel": "yellow",
    "dutyBreakdown": [ { "label": "最惠国关税 3%", "rate": 0.03, "base": 50616, "amount": 1518.48, "confidence": "high", "sourceUrl": "https://…" } ],
    "taxChain": [ { "name": "增值税（ÁFA）", "rate": 0.27, "base": 52134.48, "amount": 14076.31, "refundable": true } ],
    "chargeLines": [],
    "remedy": null
  },

  "range":    { "best": 52134.48, "expected": 52134.48, "worst": 52134.48, "states": [ … ] },
  "unresolved":[ { "id": "UF-04", "title": "…", "status": "open", "reviewDue": "2027-04-20", "impactUsd": null } ],
  "dataGaps": [ { "field": "…", "reason": "…", "impactUsd": null, "suggestAction": "…" } ],
  "assumptions":[ { "field": "insurance", "value": 216, "note": "按参数默认 0.45% 估算", "confidence": "medium" } ],
  "sensitivity":[ { "label": "运费上涨 10%", "delta": 247.2, "deltaPct": 1 } ],
  "timeline": [ { "date": "2026-07-24", "label": "…", "relation": "past" } ],
  "actions":  [ { "label": "ECE/E-mark 汽配认证", "mandatory": true, "who": "出口商", "days": "45–120 天" } ],
  "risk":     { "blockRisk": "green", "costShock": "green", "cashGap": "yellow" },
  "confidence":{ "report": "high", "weighted": 1, "unverifiedCount": 0 },
  "meta":     { "engineVersion": "0.1.0", "paramsVersion": "kb-2026.10.24-5", "asOf": "2026-10-22" }
}
```

**四条渲染红线：**

1. `landedCost` 与 `cashRequired` 不得相加、不得起别名（`totalCost`/`landedTotal`/`finalCost` 一律禁用）
2. `state` 为 `blocked` 或 `needs_confirmation` 时，**`expected` 可能为 `null`**，界面要显示「算不出来 + 原因」，不能显示 0
3. `unresolved` 为空要写「本票没有待核项」，**不许整块不显示**
4. 比率（`rate`/`deltaPct`/`cashGapRatio`）是 0–1 小数，乘 100 再显示

---

## 四、老周的两条通道

### POST /api/assistant/prefetch

只读、不调模型、不花额度。认出问题里的编码/品名 + 国家，就去参数库查事实。

```jsonc
// 请求
{ "question": "8708.91 汽配发匈牙利，最惠国税率多少" }

// 命中
{ "kind": "facts", "facts": { "国家": "匈牙利", "编码": "8708.91", "最惠国税率": { "值": "3%", "置信度": "high", "出处": "https://…" } } }

// 没认出来
{ "kind": "none", "reason": "no_country" }
```

`kind` 三种：`facts` / `ambiguous`（编码有多种可能）/ `none`。
**`none` 不是错误**，前端照常把问题发给模型，只是不带事实。

### ALL /.cloud/*

云服务 key 有 Origin 白名单，换域名会 403 `access_denied`，而且**拦在浏览器端、服务器日志一个字都没有**。
所以服务端做了同源转发：客户端请求 `/.cloud/…`，服务端不带 Origin 去请求上游。

```
POST /.cloud/llm/chat/completions
x-wb-webapp-access-key: <必带，否则这个端点会变成开放转发器>
```

**实测结论（2026-10-25，对着线上 key 跑出来的，不是猜的）：**

| 项 | 结论 |
| --- | --- |
| 路径前缀 | `/.cloud/llm/...`（SDK 内部常量 `j = "/.cloud"`，不是 `/api/v1/...`） |
| 鉴权 | 只认头 `x-wb-webapp-access-key`，值就是 publishableKey |
| 模型列表 | `GET /.cloud/llm/models` 返回数组，可用 id 见下 |
| **`stream: false`** | **不支持**，返回 `request_invalid_parameter`。必须 `stream: true` 走 SSE |
| 可用模型 | `auto` `hy3` `hy4-preview` `glm-5.3` `glm-5.3-flash` `deepseek-v4.1-flash` `deepseek-v4-flash` `kimi-k2.5` `hunyuan-chat` `minimax-m3` `step-5-preview` 等 30 余个 |

只支持流式这件事对小程序是硬约束：`wx.request` 没有 SSE，必须开 `enableChunked` 并用
`requestTask.onChunkReceived` 自己切 `data:` 行（见 `miniprogram/pages/chat/chat.js`）。
基础库低于 2.20.2 拿不到这个能力，页面上会降级成离线兜底文案，而不是白屏。

---

## 五、小程序接入注意（踩过才知道）

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| 请求合法域名 | `http://IP:8080` 真机直接请求失败 | 开发者工具勾「不校验合法域名」；正式发布需 https + 备案 |
| 无 cookie | 历史报告永远空 | 请求头带 `X-Device-Id` |
| 不支持 SSE | 老周回答要么整段出现要么超时 | 用普通 POST，前端逐字显示 |
| 无 iframe | B 站播放器打不开 | 只提供 `watchUrl`，提示去浏览器 |
| picker 数据量大 | 68 个国家一屏滚不动 | 按 `regionLabel` 分 7 组 |
| 大数字折行 | `66,210.79` 在 375px 下断成两行 | 用 `font-variant-numeric: tabular-nums` + 字号下限 22px |

---

## 六、错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `E_NOT_FOUND` | 404 | 接口或报告不存在 |
| `E_REPORT_NOT_FOUND` | 404 | 报告 ID 无效 |
| `E_DECLARATION_DATE_REQUIRED` | 400 | 缺申报日（决定税率档，必填） |
| `E_MFN_PENDING` | 400 | 该品类在该市场不按货值百分比计征，**拒绝出数**（不是 0） |
| `E_FOB_REQUIRED` | 400 | 货值缺失或 ≤ 0 |
| `E_HS_UNKNOWN` | 400 | 品类不在 6 个已入库范围内 |
| `E_BATCH_TOO_LARGE` | 413 | 批量超过 200 行 |
| `E_OPERATOR_INVALID` | 401 | 操作人密钥无效 |
| `E_DRAFT_MISSING` | 400 | 确认页草稿过期（刷新即丢） |

完整列表见 `lib/` 各模块的 `errors.push({ code })`。

---

## 七、本地测一遍

```bash
# 覆盖
curl -s http://127.0.0.1:4173/api/meta/coverage | head -c 300

# 日历
curl -s "http://127.0.0.1:4173/api/calendar?today=2026-10-25" | head -c 300

# 一句话 → 草稿
curl -s -X POST http://127.0.0.1:4173/api/parse \
  -H "content-type: application/json" \
  -d '{"text":"8708.91 汽配 1200 件，FOB 48000 美元，运到匈牙利，10 月 20 日申报"}'

# 出报告（带设备号，模拟小程序）
curl -s -X POST http://127.0.0.1:4173/api/quote \
  -H "content-type: application/json" -H "x-device-id: mp-test0001" \
  -d '{"input":{"country":"HU","hsCode":"8708.91","fob":48000,"freight":2400,"qty":1200,"channel":"B2B","dates":{"declarationDate":"2026-10-20"}}}'
```
