/**
 * 安全订阅端点 —— 单文件版
 *
 * ────────────────────────────────────────────────────────────────
 * 和常见订阅 Worker 的区别，是把攻击面砍到最小：
 *
 *   1. 没有默认凭据。SUB_KEY 没设置或太短，服务直接不工作（fail closed），
 *      绝不回退到某个写死的默认值。
 *   2. 完全只读。没有编辑页、不处理 POST、不写 KV —— 没有任何
 *      "拿到 URL 就能改内容" 的路径。
 *   3. 不向任何第三方发请求。节点来自你自己设置的环境变量，格式转换
 *      在本文件里完成，没有订阅聚合、没有在线转换、没有 IP 查询。
 *   4. 任何不匹配的请求返回同一份 404：错误的 key、缺失的 key、
 *      浏览器 UA、被拦的 UA、错误的方法，从外面看完全一样。
 * ────────────────────────────────────────────────────────────────
 *
 * 支持的输出格式：
 *   - base64 节点链接列表（v2rayN / v2rayNG / Shadowrocket / Karing /
 *     Hiddify / NekoBox 等"分享链接系"客户端）
 *   - Clash YAML（Clash / Mihomo / Clash Verge / ClashX / Stash 等）
 *     由本文件从同一条链接自动转换，不经过任何第三方
 *
 * 环境变量（控制台 Settings -> Variables and Secrets，或 wrangler secret put）：
 *
 *   必填
 *     SUB_KEY   路径里那一段随机值，32 位十六进制。
 *               生成：openssl rand -hex 16
 *     NODES     节点链接，一行一个（vless:// vmess:// trojan:// ss://）。
 *               也可以直接填已经 base64 过的内容，代码能识别。
 *
 *   可选
 *     NODES_CLASH   自己准备的完整 Clash YAML。填了就用它，不再自动转换。
 *     SUB_NAME      订阅名（默认 nf-node）
 *     UPDATE_HOURS  建议更新间隔，小时（默认 6）
 *     UA_MODE       clients | nobrowser | any   （默认 nobrowser）
 *     CLASH_NAMES   自动生成 Clash 配置时的顶层分组名（默认 PROXY）
 *     ALERT_WEBHOOK 可选。取订阅时 POST 一条通知，只有事件名 + 国家 +
 *                   机房代码，不含 IP。用来发现地址被别人用了。
 *
 * 订阅地址： https://你的订阅域名/<SUB_KEY>
 *           https://你的订阅域名/<SUB_KEY>/clash    （强制 Clash）
 *           https://你的订阅域名/<SUB_KEY>/base64   （强制 base64）
 *
 * 排障：部署后 `npx wrangler tail`，配置问题会打在日志里；
 *       对外一律返回 404，所以访客看不出区别。
 */

const MIN_KEY_LENGTH = 24;

/** UA_MODE=clients 时放行的客户端特征（小写子串）。 */
const CLIENT_UA = [
  "v2rayn", "v2rayng", "v2ray", "clash", "mihomo", "stash",
  "sing-box", "singbox", "sfi/", "sfa/", "sfm/", "hiddify",
  "shadowrocket", "nekobox", "neko", "surge", "quantumult", "loon",
  "karing", "passwall", "openclash", "flclash", "clashx", "clash-verge",
  "verge", "sub-store", "substore",
];

/** UA_MODE=nobrowser 时额外拒绝的采集器特征（小写子串）。 */
const SCRAPER_UA = [
  "curl/", "wget/", "python-requests", "python-urllib", "aiohttp",
  "go-http-client", "okhttp", "java/", "scrapy", "axios/", "node-fetch",
  "libwww-perl", "httpclient", "guzzle",
];

/** 自动识别为 Clash 系客户端时直接给 YAML。 */
const CLASH_UA = /clash|mihomo|stash|verge|openclash|flclash/;

const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="robots" content="noindex"><title>404 Not Found</title>' +
  "</head><body><h1>404 Not Found</h1></body></html>";

