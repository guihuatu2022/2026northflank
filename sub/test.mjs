// 订阅 Worker 的回归测试。覆盖多订阅分流、认证、CSRF、输入校验、
// lastFetch 记录、降级模式、以及管理页嵌入 JSON 的健壮性。
// 跑法：node sub/test.mjs
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, "worker.js")).href);

class MockKV {
  constructor() { this.store = new Map(); this.writes = 0; }
  async get(key, type) {
    const v = this.store.get(key);
    if (v === undefined || v === null) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key, value) { this.writes++; this.store.set(key, value); }
}

const ADMIN_PATH = "a".repeat(8) + "1b2c3d4e5f60718293a4b5c6d7e8f90";   // 40 位
const ADMIN_PASS = "correct-horse-battery-staple-42";
const T_A = "1111111111111111111111111111aa";
const T_B = "2222222222222222222222222222bb";
const NODE1 = "vless://11111111-1111-1111-1111-111111111111@a.example.com:443?security=tls&sni=a.example.com&type=ws&host=a.example.com&path=/p&fp=chrome#节点A";
const NODE2 = "trojan://pw@b.example.org:443?security=tls&sni=b.example.org&type=tcp#节点B";
const NODE3 = "vless://22222222-2222-2222-2222-222222222222@c.example.net:443?security=tls&sni=c.example.net&type=ws&path=/q&host=c.example.net#节点C";

