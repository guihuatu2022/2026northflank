#!/usr/bin/env node
/**
 * 把 sing-box 格式的节点配置（JSON）转成标准分享链接。
 *
 * 为什么需要它：Karing 的「分享」只产出 ulink:// 私有格式，导不出标准链接
 * （KaringX/karing#1332，作者回复 no plan）。但它可以把配置以 JSON 显示/复制
 * 出来，从 JSON 就能还原成标准链接。
 *
 * 跑法：
 *   node sub/json-to-link.mjs '{"server":"...","type":"vless",...}'
 *   node sub/json-to-link.mjs < config.json
 *   node sub/json-to-link.mjs            # 交互式粘贴，Ctrl-D 结束
 *
 * 会明确列出**标准分享链接表达不了、因此被丢掉**的字段 —— 最关键的是
 * 自定义 WebSocket 头（例如 X-Origin-Key）。丢了它，直连源站会被拒绝。
 */

import readline from "node:readline";

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

let raw = process.argv.slice(2).join(" ").trim();
if (!raw) {
  if (!process.stdin.isTTY) {
    raw = (await readStdin()).trim();
  } else {
    console.log(`${BOLD}把配置 JSON 粘进来，粘完按 Ctrl-D：${OFF}`);
    raw = (await readStdin()).trim();
  }
}
if (!raw) {
  console.error("没有输入内容。");
  process.exit(1);
}

let obj;
try {
  obj = JSON.parse(raw);
} catch (err) {
  console.error(`${RED}JSON 解析失败：${err.message}${OFF}`);
  process.exit(1);
}

// 有些人会粘一个含 outbounds 的完整配置，这里自动挑出第一个可用节点
if (!obj.type && Array.isArray(obj.outbounds)) {
  const found = obj.outbounds.find((o) => o && o.type && o.server);
  if (!found) {
    console.error(`${RED}这份配置里找不到带 server 的 outbound。${OFF}`);
    process.exit(1);
  }
  obj = found;
}

const warnings = [];
const lost = [];

const enc = encodeURIComponent;
const type = String(obj.type || "").toLowerCase();
const host = String(obj.server || "");
const port = Number(obj.server_port || obj.port || 0);

if (!host || !port) {
  console.error(`${RED}缺少 server 或 server_port。${OFF}`);
  process.exit(1);
}

const q = [];
const push = (k, v) => {
  if (v !== undefined && v !== null && v !== "") q.push(`${k}=${v}`);
};

/** TLS / uTLS / REALITY */
function applyTls(target) {
  const tls = target.tls || {};
  const reality = tls.reality || {};
  if (tls.enabled === false) return { security: "", sni: "", fp: "" };
  const isReality = !!(reality.enabled || reality.public_key || reality.publicKey);
  const sni = String(tls.server_name || tls.serverName || target.sni || "");
  const utls = tls.utls || {};
  const fp = String(utls.fingerprint || tls.fingerprint || target.fp || "");
  if (isReality) {
    push("security", "reality");
    push("pbk", reality.public_key || reality.publicKey || "");
    push("sid", reality.short_id || reality.shortId || "");
    if (reality.spider_x || reality.spiderX) push("spx", reality.spider_x || reality.spiderX);
  } else {
    push("security", "tls");
  }
  push("sni", enc(sni));
  push("fp", fp);
  if (Array.isArray(tls.alpn) && tls.alpn.length) push("alpn", enc(tls.alpn.join(",")));
  if (tls.insecure || tls.allowInsecure) push("allowInsecure", "1");
  return { security: "tls", sni, fp };
}

/** 传输层；顺带记录标准链接表达不了的头部 */
function applyTransport(target) {
  const tr = target.transport || {};
  const net = String(tr.type || "tcp").toLowerCase();
  const headers = tr.headers || {};
  const hostHeader =
    headers.Host || headers.host || (Array.isArray(headers.Host) ? headers.Host[0] : "");

  for (const [k, v] of Object.entries(headers)) {
    if (/^host$/i.test(k)) continue;
    const val = Array.isArray(v) ? v.join(", ") : String(v);
    lost.push(
      `自定义 WebSocket 头 ${k}: ${mask(val)} —— 标准分享链接没有承载它的字段`
    );
  }

  if (net === "ws") {
    push("type", "ws");
    push("host", enc(String(hostHeader || host)));
    push("path", enc(String(tr.path || "/")));
  } else if (net === "grpc") {
    push("type", "grpc");
    push("serviceName", enc(String(tr.service_name || tr.serviceName || "")));
    if (tr.multi_mode || tr.multiMode) push("mode", "multi");
  } else if (net === "http" || net === "h2") {
    push("type", "h2");
    push("host", enc(String(hostHeader || host)));
    push("path", enc(String(tr.path || "/")));
  } else {
    push("type", "tcp");
    push("headerType", String(tr.header && tr.header.type ? tr.header.type : "none"));
  }
  return net;
}

