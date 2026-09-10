/**
 * 订阅服务 —— 单文件版（KV 存储 + 多订阅 + 管理页）
 *
 * ════════════════════════════════════════════════════════════════════
 * 设计要点
 *
 * 1. 读凭证与写凭证彻底分离
 *      订阅 token   只读，且只能读到它自己那一份节点
 *      管理员凭证   读 + 写全部
 *    所以某个朋友的订阅地址泄露，他拿不到任何写能力，也看不到别人的节点，
 *    而且你可以在管理页上单独撤销那一个 token。
 *
 * 2. 没有默认凭据。任何一个关键变量缺失或太短，对应功能直接不工作
 *    （fail closed），绝不回退到写死的默认值。
 *
 * 3. 零第三方请求。节点存在你的 KV 里，Clash YAML 在本文件内转换，
 *    没有订阅聚合、没有在线转换、没有 IP 查询。
 *
 * 4. 订阅路径的响应完全统一：错误的 token、禁用的订阅、浏览器 UA、
 *    被拦的 UA、错误的方法 —— 从外面看都是同一份 404。
 *    唯一的例外是管理路径（它必须让你看到认证弹框）。
 * ════════════════════════════════════════════════════════════════════
 *
 * 环境变量（控制台 Settings -> Variables and Secrets，或 wrangler secret put）
 *
 *   必填
 *     KV             一个 KV 命名空间的绑定，**变量名必须是 KV**
 *     ADMIN_PATH     管理页路径，128 位随机值：openssl rand -hex 16
 *     ADMIN_PASSWORD 管理页密码，至少 16 位，必须是随机值不要自己编：
 *                    openssl rand -base64 24
 *
 *   可选
 *     ADMIN_USER    管理页用户名（默认 admin）
 *     SUB_NAME      订阅名（默认 nf-node）
 *     UPDATE_HOURS  建议更新间隔，小时（默认 6）
 *     UA_MODE       clients | nobrowser | any  （默认 nobrowser）
 *     CLASH_NAMES   自动生成的 Clash 配置里顶层分组名（默认 PROXY）
 *     ALERT_WEBHOOK 可选。取订阅时 POST 一条通知，只有事件名 + 国家 +
 *                   机房代码，不含 IP。
 *
 *   仅在没有绑定 KV 时生效（单订阅降级模式）
 *     SUB_KEY       单一订阅路径
 *     NODES         节点链接，一行一个
 *
 * 地址
 *     管理页： https://订阅域名/<ADMIN_PATH>
 *     订阅：   https://订阅域名/<订阅token>
 *              https://订阅域名/<订阅token>/clash
 *              https://订阅域名/<订阅token>/base64
 *
 * 排障：`npx wrangler tail`，配置问题会打在日志里。
 */

const MIN_KEY_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 16;
const CFG_KEY = "cfg";
/** 两次取订阅间隔小于这个秒数就不重复写 lastFetch，省 KV 写入配额 */
const LASTFETCH_MIN_INTERVAL = 300;

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

const CLASH_UA = /clash|mihomo|stash|verge|openclash|flclash/;

const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="robots" content="noindex"><title>404 Not Found</title>' +
  "</head><body><h1>404 Not Found</h1></body></html>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) return notFound();

    // 1) 管理页。路径本身是 128 位秘密，再加 Basic 认证。
    const adminPath = String(env.ADMIN_PATH || "").trim();
    if (adminPath.length >= MIN_KEY_LENGTH && timingSafeEqual(segments[0], adminPath)) {
      return handleAdmin(request, env, ctx, url);
    }

    // 2) 订阅
    return handleSubscription(request, env, ctx, url, segments);
  },
};

// ═══════════════════════════════ 订阅 ═══════════════════════════════

