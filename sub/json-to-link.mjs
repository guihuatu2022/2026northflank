#!/usr/bin/env node
/**
 * 把 sing-box 格式的节点配置（JSON）转成标准分享链接 —— 命令行版。
 *
 * 为什么需要它：Karing 的「分享」只产出 ulink:// 私有格式，导不出标准链接
 * （KaringX/karing#1332，作者回复 no plan）。但它可以把配置以 JSON 显示/复制
 * 出来，从 JSON 就能还原成标准链接。
 *
 * 转换逻辑本身在 sub/worker.js 里 —— 那个文件同时也是部署到 Cloudflare 的
 * 完整代码，管理页上的「从 JSON 导入节点」调用的就是同一份函数。
 * 这个脚本只是给它套一层命令行外壳，所以两边永远不会转出不一样的结果。
 *
 * 跑法：
 *   node sub/json-to-link.mjs '{"server":"...","type":"vless",...}'
 *   node sub/json-to-link.mjs < config.json
 *   node sub/json-to-link.mjs            # 交互式粘贴，Ctrl-D 结束
 *   node sub/json-to-link.mjs '...' > nodes.txt   # 只导出链接，便于重定向
 *
 * 输出约定：链接走 stdout（一行一条，可直接重定向），
 *           被丢弃的字段和失败原因走 stderr（不污染管道）。
 */

import { outboundToLink, extractOutbounds } from "./worker.js";

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function die(msg) {
  console.error(`${RED}${msg}${OFF}`);
  process.exit(1);
}

let raw = process.argv.slice(2).join(" ").trim();
if (!raw) {
  if (process.stdin.isTTY) {
    console.log(`${BOLD}把配置 JSON 粘进来，粘完按 Ctrl-D：${OFF}`);
  }
  raw = (await readStdin()).trim();
}
if (!raw) die("没有输入内容。");

// 先单独试一次整体解析，纯粹为了能在语法出错时给出明确提示 ——
// extractOutbounds 会静默跳过解析失败的片段，那样报错会很难懂。
let whole = null;
try {
  whole = JSON.parse(raw);
} catch {
  /* 不是单个 JSON 对象，交给 extractOutbounds 按片段切 */
}

const outbounds = extractOutbounds(raw);
if (!outbounds.length) {
  if (whole === null) {
    die("JSON 解析失败。请确认粘贴的是完整的一段（从 { 开始到 } 结束）。");
  }
  die("里面没有 JSON 对象。");
}

const links = [];
const lost = [];
const failed = [];
const skipped = [];

for (const ob of outbounds) {
  if (!ob || typeof ob !== "object" || !ob.type || !ob.server) {
    // direct / block / selector 这类没有 server 的 outbound，如实说明而不是假装成功
    if (ob && typeof ob === "object" && ob.type) skipped.push(String(ob.tag || ob.type));
    continue;
  }
  const label = String(ob.tag || ob.name || ob.server || ob.type);
  try {
    const r = outboundToLink(ob);
    links.push(r.link);
    for (const x of r.lost) lost.push(`${label}：${x}`);
  } catch (err) {
    failed.push(`${label}：${(err && err.message) || "转换失败"}`);
  }
}

if (!links.length) {
  console.error(`${RED}没有转出任何链接。${OFF}`);
  for (const f of failed) console.error(`  ${RED}·${OFF} ${f}`);
  if (skipped.length) {
    console.error(`${DIM}跳过（没有 server，属于规则型 outbound）：${skipped.join("、")}${OFF}`);
  }
  process.exit(1);
}

// stdout：只有链接，方便 `> nodes.txt` 或直接喂给别的脚本
for (const l of links) console.log(l);

// stderr：给人看的说明
const err = (s) => console.error(s);
err("");
err(
  `${BOLD}已转换 ${links.length} 条${OFF}` +
    (skipped.length ? `${DIM}（跳过 ${skipped.length} 条规则型 outbound）${OFF}` : "")
);

if (lost.length) {
  err("");
  err(`${YELLOW}${BOLD}以下设置无法写进标准链接，已丢弃：${OFF}`);
  for (const l of lost) err(`  ${YELLOW}·${OFF} ${l}`);
  err("");
  err(
    `${BOLD}注意：${OFF}自定义 WebSocket 头通常用来过源站的门禁（例如本项目的 ORIGIN_SECRET）。`
  );
  err(
    `丢掉它之后，这条链接${RED}不能直连源站${OFF}，但${GREEN}经 Cloudflare 的域名可以用${OFF}`
  );
  err(`—— 因为那一段的头是 Worker 自己加的，不需要客户端提供。`);
}

if (failed.length) {
  err("");
  err(`${YELLOW}${BOLD}这些没转成功：${OFF}`);
  for (const f of failed) err(`  ${YELLOW}·${OFF} ${f}`);
}

if (lost.length || failed.length) {
  err("");
  err(`${DIM}提示：管理页里也有同样的功能（「从 JSON 导入节点」），不用命令行。${OFF}`);
}