export default {
  async fetch(request, env, ctx) {
    const key = String(env.SUB_KEY || "").trim();

    // 配置不合格就不服务。绝不用默认值兜底 —— 那正是常见实现最容易被
    // 扫描到的原因。对外仍是统一 404，只有 wrangler tail 里能看到原因。
    if (key.length < MIN_KEY_LENGTH) {
      console.warn(
        `[sub] SUB_KEY 未设置或长度不足（当前 ${key.length}，要求 >= ${MIN_KEY_LENGTH}），拒绝服务。` +
          " 生成一个：openssl rand -hex 16"
      );
      return notFound();
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // 第一段必须等于 SUB_KEY。用恒定时间比较，避免时序侧信道。
    if (segments.length === 0 || !timingSafeEqual(segments[0], key)) {
      return notFound();
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return notFound();
    }

    const ua = String(request.headers.get("User-Agent") || "").toLowerCase();
    if (!uaAllowed(ua, env.UA_MODE)) {
      console.log(`[sub] UA 被拒: ${ua.slice(0, 80)}`);
      return notFound();
    }

    // 可选的取用通知。不含 IP，只用于让你发现地址被转手。
    if (env.ALERT_WEBHOOK && ctx && typeof ctx.waitUntil === "function") {
      const cf = request.cf || {};
      ctx.waitUntil(
        fetch(String(env.ALERT_WEBHOOK), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "sub_fetch",
            country: cf.country || "",
            colo: cf.colo || "",
          }),
        }).catch(() => {})
      );
    }

    const nodes = String(env.NODES || "");
    const isHead = request.method === "HEAD";
    const wantClash =
      segments[1] === "clash" ||
      segments[1] === "yaml" ||
      segments[1] === "mihomo" ||
      url.searchParams.has("clash") ||
      CLASH_UA.test(ua);

    if (wantClash) {
      // 优先用你自己准备的完整 YAML；否则从链接自动转换。
      const custom = String(env.NODES_CLASH || "");
      const yaml = custom.trim() ? custom : buildClashYaml(nodes, env);
      if (yaml) return subscription(yaml, "text/yaml; charset=utf-8", env, isHead);
      console.warn("[sub] 请求了 Clash 格式，但 NODES 里没有可转换的节点；回退 base64。");
    }

    const payload = buildBase64Payload(nodes);
    if (!payload) {
      console.warn("[sub] NODES 为空，返回空订阅。请设置 NODES 环境变量。");
    }
    return subscription(payload, "text/plain; charset=utf-8", env, isHead);
  },
};

// ─────────────────────────────── 响应 ───────────────────────────────

/**
 * 订阅响应：显式禁止缓存，并去掉一切可能二次泄露凭据的通道。
 * HEAD 请求必须返回 null body —— 不能依赖运行时替我们剥掉。
 */
function subscription(body, contentType, env, isHead) {
  const name = String(env.SUB_NAME || "nf-node");
  const hours = Number.parseInt(String(env.UPDATE_HOURS || "6"), 10);
  return new Response(isHead ? null : body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      // 响应内容依赖 UA（base64 / YAML 二选一），明确声明避免被错误复用
      vary: "User-Agent",
      "profile-update-interval": String(Number.isFinite(hours) && hours > 0 ? hours : 6),
      "content-disposition": `attachment; filename*=utf-8''${encodeURIComponent(name)}`,
    },
  });
}

