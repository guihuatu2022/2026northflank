#!/usr/bin/env node
/**
 * 把 worker/site/ 下的整个伪装站内联进一个单文件 Worker。
 *
 * 产物：worker/standalone.js
 *
 * 为什么需要它：在 Cloudflare 控制台里直接创建 Worker 时没有静态资源绑定
 * （env.ASSETS），所以站点必须内联进脚本本身，才能做到"复制粘贴一个文件
 * 就能部署"。
 *
 * 改完 worker/site/ 下的内容后重新生成：
 *   node worker/build-standalone.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, "site");
const OUT = path.join(HERE, "standalone.js");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
};

/** 内容带哈希的资源可以长期缓存。 */
const HASHED = /\.[0-9a-f]{8,}\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf)$/i;

function cacheFor(rel) {
  if (HASHED.test(rel)) return "public, max-age=31536000, immutable";
  if (rel.endsWith(".html")) return "public, max-age=300";
  return "public, max-age=3600";
}

/**
 * 包成模板字符串字面量。
 *
 * 必须转义反斜杠：伪装站里的 site.js 含正则（`\/index\.html$/`），
 * 在模板字符串里 `\/` 和 `\.` 会被当成转义序列吃掉，导致内联后的脚本损坏。
 */
function tpl(s) {
  return "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function walk(dir, base = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) {
      out.push(...walk(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(SITE).sort();
const entries = [];

for (const rel of files) {
  const body = fs.readFileSync(path.join(SITE, rel), "utf8");
  const type = TYPES[path.extname(rel).toLowerCase()] || "application/octet-stream";
  entries.push(`  ${JSON.stringify("/" + rel)}: [${JSON.stringify(type)}, ${JSON.stringify(cacheFor(rel))},\n    ${tpl(body)}],`);
}

const generated = `/**
 * nf-node 边缘网关 —— 单文件版
 *
 * 这个文件与 worker/src/index.js 功能完全相同，区别是把整个伪装站内联了进来，
 * 所以可以直接复制到 Cloudflare 控制台的 Worker 编辑器里部署，不需要命令行、
 * 不需要装任何东西，也不需要静态资源绑定。
 *
 * 部署方法：
 *   1. 改下面标着「配置」的三行
 *   2. 全选本文件、复制
 *   3. Cloudflare 控制台 -> Workers & Pages -> Create -> Worker -> 命名 -> Deploy
 *   4. 点 Edit code，把内容全选替换成这个文件，再点 Deploy
 *   5. 到 Settings -> Domains & Routes 绑定自己的域名，
 *      并删掉自动分配的 *.workers.dev 路由
 *
 * 伪装站内容由 worker/build-standalone.mjs 从 worker/site/ 自动生成。
 * 要改站点请改 site/ 下的文件，然后运行：node worker/build-standalone.mjs
 */

// ══════════════════════ 配置：只改这三行 ══════════════════════
const WS_PATH = "/assets/app.把这里换成32位随机十六进制.js";
const ORIGIN_HOST = "把这里换成容器域名.code.run";
const ORIGIN_SECRET = "把这里换成你的密钥";
// ═════════════════════════════════════════════════════════════

// 如果不想把值写在代码里，也可以在上面保持原样，改为在控制台的
// Settings -> Variables and Secrets 里设置同名的变量，代码会优先使用它们。

const ORIGIN_KEY_HEADER = "X-Origin-Key";

/** 按原样从磁盘提供的扩展名；其余路径按 .html 解析。 */
const STATIC_FILE = /\\.(?:html|css|js|mjs|json|map|svg|png|jpe?g|gif|webp|avif|ico|txt|xml|pdf|woff2?|ttf|otf)$/i;

/** 伪装站：[content-type, cache-control, body] */
const FILES = {
${entries.join("\n")}
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = readConfig(env);

    // 秘密前缀优先判断：长得像静态资源也必须先走这里，
    // 否则扫描器访问它就能分辨出"这个路径有东西"。
    if (cfg.wsPath && url.pathname.startsWith(cfg.wsPath)) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket" || !cfg.originHost) {
        return notFound(request);
      }
      return proxyToOrigin(request, cfg);
    }

    return serveFile(request, url);
  },
};

/** 环境变量优先，其次用文件顶部的常量。 */
function readConfig(env) {
  const e = env || {};
  return {
    wsPath: String(e.WS_PATH || WS_PATH || "").trim(),
    originHost: String(e.ORIGIN_HOST || ORIGIN_HOST || "").trim(),
    originSecret: String(e.ORIGIN_SECRET || ORIGIN_SECRET || ""),
  };
}

function assetPath(pathname) {
  if (pathname === "" || pathname === "/") return "/index.html";
  if (STATIC_FILE.test(pathname)) return pathname;
  return pathname.replace(/\\/+$/, "") + ".html";
}

function serveFile(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notFound(request);
  }
  const entry = FILES[assetPath(url.pathname)];
  if (!entry) {
    return notFound(request);
  }
  const [type, cache, body] = entry;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: { "content-type": type, "cache-control": cache },
  });
}

async function proxyToOrigin(request, cfg) {
  let origin = String(cfg.originHost).trim().replace(/\\/+$/, "");
  if (!/^https?:\\/\\//i.test(origin)) {
    origin = "https://" + origin;
  }

  // 从原始 URL 字符串里截取路径+查询，不要用 URL 对象重建：
  // 客户端会把早数据追加在路径后面，任何重新编码都会破坏握手。
  const rest = request.url.slice(new URL(request.url).origin.length);

  const headers = new Headers(request.headers);
  // Host 由目标 URL 决定；cdn-loop 是 Cloudflare 自己的记账头，不能往下一跳传。
  headers.delete("host");
  headers.delete("cdn-loop");
  if (cfg.originSecret) {
    headers.set(ORIGIN_KEY_HEADER, cfg.originSecret);
  }

  let upstream;
  try {
    upstream = await fetch(origin + rest, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch {
    // 传输失败：伪装成"页面不存在"，不泄露源站信息。
    return notFound(request);
  }

  if (upstream.webSocket) {
    // 直接把上游 socket 交给客户端，不经过 JS 逐帧搬运。
    return new Response(null, { status: 101, webSocket: upstream.webSocket });
  }

  // 只有拿着秘密路径才会走到这里，所以给一个明确的错误更好排查。
  return new Response("upstream did not accept the upgrade\\n", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 所有未命中都返回同一份站点 404，主动探测者没有可对比的差异。 */
function notFound() {
  const entry = FILES["/404.html"];
  const body = entry ? entry[2] : '<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>';
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
`;

fs.writeFileSync(OUT, generated);
const kb = (Buffer.byteLength(generated) / 1024).toFixed(1);
console.log(`已生成 ${path.relative(process.cwd(), OUT)}`);
console.log(`  内联文件数: ${files.length}`);
console.log(`  体积: ${kb} KB`);