const base = "https://sub.example.com";
const ctx = { waitUntil(p) { return p; } };
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${extra}`)); };
const req = (p, init) => new Request(base + p, init);
const UA = { "User-Agent": "v2rayN/6.45" };
const basic = (u, p) => ({ Authorization: "Basic " + Buffer.from(u + ":" + p).toString("base64") });
const adminHeaders = () => ({ ...basic("admin", ADMIN_PASS), "content-type": "application/json", "x-admin-action": "save" });

async function seed(env, nodes, subs) {
  const kv = env.KV;
  // 先写一份配置（模拟管理员保存过）
  const ids = [];
  for (const u of nodes) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(u));
    const b = new Uint8Array(d); let h = "";
    for (let i = 0; i < 4; i++) h += ("0" + b[i].toString(16)).slice(-2);
    ids.push({ id: h, uri: u, name: "n" + h.slice(0, 4) });
  }
  await kv.put("cfg", JSON.stringify({
    version: 1,
    nodes: ids,
    subs: subs.map((s) => ({ ...s, nodes: s.uris.map((u) => ids.find((n) => n.uri === u).id) })),
  }));
  return ids;
}

const mkEnv = () => ({ KV: new MockKV(), ADMIN_PATH, ADMIN_PASSWORD: ADMIN_PASS, SUB_NAME: "test" });

console.log("--- 1. 多订阅分流（核心需求）---");
{
  const env = mkEnv();
  await seed(env, [NODE1, NODE2, NODE3], [
    { token: T_A, name: "给朋友A", enabled: true, uris: [NODE1, NODE2] },
    { token: T_B, name: "给朋友B", enabled: true, uris: [NODE3] },
  ]);
  const a = await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx);
  const b = await mod.default.fetch(req(`/${T_B}`, { headers: UA }), env, ctx);
  const aList = Buffer.from(await a.text(), "base64").toString();
  const bList = Buffer.from(await b.text(), "base64").toString();
  check("A 拿到 2 个节点", aList.split("\n").length === 2 && aList.includes("节点A") && aList.includes("节点B"));
  check("B 只拿到 1 个节点", bList.split("\n").length === 1 && bList.includes("节点C"));
  check("B 看不到 A 的节点", !bList.includes("节点A") && !bList.includes("节点B"));
  const aYaml = await (await mod.default.fetch(req(`/${T_A}/clash`, { headers: { "User-Agent": "clash-verge/2.0" } }), env, ctx)).text();
  check("A 的 Clash YAML 只含自己的两个节点", aYaml.includes("节点A") && aYaml.includes("节点B") && !aYaml.includes("节点C"));
  const bYaml = await (await mod.default.fetch(req(`/${T_B}/clash`, { headers: { "User-Agent": "mihomo/1.18" } }), env, ctx)).text();
  check("B 的 Clash YAML 只含自己的节点", bYaml.includes("节点C") && !bYaml.includes("节点A"));
}

console.log("--- 2. 禁用与不存在的 token 都返回 404 ---");
{
  const env = mkEnv();
  await seed(env, [NODE1], [
    { token: T_A, name: "启用", enabled: true, uris: [NODE1] },
    { token: T_B, name: "禁用", enabled: false, uris: [NODE1] },
  ]);
  const enabled = await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx);
  check("启用的 token -> 200", enabled.status === 200, `status=${enabled.status}`);
  const bodies = [];
  for (const [name, path] of [["禁用的", "/" + T_B], ["不存在的", "/" + "f".repeat(32)], ["太短的", "/short"]]) {
    const r = await mod.default.fetch(req(path, { headers: UA }), env, ctx);
    bodies.push(await r.text());
    check(`${name} token -> 404`, r.status === 404, `status=${r.status}`);
  }
  const browse = await mod.default.fetch(req(`/${T_A}`, { headers: { "User-Agent": "Mozilla/5.0 Firefox/128" } }), env, ctx);
  bodies.push(await browse.text());
  check("浏览器 UA -> 404", browse.status === 404, `status=${browse.status}`);
  const noPost = await mod.default.fetch(req(`/${T_A}`, { method: "POST", headers: UA }), env, ctx);
  bodies.push(await noPost.text());
  check("POST 到订阅路径 -> 404", noPost.status === 404);
  check("五种未命中场景响应体完全一致", new Set(bodies).size === 1, `unique=${new Set(bodies).size}`);
}

console.log("--- 3. 管理页认证 ---");
{
  const env = mkEnv();
  const noAuth = await mod.default.fetch(req(`/${ADMIN_PATH}`), env, ctx);
  check("无凭证 -> 401", noAuth.status === 401, `status=${noAuth.status}`);
  check("返回 WWW-Authenticate", (noAuth.headers.get("www-authenticate") || "").includes("Basic"));
  const badPass = await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("admin", "wrong-password-here") }), env, ctx);
  check("密码错 -> 401", badPass.status === 401);
  const badUser = await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("root", ADMIN_PASS) }), env, ctx);
  check("用户名错 -> 401", badUser.status === 401);
  const okGet = await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("admin", ADMIN_PASS) }), env, ctx);
  const html = await okGet.text();
  check("正确凭证 -> 200 HTML", okGet.status === 200 && (okGet.headers.get("content-type") || "").includes("html"));
  check("页面含管理界面", html.includes("订阅管理") && html.includes("节点池"));
  check("页面不含密码", !html.includes(ADMIN_PASS));
  // 管理路径猜错 -> 走订阅分支 -> 404（不泄露管理路径存在与否）
  const wrongPath = await mod.default.fetch(req("/" + "b".repeat(24), { headers: basic("admin", ADMIN_PASS) }), env, ctx);
  check("管理路径猜错 -> 404（不暴露）", wrongPath.status === 404);
}

console.log("--- 4. 写入与 CSRF ---");
{
  const env = mkEnv();
  const body = JSON.stringify({ nodes: [NODE1, NODE2], subs: [{ token: T_A, name: "A", enabled: true, nodes: [NODE1] }] });
  const noHeader = await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: { ...basic("admin", ADMIN_PASS), "content-type": "application/json" }, body }), env, ctx);
  check("缺自定义头 -> 403（挡 CSRF）", noHeader.status === 403, `status=${noHeader.status}`);
  const badOrigin = await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: { ...adminHeaders(), Origin: "https://evil.example" }, body }), env, ctx);
  check("Origin 不符 -> 403", badOrigin.status === 403, `status=${badOrigin.status}`);
  const noAuth = await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-admin-action": "save" }, body }), env, ctx);
  check("未认证 POST -> 401", noAuth.status === 401);
  const ok = await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: adminHeaders(), body }), env, ctx);
  const j = await ok.json();
  check("保存成功", ok.status === 200 && j.ok === true, JSON.stringify(j));
  check("写入 KV 一次", env.KV.writes === 1, `writes=${env.KV.writes}`);
  const after = await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx);
  const afterList = Buffer.from(await after.text(), "base64").toString();
  check("保存后订阅立即生效", after.status === 200 && afterList.includes("节点A"));
  const subHtml = await (await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("admin", ADMIN_PASS) }), env, ctx)).text();
  // 订阅地址是在前端用 BASE + token 拼出来的，所以 HTML 里是分开的两部分
  check("管理页含 token 与基址", subHtml.includes(T_A) && subHtml.includes(base));
}

console.log("--- 5. 输入校验与警告 ---");
{
  const env = mkEnv();
  const body = JSON.stringify({
    nodes: [NODE1, "hysteria2://x@y:443#hy", "这不是链接"],
    subs: [{ token: "short", name: "非法token" }, { token: T_A, name: "A", nodes: [NODE1] }],
  });
  const r = await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: adminHeaders(), body }), env, ctx);
  const j = await r.json();
  check("非法 token 被替换成合法值", j.ok && j.subs === 2);
  check("给出警告", Array.isArray(j.warnings) && j.warnings.length >= 2, JSON.stringify(j.warnings));
  check("hysteria2 被提示无法转 Clash", j.warnings.some((w) => w.includes("Clash 无法转换")));
  const cfg = JSON.parse(await env.KV.get("cfg"));
  check("只留下 2 个合法节点", cfg.nodes.length === 2, `nodes=${cfg.nodes.length}`);
  check("新 token 是 32 位十六进制", /^[0-9a-f]{32}$/.test(cfg.subs[0].token), cfg.subs[0].token);
}

console.log("--- 6. lastFetch 记录（发现泄露）---");
{
  const env = mkEnv();
  await seed(env, [NODE1], [{ token: T_A, name: "A", enabled: true, uris: [NODE1] }]);
  const before = env.KV.writes;
  const fake = { waitUntil(p) { return p; }, };
  const r = await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx);
  await r.text();
  await new Promise((res) => setTimeout(res, 30));
  check("取订阅后写入 lastFetch", env.KV.writes > before, `writes=${env.KV.writes}`);
  const cfg = JSON.parse(await env.KV.get("cfg"));
  check("记录了时间", cfg.subs[0].lastFetch && cfg.subs[0].lastFetch.ts > 0);
  // 节流：紧接着再取一次不应重复写
  const mid = env.KV.writes;
  await (await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx)).text();
  await new Promise((res) => setTimeout(res, 30));
  check("5 分钟内不重复写（省配额）", env.KV.writes === mid, `writes=${env.KV.writes} vs ${mid}`);
}

console.log("--- 7. 无 KV 时的降级模式 ---");
{
  const env = { SUB_KEY: T_A, NODES: NODE1 + "\n" + NODE2, SUB_NAME: "legacy" };
  const r = await mod.default.fetch(req(`/${T_A}`, { headers: UA }), env, ctx);
  const list = Buffer.from(await r.text(), "base64").toString();
  check("降级模式仍可用", r.status === 200 && list.includes("节点A") && list.includes("节点B"));
  const other = await mod.default.fetch(req(`/${T_B}`, { headers: UA }), env, ctx);
  check("其它 token -> 404", other.status === 404);
}

console.log("--- 8. 管理页嵌入 JSON 的健壮性 ---");
{
  const env = mkEnv();
  const evil = NODE1 + "%3C%2Fscript%3E";  // 名字里带 </script>
  const body = JSON.stringify({ nodes: [evil], subs: [] });
  await mod.default.fetch(req(`/${ADMIN_PATH}`, { method: "POST", headers: adminHeaders(), body }), env, ctx);
  const html = await (await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("admin", ADMIN_PASS) }), env, ctx)).text();
  const scriptEnd = html.indexOf("</script>");
  const cfgPart = html.slice(0, scriptEnd);
  check("节点名里的 </script> 未截断文档", !cfgPart.includes("</script>") || cfgPart.includes("\\u003c"), "转义失败");
  const m = html.match(/var CFG = ([\s\S]*?);\n/);
  let parsed = null;
  try { parsed = JSON.parse(m[1]); } catch (e) { /* ignore */ }
  check("嵌入的 JSON 可解析", parsed !== null && Array.isArray(parsed.nodes));
}

console.log("--- 9. 管理页 JSON → 分享链接（/convert）---");
{
  const env = mkEnv();
  await seed(env, [NODE1], [{ token: T_A, name: "A", enabled: true, uris: [NODE1] }]);
  const writesBefore = env.KV.writes;
  const convert = (body, headers) =>
    mod.default.fetch(req(`/${ADMIN_PATH}`, {
      method: "POST",
      headers: headers || { ...basic("admin", ADMIN_PASS), "content-type": "application/json", "x-admin-action": "convert" },
      body: JSON.stringify(body),
    }), env, ctx);

  // 单个节点
  const one = await convert({ json: JSON.stringify({
    type: "vless", tag: "来自Karing", server: "sub.example.com", server_port: 443,
    uuid: "11111111-1111-1111-1111-111111111111",
    tls: { enabled: true, server_name: "sub.example.com", utls: { enabled: true, fingerprint: "chrome" } },
    transport: { type: "ws", path: "/assets/app.abc.js", headers: { Host: "sub.example.com" } },
  }) });
  const oneJ = await one.json();
  check("单个节点 -> ok", one.status === 200 && oneJ.ok === true, JSON.stringify(oneJ).slice(0, 120));
  check("转出 1 条链接", Array.isArray(oneJ.links) && oneJ.links.length === 1);
  check("链接是 vless:// 且含路径与 SNI",
    oneJ.links[0].startsWith("vless://") && oneJ.links[0].includes("path=%2Fassets%2Fapp.abc.js") &&
    oneJ.links[0].includes("sni=sub.example.com") && oneJ.links[0].includes("host=sub.example.com"),
    oneJ.links[0]);
  check("节点名进了 # 片段", decodeURIComponent(oneJ.links[0].split("#")[1]) === "来自Karing");

  // 完整配置：direct 跳过、自定义头与 mux 记入 lost
  const full = await convert({ json: JSON.stringify({ outbounds: [
    { type: "direct", tag: "direct" },
    { type: "vless", tag: "A", server: "a.example.com", server_port: 443,
      uuid: "11111111-1111-1111-1111-111111111111",
      tls: { enabled: true, server_name: "a.example.com" },
      transport: { type: "ws", path: "/p", headers: { Host: "a.example.com", "X-Origin-Key": "abcdefghijklmnop" } },
      multiplex: { enabled: true, protocol: "h2mux" } },
    { type: "trojan", tag: "B", server: "b.example.com", server_port: 8443, password: "pw",
      tls: { enabled: true, server_name: "b.example.com" }, transport: { type: "grpc", service_name: "gsvc" } },
  ] }) });
  const fullJ = await full.json();
  check("完整配置 -> 2 条链接", fullJ.ok === true && fullJ.links.length === 2, JSON.stringify(fullJ).slice(0, 160));
  check("direct 不出现在结果里", !fullJ.links.some((l) => l.includes("direct")));
  check("自定义头写入 lost 并打码", fullJ.lost.some((x) => x.includes("X-Origin-Key") && x.includes("…") && !x.includes("abcdefghijklmnop")),
    JSON.stringify(fullJ.lost));
  check("mux 写入 lost", fullJ.lost.some((x) => x.includes("多路复用")));
  check("trojan 走 grpc", fullJ.links[1].startsWith("trojan://") && fullJ.links[1].includes("type=grpc") && fullJ.links[1].includes("serviceName=gsvc"), fullJ.links[1]);

  // 多个对象首尾相接（Karing 里一条条复制出来的样子）
  const many = await convert({ json:
    '{"type":"ss","tag":"S1","server":"s1.example.com","server_port":8388,"method":"aes-128-gcm","password":"p1"}\n' +
    '{"type":"ss","tag":"S2","server":"s2.example.com","server_port":8388,"method":"aes-128-gcm","password":"p2"}' });
  const manyJ = await many.json();
  check("多个对象拼接 -> 2 条", manyJ.ok === true && manyJ.links.length === 2, JSON.stringify(manyJ).slice(0, 120));

  // 端点与导出的函数结果必须一致（命令行版复用的就是它）
  const direct = mod.outboundToLink({ type: "ss", tag: "S1", server: "s1.example.com", server_port: 8388, method: "aes-128-gcm", password: "p1" });
  check("导出的 outboundToLink 与端点结果一致", direct.link === manyJ.links[0]);
  check("导出了 extractOutbounds", typeof mod.extractOutbounds === "function");

  // 失败路径
  const bad = await convert({ json: "{ 这不是 JSON" });
  const badJ = await bad.json();
  check("坏 JSON -> ok:false 且有提示", bad.status === 200 && badJ.ok === false && /JSON/.test(badJ.error), JSON.stringify(badJ));
  const onlyDirect = await convert({ json: '{"outbounds":[{"type":"direct"}]}' });
  const odJ = await onlyDirect.json();
  check("只有 direct -> ok:false 并解释原因", odJ.ok === false && /direct|server/.test(odJ.error), JSON.stringify(odJ));
  const noUuid = await convert({ json: '{"type":"vless","server":"a.example.com","server_port":443}' });
  const nuJ = await noUuid.json();
  check("缺 uuid -> ok:false 且报出原因", nuJ.ok === false && /uuid/.test(nuJ.error), JSON.stringify(nuJ));
  const empty = await convert({ json: "" });
  check("空输入 -> ok:false", (await empty.json()).ok === false);
  check("convert 不写 KV", env.KV.writes === writesBefore, `${env.KV.writes} != ${writesBefore}`);

  // 认证与 CSRF 与 save 完全同一套
  const noAuthConv = await mod.default.fetch(req(`/${ADMIN_PATH}`, {
    method: "POST", headers: { "content-type": "application/json", "x-admin-action": "convert" },
    body: JSON.stringify({ json: "{}" }),
  }), env, ctx);
  check("convert 无凭证 -> 401", noAuthConv.status === 401, `status=${noAuthConv.status}`);
  const noHeader = await mod.default.fetch(req(`/${ADMIN_PATH}`, {
    method: "POST", headers: { ...basic("admin", ADMIN_PASS), "content-type": "application/json" },
    body: JSON.stringify({ json: "{}" }),
  }), env, ctx);
  check("convert 缺自定义头 -> 403", noHeader.status === 403, `status=${noHeader.status}`);
  const badOrigin = await convert({ json: "{}" }, {
    ...basic("admin", ADMIN_PASS), "content-type": "application/json",
    "x-admin-action": "convert", Origin: "https://evil.example.net",
  });
  check("convert 跨站 Origin -> 403", badOrigin.status === 403, `status=${badOrigin.status}`);
  const notJson = await mod.default.fetch(req(`/${ADMIN_PATH}`, {
    method: "POST",
    headers: { ...basic("admin", ADMIN_PASS), "content-type": "application/json", "x-admin-action": "convert" },
    body: "不是 json",
  }), env, ctx);
  check("convert 请求体不是 JSON -> 400", notJson.status === 400, `status=${notJson.status}`);
}

console.log("--- 10. 管理页的导入界面存在且与端点对齐 ---");
{
  const env = mkEnv();
  const html = await (await mod.default.fetch(req(`/${ADMIN_PATH}`, { headers: basic("admin", ADMIN_PASS) }), env, ctx)).text();
  check("有「从 JSON 导入节点」按钮", html.includes('id="importBtn"') && html.includes("从 JSON 导入节点"));
  check("有粘贴框与转换按钮", html.includes('id="importBox"') && html.includes('id="importGo"') && html.includes("转换并追加到节点池"));
  check("前端带 x-admin-action: convert", html.includes('"x-admin-action": "convert"'));
  check("前端把新节点并回节点池", html.includes('state.nodes = current') && html.includes("renderSubs()"));
  check("会提示点保存", /记得点保存/.test(html));
  check("会显示丢失的字段", html.includes("以下设置标准链接装不下"));
  // 模板里不能出现反引号或模板插值，否则整个管理页会崩
  check("嵌入的脚本没有未转义的 </script>", html.indexOf("</script>") === html.lastIndexOf("</script>"), "脚本被提前截断");
  check("导入面板默认隐藏", /id="importPanel" style="display:none"/.test(html));
  // 换行符在浏览器里必须真的是换行，而不是字面量 \n
  check("split/join 用的是真换行", html.includes('.split("\\n")') && !html.includes('.split("\\\\n")'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
