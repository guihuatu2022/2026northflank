# nf-node

一个跑在容器里、无特权运行的 **VLESS over WebSocket 源站**，配合 Cloudflare
边缘使用。容器刻意做得很小：自己从环境变量渲染引擎配置、监护一个子进程、
只反代一个秘密路径前缀，其余一切请求返回同一份响应。

> **非官方项目。** 本项目与 SagerNet 或 sing-box 项目没有任何隶属、背书或
> 赞助关系。详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
>
> **部署前请务必阅读** [安全须知](#安全须知) 与
> [定制伪装站](#定制伪装站)。照原样部署到公开仓库、并使用自带的伪装内容，
> 得到的节点既容易被指纹识别，也容易被滥用。

---

## 目录

- [工作原理](#工作原理)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
  - [第一步：构建镜像](#第一步构建镜像)
  - [第二步：部署容器（Northflank）](#第二步部署容器northflank)
  - [第三步：部署 Worker（详细步骤）](#第三步部署-worker详细步骤)
- [环境变量](#环境变量)
- [客户端配置](#客户端配置)
- [定制伪装站](#定制伪装站)
- [安全须知](#安全须知)
- [验收清单](#验收清单)
- [排障](#排障)
- [许可证](#许可证)

---

## 工作原理

```
客户端（VLESS + WS + TLS，uTLS 伪装成浏览器）
   |
   |  这一段链路上的观察者只能看到：SNI、以及客户端的 TLS 指纹。
   v
Cloudflare 边缘  （自定义域名 -> Worker + 静态资源）
   |-- 秘密前缀 + Upgrade: websocket -> 反代到源站
   |-- 其它任意路径 -> Worker 解析成页面，或返回站点自己的 404
   v
容器  （0.2 vCPU / 512 MB 足够）
   |-- /app/gateway  监听 0.0.0.0:$LISTEN_PORT
   |     |-- 秘密前缀 + Upgrade + 正确的 X-Origin-Key -> 反代
   |     `-- 其余一切 -> 同一份 404
   `-- /app/engine   sing-box，只监听 127.0.0.1:$UPSTREAM_PORT
```

三个刻意的设计选择：

1. **容器不提供任何真实内容。** 伪装站放在边缘。源站对任意路径、任意方法、
   任意畸形请求都返回同一份 404，主动探测者没有可对比的差异。
2. **引擎先监听成功，才开放公网端口**；并且**故意不设置**
   `ReadTimeout` / `WriteTimeout`，避免长连接被 HTTP 服务器掐断。
3. **镜像里没有任何凭据。** 一切在启动时渲染，所以同一个镜像可以服务任意
   多个节点。

### 为什么用前缀匹配而不是精确匹配

开启早数据（early data）后，客户端会把它追加到请求路径后面，路径变成
`<WS_PATH><早数据>` 而不再是精确的 `WS_PATH`。因此 Worker 和 gateway 都用
**前缀**判断，并且都必须把路径原样透传。`WS_PATH` 不能以 `/` 结尾——gateway
会直接拒绝，因为那会让前缀产生歧义。

---

## 仓库结构

```
Dockerfile                     多阶段构建：裁剪版引擎 + gateway
.github/workflows/build.yml    push 后构建并推送 linux/amd64 到 GHCR
front/                         容器入口（Go，仅用标准库）
  main.go                      变量校验、监护子进程、信号、HTTP 服务
  config.go                    环境变量解析 + 引擎配置渲染
  proxy.go                     路径/密钥门禁与 WebSocket 反代
  cgroup.go                    读取容器内存与 CPU 限额
  pages.go                     那一份统一响应
worker/                        边缘侧部署
  src/index.js                 WS 反代 + 显式资源解析 + 统一 404
  wrangler.jsonc               静态资源与 Worker 的接线配置
  package.json                 依赖与脚本（只在本地/CI 用）
  site/                        伪装站（请务必定制！）
third_party/                   上游许可证文本
```

---

## 快速开始

### 第一步：构建镜像

1. 把本仓库推送到 GitHub。附带的工作流会在每次推送到 `main` 以及打 `v*`
   标签时构建，并发布到 GHCR：

   ```
   ghcr.io/<用户名>/<仓库名>:edge      # 跟踪 main
   ghcr.io/<用户名>/<仓库名>:<sha>     # 不可变
   ```

2. 首次推送前，先改掉 `Dockerfile` 里的镜像标签占位符：

   ```
   org.opencontainers.image.source="https://github.com/OWNER/REPO"
   ```

3. 包的可见性跟随仓库可见性：仓库公开则镜像公开，平台侧就不再需要注册表
   凭据。**故意不发布 `latest` 标签**——请部署不可变标签或 digest。

本地构建（可选，需要本机有 Docker）：

```sh
docker build -t nf-node:local --build-arg SING_BOX_VERSION=v1.14.0 .
```

### 第二步：部署容器（Northflank）

| 配置项 | 值 |
| --- | --- |
| 来源 | 你的 GHCR 镜像，固定到某个 tag 或 digest |
| 规格 | `nf-compute-20`（0.2 vCPU / 512 MB） |
| 实例数 | 1 |
| 端口 | 容器端口 `8080`，协议 **HTTP**，公开 |
| 健康检查 | 必须选 **TCP** 探针，端口 8080（**不要**用 HTTP 探针） |
| 自定义域名 | 可选；若绑定，请**关掉平台自动分配的 `code.run` 域名** |

环境变量至少要给 `NODE_ID`、`WS_PATH`、`ORIGIN_SECRET`，生成方式：

```sh
uuidgen                            # NODE_ID
echo "/assets/2026/$(openssl rand -hex 16)"   # WS_PATH
openssl rand -hex 24               # ORIGIN_SECRET
```

### 第三步：部署 Worker（详细步骤）

#### 先理解 `worker/` 里的文件各自干什么

`worker/` 不是一个单独的 js 文件，因为一个可部署的 Worker 需要三类东西。
`wrangler deploy` 会把它们一起打包上传：

| 文件 / 目录 | 作用 | 是否上传 |
| --- | --- | --- |
| `src/index.js` | Worker 脚本本体（路由、WS 反代、404） | ✅ 上传为 Worker 代码 |
| `wrangler.jsonc` | 部署配置：脚本入口、静态资源目录、路由行为 | ❌ 只给 wrangler 读，不上传 |
| `package.json` | 声明 `wrangler` 依赖与 `npm run` 脚本 | ❌ 只给 npm 读，不上传 |
| `site/`（含子目录） | 伪装站的全部静态文件 | ✅ 作为静态资源一起上传 |
| `.dev.vars.example` | 本地 `wrangler dev` 用的变量样例 | ❌ 参考用，`.dev.vars` 不要提交 |
| `node_modules/` | `npm install` 生成 | ❌ 本地用 |

也就是说：**`wrangler deploy` 会把 `src/index.js` 和 `site/` 一起部署**，
`wrangler.jsonc` 负责告诉它"哪个是脚本、哪个是资源目录"。你不需要手动传
任何文件。

#### 前置条件

1. 一个 Cloudflare 账号（免费版即可）。
2. **一个已经托管到 Cloudflare 的域名**（NS 指向 CF）。Worker 的自定义域名
   只能绑定在同一个账号下的域名上。
3. 本机装有 Node.js 18 以上（`node --version` 能输出版本号即可）。

#### 步骤

```sh
cd worker

# 1) 安装 wrangler（只装到本目录，不会污染全局）
npm install

# 2) 登录 Cloudflare，会打开浏览器授权
npx wrangler login

# 3) 先部署一次：这一步会创建 Worker 并上传 site/ 里的静态资源
npx wrangler deploy
#    此时隧道还不能用，因为三个变量还没设。站点资源已经就绪。
#    注意 wrangler.jsonc 里 workers_dev 为 false，所以部署后
#    workers.dev 域名不可用，必须走第 5 步绑定自定义域名。

# 4) 设置三个变量（推荐用交互式输入，值不会进 shell 历史）
npx wrangler secret put WS_PATH        # 例如 /assets/2026/9f3c1a7e5b2d4806
npx wrangler secret put ORIGIN_HOST    # 例如 port--service--abc123.code.run
npx wrangler secret put ORIGIN_SECRET  # 必须与容器的 ORIGIN_SECRET 完全一致
#    secret 立即生效，不需要重新部署。

# 5) 绑定自定义域名（控制台操作）
#    Cloudflare 控制台 -> Workers & Pages -> 选择 nf-node-edge
#    -> Settings -> Domains & Routes -> Add -> Custom Domain
#    -> 输入一个子域名，例如 cdn.你的域名.com -> Add Domain
#    Cloudflare 会自动创建 DNS 记录并签发证书，通常一两分钟生效。
```

#### 然后关掉会拦截客户端的功能

在同一个域名的控制台里：

- 关闭 **Bot Fight Mode**、**安全挑战（Managed Challenge）**、以及会发挑战的
  **托管 WAF 规则**。它们会连你自己的代理客户端一起拦掉，表现为"时不时连不
  上"，而且极难排查。
- 确认没有任何缓存规则命中秘密前缀。

#### 三处必须一致的字符串

`WS_PATH` 必须在这三处**逐字节相同**：Worker 的 secret、容器的 `WS_PATH`、
以及每个客户端的 `path`。
`ORIGIN_SECRET` 必须在这两处相同：Worker 的 secret、容器的 `ORIGIN_SECRET`。

这是最常见的静默失败原因。

#### 本地预览（可选）

```sh
cd worker
cp .dev.vars.example .dev.vars   # 填入自己的值，这个文件不要提交
npm run dev                      # 本地起一个带静态资源的 Worker
```

`.dev.vars` 只在本地生效，部署时不会上传。

#### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地预览（读 `.dev.vars`） |
| `npm run deploy` | 部署（等价于 `npx wrangler deploy`） |
| `npm run check` | 只做打包演练，不真正部署，用来验证配置 |
| `npx wrangler tail` | 实时查看线上日志 |
| `npx wrangler secret list` | 列出已设置的变量名（不显示值） |
| `npx wrangler deployments list` | 查看部署历史，可回滚 |

---

## 环境变量

### 必填

| 名称 | 校验规则 | 说明 |
| --- | --- | --- |
| `NODE_ID` | 必须是 UUID 格式；已知示例值会被拒绝 | VLESS 用户 ID。用 `uuidgen` 生成 |
| `WS_PATH` | 以 `/` 开头、长度 ≥16、不以 `/` 结尾、不含空白或 `?#%`、非常见值 | 共享的秘密路径。用 `openssl rand -hex 16` 生成 |

缺失或非法时容器会**以状态码 2 退出并打印具体原因**。刻意没有兜底默认值：
一个公开镜像如果带着默认 UUID 启动，任何拉取它的人都会变出一个开放代理。

### 可选

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `LISTEN_PORT` | `8080` | gateway 监听端口，必须与平台发布的端口一致 |
| `UPSTREAM_PORT` | `9000` | 引擎的本地回环端口，永不对外发布 |
| `LOG_LEVEL` | `warn` | `error` / `warn` / `info` / `debug`。`info` 会打印启动摘要；**任何级别都不会打印凭据** |
| `MAX_EARLY_DATA` | `2048` | 接受的早数据字节数，`0` 表示关闭。客户端不发早数据也能正常工作 |
| `EARLY_DATA_HEADER` | 空 | 留空表示早数据放在路径里（Xray 的默认行为）。只有当所有客户端都用 header 模式时才设成 `Sec-WebSocket-Protocol` |
| `MAX_CONNS` | `300` | 并发隧道连接上限。超限时**只在秘密路径上**返回 503 |
| `ORIGIN_SECRET` | 空 | 设置后 gateway 会要求 `X-Origin-Key` 头。**请务必设置** |
| `SINGBOX_MEMLIMIT_MB` | cgroup 限额的 55% | 引擎的 Go 软内存上限 |
| `FRONT_MEMLIMIT_MB` | cgroup 限额的 15% | gateway 的 Go 软内存上限。两个进程共用一个 cgroup，所以刻意分开算 |
| `GOMAXPROCS` | 由 `cpu.max` 推导 | 0.2 vCPU 会算成 1 |
| `CONFIG_PATH` | 依次尝试 `/app/config.json`、`/tmp`、`/dev/shm` | 渲染出的引擎配置写在哪里 |
| `READY_TIMEOUT` | `20` | 等待引擎监听的秒数，超时则退出让平台重启 |

---

## 客户端配置

请使用支持 **uTLS 浏览器指纹**的客户端，并把指纹设成 Chrome。TLS 的
`ClientHello` 是客户端生成的，链路上的观察者能看到它——一个默认的 Go 或自研
TLS 栈是很强的特征。

| 字段 | 值 |
| --- | --- |
| 协议 | VLESS |
| 传输 | `ws` |
| 安全 | `tls` |
| 地址 | 你的 Cloudflare 域名（**不是** `code.run` 域名） |
| 端口 | `443` |
| SNI / Host | 同一个域名 |
| Path | 与 `WS_PATH` 完全一致 |
| `ed` | 设为 `2048` 与服务端 `MAX_EARLY_DATA` 对应，或两端都设 `0` 关闭 |
| Mux | **关闭** |
| TLS 0-RTT | **关闭** |

等价分享链接（把值换成你自己的）：

```
vless://<NODE_ID>@<你的域名>?encryption=none&security=tls&sni=<你的域名>&type=ws&host=<你的域名>&path=<WS_PATH>&ed=2048#node
```

两条比任何参数都重要的规则：

- **不要往客户端配置里塞额外 IP，也不要把域名手动指向挑出来的 Cloudflare
  地址。** 除了违反 Cloudflare 条款，这还是个已经出名、会被针对性隔离的模式。
- **不要分享这个节点。** 分享同时放大流量并招来举报，这正是最容易被封的两件事。

---

## 定制伪装站

`worker/site/` 里全部是占位内容。**请替换掉它。** 如果一千个部署都提供同样的
页面、同样的品牌，那个"同一性"本身就是指纹：观察者用一个请求就能认出整批节点。

至少需要改：

- 每个页面的品牌名、`<title>` 和 meta 描述。
- `favicon.svg`、`assets/style.css` 里的 `--accent` 色调、以及各页页头的字标。
- 邮箱、街道地址（`contact.html`、`privacy.html`、`terms.html` 里的
  `hello@slatepath.dev`）。
- `sitemap.xml` 和 `robots.txt` 里的绝对 URL。
- 文章日期，以及首页那句"available from"的日期。

请保留这些结构性特征：多个互相链接的页面、一个 `404.html`、真实可读的正文，
并且**不要**留下 "lorem ipsum"、"coming soon" 之类的占位文字。确认每条内链
都能打开。

站内链接带 `.html` 后缀是有意为之，但 Worker 同时也支持不带后缀的写法，两种
都能正常返回 200，不会产生跳转。想改成 `/about` 这种更现代的写法，直接批量改
链接即可，路由不用动。

---

## 安全须知

**镜像里没有任何凭据。** `NODE_ID`、`WS_PATH`、`ORIGIN_SECRET` 都在启动时从
环境变量读取，引擎配置也是运行时才写到磁盘。**绝不要把它们作为 build
argument 传入**：那会残留在镜像历史与构建日志里。

**请设置 `ORIGIN_SECRET`。** 不设的话，任何发现源站域名的人都能直接连上隧道
端口。设了之后，缺少匹配 `X-Origin-Key` 头的请求会拿到与其它路径完全相同的
404。这个头只存在于边缘到源站这一段，客户端永远看不到。

**关掉平台自动分配的域名。** `code.run` 子域名是可以被枚举发现的。请给自己
的端口绑定一个中性的域名，并把自动域名关掉。

**不要把输不起的东西押在这上面。** 在免费层跑隧道节点与多数平台的条款精神
相悖，而 Cloudflare 的条款明确禁止用其服务提供代理。请让账号、域名、镜像
仓库与你在意的一切保持隔离。

**容易忽略的运维动作：**

- 关注平台的出网计费。Northflank 即使免费层也是按 GB 收出网费，免费的是算力。
- 第一个月结束前就设好账单告警。
- 不要用这个节点跑视频或大文件下载。长期恒定速率的流量是最容易被分类的特征。
- 让部署和伪装站远离任何与你真实身份关联的仓库。

---

## 验收清单

每次改配置后都跑一遍。

| # | 检查项 | 期望结果 |
| --- | --- | --- |
| 1 | 浏览器访问域名 | 站点正常渲染，页面之间可以互相跳转 |
| 2 | `curl -sI https://域名/` | 除 Cloudflare 自身外没有 `Server` 头，没有自定义头 |
| 3 | 请求 20 个随机路径 | 全部是同一份 404，样式与站点一致 |
| 4 | `curl -sI https://域名/<WS_PATH>` | 404，**不是** 101/400/426/502 |
| 5 | `curl -s -H 'Upgrade: websocket' https://域名/<WS_PATH>` | 404——没有密钥就不该升级 |
| 6 | 客户端连接 | 隧道可用 |
| 7 | 用错误 UUID 连接 | 失败方式与"页面不存在"一致 |
| 8 | 对随机路径发 POST/PUT | 404 |
| 9 | 停掉容器后再浏览 | 站点照常打开（它在边缘） |
| 10 | `dig +short <域名>` | 不应出现 `104.21.x.1` 这类地址 |
| 11 | 客户端的 JA3/JA4 | 与常见浏览器一致 |

本地对容器跑同样的检查：

```sh
curl -sI  http://127.0.0.1:8080/                       # 404
curl -s   http://127.0.0.1:8080/<WS_PATH>              # 404
curl -s -H 'Upgrade: websocket' \
     -H 'X-Origin-Key: <密钥>' \
     -H 'Connection: Upgrade' http://127.0.0.1:8080/<WS_PATH>
```

---

## 排障

| 现象 | 可能原因 |
| --- | --- |
| 容器立刻退出，状态码 2 | 必填变量缺失或非法，报错信息里会点名是哪一个 |
| 容器退出，状态码 1 | 引擎启动失败，或配置路径不可写。把 `LOG_LEVEL` 调到 `debug` |
| 客户端连上后立刻断开 | Worker、容器、客户端三处的 `WS_PATH` 不一致，或路径被某处改写过。注意早数据的前缀规则 |
| 所有客户端都时通时不通 | Cloudflare 的挑战机制（Bot Fight Mode、WAF、Under Attack 模式）在拦升级请求。为这个域名关掉它们 |
| 某个网络能用，另一个不能用 | 你域名分到的边缘地址被干扰了。换域名或换 zone 再试；不要去手动指定地址 |
| 连接数一多速度就崩 | 撞到 0.2 vCPU 上限了。调低 `MAX_CONNS`、确认 `LOG_LEVEL` 是 `warn`、确认客户端关了 mux |
| 开启早数据后上游报错 | `MAX_EARLY_DATA` 与客户端的 `ed` 必须一致；除非设了 `EARLY_DATA_HEADER`，客户端必须用路径模式 |
| 部署后 workers.dev 域名打不开 | 这是预期行为：`wrangler.jsonc` 里 `workers_dev` 为 `false`。请绑定自定义域名 |
| 绑定自定义域名时报错 | 域名必须已托管在同一个 Cloudflare 账号下 |

### 一个已知的未验证点

Worker 通过返回一个携带 `upstream.webSocket` 的 `101` 响应，把上游 socket
直接交给客户端（见 `worker/src/index.js` 顶部的注释）。这是与 `accept()` 相对
应的官方写法，好处是不必把每一帧都搬过 JS 层——但这一条在发布前没能对着真实
Cloudflare 账号实测。

如果出现**"升级之后立刻断开、而直连源站却正常"**，就是这一行需要改：改成
`upstream.webSocket.accept({ allowHalfOpen: true })`，再用一个 `WebSocketPair`
在两边转发消息。两种写法都能工作，只是转发版本每帧都要过 JS，会吃 CPU 并限制
吞吐。

Worker 的其余路由逻辑由 `worker/src/index.js` 的测试台覆盖（33 条断言），容器
行为由上方的检查项覆盖。

---

## 许可证

GPL-3.0-or-later，与镜像内重新分发的引擎保持一致。见 [`LICENSE`](LICENSE)
与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

由于镜像内含 GPL 软件，发布镜像就等于在分发该软件：请把许可证文本保留在镜像
里（Dockerfile 已经拷贝了），并保证 `THIRD_PARTY_NOTICES.md` 中记录的源码
链接始终可用。
