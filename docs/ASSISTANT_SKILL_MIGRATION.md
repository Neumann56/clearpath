# 让老周"会想"：外贸专家能力接入方案

> 面向场景：校内比赛演示（不做真实报关测评）
> 约束不变：零 npm 依赖、浏览器端单轮对话、双口径不相加
>
> **状态：已落地（2026-10-25）。** L2 常识包 9 → 18 类、L3 服务端预取、
> `tests/assistant-agent.test.js`（13 项）、`verify` 201 项全绿。
> 实测结果见第八节。

---

## 〇、先回答那句问题

**能迁，但"全量迁移"的正确含义是迁能力，不是贴原文。**

专家 skill 原文直接塞进系统词，在比赛现场是**风险最高**的一种做法：

| 塞原文会怎样 | 现场表现 |
| --- | --- |
| 常识包有绝对 3000 字上限（11 项测试钉着） | 超限后截断，注进去的是半截话 |
| 正文出现费率、公式、加成系数 | 模型立刻开始算这票的账，`landedCost` 和 `cashRequired` 被它合成一个数 |
| 大量"读取文件 / 执行脚本"的指令 | 浏览器里执行不了，模型要么忽略要么编造执行结果 |
| 评委追问"这个数哪来的" | 答不出来 —— 而"每个数有出处"正是这个产品的卖点 |

**比赛现场就是最严格的测评。** 评委不问"你算得快不快"，只问"你这个数凭什么"。老周当场给出一个没出处的数字，前面演示的"我们不编数"全部作废。

所以方案是：**能力全给，算式不给。**

---

## 一、专家 skill 的结构与逐块处理

一个专家 skill 大致是这几块，每块能不能迁、怎么迁完全不同：

| skill 里的块 | 内容形态 | 处理 | 落点 |
| --- | --- | --- | --- |
| 身份与人设 | "你是有十年经验的外贸经理" | **原样迁** | `assistant-prompt.js` 已有 |
| 领域概念与判断 | "FOB 和 CIF 差在谁承担运费保险" | **改写后迁**，删掉所有数字 | `trade-knowledge.js` 扩类 |
| 话术与客户应对 | "客户压价时先问清是压单价还是压总价" | **原样迁**，这类最值钱 | `trade-knowledge.js` 扩类 |
| 操作流程 | "报价前先确认这三件事" | **迁成指路**，指向产品页面 | `product-map.js` 预填链接 |
| 报价核算方法 | "成本加成 15%–20%" | **不迁** | — |
| 利润与退税测算 | "退税率 13%，换算公式…" | **不迁** | 引擎已做，且必须走报告 |
| 工具/脚本调用 | "执行 xxx.py 读取参数表" | **不迁**，改成服务端工具 | 见第三节 |

判断标准一句话：**能改变"怎么说"，就迁；会改变"算什么"，就不迁。**

---

## 二、三层结构

```
┌─ L1 人格层（已有）  assistant-prompt.js
│    十二年老外贸的口吻、三条硬规则（不算数/不给合计/不承诺）
├─ L2 常识层（扩容）  trade-knowledge.js  9 类 → 18 类
│    纯定性、零数字，按关键词命中注入，最多 2 条
└─ L3 工具层（新增）  lib/assistant-agent.js
     服务端查参数库，把"带出处的数字"递给模型
     —— 这一层才是让评委觉得"它真懂这单"的地方
```

L3 是关键。没有它，老周永远只能讲通识；有了它，他能张口说出"8708.91 到美国 MFN 是 2.5%，出处 HTS 8708.91.50，置信度高"——**而这个数字不是他算的，是参数库给的。**

---

## 三、L3 实现：服务端预取（推荐）

### 3.1 为什么不是 ReAct 工具循环

真正的工具循环要模型支持 function calling、要改前端流式协议、要处理"模型乱调工具"。演示项目不值得。

**预取**的思路：服务端先看懂问题里有没有 HS 码和国家，有就直接查参数库，把结果拼进系统词，再让模型单轮回答。

