#!/usr/bin/env bash
#
# 一键部署 / 配置助手。可以反复运行。
#
# 第一次运行（容器还没建时）：
#   生成三份密码并打印出来，让你拿去 Northflank 建容器。
#
# 第二次运行（容器建好、拿到 code.run 域名后）：
#   问你要那个域名，然后部署 Cloudflare Worker。
#
# 以后改了 worker/site/ 里的伪装站内容，再跑一次就能更新。

set -euo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; OFF=$'\033[0m'
say()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$OFF"; }
ok()   { printf '%s%s%s\n' "$GREEN" "$*" "$OFF"; }
die()  { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

SECRETS="$HOME/.nf-node-secrets"
WORKER_DIR="worker"

# 第一种模式（默认）：用命令行部署
# 第二种模式（--paste）：生成一份填好值的单文件 Worker，供你复制粘贴到控制台
MODE="deploy"
case "${1:-}" in
  ""|--deploy) MODE="deploy" ;;
  --paste|paste) MODE="paste" ;;
  -h|--help)
    cat <<'EOF'
用法：
  ./deploy.sh            正常流程：生成密钥、部署 Worker
  ./deploy.sh --paste    生成一份可直接粘贴到 Cloudflare 控制台的单文件 Worker

两种方式二选一即可，效果相同。
EOF
    exit 0 ;;
  *) die "未知参数：$1   （可用：--paste，或 -h 看帮助）" ;;
esac

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    cat /proc/sys/kernel/random/uuid
  fi
}

show_container_values() {
  cat <<EOF

  ─────────────────────────────────────────────────────────────
  把下面这三个值填到 Northflank 容器的「环境变量」里：

      NODE_ID       = ${NODE_ID}
      WS_PATH       = ${WS_PATH}
      ORIGIN_SECRET = ${ORIGIN_SECRET}

  这三个值同时保存在：${SECRETS}
  以后要再查：  cat ${SECRETS}
  ─────────────────────────────────────────────────────────────
EOF
}

# ------------------------------------------------------------ 1. 环境检查
say "1/4  检查环境"
command -v node >/dev/null 2>&1 || die "没有找到 node。请先安装：sudo apt install nodejs npm"
command -v npm  >/dev/null 2>&1 || die "没有找到 npm。请先安装：sudo apt install npm"
printf '     Node.js %s\n' "$(node -v)"
[ -f "$WORKER_DIR/wrangler.jsonc" ] || die "没有找到 $WORKER_DIR/wrangler.jsonc，请在项目根目录运行本脚本"

# ------------------------------------------------------------ 2. 密钥
say "2/4  准备密钥"
if [ -f "$SECRETS" ]; then
  printf '     从 %s 读取\n' "$SECRETS"
  # shellcheck disable=SC1090
  . "$SECRETS"
else
  printf '     首次运行，生成新的密钥并保存到 %s\n' "$SECRETS"
  ( umask 077; cat > "$SECRETS" <<EOF
NODE_ID=$(new_uuid)
WS_PATH=/assets/app.$(rand_hex 16).js
ORIGIN_SECRET=$(rand_hex 24)
EOF
  )
  chmod 600 "$SECRETS"
  # shellcheck disable=SC1090
  . "$SECRETS"
fi

[ -n "${NODE_ID:-}" ]       || die "$SECRETS 里缺少 NODE_ID。删掉该文件后重新运行本脚本即可"
[ -n "${WS_PATH:-}" ]       || die "$SECRETS 里缺少 WS_PATH。删掉该文件后重新运行本脚本即可"
[ -n "${ORIGIN_SECRET:-}" ] || die "$SECRETS 里缺少 ORIGIN_SECRET。删掉该文件后重新运行本脚本即可"
ok "     密钥就绪"

# ------------------------------------------------------------ 3. 域名
# ORIGIN_HOST 是容器在 Northflank 上分到的域名，只能由你提供。
if [ -z "${ORIGIN_HOST:-}" ]; then
  say "3/4  还差容器的域名"
  cat <<'EOF'

  现在需要 Northflank 给容器分配的那个域名：

    在哪里找： Northflank 控制台 -> 你的服务 -> Ports & DNS
    长这样：    port-name--service-name--abc123.code.run

  如果容器还没建，请先做这几步：

    1. 打开 https://app.northflank.com ，新建 Project（区域建议选 US West）
    2. 新建 Service，来源选「外部镜像」，填：
         ghcr.io/你的用户名/你的仓库名:edge       （凭据留空）
    3. 规格选 nf-compute-20，实例数填 1
    4. 端口：容器端口 8080，协议 HTTP，勾选「公开」
    5. 健康检查：类型必须选 TCP，端口 8080      <-- 千万别选 HTTP
    6. 环境变量：把下面这三个值填进去

  建好之后回到这里，再运行一次 ./deploy.sh 即可。