/** 所有不匹配的请求都走这里，响应完全一致。 */
function notFound() {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// ─────────────────────────────── base64 输出 ───────────────────────────────

/**
 * 把 NODES 变成客户端能吃的 base64。
 * 如果填进来的已经是 base64（不含 "://" 且只由 base64 字符组成），
 * 原样返回，避免二次编码。
 */
function buildBase64Payload(nodes) {
  const raw = nodes.trim();
  if (!raw) return "";
  if (!raw.includes("://") && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    return raw.replace(/\s+/g, "");
  }
  return toBase64(raw);
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const normalized = padBase64(String(b64).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function padBase64(s) {
  const rest = s.length % 4;
  return rest === 0 ? s : s + "=".repeat(4 - rest);
}

// ─────────────────────────────── Clash YAML 输出 ───────────────────────────────

/**
 * 从分享链接生成一份最小可用的 Clash / Mihomo 配置。
 *
 * 刻意只输出已核实的字段（对照 mihomo 官方配置文档），不猜字段名 ——
 * 写错一个键会让客户端拒收整份配置，比"不支持"更糟。
 *
 * 因此这里**不包含** smux 与 early-data：
 *   - early data：属于可选优化，省略只是每条新连接多一个往返
 *   - smux：mihomo 自己的 smux 与 sing-box 服务端的 mux 是否互通，
 *     我无法在这里验证；加上去一旦不兼容，用户会直接连不上。
 *     需要的话可以手动加 smux: {enabled: true} 自行测试。
 */
function buildClashYaml(nodes, env) {
  const { proxies, skipped } = parseNodes(nodes);
  if (!proxies.length) return "";

  // Clash 要求代理名唯一
  const seen = new Map();
  for (const p of proxies) {
    const base = p.name;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) p.name = `${base} ${n}`;
  }

  const names = proxies.map((p) => p.name);
  // 逗号会破坏 `MATCH,<name>` 的规则语法，直接剔除
  const groupName = (String(env.CLASH_NAMES || "PROXY").trim() || "PROXY").replace(/[,\r\n]/g, "");

  const groups = [
    { name: groupName, type: "select", proxies: ["AUTO", ...names] },
    {
      name: "AUTO",
      type: "url-test",
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
      proxies: names,
    },
  ];

  const head = [
    "# 由订阅 Worker 自动生成（未经过任何第三方转换）",
    "# 这是最小可用配置：全部流量走代理。需要分流规则请用客户端自己的规则集覆盖。",
  ];
  if (skipped.length) {
    head.push(`# 已跳过无法转换的链接：${[...new Set(skipped)].join(", ")}`);
  }

  return (
    [
      ...head,
      "proxies:",
      emitObjectList(proxies),
      "proxy-groups:",
      emitObjectList(groups),
      "rules:",
      `  - MATCH,${groupName}`,

    ].join("\n") + "\n"
  );
}

/** 顶层：一组对象，每个对象的第一项跟在 "- " 后面。 */
function emitObjectList(items) {
  return items
    .map((obj) =>
      Object.entries(obj)
        .map(([k, v], i) => {
          const line = emitEntry(k, v, 4);
          return i === 0 ? "  - " + line.slice(4) : line;
        })
        .join("\n")
    )
    .join("\n");
}

function emitEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  const k = yamlKey(key);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}${k}: []`;
    return (
      `${pad}${k}:\n` +
      value.map((v) => `${" ".repeat(indent + 2)}- ${yamlScalar(v)}`).join("\n")
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return `${pad}${k}: {}`;
    return `${pad}${k}:\n` + entries.map(([ik, iv]) => emitEntry(ik, iv, indent + 2)).join("\n");
  }
  return `${pad}${k}: ${yamlScalar(value)}`;
}

/**
 * 输出 YAML 标量。
 *
 * 简单值走裸标量（可读，也是 Clash 配置的惯例）；其余一律用
 * JSON.stringify —— JSON 字符串是合法的 YAML 双引号标量，转义规则一致，
 * 比手写转义安全（中文名、引号、反斜杠都不会出问题）。
 */
const PLAIN_SAFE = /^[A-Za-z0-9_./:@,+-]+$/;
const PLAIN_RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;

function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v ?? "");
  if (
    s &&
    PLAIN_SAFE.test(s) &&
    !PLAIN_RESERVED.test(s) &&
    !/^-?\d+(?:\.\d+)?$/.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

function yamlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** 把多行链接拆成代理对象。 */
function parseNodes(nodes) {
  let text = String(nodes || "").trim();
  if (!text) return { proxies: [], skipped: [] };

  // NODES 可能整体是 base64
  if (!text.includes("://") && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    try {
      text = fromBase64(text);
    } catch {
      return { proxies: [], skipped: [] };
    }
  }

  const proxies = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const uri = raw.trim();
    if (!uri || uri.startsWith("#")) continue;
    const scheme = uri.slice(0, uri.indexOf("://")).toLowerCase();
    let proxy = null;
    try {
      if (scheme === "vless") proxy = parseVless(uri);
      else if (scheme === "vmess") proxy = parseVmess(uri);
      else if (scheme === "trojan") proxy = parseTrojan(uri);
      else if (scheme === "ss") proxy = parseSs(uri);
    } catch (err) {
      console.log(`[sub] 解析失败 ${scheme}:// ${err && err.message}`);
    }
    if (proxy) proxies.push(proxy);
    else skipped.push(`${scheme}://`);
  }
  return { proxies, skipped };
}