async function handleSubscription(request, env, ctx, url, segments) {
  const token = segments[0];
  if (token.length < MIN_KEY_LENGTH) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();

  const ua = String(request.headers.get("User-Agent") || "").toLowerCase();
  if (!uaAllowed(ua, env.UA_MODE)) {
    console.log(`[sub] UA 被拒: ${ua.slice(0, 80)}`);
    return notFound();
  }

  let uris = [];
  let subName = "";

  if (env.KV) {
    const cfg = await loadConfig(env);
    const sub = cfg.subs.find((s) => s && timingSafeEqual(String(s.token || ""), token));
    // 未知 token 与已禁用订阅返回完全相同的 404
    if (!sub || sub.enabled === false) return notFound();
    const byId = new Map(cfg.nodes.map((n) => [n.id, n]));
    uris = (sub.nodes || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((n) => n.uri);
    subName = String(sub.name || "");

    // 记录取用时间/国家，用于发现地址被转手。写入做了节流。
    const now = Math.floor(Date.now() / 1000);
    const prev = (sub.lastFetch && Number(sub.lastFetch.ts)) || 0;
    if (now - prev >= LASTFETCH_MIN_INTERVAL && ctx && typeof ctx.waitUntil === "function") {
      const cf = request.cf || {};
      sub.lastFetch = { ts: now, country: String(cf.country || "") };
      ctx.waitUntil(env.KV.put(CFG_KEY, JSON.stringify(cfg)).catch(() => {}));
    }
  } else {
    // 降级模式：没有绑定 KV 时，用 SUB_KEY + NODES 提供单一订阅
    const legacyKey = String(env.SUB_KEY || "").trim();
    if (legacyKey.length < MIN_KEY_LENGTH || !timingSafeEqual(token, legacyKey)) return notFound();
    uris = splitLines(decodeIfBase64Blob(String(env.NODES || "")));
  }

  if (!uris.length) console.warn("[sub] 该订阅没有任何节点，返回空内容。");

  if (env.ALERT_WEBHOOK && ctx && typeof ctx.waitUntil === "function") {
    const cf = request.cf || {};
    ctx.waitUntil(
      fetch(String(env.ALERT_WEBHOOK), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "sub_fetch",
          name: subName,
          country: cf.country || "",
          colo: cf.colo || "",
        }),
      }).catch(() => {})
    );
  }

  const isHead = request.method === "HEAD";
  const joined = uris.join("\n");
  const wantClash =
    segments[1] === "clash" ||
    segments[1] === "yaml" ||
    segments[1] === "mihomo" ||
    url.searchParams.has("clash") ||
    CLASH_UA.test(ua);

  if (wantClash) {
    const yaml = buildClashYaml(joined, env);
    if (yaml) return subscription(yaml, "text/yaml; charset=utf-8", env, isHead, subName);
    console.warn("[sub] 请求了 Clash 格式，但没有可转换的节点；回退 base64。");
  }

  return subscription(toBase64(joined), "text/plain; charset=utf-8", env, isHead, subName);
}

/**
 * 订阅响应：显式禁止缓存，并去掉一切可能二次泄露凭据的通道。
 * HEAD 请求必须返回 null body —— 不能依赖运行时替我们剥掉。
 */
