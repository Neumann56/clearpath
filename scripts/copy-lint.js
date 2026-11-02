/**
 * 文案门禁（PRD §10.3）：渲染后扫真实文案，不扫源码。
 * 6 条禁止规则（W1–W6）+ 3 条必现断言（R1–R3）。任一命中 exit 1。
 *
 * 用法：先起服务（npm start），再 node scripts/copy-lint.js [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173';
const NA = process.env.NO_PROXY;
if (!NA) {
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  process.env.HTTP_PROXY = '';
  process.env.HTTPS_PROXY = '';
}

const DISCLAIMER =
  '本报告为基于公开参数与您提供输入的估算，不构成法律、税务或海关申报意见。标注“待核/未核实”的事项尚未取得一手来源，不得作为申报依据。最终税费以目的国海关与您的报关代理确认为准。';

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const RULES = [
  { id: 'W1', re: /包税|双清包税|保证清关|一定能进|保证通过/g, why: '结果承诺' },
  { id: 'W2', re: /最终税费为|实际应缴|以本报告为准/g, why: '把估算写成结论' },
  { id: 'W3', re: /必定适用|一定适用|肯定需要办理/g, why: '存疑项被写成确定结论' },
  { id: 'W4', re: /已核实/g, why: '与置信度标签冲突', allow: (block) => /data-confidence="high"/.test(block) },
  { id: 'W5', re: /总计[^。\n]{0,16}美元/g, why: '疑似跨口径合计', allow: (block) => /data-basis="/.test(block) },
  { id: 'W6', re: /(?<!不含)(?<!不包括)未核实/g, why: '未核项被当成已核项陈述', allow: (block) => /data-unverified-badge/.test(block) },
  // W7：界面文案不许出现内部字段名。属性（如 data-basis="landedCost"）在清洗阶段已被剥离，
  // 所以能命中的都是真显示给用户看的文字。这类词出现在报告里，等于把工程内部口径摊给客户看。
  {
    id: 'W7',
    re: /\b(landedCost|cashRequired|cashGapRatio|cashGap|dutyTotal|taxTotal|effectiveRate|refundableVat|unrefundableTax|complianceCost|addOnTotal|dutiableCif|baseComponents|hsPrefix|taxSteps)\b/g,
    why: '界面出现内部字段名',
  },
];

const FIXTURES = [
  { rule: 'W1', text: '本服务双清包税', hit: true },
  { rule: 'W1', text: '我们不承诺清关结果', hit: false },
  { rule: 'W2', text: '最终税费为 70,862.40', hit: true },
  { rule: 'W2', text: '最终税费以目的国海关确认为准', hit: false },
  { rule: 'W3', text: '该品类必定适用 232', hit: true },
  { rule: 'W3', text: '该编码是否适用尚未核实，两种情形分别为…', hit: false },
  { rule: 'W4', text: '已核实：8708.91 在附件内', hit: true },
  { rule: 'W4', text: '该项未核实，仅供参考', hit: false },
  { rule: 'W5', text: '总计 70,862.40 美元', hit: true },
  { rule: 'W5', text: '税费合计 20,246.40', hit: false },
  { rule: 'W6', text: '本行未核实，不得对外', hit: true },
  { rule: 'W6', text: '该项尚未取得一手来源', hit: false },
  { rule: 'W7', text: '清关需备现金 cashRequired 67,869.12', hit: true },
  { rule: 'W7', text: '分母是 landedCost，不是 cashRequired', hit: true },
  { rule: 'W7', text: '真实成本与需备现金不能相加', hit: false },
];

function runFixtures() {
  const fails = [];
  for (const f of FIXTURES) {
    const r = RULES.find((x) => x.id === f.rule);
    r.re.lastIndex = 0;
    const hit = r.re.test(f.text);
    if (hit !== f.hit) fails.push(`${f.rule} fixture：期望 ${f.hit} 实际 ${hit} · 「${f.text}」`);
  }
  return fails;
}

async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, html: await r.text() };
}

function sectionBlocks(html) {
  const out = [];
  const re = /<section data-report-section="([^"]+)"[\s\S]*?(?=<section data-report-section=|<\/main>)/g;
  let m;
  while ((m = re.exec(html))) out.push({ section: m[1], html: m[0], text: strip(m[0]) });
  return out;
}

async function main() {
  const reportJson = findLatestReport();
  if (!reportJson) {
    console.error('没有已生成的报告。请先运行 npm start 并生成一票，或执行 scripts/seed-demo.js。');
    process.exit(2);
  }

  const targets = [
    { name: '首页', path: '/' },
    { name: '录入', path: '/quote/new' },
    { name: `报告 ${reportJson.reportId.slice(0, 8)}`, path: `/quote/${reportJson.reportId}/report`, isReport: true },
    { name: '打印', path: `/quote/${reportJson.reportId}/print` },
    { name: '待核中心（演示）', path: '/demo/unresolved' },
    // 视频栏目也要过同一道门禁：它的文案里最容易滑出"包税""保证能进"这类结果承诺，
    // 而这里恰好是用户最不设防的地方（看视频时不看免责声明）。
    { name: '看懂外贸', path: '/learn' },
    // 市场热度页全是数字和贸易术语，最容易把"进口额"写成"销量承诺"，也必须过门禁
    { name: '市场热度', path: '/market' },
    { name: '店铺入驻', path: '/shop-guide' },
    { name: '快速上手', path: '/guide' },
    { name: '数据出处', path: '/about' },
    // 手机端是独立的一套模板（先给两个数、明细折叠），文案是新写的，不复用 PC 的，
    // 所以必须单独扫一遍——不扫就等于手机端没有门禁。
    { name: '手机首页', path: '/m' },
    { name: '手机录入', path: '/m/new' },
    { name: '手机报告', path: `/m/report/${reportJson.reportId}` },
    { name: '手机报告页之外的日历', path: '/m/calendar' },
    { name: '手机看懂外贸', path: '/m/learn' },
  ];

  const hits = [];
  let reportHtml = '';

  for (const t of targets) {
    const { status, html } = await get(t.path);
    if (status !== 200) {
      hits.push({ rule: 'HTTP', file: t.name, text: `返回 ${status}` });
      continue;
    }
    if (t.isReport) reportHtml = html;
    const blocks = t.isReport ? sectionBlocks(html) : [{ section: '-', html, text: strip(html) }];
    for (const b of blocks) {
      for (const r of RULES) {
        r.re.lastIndex = 0;
        let m;
        let allowed = false;
        if (r.allow && r.allow(b.html)) allowed = true;
        while ((m = r.re.exec(b.text))) {
          if (allowed) continue;
          hits.push({ rule: r.id, file: `${t.name} · 段 ${b.section}`, text: m[0], why: r.why });
        }
      }
    }
  }

  // ---- R1 双口径同屏 ----
  const r1 = /data-basis="landedCost"[\s\S]*?data-basis="cashRequired"/.test(reportHtml) || /data-basis="cashRequired"[\s\S]*?data-basis="landedCost"/.test(reportHtml);
  const r1text = strip(reportHtml).includes('真实成本') && strip(reportHtml).includes('清关需备现金');
  if (!(r1 && r1text)) hits.push({ rule: 'R1', file: '报告', text: '首屏未同时出现两个口径，或缺少 data-basis 标记' });

  // ---- R2 每条待核都有差额/影响 X 美元 ----
  const cards = reportHtml.match(/data-unresolved-id="[^"]+"[\s\S]*?(?=data-unresolved-id="|<section|<\/div>\s*<\/div>)/g) || [];
  const noMoney = cards.filter(
    (c) => /data-unresolved-impact/.test(c) && !/\d[\d,]*\.\d{2}\s*美元|不进入金额|不适用|无法单独标价/.test(strip(c))
  );
  if (noMoney.length) hits.push({ rule: 'R2', file: '报告 · 段 8.5', text: `${noMoney.length} 条待核卡缺金额或条件句` });

  // ---- R3 免责声明原文 ----
  if (!strip(reportHtml).includes(DISCLAIMER)) hits.push({ rule: 'R3', file: '报告 · 段 10', text: '免责声明与 §6.11 原文不一致' });

  // ---- 段数（AC-13）----
  const sections = [...reportHtml.matchAll(/data-report-section="([^"]+)"/g)].map((m) => m[1]);
  const expect = ['1', '2', '2.5', '3', '4', '4.5', '5', '5.5', '6', '7', '8', '8.5', '9', '10', '11'];
  if (JSON.stringify(sections) !== JSON.stringify(expect)) {
    hits.push({ rule: 'AC-13', file: '报告', text: `段落顺序/数量不符：${sections.join(',')}` });
  }

  const fixtureFails = runFixtures();
  const out = {
    ok: hits.length === 0 && fixtureFails.length === 0,
    base: BASE,
    reportId: reportJson.reportId,
    sections,
    hits,
    fixtures: fixtureFails,
    checkedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(process.cwd(), 'out'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'out', 'copy-lint.json'), JSON.stringify(out, null, 2), 'utf8');

  if (fixtureFails.length) {
    console.error('fixture 失败（改正则前先修 fixture）：');
    for (const f of fixtureFails) console.error(' -', f);
    process.exit(1);
  }
  if (hits.length) {
    console.error(`文案门禁未通过：${hits.length} 处命中`);
    for (const h of hits) console.error(` - [${h.rule}] ${h.file}：${h.text}${h.why ? '（' + h.why + '）' : ''}`);
    process.exit(1);
  }
  console.log(`文案门禁通过 · 报告 ${reportJson.reportId.slice(0, 8)} · ${sections.length} 段全部就位 · 0 命中`);
}

function findLatestReport() {
  const dir = path.join(process.cwd(), 'data', 'runtime', 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, files[0].f), 'utf8'));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