效果对评委几乎一样（老周张口就有数），但：
- 不改前端 `messages` 结构，只多一个前置请求
- 不依赖模型是否支持 tools
- 数字 100% 来自 `data/params`，不可能编
- 查不到就说查不到，不会硬凑

### 3.2 新增 `lib/assistant-agent.js`

```js
// 服务端预取：从问题里认出 HS 码 + 国家，查参数库，返回带出处的数字
import { loadParams, matchTariff, matchCharges, resolveHsInput } from './params.js';

/** 从中文里找国家名，长名优先（"阿联酋"要压过"阿联"） */
function findCountry(q, params) {
  const hits = (params.raw.countries || [])
    .filter((c) => c.name && q.includes(c.name))
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0] || null;
}

/** 从问题里抠出 HS 码；没有编码就把整句交给品名归一（和录入页同一套逻辑） */
function findHs(q, params) {
  const m = q.match(/\d{4}(?:[\s.]?\d{2}){0,2}/);
  return resolveHsInput(params, m ? m[0] : q);
}

/**
 * 返回 null 表示这问题不涉及具体某票，交给纯常识回答。
 * 返回对象时，facts 会被序列化进系统词 —— 只给已格式化的字符串，不给公式。
 */
export function prefetch(question) {
  const params = loadParams();
  const q = String(question || '');
  const country = findCountry(q, params);
  const hsRes = findHs(q, params);
  // partial_code 是"10%"里的 10 这种，认了就会拿它去套税目 —— 必须先挡
  if (!hsRes || hsRes.matchedBy === 'partial_code') return null;
  if (!country || !hsRes.digits) return null;
  if (hsRes.matchedBy === 'ambiguous') {
    return { kind: 'ambiguous', country, candidates: hsRes.candidates };
  }

  const tariff = matchTariff(params.idx, country.code, hsRes.digits);
  const charges = matchCharges(params.idx, country.code);
  const cat = (params.raw.hsCatalog || []).find((c) => hsRes.digits.startsWith(c.hs));

  return {
    kind: 'facts',
    facts: {
      编码: hsRes.digits,
      品类: cat ? cat.name : '未归类',
      市场: `${country.name}（${country.code}）`,
      数据版本: params.version,
      数据截止: params.asOf,
      最惠国税率: tariff
        ? {
            值: pct(tariff.rate),
            置信度: tariff.confidence,
            出处: tariff.sourceUrl,
            说明: tariff.note || '',
            生效日: tariff.validFrom || '',
          }
        : '参数库无此组合',
      规费: charges.length
        ? charges.map((c) => ({
            名称: c.label || c.code,
            计法: c.rate ? pct(c.rate) : '定额',
            下限: c.min || '',
            上限: c.max || '',
            置信度: c.confidence || '',
            出处: c.sourceUrl || '',
          }))
        : '该市场规费未入库（报告里会写明，不给 0）',
    },
  };
}

function pct(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return String(rate || '');
  return `${Number((n * 100).toFixed(3))}%`;   // 0.025 → 2.5% / 0.003464 → 0.346%
}
```

### 3.3 `server.js` 加一条路由

```js
// POST /api/assistant/prefetch —— 只读，不打模型，不花额度
if (url.pathname === '/api/assistant/prefetch' && req.method === 'POST') {
  const body = await readBody(req);          // 现有 helper，内部已限 2MB
  const { prefetch } = await import('./lib/assistant-agent.js');
  return send(res, 200, prefetch(body.question || '') || { kind: 'none' });
}
```

### 3.4 `public/js/assistant.js` 改一处

在 `general` 模式发消息前，先问一次预取，命中就把 facts 塞进系统词：

```js
// 发消息前
let sys = generalSystemPrompt(question, activeIds);   // 现有
try {
  const r = await fetch('/api/assistant/prefetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const pf = await r.json();
  if (pf.kind === 'facts') sys += factsBlock(pf.facts);      // 见下
  if (pf.kind === 'ambiguous') sys += askWhichOne(pf.candidates);
} catch { /* 预取失败不影响对话，退化成纯常识回答 */ }
```

`factsBlock()` 的措辞是成败关键：