function subscription(body, contentType, env, isHead, subName) {
  const name = String(subName || env.SUB_NAME || "nf-node");
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

// ═══════════════════════════════ 管理页 ═══════════════════════════════

async function handleAdmin(request, env, ctx, url) {
  const password = String(env.ADMIN_PASSWORD || "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.warn(
      `[sub] ADMIN_PASSWORD 未设置或长度不足（当前 ${password.length}，要求 >= ${MIN_PASSWORD_LENGTH}），` +
        "管理页已禁用。生成一个：openssl rand -base64 24"
    );
    return notFound();
  }
  if (!checkBasicAuth(request, env)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: {
        "www-authenticate": 'Basic realm="admin", charset="UTF-8"',
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  if (!env.KV) {
    return htmlResponse(
      adminShell("管理页不可用", "<p>管理页需要绑定一个 KV 命名空间，且变量名必须是 <code>KV</code>。</p>")
    );
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const cfg = await loadConfig(env);
    return htmlResponse(renderAdminPage(cfg, url), request.method === "HEAD");
  }

  if (request.method === "POST") {
    // CSRF：跨站表单设不了自定义头；跨站 fetch 带自定义头会触发 CORS 预检，
    // 而本 Worker 不返回任何 CORS 头，浏览器会直接拦下。Origin 再叠一层。
    if (request.headers.get("x-admin-action") !== "save") {
      return jsonResponse({ ok: false, error: "缺少自定义请求头" }, 403);
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return jsonResponse({ ok: false, error: "Origin 校验失败" }, 403);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400);
    }

    const { cfg, warnings } = await normalizeIncoming(payload, env);
    try {
      await env.KV.put(CFG_KEY, JSON.stringify(cfg));
    } catch (err) {
      console.error("[sub] 写入 KV 失败:", err && err.message);
      return jsonResponse({ ok: false, error: "写入 KV 失败：" + (err && err.message) }, 500);
    }
    return jsonResponse({
      ok: true,
      warnings,
      nodes: cfg.nodes.length,
      subs: cfg.subs.length,
    });
  }

  return notFound();
}

/**
 * 校验并规范化管理页提交的内容。
 *
 * 订阅引用节点**用 URI 而不是 id** —— 这样你在节点池里改一行文字不会让
 * 勾选关系错位，服务端统一负责 URI 与 id 的映射。
 */
async function normalizeIncoming(payload, env) {
  const warnings = [];
  const rawNodes = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
  const nodes = [];
  const seenUri = new Set();
  for (const item of rawNodes) {
    const uri = String(item || "").trim();
    if (!uri || seenUri.has(uri)) continue;
    if (!/^[a-z0-9]+:\/\//i.test(uri)) {
      warnings.push("看不懂这一行，已忽略：" + uri.slice(0, 40));
      continue;
    }
    seenUri.add(uri);
    const name = nameFromUri(uri) || "节点 " + (nodes.length + 1);
    nodes.push({ id: await shortHash(uri), uri, name });
    if (!parseShareLinkSafe(uri)) warnings.push("Clash 无法转换（base64 仍可用）：" + name);
  }

  const uriToId = new Map(nodes.map((n) => [n.uri, n.id]));
  const rawSubs = Array.isArray(payload && payload.subs) ? payload.subs : [];
  const subs = [];
  const seenToken = new Set();
  for (const item of rawSubs) {
    if (!item || typeof item !== "object") continue;
    let token = String(item.token || "").trim();
    if (token.length < MIN_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
      token = randomToken();
      warnings.push("有一个订阅的 token 不合法，已自动重新生成。");
    }
    if (seenToken.has(token)) {
      token = randomToken();
      warnings.push("有两个订阅用了同一个 token，后者已自动重新生成。");
    }
    seenToken.add(token);
    const ids = (Array.isArray(item.nodes) ? item.nodes : [])
      .map((u) => uriToId.get(String(u || "").trim()))
      .filter(Boolean);
    subs.push({
      token,
      name: String(item.name || "").trim() || "未命名",
      enabled: item.enabled !== false,
      nodes: [...new Set(ids)],
      lastFetch: item.lastFetch && typeof item.lastFetch === "object" ? item.lastFetch : null,
    });
  }

  return { cfg: { version: 1, nodes, subs }, warnings };
}

function parseShareLinkSafe(uri) {
  try {
    return parseShareLink(uri);
  } catch {
    return null;
  }
}

async function loadConfig(env) {
  let raw = null;
  try {
    raw = await env.KV.get(CFG_KEY, "json");
  } catch (err) {
    console.warn("[sub] 读取 KV 失败:", err && err.message);
  }
  if (raw && typeof raw === "object") {
    return {
      version: 1,
      nodes: Array.isArray(raw.nodes) ? raw.nodes.filter((n) => n && n.id && n.uri) : [],
      subs: Array.isArray(raw.subs) ? raw.subs.filter((s) => s && s.token) : [],
    };
  }
  // 首次访问：用 NODES / SUB_KEY 做种子，但**不写 KV** —— GET 不该有副作用。
  // 你在管理页点一次保存就会落盘。
  const nodes = await seedNodes(String(env.NODES || ""));
  const subs = [];
  const token = String(env.SUB_KEY || "").trim();
  if (token.length >= MIN_KEY_LENGTH) {
    subs.push({
      token,
      name: "默认",
      enabled: true,
      nodes: nodes.map((n) => n.id),
      lastFetch: null,
    });
  }
  return { version: 1, nodes, subs };
}

async function seedNodes(text) {
  const out = [];
  for (const uri of splitLines(decodeIfBase64Blob(text))) {
    if (!/^[a-z0-9]+:\/\//i.test(uri)) continue;
    out.push({
      id: await shortHash(uri),
      uri,
      name: nameFromUri(uri) || "节点 " + (out.length + 1),
    });
  }
  return out;
}

function renderAdminPage(cfg, url) {
  const payload = {
    nodes: cfg.nodes.map((n) => n.uri),
    subs: cfg.subs.map((s) => ({
      token: s.token,
      name: s.name,
      enabled: s.enabled !== false,
      nodes: cfg.nodes.filter((n) => (s.nodes || []).includes(n.id)).map((n) => n.uri),
      lastFetch: s.lastFetch || null,
    })),
  };
  // 嵌进 <script> 时必须把 < 转义，否则节点名里的 </script> 会截断文档
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return ADMIN_HTML.replace("__BASE__", JSON.stringify(url.origin)).replace("__CFG__", json);
}

function adminShell(title, body) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>订阅管理</title>' +
    "<style>body{font:15px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#222}" +
    "code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}</style></head><body>" +
    (title ? "<h1>" + title + "</h1>" : "") +
    body +
    "</body></html>"
  );
}