function mask(s) {
  const v = String(s);
  return v.length <= 12 ? v : v.slice(0, 6) + "…" + v.slice(-4);
}

let link = "";

if (type === "vless") {
  const uuid = String(obj.uuid || "");
  if (!uuid) {
    console.error(`${RED}缺少 uuid。${OFF}`);
    process.exit(1);
  }
  push("encryption", "none");
  applyTls(obj);
  if (obj.flow) push("flow", enc(String(obj.flow)));
  applyTransport(obj);
  link = `vless://${uuid}@${host}:${port}?${q.join("&")}#${enc(String(obj.tag || obj.name || ""))}`;
} else if (type === "vmess") {
  const j = {
    v: "2",
    ps: String(obj.tag || obj.name || ""),
    add: host,
    port: String(port),
    id: String(obj.uuid || ""),
    aid: String(obj.alter_id || obj.alterId || 0),
    scy: String(obj.security || "auto"),
    net: String((obj.transport || {}).type || "tcp"),
    type: "none",
    host: "",
    path: "",
    tls: "",
  };
  const tls = obj.tls || {};
  if (tls.enabled !== false && (tls.server_name || tls.serverName || tls.enabled)) {
    j.tls = "tls";
    j.sni = String(tls.server_name || tls.serverName || "");
  }
  const tr = obj.transport || {};
  if (j.net === "ws") {
    j.path = String(tr.path || "/");
    const hh = (tr.headers || {}).Host || (tr.headers || {}).host || host;
    j.host = Array.isArray(hh) ? hh[0] : String(hh);
    for (const k of Object.keys(tr.headers || {})) {
      if (!/^host$/i.test(k)) {
        lost.push(`自定义 WebSocket 头 ${k} —— 标准分享链接没有承载它的字段`);
      }
    }
  } else if (j.net === "grpc") {
    j.path = String(tr.service_name || tr.serviceName || "");
  }
  link = "vmess://" + Buffer.from(JSON.stringify(j), "utf8").toString("base64");
} else if (type === "trojan") {
  const password = String(obj.password || "");
  if (!password) {
    console.error(`${RED}缺少 password。${OFF}`);
    process.exit(1);
  }
  const tls = obj.tls || {};
  push("security", "tls");
  push("sni", enc(String(tls.server_name || tls.serverName || obj.sni || host)));
  if (Array.isArray(tls.alpn) && tls.alpn.length) push("alpn", enc(tls.alpn.join(",")));
  applyTransport(obj);
  link = `trojan://${enc(password)}@${host}:${port}?${q.join("&")}#${enc(
    String(obj.tag || obj.name || "")
  )}`;
} else if (type === "shadowsocks" || type === "ss") {
  const method = String(obj.method || obj.cipher || "");
  const password = String(obj.password || "");
  if (!method || !password) {
    console.error(`${RED}缺少 method 或 password。${OFF}`);
    process.exit(1);
  }
  const userinfo = Buffer.from(`${method}:${password}`, "utf8").toString("base64");
  link = `ss://${userinfo}@${host}:${port}#${enc(String(obj.tag || obj.name || ""))}`;
} else {
  console.error(`${RED}不支持的 type：${type || "(空)"}${OFF}`);
  console.log(`${DIM}支持的：vless / vmess / trojan / shadowsocks${OFF}`);
  process.exit(1);
}

// 标准链接表达不了的其它设置
const mp = obj.multiplex || obj.mux;
if (mp && mp.enabled !== false && (mp.enabled || mp.protocol)) {
  lost.push(
    `多路复用（mux${mp.protocol ? " / " + mp.protocol : ""}）—— 标准链接没有这个字段，需要在客户端界面里手动开`
  );
}
if (obj.udp === false) lost.push("udp: false —— 标准链接无法表达，客户端默认会开");

console.log(`${BOLD}标准分享链接${OFF}\n`);
console.log(link);
console.log();

if (lost.length) {
  console.log(`${YELLOW}${BOLD}以下设置无法写进标准链接，已丢弃：${OFF}`);
  for (const l of lost) console.log(`  ${YELLOW}·${OFF} ${l}`);
  console.log();
  console.log(
    `${BOLD}注意：${OFF}自定义 WebSocket 头通常用来过源站的门禁（例如本项目的 ORIGIN_SECRET）。`
  );
  console.log(
    `丢掉它之后，这条链接${RED}不能直连源站${OFF}，但${GREEN}经 Cloudflare 的域名可以用${OFF}`
  );
  console.log(`—— 因为那一段的头是 Worker 自己加的，不需要客户端提供。`);
  console.log();
}

if (warnings.length) {
  for (const w of warnings) console.log(`${YELLOW}·${OFF} ${w}`);
}
