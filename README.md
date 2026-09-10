# nf-node

把一台免费容器变成你的代理节点，对外只暴露一个 Cloudflare 域名。

**部署一共四步，你只需要填 3 个值。** 下面开始的部分看完就够了，最后那半篇是给想改配置的人看的，正常使用不用看。

---

## 你需要准备

| 需要的 | 说明 |
|---|---|
| GitHub 账号 | 用来放代码、自动构建容器镜像 |
| Northflank 账号 | 免费层就行，**但必须绑一张信用卡**（免费层也要绑，否则建不了服务） |
| Cloudflare 账号 + 一个域名 | 域名必须已经把 NS 托管到 Cloudflare |

---

## 第 1 步：把代码放到 GitHub

如果你已经把这个仓库 fork 或推送到了自己的 GitHub，跳过这步。

推送后，GitHub Actions 会**自动开始构建镜像**，大约 3 分钟。构建完的位置是：

```
ghcr.io/你的用户名/你的仓库名:edge
```

看构建进度：仓库页面 → **Actions** 标签。

---

## 第 2 步：生成三份密码

在终端里跑一次：

```sh
cd ~/cloudflare/nf-node
./deploy.sh
```

**第一次运行它只做一件事**：生成三份密码打印给你，然后告诉你怎么往下走。密码会存到 `~/.nf-node-secrets`，丢了可以再查。

把打印出来的三个值复制好，下一步要用。

> **为什么要先生成密码？** 因为容器**缺少 `NODE_ID` 会直接退出**（这是刻意设计的，防止有人拿默认值跑出开放代理）。如果先建容器再补密码，你会看到容器一起来就挂掉，以为坏了。

---

## 第 3 步：在 Northflank 建容器

登录 https://app.northflank.com ，按下面填。**只有这几项要动，其它保持默认。**

| 项目 | 填什么 |
|---|---|
| 套餐 | **Developer Sandbox**（免费） |
| 支付方式 | 绑一张卡（免费层也要绑） |
| 新建 Project | 区域选 **US West** 或 **US West California** |
| 新建 Service | 来源选「外部镜像」，填 `ghcr.io/你的用户名/你的仓库名:edge`，凭据留空 |
| 机器规格 | `nf-compute-20`（0.2 vCPU / 512 MB） |
| 实例数 | `1` |
| **端口** | 容器端口填 `8080`，协议选 **HTTP**，勾选「公开」 |
| **健康检查** | ⚠️ 类型必须选 **TCP**，端口 `8080`（**千万别选 HTTP**） |
| **环境变量** | 把第 2 步那三个值填进去 |

保存后等它跑起来。然后在 **Ports & DNS** 页面能看到一个域名：

```
port-name--service-name--abc123.code.run
```

**复制它**，下一步要用。

> 顺便建议：如果 Northflank 允许，把这个自动域名**关掉**，改用你自己的域名——自动域名可以被扫描到。

---

## 第 4 步：再跑一次脚本，部署 Worker

```sh
cd ~/cloudflare/nf-node
./deploy.sh
```

这次它会做三件事：

1. 问你上一步那个 `code.run` 域名 —— 粘贴进去，回车
2. 打开浏览器让你登录 Cloudflare（**不需要输入任何码**，点一下同意就行）
3. 部署 Worker，并把密码一起传上去

看到「Worker 部署完成」就好了。以后改了伪装站内容，再跑一次这条命令就能更新。

### 最后：给 Worker 绑一个自己的域名

脚本已经把 `*.workers.dev` 关掉了（那个域名会被扫描器找到），所以**不绑域名就没有入口**：

1. 打开 https://dash.cloudflare.com
2. 左边点 **Workers & Pages** → 选中 **nf-node-edge**
3. **Settings** → **Domains & Routes** → **Add** → **Custom Domain**
4. 填一个子域名，例如 `cdn.你的域名.com`，确认

等一两分钟证书签发完就生效了。

**同一页面上还有两件事必须确认**，否则客户端会时通时不通，而且极难排查：

- ❌ **Bot Fight Mode** —— 必须关闭
- ❌ **安全挑战 / Under Attack 模式** —— 必须关闭

原因是它们会给请求弹验证码或 JS 挑战，而你的代理客户端不是浏览器，会被一起拦掉。

