/**
 * Edge gateway for a Cloudflare-fronted tunnel node.
 *
 * Routing is deliberately explicit. The Worker runs before the asset layer
 * (`run_worker_first: true`) and resolves pages itself, rather than relying on
 * the static-asset layer's HTML handling. That matters for two reasons:
 *
 *   1. The secret prefix must be matched against the request exactly as the
 *      client sent it, including any early data appended to the path. Asset
 *      routing can rewrite or redirect paths, which would silently break the
 *      handshake.
 *   2. The behaviour for `/` and for extension-less URLs then does not depend
 *      on `html_handling` semantics that are easy to get wrong.
 *
 * Responsibilities:
 *   - proxy one secret path prefix to the origin, only on a real WebSocket
 *     upgrade;
 *   - serve the decoy site for everything else;
 *   - answer every miss, every other method and every failure with one uniform
 *     404 page, so that active probing learns nothing.
 *
 * The WebSocket is passed through without a JavaScript message loop: calling
 * `accept()` would mean relaying every frame through the isolate, which costs
 * CPU and caps throughput. Returning the upstream socket on a 101 response
 * hands it to the client directly.
 *
 * Configuration (see README):
 *   WS_PATH       - secret path prefix, e.g. /assets/app.3f9c1a7e5b2d4806.js
 *   ORIGIN_HOST   - the container's public hostname
 *   ORIGIN_SECRET - shared secret added on the edge -> origin leg only
 */

const ORIGIN_KEY_HEADER = "X-Origin-Key";

const FALLBACK_404 =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  "<title>404 Not Found</title></head><body><h1>404</h1>" +
  "<p>The requested resource is not available.</p></body></html>";

/** Extensions served from disk under their own name. */
const STATIC_FILE = /\.(?:html|css|js|mjs|json|map|svg|png|jpe?g|gif|webp|avif|ico|txt|xml|pdf|woff2?|ttf|otf)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsPath = (env.WS_PATH || "").trim();

    if (wsPath && url.pathname.startsWith(wsPath)) {
      // The path is secret, but a leak or a lucky guess must still not produce
      // a response that differs from any other missing page.
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket" || !env.ORIGIN_HOST) {
        return notFound(request, env);
      }
      return proxyToOrigin(request, env);
    }

    return serveAsset(request, env, url);
  },
};

/**
 * Resolves a request to a file in the asset collection.
 *
 * `/`            -> /index.html
 * `/about`       -> /about.html
 * `/about.html`  -> /about.html
 * `/assets/x.css`-> /assets/x.css
 *
 * Anything that does not resolve is served the site's own 404 page, so a miss
 * looks exactly like a page that was never published.
 */
async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return notFound(request, env);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notFound(request, env);
  }

  const target = new URL(assetPath(url.pathname), url.origin);
  let res;
  try {
    res = await env.ASSETS.fetch(new Request(target, { method: request.method }));
  } catch {
    return notFound(request, env);
  }

  if (res.ok || res.status === 304) {
    return res;
  }
  return notFound(request, env);
}

function assetPath(pathname) {
  if (pathname === "" || pathname === "/") {
    return "/index.html";
  }
  if (STATIC_FILE.test(pathname)) {
    return pathname;
  }
  return pathname.replace(/\/+$/, "") + ".html";
}

async function proxyToOrigin(request, env) {
  const origin = normaliseOrigin(env.ORIGIN_HOST);

  // Rebuild the target from the raw URL string rather than from URL fields.
  // Clients append early data to the path, so any re-encoding here would break
  // the handshake that the container-side server validates byte for byte.
  const rest = request.url.slice(new URL(request.url).origin.length);
  const target = origin + rest;

  const headers = new Headers(request.headers);
  // The target URL decides the Host header; forwarding the client's would be
  // rejected or ignored. `cdn-loop` is a Cloudflare bookkeeping header that
  // must not be passed on to another hop.
  headers.delete("host");
  headers.delete("cdn-loop");
  if (env.ORIGIN_SECRET) {
    headers.set(ORIGIN_KEY_HEADER, env.ORIGIN_SECRET);
  }

  // A WebSocket handshake is always a bodyless GET. The runtime fills in the
  // protocol-required headers (Sec-WebSocket-Key and friends) itself.
  //
  // Only the transport call is guarded: anything else that goes wrong here is a
  // bug, and it is better to see a loud exception in the Workers log than a
  // silent 404 that looks like normal traffic. This branch is unreachable
  // without the secret path and an upgrade request, so a prober never sees it.
  let upstream;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch {
    // Transport failure. Indistinguishable from a missing page on purpose.
    return notFound(request, env);
  }

  if (upstream.webSocket) {
    // Hand the socket straight to the client.
    return new Response(null, { status: 101, webSocket: upstream.webSocket });
  }

  // Only reachable with a valid secret path, so a plain error is safe here and
  // far easier to diagnose than a disguised 404.
  return new Response("upstream did not accept the upgrade\n", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function normaliseOrigin(value) {
  let s = String(value).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) {
    s = "https://" + s;
  }
  return s;
}

/** Returns the site's own 404 page, or a minimal document if that fails. */
async function notFound(request, env) {
  if (!env.ASSETS) {
    return plainNotFound();
  }
  try {
    const assetUrl = new URL("/404.html", request.url).toString();
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
    if (!res.ok) {
      return plainNotFound();
    }
    const headers = new Headers(res.headers);
    // The runtime hands back a decoded body; forwarding the original encoding
    // and length headers would corrupt it.
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: 404, headers });
  } catch {
    return plainNotFound();
  }
}

function plainNotFound() {
  return new Response(FALLBACK_404, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