```js
function factsBlock(f) {
  return `\n\n【这票的已知事实】以下数字全部来自参数库 ${f.数据版本}，`
    + `你可以直接引用，但**必须一并说出置信度和出处**，并且：\n`
    + `- 不许相加、不许折算成金额、不许估算总成本\n`
    + `- 不许说"大概""差不多"，库里没有就说没有\n`
    + `${JSON.stringify(f, null, 1)}\n`;
}
```

### 3.5 边界（必须实现）

| 情况 | 行为 |
| --- | --- |
| 问题里只有国家没有编码 | 不预取，回答里引导「新预演」，并给预填链接 |
| 编码命中多个品类 | 回候选让人挑，不替用户选（猜错就是用错税目） |
| 参数库没这个组合 | 明确说"这个组合没入库"，不许近似 |
| 规费未入库 | 说"该市场规费未入库"，**不许给 0** |
| 预取接口挂了 | 静默降级成纯常识回答，页面不报错 |

---

### 3.6 已实测（对着 `kb-2026.10.24-5` 真跑过）

上面这套识别逻辑已经在真实参数库上验过，七个问句的结果：

| 问句 | 识别结果 | 预取 |
| --- | --- | --- |
| 8708.91 汽配发匈牙利的最惠国税率 | HU / 870891 · 3% · high · TARIC | ✅ |
| 8708.91 到美国税率和出处 | US / 870891 · 2.5% · high · hts.usitc.gov | ✅ |
| 光伏组件发巴西要交什么税 | BR / 854143（品名归一命中） | ✅ |
| 散热器到德国怎么算 | DE / 870891（品名归一命中） | ✅ |
| 这批货总共要花多少钱 | 无实体 | ❌ 引导跑预演 |
| 客户砍价 10% 我该怎么回 | `10` 差点被当成编码 → 被 `partial_code` 挡掉 | ❌ 走话术 |
| 锂电池发美国要注意什么 | 该品类未入库 | ❌ 明说没入库 |

倒数第二条是最容易翻车的地方：**"10%"里的 10 会被正则会抠出来**。如果只判"有没有数字"，老周会拿 `10` 去查税目。`partial_code` 这一挡必须写进代码，不是可选项。

---

## 四、L2 常识包扩容：9 类 → 18 类

现有 9 类：流程 / 报价 / 付款 / 单据 / 信用证 / 术语 / 风险 / 话术 / 原产地。

建议补这 9 类（全部零数字，可从小红书/知乎/外贸论坛的真实问答里提炼，也可从专家 skill 的判断部分改写）：

| 新增主题 | 典型问题 |
| --- | --- |
| 询盘判断 | "客户一上来就要最低价，是不是比价党" |
| 砍价应对 | "客户说要砍 10%，怎么接" |
| 样品与大货 | "样品费该不该收" |
| 验货与索赔 | "客户说货有瑕疵要扣款" |
| 交期沟通 | "客户催交期怎么回" |
| 新客户风控 | "第一次合作要不要做信保" |
| 单证一致性 | "发票和装箱单不一致会怎样" |
| 退运与弃货 | "客户不提货了怎么办" |
| 展会与跟单 | "展会上怎么判断真假买家" |

**铁律不变**：正文不许出现阿拉伯数字、货币符号、百分比费率。有数字模型就会拿去算这票的账。

---

## 五、演示脚本（评委面前 90 秒）

1. **起手**：在录入页问老周「8708.91 汽配发匈牙利，有什么要注意的」
   → 他说出欧盟关税同盟、VAT 现金占用、GPSR 认证**三件事**（L2 命中）
2. **亮工具**：切到首页问「8708.91 到美国的最惠国税率是多少，出处是哪」
   → 他答「2.5%，HTS 8708.91.50，置信度高」，**出处可点开**（L3 预取）
3. **划边界**：接着问「那这票总共要花多少钱」
   → 他必须说「这个要跑预演，我给你填好」并给预填链接 —— **不硬算**
4. **收尾**：真跑一票，念出两个数：真实成本 / 需备现金，说「这两个数不能相加，我们永远不给你合计」

第 3 步是整场最值钱的一步。**能算而不算，比会算更难做，也更显专业。**

---

