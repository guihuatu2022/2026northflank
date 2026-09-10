/**
 * 安全订阅端点 —— 单文件版
 *
 * ────────────────────────────────────────────────────────────────
 * 这份代码和常见订阅 Worker 的区别，是把攻击面砍到最小：
 *
 *   1. 没有默认凭据。SUB_KEY 没设置或太短，服务直接不工作（fail closed），
 *      绝不回退到某个写死的默认值。
 *   2. 完全只读。没有编辑页、不处理 POST、不写 KV —— 因此没有任何
 *      "拿到 URL 就能改内容" 的路径。
 *   3. 不向任何第三方发请求。节点列表来自你自己设置的环境变量，
 *      没有订阅聚合、没有在线订阅转换、没有 IP 查询。
 *   4. 任何不匹配的请求返回同一份 404：错误的 key、缺失的 key、
 *      浏览器 UA、被拦的 UA、错误的方法，从外面看完全一样。
 *
 * 订阅 URL 本身就是"不记名凭证"：谁拿到 URL 谁就拿到全部节点。
 * 所以这里的核心是让它猜不到、让爬虫没有收获、泄露后能快速更换。
 * ────────────────────────────────────────────────────────────────
 *
 * 环境变量（在控制台 Settings -> Variables and Secrets 里设置，
 * 或者用 npx wrangler secret put）：
 *
 *   必填
 *     SUB_KEY   路径里那一段随机值。32 位十六进制。
 *               生成：openssl rand -hex 16
 *     NODES     节点链接，一行一个（vless://... 等）。
 *               也可以直接填已经 base64 过的内容，代码能识别。
 *
 *   可选
 *     NODES_CLASH   Clash / Mihomo 用的完整 YAML 文本。
 *                   不填则 Clash 客户端也会拿到 base64。
 *     UA_MODE       clients | nobrowser | any   （默认 nobrowser）
 *                     clients   = 只放行已知客户端 UA（最严，可能误伤）
 *                     nobrowser = 拒绝浏览器和常见采集器（默认）
 *                     any       = 不做 UA 过滤（仅调试时用）
 *     SUB_NAME      客户端里显示的订阅名（默认 nf-node）
 *     UPDATE_HOURS  建议更新间隔，小时（默认 6）
 *     ALERT_WEBHOOK 可选。每次取订阅时向这个地址 POST 一条通知，
 *                   内容只有 事件名 + 国家 + 机房代码，不含 IP。
 *                   用来发现"订阅地址被别人拿去用了"。
 *
 * 用完之后你的订阅地址是：
 *     https://你的订阅域名/<SUB_KEY>
 *
 * 排障：部署后在终端运行 `npx wrangler tail`，配置问题会打在日志里
 *       （但对外一律返回 404，所以访客看不出区别）。
 */

const MIN_KEY_LENGTH = 24;

/** UA_MODE=clients 时放行的客户端特征（小写子串）。 */
const CLIENT_UA = [
  "v2rayn", "v2rayng", "v2ray", "clash", "mihomo", "stash",
  "sing-box", "singbox", "sfi/", "sfa/", "sfm/", "hiddify",
  "shadowrocket", "nekobox", "neko", "surge", "quantumult", "loon",
  "karing", "passwall", "openclash", "flclash", "clashx", "clash-verge",
  "sub-store", "substore",
];

/** UA_MODE=nobrowser 时额外拒绝的采集器特征（小写子串）。 */
const SCRAPER_UA = [
  "curl/", "wget/", "python-requests", "python-urllib", "aiohttp",
  "go-http-client", "okhttp", "java/", "scrapy", "axios/", "node-fetch",
  "libwww-perl", "httpclient", "guzzle",
];

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

    const wantClash =
      segments[1] === "clash" ||
      segments[1] === "yaml" ||
      segments[1] === "mihomo" ||
      url.searchParams.has("clash") ||
      /(clash|mihomo|stash)/.test(ua);

    const isHead = request.method === "HEAD";
    const clash = String(env.NODES_CLASH || "").trim();
    if (wantClash && clash) {
      return subscription(clash, "text/yaml; charset=utf-8", env, isHead);
    }

    const payload = buildPayload(String(env.NODES || ""));
    if (!payload) {
      console.warn("[sub] NODES 为空，返回空订阅。请设置 NODES 环境变量。");
    }
    return subscription(payload, "text/plain; charset=utf-8", env, isHead);
  },
};

/**
 * 订阅响应：显式禁止缓存，并去掉一切可能二次泄露凭据的通道。
 *
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

/**
 * 把 NODES 变成客户端能吃的 base64。
 *
 * 如果填进来的已经是 base64（不含 "://" 且只由 base64 字符组成），
 * 原样返回，避免二次编码。
 */
function buildPayload(nodes) {
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