---

## 只有这 3 个值需要你关心

| 值 | 填在哪 | 说明 |
|---|---|---|
| `NODE_ID` | 只填 Northflank | 一串 UUID，相当于账号密码 |
| `WS_PATH` | **两边都填，必须一样** | 一个秘密路径，形如 `/assets/app.9f3c1a7e5b2d4806a1b2c3d4e5f60718.js` |
| `ORIGIN_SECRET` | **两边都填，必须一样** | 另一串密码，防止别人绕过 Worker 直接摸到你的容器 |
| `ORIGIN_HOST` | 只填 Worker | 容器在 Northflank 的域名，脚本已经帮你填好了 |

这三个值脚本都生成好并存在 `~/.nf-node-secrets`，想再看一眼：

```sh
cat ~/.nf-node-secrets
```

**这三个值不要发给任何人，也不要提交到 GitHub。**

---

## 怎么确认成功了

按顺序做这 4 个检查：

| # | 做什么 | 看到什么算成功 |
|---|---|---|
| 1 | 浏览器打开 `https://cdn.你的域名.com` | 出现一个正常的英文网站，页面之间能点着跳转 |
| 2 | 随便访问一个不存在的地址，比如 `/abcd1234` | 出现 404 页面，**样式和网站一致** |
| 3 | 用客户端连接（见下一节） | 能正常上网 |
| 4 | 回到 Northflank 看容器日志 | 没有反复重启 |

第 1 条最重要。**如果打开是一片空白、或者出现 Cloudflare 的错误页，说明 Worker 没绑上域名**，回到第 3 步最后那部分。

---

## 客户端怎么连

用任何支持 VLESS 的客户端（v2rayN、Shadowrocket、sing-box 等），按下面填：

| 字段 | 填什么 |
|---|---|
| 协议 | VLESS |
| 传输 | WebSocket（`ws`） |
| 安全 | TLS |
| 地址 / 端口 | `cdn.你的域名.com` / `443` |
| SNI / Host | 同上面的地址 |
| Path | 和 `WS_PATH` **一模一样** |
| `ed` | `2048` |
| Mux | **关闭** |

或者直接生成一条分享链接（把尖括号换成你自己的值）：

```
vless://<NODE_ID>@<你的域名>?encryption=none&security=tls&sni=<你的域名>&type=ws&host=<你的域名>&path=<WS_PATH>&ed=2048#node
```

**客户端里记得把 TLS 指纹设成 Chrome**（很多客户端叫 "uTLS 指纹" 或 "Fingerprint"）。默认的指纹很容易被识别出来。

---

## 连不上怎么办

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 网页打不开，显示 Cloudflare 错误 | 没绑自定义域名 | 回到第 3 步最后一步 |
| 网页正常，但客户端连不上 | 三处 `WS_PATH` 不一致 | `cat ~/.nf-node-secrets` 对一遍：Worker 里、Northflank 里、客户端里 |
| 网页 404、样式很朴素 | 你访问的是 Northflank 的 `code.run` 域名 | 这是正常的，伪装站只在 Cloudflare 上 |
| 客户端时通时不通 | Cloudflare 的 Bot Fight Mode 或安全挑战没关 | 去域名设置里关掉 |
| 容器反复重启 | 健康检查选了 HTTP | 改成 **TCP** 探针 |
| 容器直接起不来 | Northflank 的环境变量没填 / 填错 | 看容器的 Logs，它会明确打印缺了哪个变量 |
| 刚还能用，突然全断 | 域名或 IP 被针对性干扰了 | 换一个子域名或换一个 Cloudflare zone 再试 |
| 越用越慢 | 免费层只有 0.2 核 CPU | 这是上限。别用它看视频 |

改完伪装站或配置后想重新部署，直接再跑一次：

```sh
./deploy.sh
```

---
---

# 以下是进阶内容

**正常使用不需要看。** 想改配置、想理解原理、或者想排查疑难问题再看。

## 工作原理