function checkBasicAuth(request, env) {
  const header = String(request.headers.get("Authorization") || "");
  if (!/^basic /i.test(header)) return false;
  let decoded;
  try {
    decoded = fromBase64(header.slice(6).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  // 两个都比较，不做短路 —— 否则响应时间会泄露用户名对不对
  const userOk = timingSafeEqual(decoded.slice(0, idx), String(env.ADMIN_USER || "admin"));
  const passOk = timingSafeEqual(decoded.slice(idx + 1), String(env.ADMIN_PASSWORD || ""));
  return userOk && passOk;
}

// ═══════════════════════════════ 管理页前端 ═══════════════════════════════
//
// 注意：这段模板里刻意不使用模板字符串（反引号）与 ${}，
// 因为它本身是外层模板字符串的一部分。

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>订阅管理</title>
<style>
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 56rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; margin: 0 0 .3rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .hint { color: #666; font-size: .875rem; margin: 0 0 .6rem; }
  textarea { width: 100%; box-sizing: border-box; font: 13px/1.5 ui-monospace, monospace;
             padding: .6rem; border: 1px solid #ccc; border-radius: 6px; resize: vertical; }
  .sub { border: 1px solid #ddd; border-radius: 8px; padding: .8rem 1rem; margin: .6rem 0; }
  .sub.off { opacity: .55; }
  .row { display: flex; align-items: center; gap: .5rem; margin: .35rem 0; flex-wrap: wrap; }
  .row > label { width: 3.2rem; color: #666; font-size: .875rem; flex: none; }
  .row input[type=text] { flex: 1 1 12rem; padding: .35rem .5rem; border: 1px solid #ccc;
                          border-radius: 5px; font: inherit; }
  .row .url { font: 12px/1.4 ui-monospace, monospace; background: #f6f6f6; padding: .3rem .45rem;
              border-radius: 4px; flex: 1 1 14rem; word-break: break-all; }
  .nodes { display: flex; flex-wrap: wrap; gap: .3rem .9rem; margin: .5rem 0 .2rem .2rem; }
  .chk { font-size: .875rem; display: inline-flex; align-items: center; gap: .25rem; }
  button { font: inherit; padding: .3rem .7rem; border: 1px solid #ccc; background: #fff;
           border-radius: 5px; cursor: pointer; }
  button:hover { background: #f4f4f4; }
  button.primary { background: #1f5f8b; color: #fff; border-color: #1f5f8b; }
  button.primary:hover { filter: brightness(1.08); }
  button.danger { color: #a33; }
  .bar { position: sticky; bottom: 0; background: #fff; border-top: 1px solid #ddd;
         padding: .7rem 0; margin-top: 1.5rem; display: flex; align-items: center; gap: .8rem; }
  #status { font-size: .875rem; color: #666; }
  .meta { font-size: .8125rem; color: #777; }
  .warn { color: #a33; font-size: .8125rem; margin: .4rem 0 0; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>订阅管理</h1>
<p class="hint">每个订阅有自己的 token 和节点范围。把地址给谁，他就只能拿到你勾选的那些节点。</p>

<h2>节点池</h2>
<p class="hint">一行一个分享链接，支持 vless:// vmess:// trojan:// ss://。链接里 # 后面的内容会作为节点名。</p>
<textarea id="nodesBox" rows="8" spellcheck="false"></textarea>

<h2>订阅</h2>
<div id="subsBox"></div>
<button id="addBtn">+ 新建订阅</button>

<div class="bar">
  <button class="primary" id="saveBtn">保存全部</button>
  <span id="status"></span>
</div>
<p class="warn" id="warnBox"></p>

<script>
var BASE = __BASE__;
var CFG = __CFG__;
var state = { nodes: (CFG.nodes || []).slice(), subs: (CFG.subs || []).slice() };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function fmtTime(ts) {
  if (!ts) return "从未取用";
  return new Date(ts * 1000).toLocaleString();
}

function nodeName(uri) {
  var h = uri.indexOf("#");
  if (h >= 0) {
    try { return decodeURIComponent(uri.slice(h + 1)); } catch (e) { return uri.slice(h + 1); }
  }
  var m = uri.match(/@([^:/?#]+)/);
  return m ? m[1] : uri.slice(0, 30);
}

function renderNodes() {
  document.getElementById("nodesBox").value = state.nodes.join("\\n");
}

function renderSubs() {
  var host = document.getElementById("subsBox");
  host.innerHTML = "";
  if (!state.subs.length) {
    host.innerHTML = '<p class="hint">还没有订阅。点下面的按钮新建一个。</p>';
    return;
  }
  state.subs.forEach(function (sub, i) {
    var box = document.createElement("div");
    box.className = "sub" + (sub.enabled === false ? " off" : "");
    var html = "";
    html += '<div class="row"><label>名称</label>';
    html += '<input type="text" data-i="' + i + '" data-f="name" value="' + esc(sub.name) + '">';
    html += '<label class="chk"><input type="checkbox" data-i="' + i + '" data-f="enabled"' +
            (sub.enabled === false ? "" : " checked") + '> 启用</label></div>';
    html += '<div class="row"><label>地址</label>';
    html += '<span class="url">' + esc(BASE + "/" + sub.token) + "</span>";
    html += '<button data-act="copy" data-i="' + i + '">复制</button>';
    html += '<button data-act="regen" data-i="' + i + '">换 token</button>';
    html += '<button class="danger" data-act="del" data-i="' + i + '">删除</button></div>';
    html += '<div class="meta">上次取用：' + esc(fmtTime(sub.lastFetch && sub.lastFetch.ts));
    if (sub.lastFetch && sub.lastFetch.country) html += "（" + esc(sub.lastFetch.country) + "）";
    html += "</div>";
    html += '<div class="nodes">';
    if (!state.nodes.length) {
      html += '<span class="hint">节点池是空的，先在上面添加节点。</span>';
    } else {
      state.nodes.forEach(function (uri) {
        var checked = (sub.nodes || []).indexOf(uri) >= 0 ? " checked" : "";
        html += '<label class="chk"><input type="checkbox" data-i="' + i + '" data-node="' +
                esc(uri) + '"' + checked + "> " + esc(nodeName(uri)) + "</label>";
      });
    }
    html += "</div>";
    box.innerHTML = html;
    host.appendChild(box);
  });
}

document.getElementById("subsBox").addEventListener("input", function (e) {
  var t = e.target;
  var i = parseInt(t.getAttribute("data-i"), 10);
  if (isNaN(i) || !state.subs[i]) return;
  var f = t.getAttribute("data-f");
  if (f === "name") state.subs[i].name = t.value;
  if (f === "enabled") state.subs[i].enabled = t.checked;
});

document.getElementById("subsBox").addEventListener("change", function (e) {
  var t = e.target;
  var i = parseInt(t.getAttribute("data-i"), 10);
  if (isNaN(i) || !state.subs[i]) return;
  var node = t.getAttribute("data-node");
  if (!node) return;
  var list = state.subs[i].nodes || [];
  var at = list.indexOf(node);
  if (t.checked && at < 0) list.push(node);
  if (!t.checked && at >= 0) list.splice(at, 1);
  state.subs[i].nodes = list;
});

document.getElementById("subsBox").addEventListener("click", function (e) {
  var act = e.target.getAttribute("data-act");
  if (!act) return;
  var i = parseInt(e.target.getAttribute("data-i"), 10);
  if (isNaN(i) || !state.subs[i]) return;
  if (act === "copy") {
    var url = BASE + "/" + state.subs[i].token;
    navigator.clipboard.writeText(url).then(
      function () { setStatus("已复制：" + url); },
      function () { setStatus("复制失败，请手动选中上面的地址"); }
    );
  } else if (act === "regen") {
    if (!confirm("换 token 后旧地址立即失效，需要重新分发给对方。继续？")) return;
    state.subs[i].token = randomToken();
    state.subs[i].lastFetch = null;
    renderSubs();
    setStatus("已换新 token，记得点保存");
  } else if (act === "del") {
    if (!confirm("删除这个订阅？对方的地址会立即失效。")) return;
    state.subs.splice(i, 1);
    renderSubs();
    setStatus("已删除，记得点保存");
  }
});

document.getElementById("addBtn").addEventListener("click", function () {
  state.subs.push({
    token: randomToken(),
    name: "新订阅 " + (state.subs.length + 1),
    enabled: true,
    nodes: state.nodes.slice(),
    lastFetch: null
  });
  renderSubs();
  setStatus("已新建，记得点保存");
});

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function showWarnings(list) {
  document.getElementById("warnBox").textContent = list && list.length
    ? "提醒：\\n" + list.join("\\n")
    : "";
}

function randomToken() {
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
  return out;
}

function reload() {
  return fetch(window.location.pathname, { cache: "no-store" })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var m = html.match(/var CFG = ([\\s\\S]*?);\\n/);
      if (!m) return;
      var fresh = JSON.parse(m[1]);
      state = { nodes: fresh.nodes || [], subs: fresh.subs || [] };
      renderNodes();
      renderSubs();
    });
}

document.getElementById("saveBtn").addEventListener("click", function () {
  var uris = document.getElementById("nodesBox").value.split("\\n")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  setStatus("保存中…");
  fetch(window.location.pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-action": "save" },
    body: JSON.stringify({ nodes: uris, subs: state.subs })
  })
    .then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    })
    .then(function (res) {
      if (!res.ok || !res.j.ok) throw new Error((res.j && res.j.error) || "保存失败");
      setStatus("已保存：" + res.j.nodes + " 个节点，" + res.j.subs + " 个订阅");
      showWarnings(res.j.warnings || []);
      return reload();
    })
    .catch(function (err) {
      setStatus("保存失败：" + err.message);
    });
});

renderNodes();
renderSubs();
</script>
</body>
</html>
`;

// ═══════════════════════════════ Clash YAML ═══════════════════════════════

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
 */
function buildClashYaml(nodes, env) {
  const proxies = [];
  const skipped = [];
  for (const uri of splitLines(nodes)) {
    const p = parseShareLinkSafe(uri);
    if (p) proxies.push(p);
    else skipped.push(uri.slice(0, uri.indexOf("://") + 3));
  }
  if (!proxies.length) return "";

  // Clash 要求代理名唯一
  const seen = new Map();
  for (const p of proxies) {
    const base = p.name;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) p.name = base + " " + n;
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
    head.push("# 已跳过无法转换的链接：" + [...new Set(skipped)].join(", "));
  }

  return (
    [
      ...head,
      "proxies:",
      emitObjectList(proxies),
      "proxy-groups:",
      emitObjectList(groups),
      "rules:",
      "  - MATCH," + groupName,
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
    if (!value.length) return pad + k + ": []";
    return (
      pad + k + ":\n" + value.map((v) => " ".repeat(indent + 2) + "- " + yamlScalar(v)).join("\n")
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return pad + k + ": {}";
    return pad + k + ":\n" + entries.map(([ik, iv]) => emitEntry(ik, iv, indent + 2)).join("\n");
  }
  return pad + k + ": " + yamlScalar(value);
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
  if (s && PLAIN_SAFE.test(s) && !PLAIN_RESERVED.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}

function yamlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

// ═══════════════════════════════ 各协议解析 ═══════════════════════════════

function parseShareLink(uri) {
  const idx = uri.indexOf("://");
  if (idx < 0) return null;
  const scheme = uri.slice(0, idx).toLowerCase();
  if (scheme === "vless") return parseVless(uri);
  if (scheme === "vmess") return parseVmess(uri);
  if (scheme === "trojan") return parseTrojan(uri);
  if (scheme === "ss") return parseSs(uri);
  return null;
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

/** 统一的传输处理，vless / vmess / trojan 共用。 */
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
  const u = new URL(uri);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();
  const security = (q.get("security") || "").toLowerCase();

  const p = {
    name: fragName(u, u.hostname + ":" + portOf(u, 443)),
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
  // 我们自己生成的节点走 Cloudflare，证书有效，默认不跳过校验
  p["skip-cert-verify"] = q.get("allowInsecure") === "1";
  return p;
}

function parseVmess(uri) {
  const body = uri.slice("vmess://".length).split("#")[0].trim();
  const json = JSON.parse(fromBase64(body));
  const net = String(json.net || "tcp").toLowerCase();

  const p = {
    name: String(json.ps || "").trim() || json.add + ":" + (json.port || 443),
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
  const u = new URL(uri);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();

  const p = {
    name: fragName(u, u.hostname + ":" + portOf(u, 443)),
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
    name: name.trim() || server + ":" + port,
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
    const parts = decodeURIComponent(plugin).split(";").filter(Boolean);
    p.plugin = parts[0];
    p["plugin-opts"] = {};
    for (const o of parts.slice(1)) {
      const eq = o.indexOf("=");
      const k = eq < 0 ? o : o.slice(0, eq);
      const v = eq < 0 ? true : o.slice(eq + 1);
      p["plugin-opts"][k] = v;
    }
  }
  return p;
}

// ═══════════════════════════════ 工具 ═══════════════════════════════

function nameFromUri(uri) {
  const h = uri.indexOf("#");
  if (h < 0) return "";
  try {
    return decodeURIComponent(uri.slice(h + 1)).trim();
  } catch {
    return uri.slice(h + 1).trim();
  }
}

/**
 * 如果整段内容本身就是 base64（不含 ://），先解一次码。
 * 用于兼容"NODES 直接填 base64 订阅内容"的写法，避免二次编码。
 */
function decodeIfBase64Blob(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.includes("://")) return raw;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw.replace(/\s+/g, ""))) return raw;
  try {
    const decoded = fromBase64(raw);
    return decoded.includes("://") ? decoded : raw;
  } catch {
    return raw;
  }
}

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

async function shortHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < 4; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
  return out;
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
  return out;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64) {
  const normalized = padBase64(
    String(b64).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "")
  );
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function padBase64(s) {
  const rest = s.length % 4;
  return rest === 0 ? s : s + "=".repeat(4 - rest);
}

/**
 * 恒定时间比较。长度本身不是秘密（约定 32），所以先比长度不算泄露。
 * 这只是消掉时序侧信道，真正的安全边界是 token / 密码的熵。
 */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function htmlResponse(html, isHead = false) {
  return new Response(isHead ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
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