// ─────────────────────────────── 各协议解析 ───────────────────────────────

function safeUrl(uri) {
  // 分享链接里的 #名字 可能是中文，URL 解析后需要再解一次码
  return new URL(uri);
}

function fragName(u, fallback) {
  const h = u.hash ? u.hash.slice(1) : "";
  let name = h;
  try {
    name = decodeURIComponent(h);
  } catch {
    /* 保留原样 */
  }
  return name.trim() || fallback;
}

function portOf(u, def) {
  const p = Number.parseInt(u.port, 10);
  return Number.isFinite(p) && p > 0 ? p : def;
}

/** 统一的 传输/WS/TLS 处理，vless / vmess / trojan 共用。 */
function applyTransport(proxy, net, host, path, tlsHost) {
  if (net === "ws" || net === "" || net === "none") {
    proxy.network = "ws";
    proxy["ws-opts"] = {
      path: path || "/",
      headers: { Host: host || tlsHost || proxy.server },
    };
  } else if (net === "grpc") {
    proxy.network = "grpc";
    proxy["grpc-opts"] = { "grpc-service-name": path || "" };
  } else if (net === "h2" || net === "http") {
    proxy.network = "h2";
    proxy["h2-opts"] = { path: path || "/", host: host ? [host] : [proxy.server] };
  } else {
    proxy.network = "tcp";
  }
}

function parseVless(uri) {
  const u = safeUrl(uri);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();
  const security = (q.get("security") || "").toLowerCase();

  const p = {
    name: fragName(u, `${u.hostname}:${portOf(u, 443)}`),
    type: "vless",
    server: u.hostname,
    port: portOf(u, 443),
    uuid: decodeURIComponent(u.username || ""),
    udp: true,
  };
  if (!p.uuid) return null;

  if (security === "tls" || security === "reality" || security === "xtls") {
    p.tls = true;
    p.servername = q.get("sni") || q.get("host") || u.hostname;
    if (security === "reality" && q.get("pbk")) {
      p["reality-opts"] = { "public-key": q.get("pbk"), "short-id": q.get("sid") || "" };
    }
  }
  const alpn = q.get("alpn");
  if (alpn) p.alpn = alpn.split(",").map((s) => s.trim()).filter(Boolean);

  // flow 只对原始 TCP 有意义；WS 下带上会让客户端连不上
  const flow = q.get("flow") || "";
  if (flow && (net === "tcp" || net === "raw")) p.flow = flow;

  applyTransport(p, net, q.get("host"), q.get("path"), p.servername);

  const fp = q.get("fp");
  if (fp) p["client-fingerprint"] = fp;
  // 分享链接里 allowInsecure=1 表示"跳过证书校验"，但我们自己生成的节点
  // 走 Cloudflare，证书是有效的，默认不跳。
  p["skip-cert-verify"] = q.get("allowInsecure") === "1";
  return p;
}