```
客户端（VLESS + WS + TLS，TLS 指纹伪装成浏览器）
   |
   v
Cloudflare 边缘  （你的自定义域名）
   |-- 秘密前缀 + WebSocket 升级 -> 反代到源站
   |-- 其它任意路径 -> 返回伪装站页面，或伪装站自己的 404
   v
Northflank 容器  （0.2 vCPU / 512 MB）
   |-- /app/gateway  监听 8080，处理公网请求
   `-- /app/engine   引擎，只监听本机 127.0.0.1:9000
```

三个关键设计：

1. **容器不提供任何真实内容。** 伪装站放在 Cloudflare 边缘。源站对任意路径、任意请求都返回同一份 404，主动探测者没有可对比的差异。
2. **引擎先监听成功，才开放公网端口**；并且故意不设读写超时，避免长连接被掐断。
3. **镜像里没有任何密码。** 一切在容器启动时从环境变量生成，所以同一个镜像可以服务任意多个部署。

### 为什么路径用「前缀」匹配而不是精确匹配

客户端会把自己的一小段数据追加在请求路径后面，路径变成 `<WS_PATH>加上一串字符`，不再是一个固定值。所以 Worker 和容器都用**前缀**判断，并且必须把路径原样转交。`WS_PATH` 不能以 `/` 结尾，否则前缀会产生歧义，容器会直接拒绝启动。

### 为什么路径长这样

`WS_PATH` 的格式刻意做成 `/assets/app.<随机十六进制>.js`，模仿打包工具产出的文件名：

- `/assets/` 是伪装站**真实存在**的目录——站点自己的 `style.<哈希>.css` 和 `site.<哈希>.js` 就在这里，不是凭空捏造的路径
- `app.<哈希>.js` 是现代打包工具（webpack / vite）的标准产出格式，任何正经网站都有
- 它**不出现在站点的任何 HTML 里**，所以访问它得到 404 完全正常——旧构建残留的资源路径本来就会 404
- 十六进制串由脚本随机生成，扫描器猜不中

想换一条：改 `~/.nf-node-secrets` 里的 `WS_PATH`，重新跑 `./deploy.sh`（它会把新值推到 Worker），再把新值同步到 Northflank 的环境变量里。

## 全部环境变量（进阶）

### 只有这三个需要填

| 名称 | 填在哪 |
|---|---|
| `NODE_ID` | 仅容器 |
| `WS_PATH` | 容器 + Worker，两侧一致 |
| `ORIGIN_SECRET` | 容器 + Worker，两侧一致 |

### 其余变量：默认值已经调好，**不要设置**

列在这里只是让你知道它们存在，以及什么情况下才需要动。

| 名称 | 默认值 | 什么情况下才改 |
|---|---|---|
| `LOG_LEVEL` | `warn` | 排查问题时临时改成 `info` 或 `debug`，平时不要动 |
| `MAX_CONNS` | `300` | 连接数一多就变慢时，往下调（比如 150） |
| `MAX_EARLY_DATA` | `2048` | 只有客户端不用 `ed=2048` 时才需要动。改错会导致连不上 |
| `EARLY_DATA_HEADER` | 空 | 只有当所有客户端都用 header 模式时 |
| `LISTEN_PORT` | `8080` | 只有你在 Northflank 改了端口时 |
| `UPSTREAM_PORT` | `9000` | 不需要改 |
| `SINGBOX_MEMLIMIT_MB` | 按容器内存自动算 | 不需要改 |
| `FRONT_MEMLIMIT_MB` | 按容器内存自动算 | 不需要改 |
| `GOMAXPROCS` | 按容器 CPU 自动算 | 不需要改 |
| `CONFIG_PATH` | 自动找可写位置 | 不需要改 |
| `READY_TIMEOUT` | `20` | 容器启动特别慢时才调大 |

### Worker 侧的三个变量

`WS_PATH`、`ORIGIN_HOST`、`ORIGIN_SECRET`，都是通过 `deploy.sh` 自动设置的，存在 Cloudflare 上，不在任何文件里。

想手动看或改：

```sh
cd worker
npx wrangler secret list                      # 看有哪些（不显示值）
echo -n "新值" | npx wrangler secret put WS_PATH   # 改某一个
```

## 定制伪装站

`worker/site/` 里全部是**模板内容**，请换成你自己的。原因：如果很多人用同一个仓库部署，所有人的伪装站长得一模一样，这本身就是最好的指纹——观察者用一次请求就能认出整批节点。

至少要改：

- 每页的品牌名和 `<title>`
- `favicon.svg`、`assets/style.css` 里的 `--accent` 颜色
- 邮箱、地址（`contact.html`、`privacy.html`、`terms.html` 里的 `hello@slatepath.dev`）
- `sitemap.xml`、`robots.txt` 里的网址
- 文章日期

保留这些：多个互相链接的页面、一个 `404.html`、真实可读的正文，**不要**留 "lorem ipsum"、"coming soon" 之类占位文字。确认每条内链都能打开。

改完再跑一次 `./deploy.sh` 就生效了。

## 安全须知

- **镜像里没有任何密码。** 绝不要把 `NODE_ID` / `WS_PATH` / `ORIGIN_SECRET` 作为构建参数传进去，那会留在镜像历史里。
- **不要分享这个节点。** 分享会同时放大流量并招来举报，这是最容易被封的两件事。
- **不要往客户端里塞额外的 IP。** 除了违反 Cloudflare 条款，这还是个已经出名、会被针对性处理的模式。
- **不要让代理配置泄露真实身份。** 域名、GitHub 账号、镜像仓库，都和你平时用的身份隔离开。
- **注意出网费用。** Northflank 免费的是算力，**流量是按 GB 收费的**（$0.06/GB）。100 GB 约 $6，1 TB 约 $60。请在账户里设一个账单告警。
- **别用它跑视频或大文件。** 长期恒定速率的大流量是最容易被识别的特征，也是账单失控的主因。

## 完整验收清单

每次改配置后建议跑一遍。

| # | 检查项 | 期望结果 |
|---|---|---|
| 1 | 浏览器访问域名 | 站点正常渲染，页面之间可跳转 |
| 2 | `curl -sI https://你的域名/` | 除 Cloudflare 外没有 `Server` 头，没有自定义头 |
| 3 | 访问 20 个随机路径 | 全部是同一份 404，样式与站点一致 |
| 4 | `curl -sI https://你的域名/<WS_PATH>` | 404，**不是** 101/400/426/502 |
| 5 | `curl -s -H 'Upgrade: websocket' https://你的域名/<WS_PATH>` | 404 —— 没有密码就不该升级成功 |
| 6 | 客户端连接 | 隧道可用 |
| 7 | 用错误 UUID 连接 | 失败方式与"页面不存在"一致 |
| 8 | 对随机路径发 POST | 404 |
| 9 | 停掉 Northflank 容器后再浏览网页 | 站点照常打开（它在边缘） |
| 10 | `dig +short 你的域名` | 不应出现 `104.21.x.1` 这类地址 |
| 11 | 客户端 TLS 指纹 | 与常见浏览器一致 |

