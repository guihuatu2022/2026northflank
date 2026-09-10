#!/usr/bin/env node
/**
 * 核对一条分享链接能不能用在你的订阅里。
 *
 * 跑法：
 *   node sub/check-link.mjs 'vless://....'
 *   node sub/check-link.mjs            # 不带参数就交互式粘贴
 *
 * 它会拿 ~/.nf-node-secrets 里的 NODE_ID / WS_PATH 去比，
 * 告诉你哪个字段不一致、以及不一致会导致什么后果。
 *
 * 背景：Karing 的「分享」只产出 ulink:// 私有格式，导不出标准 vless://
 * （作者明确表示不做）。所以不要去 Karing 里导出 —— 权威来源是容器真正
 * 在用的那两个值，也就是 make-subscription.sh 打印出来的那条链接。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

const SECRETS = path.join(os.homedir(), ".nf-node-secrets");
const SUBADMIN = path.join(os.homedir(), ".nf-node-sub-admin");

function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      out[s.slice(0, eq).trim()] = s.slice(eq + 1);
    }
  } catch {
    /* 文件不存在就算了 */
  }
  return out;
}

function mask(s, keep = 8) {
  const v = String(s || "");
  if (v.length <= keep + 4) return v;
  return v.slice(0, keep) + "…" + v.slice(-4);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    })
  );
}

const env = { ...loadEnvFile(SECRETS), ...loadEnvFile(SUBADMIN) };

let input = process.argv.slice(2).join(" ").trim();
if (!input) {
  console.log(`${BOLD}把分享链接粘进来${OFF}（vless:// 开头，回车结束）：`);
  input = await ask("> ");
}
if (!input) {
  console.error("没有输入内容。");
  process.exit(1);
}