## 六、交付清单（已完成）

- [x] `lib/assistant-agent.js`（新增）——预取：认编码 / 认品名 / 认国家，挡 `partial_code`
- [x] `server.js` 加 `POST /api/assistant/prefetch`——只读、不打模型、不花额度
- [x] `public/js/assistant.js` 加 `prefetchFacts()` + 与模型预热**并行**，2.5 秒超时
- [x] `public/js/assistant-prompt.js` 加 `factsBlock()`，`generalSystemPrompt` 收第 4 个参数
- [x] `public/js/trade-knowledge.js` 扩到 18 类
- [x] `tests/assistant-agent.test.js`（13 项）
- [x] `tests/trade-knowledge.test.js` 加 3 项（事实注入 / 歧义反问 / 无事实时不多一个字节）
- [x] `scripts/e2e-kb-live.js` 修"切题"判据

`node scripts/verify.js` → **201 通过 / 0 失败**（原 185 + 新增 16）。

---

## 七、落地时的两处改动（与最初设想不同）

1. **品名也要认**。初稿 `findHs()` 只认数字编码，导致「光伏组件发巴西要交什么税」识别不出来。
   改成抠不到数字就把整句交给 `resolveHsInput()` 做品名归一——和录入页走同一条路。
2. **`partial_code` 必须显式挡**。`resolveHsInput` 对「客户砍价 10%」会返回 `digits:'10'`，
   因为它把不足 6 位的数字判成"笔误"。如果预取层只写 `!hsRes.digits`，`10` 会一路走到
   `matchTariff` 去套税目。这一挡现在有测试钉着。

---

## 八、实测记录（真模型，2026-10-25）

**问：** `8708.91 汽配发匈牙利，最惠国税率是多少，出处是哪`

> 3%。这是欧盟共同税则的 6 位口径，出处是欧盟 TARIC 查询系统（ec.europa.eu/taxation_customs/dds2/taric），
> 置信度 high，2024-01-01 起生效。
>
> 有一点得提醒：3% 是 6 位税号 8708 91 这一档的税率，再往下的 8 位子目税率不一样：
> 8708 91 20 是 3%，35 和 91 是 4.5%，99 是 3.5%。你得让报关行按实际子目给个书面确认…这个我拿不准，不能替你定。

**问：** `8708.91 发美国，这票总共要花多少钱，给我一个数`

> 这个数我给不了。我手上没有你这票的货值、运费、申报日期这些具体数据，凭空给一个「大概多少」那就是编的…
> 最惠国税率 2.5%（高置信，来源：美国海关 HTS 8708.91.50）
> 另外还挂着三条附加措施：旧 301 25%（置信度 medium，这条还得核）、新 301 12.5%（高置信）、
> 232 钢铝铜 25%（置信度 low，这条最不确定）…它们之间还互斥，232 一旦命中就把 301 全部排掉。
> 清关规费那两块：MPF 按货值 0.346% 计，默认不计入；HMF 按货值 0.125% 计，默认不计入。
> 加不加、叠加哪几条，得由引擎按你的申报日判定，这个我不能替它算。

两问都对：**该给数的给了出处，该拒绝的拒绝了**。第二问是整场演示最值钱的一步——
他手上明明有 2.5% 和各种附加措施，仍然不给总额，还把"为什么不能加"讲清楚了。

---

## 九、还没做、也不建议现在做

云服务的 `chat.completions` 是否支持 `tools` 参数，没实测过。本方案**不依赖它**（用预取代替工具循环），所以不影响落地。若后续想升级成真 ReAct，先跑一次带 `tools` 的请求确认，再决定。

如果坚持要"全量塞原文"，三件事必须做：

1. 把 skill 原文压到 3000 字以内，只留人设与话术，删掉全部算式
2. 改 `assistant-prompt.js` 的基线，同步改 `tests/trade-knowledge.test.js` 的字数断言
3. 演示前用 `node scripts/e2e-kb-live.js "这票总共多少钱"` 实测一次，**确认它不会自己算**

第三条是必须的。测试全绿不代表它不算钱——这个项目已经栽过四次"测试全绿但线上行为错"。