## 一个已知的未验证点

Worker 通过返回一个携带上游 socket 的 `101` 响应，把 WebSocket 直接交给客户端（见 `worker/src/index.js` 顶部注释）。这是官方文档里与 `accept()` 相对应的写法，好处是不必把每一帧都搬过 JS 层——但这一条**没能在真实的 Cloudflare 账号上实测过**。

如果出现「**升级之后立刻断开，但直连 Northflank 的 `code.run` 域名却正常**」，就是这一行需要改：改成 `upstream.webSocket.accept({ allowHalfOpen: true })`，再用一个 `WebSocketPair` 在两边转发消息。两种写法都能工作，只是转发版本每帧都要过 JS，会吃 CPU 并限制速度。

Worker 的其余路由逻辑有 33 条本地断言的测试台覆盖。

## 目录结构

```
Dockerfile                     多阶段构建：裁剪版引擎 + gateway
deploy.sh                      一键部署 Worker 的脚本
.github/workflows/build.yml    push 后自动构建镜像
front/                         容器入口（Go）
worker/
  src/index.js                 Worker 脚本
  wrangler.jsonc               部署配置
  site/                        伪装站（请定制）
third_party/                   第三方许可证
```

## 许可证

GPL-3.0-or-later，与镜像内重新分发的引擎保持一致。见 [`LICENSE`](LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

由于镜像内含 GPL 软件，发布镜像就等于在分发该软件：许可证文本已经打包进镜像，请保证 `THIRD_PARTY_NOTICES.md` 中记录的源码链接始终可用。