// 去掉可能被一起复制进来的引号与首尾空白
input = input.replace(/^["'<]+|["'>]+$/g, "").trim();

console.log();

// ─────────────────────────── ulink 的情况先单独说清楚
if (/^ulink:\/\//i.test(input) || /^karing:\/\//i.test(input)) {
  console.log(`${RED}这是 Karing 的私有格式，不是标准分享链接。${OFF}\n`);
  console.log("Karing 的「分享」只会产出 ulink://install/?content=... ，导不出 vless://。");
  console.log("有人提过要求支持标准链接（KaringX/karing#1332），作者回复 no plan。");
  console.log();
  console.log(`${BOLD}你不需要它。${OFF} 你这条节点的权威参数来自容器真正在用的两个值：`);
  console.log(`  NODE_ID 和 WS_PATH，它们存在 ${SECRETS}`);
  console.log();
  console.log(`跑一次下面的命令就能得到正确的链接并核对：`);
  console.log(`  ./sub/make-subscription.sh`);
  console.log(`  node sub/check-link.mjs '<它打印出来的 vless 链接>'`);
  console.log();
  process.exit(2);
}

if (!/^vless:\/\//i.test(input)) {
  console.log(`${YELLOW}注意：这不是 vless:// 链接。${OFF}`);
  if (/^(vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//i.test(input)) {
    console.log("它是其它协议的链接。订阅服务能收（Clash 转换也支持 vmess/trojan/ss），");
    console.log("但下面这些和容器相关的检查只对 vless 有意义。\n");
  } else {
    console.log("看不懂这个格式，只能做有限的检查。\n");
  }
}

// ─────────────────────────── 解析
let u;
try {
  u = new URL(input);
} catch {
  console.error(`${RED}链接格式无法解析。${OFF} 可能被中途截断了（比如复制时少了尾巴）。`);
  process.exit(1);
}

const q = u.searchParams;
const get = (...keys) => {
  for (const k of keys) {
    const v = q.get(k);
    if (v) return v;
  }
  return "";
};
const decodeHash = (h) => {
  try {
    return decodeURIComponent(h || "");
  } catch {
    return h || "";
  }
};

const info = {
  uuid: decodeURIComponent(u.username || ""),
  host: u.hostname,
  port: u.port || "",
  path: get("path"),
  sni: get("sni"),
  hostHeader: get("host"),
  security: (get("security") || "").toLowerCase(),
  type: (get("type") || "tcp").toLowerCase(),
  ed: get("ed"),
  fp: get("fp"),
  name: decodeHash((u.hash || "").replace(/^#/, "")),
};

console.log(`${BOLD}解析结果${OFF}`);
console.log(`  名字      ${info.name || DIM + "(没有名字)" + OFF}`);
console.log(`  地址      ${info.host}:${info.port || "(未写端口)"}`);
console.log(`  UUID      ${mask(info.uuid)}   ${DIM}完整值 ${info.uuid.length} 字符${OFF}`);
console.log(`  传输      ${info.type}    ${info.security ? "security=" + info.security : DIM + "(没有 security 参数)" + OFF}`);
console.log(`  path      ${info.path || DIM + "(没有 path)" + OFF}`);
console.log(`  sni       ${info.sni || DIM + "(没有 sni)" + OFF}`);
console.log(`  Host 头   ${info.hostHeader || DIM + "(没有 host)" + OFF}`);
console.log(`  ed        ${info.ed || DIM + "(没有 ed，每条新连接会多一个往返)" + OFF}`);
console.log(`  指纹      ${info.fp || DIM + "(没有 fp；客户端里请把 TLS 指纹设成 chrome)" + OFF}`);

// ─────────────────────────── 与容器配置对比
const problems = [];
const notes = [];

console.log(`\n${BOLD}与容器配置对比${OFF}`);

if (!env.NODE_ID && !env.WS_PATH) {
  console.log(`${YELLOW}  找不到 ${SECRETS}${OFF}，无法对比。`);
  console.log(`  ${DIM}如果你是用 deploy.sh 配的，那个文件应该存在。${OFF}`);
  notes.push("没有本地凭据可对比");
} else {
  // UUID
  if (env.NODE_ID) {
    if (!info.uuid) {
      console.log(`  UUID      ${RED}缺${OFF}`);
      problems.push("链接里没有 UUID");
    } else if (info.uuid.toLowerCase() === env.NODE_ID.toLowerCase()) {
      console.log(`  UUID      ${GREEN}一致${OFF}`);
    } else {
      console.log(`  UUID      ${RED}不一致${OFF}  本地 ${mask(env.NODE_ID)}  链接 ${mask(info.uuid)}`);
      problems.push("UUID 与容器的 NODE_ID 不同 → 客户端会被拒绝（表现为连上就断）");
    }
  }

  // path：容器用前缀匹配，所以链接里的 path 必须以 WS_PATH 开头
  if (env.WS_PATH) {
    if (!info.path) {
      if (info.type === "ws") {
        console.log(`  path      ${RED}缺${OFF}    容器要求以 ${env.WS_PATH} 开头`);
        problems.push("ws 传输但没有 path → 容器会返回 404");
      } else {
        console.log(`  path      ${DIM}不适用（传输是 ${info.type}）${OFF}`);
      }
    } else if (info.path === env.WS_PATH) {
      console.log(`  path      ${GREEN}一致${OFF}`);
    } else if (info.path.startsWith(env.WS_PATH)) {
      console.log(`  path      ${GREEN}以容器路径为前缀${OFF}（客户端早数据会追加在后面，正常）`);
    } else {
      console.log(`  path      ${RED}不一致${OFF}\n            容器是 ${env.WS_PATH}\n            链接是 ${info.path}`);
      problems.push("path 与容器的 WS_PATH 对不上 → 会返回 404，完全连不上");
    }
  }
}

// 协议/传输层面的检查（和容器无关，但连不上时也是常见原因）
if (info.type !== "ws") {
  notes.push(
    `传输是 ${info.type}，不是 ws。` +
      "如果这条是你自己的节点（要经 Northflank 的公网端口，而它只放 HTTP），" +
      "那它穿不过去，必须是 ws 或 httpupgrade；如果是从别处拿来的直连节点，可以忽略这条"
  );
}
if (info.security !== "tls" && info.security !== "reality") {
  notes.push(
    "没有 security=tls。你自己的节点要经 Cloudflare，这一段必须是 tls；" +
      "别处拿来的直连节点可以忽略"
  );
}
if (info.hostHeader && info.hostHeader !== info.host) {
  notes.push(
    `Host 头是 ${info.hostHeader}，和地址 ${info.host} 不一样。` +
      "经过 Cloudflare 时这会被用来路由，通常应该是同一个域名"
  );
}
if (info.sni && info.hostHeader && info.sni !== info.hostHeader) {
  notes.push(`sni 是 ${info.sni}，Host 头是 ${info.hostHeader}，两者不一致，确认是有意为之`);
}
if (info.ed) {
  const limit = Number.parseInt(env.MAX_EARLY_DATA || "2048", 10);
  const ed = Number.parseInt(info.ed, 10);
  if (Number.isFinite(ed) && Number.isFinite(limit) && ed > limit) {
    problems.push(`ed=${ed} 超过容器的 MAX_EARLY_DATA=${limit}，会被拒绝`);
  }
}

// ─────────────────────────── 结论
console.log(`\n${BOLD}结论${OFF}`);
if (problems.length) {
  for (const p of problems) console.log(`  ${RED}✘${OFF} ${p}`);
  console.log(
    `\n  ${BOLD}这条链接不要放进订阅${OFF}，先按上面的差异改正。`
  );
  if (problems.some((p) => p.startsWith("UUID") || p.startsWith("path"))) {
    console.log(
      `  ${DIM}最省事的做法：删掉它，重新跑 ./sub/make-subscription.sh 拿一条正确的。${OFF}`
    );
  }
} else {
  console.log(`  ${GREEN}✔${OFF} 关键字段都对得上，可以放进订阅。`);
}

if (notes.length) {
  console.log(`\n${BOLD}另外注意${OFF}`);
  for (const n of notes) console.log(`  ${YELLOW}·${OFF} ${n}`);
}

console.log();
process.exit(problems.length ? 1 : 0);