function parseVmess(uri) {
  const body = uri.slice("vmess://".length).split("#")[0].trim();
  const json = JSON.parse(fromBase64(body));
  const net = String(json.net || "tcp").toLowerCase();

  const p = {
    name: String(json.ps || "").trim() || `${json.add}:${json.port || 443}`,
    type: "vmess",
    server: String(json.add || ""),
    port: Number.parseInt(json.port, 10) || 443,
    uuid: String(json.id || ""),
    cipher: "auto",
    udp: true,
  };
  if (!p.server || !p.uuid) return null;

  const tls = String(json.tls || "").toLowerCase();
  if (tls === "tls" || tls === "reality") {
    p.tls = true;
    p.servername = String(json.sni || json.host || p.server);
  }
  if (json.alpn) {
    p.alpn = String(json.alpn).split(",").map((s) => s.trim()).filter(Boolean);
  }
  applyTransport(p, net, json.host, json.path, p.servername);
  p["skip-cert-verify"] = false;
  if (json.fp) p["client-fingerprint"] = String(json.fp);
  return p;
}

function parseTrojan(uri) {
  const u = safeUrl(uri);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();

  const p = {
    name: fragName(u, `${u.hostname}:${portOf(u, 443)}`),
    type: "trojan",
    server: u.hostname,
    port: portOf(u, 443),
    password: decodeURIComponent(u.username || ""),
    udp: true,
    // trojan 的 TLS 是强制的，且字段名是 sni 而不是 servername
    sni: q.get("sni") || q.get("peer") || u.hostname,
    "skip-cert-verify": q.get("allowInsecure") === "1",
  };
  if (!p.password) return null;

  applyTransport(p, net, q.get("host"), q.get("path"), p.sni);
  const fp = q.get("fp");
  if (fp) p["client-fingerprint"] = fp;
  return p;
}

function parseSs(uri) {
  // 两种写法：
  //   ss://base64(method:password)@host:port#name   （SIP002）
  //   ss://base64(method:password@host:port)#name   （旧写法）
  let rest = uri.slice("ss://".length);
  let fragment = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query = "";
  const qAt = rest.indexOf("?");
  if (qAt >= 0) {
    query = rest.slice(qAt + 1);
    rest = rest.slice(0, qAt);
  }

  let method = "";
  let password = "";
  let hostport = "";

  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    let decoded = userinfo;
    try {
      decoded = fromBase64(userinfo);
    } catch {
      decoded = decodeURIComponent(userinfo);
    }
    const colon = decoded.indexOf(":");
    method = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
  } else {
    let decoded = "";
    try {
      decoded = fromBase64(rest);
    } catch {
      return null;
    }
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) return null;
    hostport = decoded.slice(at2 + 1);
    const userinfo = decoded.slice(0, at2);
    const colon = userinfo.indexOf(":");
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
  }

  const colon = hostport.lastIndexOf(":");
  if (colon < 0) return null;
  const server = hostport.slice(0, colon);
  const port = Number.parseInt(hostport.slice(colon + 1), 10);
  if (!server || !method || !Number.isFinite(port)) return null;

  let name = fragment;
  try {
    name = decodeURIComponent(fragment);
  } catch {
    /* 保留原样 */
  }

  const p = {
    name: name.trim() || `${server}:${port}`,
    type: "ss",
    server,
    port,
    cipher: method,
    password,
    udp: true,
  };

  const params = new URLSearchParams(query);
  const plugin = params.get("plugin");
  if (plugin) {
    const [pluginName, ...opts] = decodeURIComponent(plugin).split(";").filter(Boolean);
    p.plugin = pluginName;
    p["plugin-opts"] = {};
    for (const o of opts) {
      const [k, v] = o.split("=");
      p["plugin-opts"][k] = v === undefined ? true : v;
    }
  }
  return p;
}

// ─────────────────────────────── 其它 ───────────────────────────────

/**
 * 恒定时间比较。长度本身不是秘密（约定 32），所以先比长度不算泄露。
 * 这只是消掉时序侧信道，真正的安全边界是 SUB_KEY 的熵。
 */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function uaAllowed(ua, mode) {
  const m = String(mode || "nobrowser").toLowerCase();
  if (m === "any") return true;
  if (m === "clients") return CLIENT_UA.some((s) => ua.includes(s));
  // nobrowser：拒绝浏览器与常见采集器，其余放行。
  // 注意这是"降低噪声"，不是安全边界 —— 路径的熵才是。
  if (ua.includes("mozilla")) return false;
  if (SCRAPER_UA.some((s) => ua.includes(s))) return false;
  return true;
}