EOF
  show_container_values
  warn "  容器建好之前不部署 Worker（部署了也连不通）。"
  exit 0
fi

ORIGIN_HOST="${ORIGIN_HOST#http://}"; ORIGIN_HOST="${ORIGIN_HOST#https://}"; ORIGIN_HOST="${ORIGIN_HOST%/}"
[[ "$ORIGIN_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "ORIGIN_HOST 看起来不是域名：$ORIGIN_HOST"
printf '     容器域名：%s\n' "$ORIGIN_HOST"

# ------------------------------------------------------ 模式 A：生成可粘贴文件
if [ "$MODE" = "paste" ]; then
  say "3/3  生成可粘贴的单文件 Worker"
  [ -f "$WORKER_DIR/standalone.js" ] || die "缺少 $WORKER_DIR/standalone.js"

  # 用 sed 替换文件顶部那三行常量。值里可能含 / 和 |，用 | 作分隔符并对值转义。
  OUT_FILE="$HOME/nf-node-worker.js"
  sed \
    -e "s|^const WS_PATH = .*|const WS_PATH = \"${WS_PATH}\";|" \
    -e "s|^const ORIGIN_HOST = .*|const ORIGIN_HOST = \"${ORIGIN_HOST}\";|" \
    -e "s|^const ORIGIN_SECRET = .*|const ORIGIN_SECRET = \"${ORIGIN_SECRET}\";|" \
    "$WORKER_DIR/standalone.js" > "$OUT_FILE"
  chmod 600 "$OUT_FILE"

  node --check "$OUT_FILE" 2>/dev/null \
    || warn "  生成的脚本语法检查没通过，请把这个问题反馈一下"

  ok "  已生成：$OUT_FILE"
  cat <<EOF

  ─────────────────────────────────────────────────────────────
  接下来在浏览器里操作（不需要命令行、不需要装 wrangler）：

    1. https://dash.cloudflare.com
       -> Workers & Pages -> Create -> Worker -> 起个名字 -> Deploy

    2. 点 Edit code，把编辑器里的内容全选删掉，
       然后粘贴 ${OUT_FILE} 的全部内容，再点 Deploy

       快速把内容复制到剪贴板：
         cat ${OUT_FILE} | xclip -selection clipboard
       （没装 xclip 就手动打开文件全选复制）

    3. Settings -> Domains & Routes：
         - Add -> Custom Domain -> 填 cdn.你的域名.com
         - 删掉自动分配的 *.workers.dev 路由

    4. 在同一个页面上确认这两项是关闭的：
         - Bot Fight Mode
         - 安全挑战 / Under Attack 模式
  ─────────────────────────────────────────────────────────────

  这个文件里含你的密钥，所以写在你家目录而不是仓库里，
  也不要提交到 GitHub。权限已设为 600。
EOF
  exit 0
fi

# ------------------------------------------------------------ 4. 依赖与登录
say "3/4  准备 wrangler"
if [ -d "$WORKER_DIR/node_modules/wrangler" ]; then
  printf '     已安装，跳过\n'
else
  printf '     首次安装，约 30 秒…\n'
  ( cd "$WORKER_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) \
    || die "npm install 失败。请手动执行：cd $WORKER_DIR && npm install"
fi

if ( cd "$WORKER_DIR" && npx --no-install wrangler whoami >/dev/null 2>&1 ); then
  printf '     Cloudflare 已登录\n'
else
  printf '     需要登录 Cloudflare，即将打开浏览器…\n'
  ( cd "$WORKER_DIR" && npx --no-install wrangler login ) \
    || die "登录失败。请手动执行：cd $WORKER_DIR && npx wrangler login"
fi

# ------------------------------------------------------------ 5. 部署
say "4/4  部署 Worker"
TMP="$(mktemp)"; chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT
printf '{"WS_PATH":"%s","ORIGIN_SECRET":"%s","ORIGIN_HOST":"%s"}\n' \
  "$WS_PATH" "$ORIGIN_SECRET" "$ORIGIN_HOST" > "$TMP"

( cd "$WORKER_DIR" && npx --no-install wrangler deploy --secrets-file "$TMP" )

ok "Worker 部署完成。"
cat <<EOF

  ─────────────────────────────────────────────────────────────
  最后还差一步：给 Worker 绑定一个自定义域名。
  （脚本已经把 *.workers.dev 关掉了，不绑域名就没有入口。）

    https://dash.cloudflare.com
      -> Workers & Pages -> nf-node-edge
      -> Settings -> Domains & Routes -> Add -> Custom Domain
      -> 填一个子域名，例如 cdn.你的域名.com

  绑好后，在同一页面上确认这两项是关闭的，
  否则客户端会时通时不通，而且很难排查：

    - Bot Fight Mode
    - 安全挑战 / Under Attack 模式
  ─────────────────────────────────────────────────────────────

  容器侧的三个值（如果还没填）：
EOF
show_container_values
