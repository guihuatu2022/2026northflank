#!/usr/bin/env bash
#
# 生成部署订阅服务需要的东西。
#
#   1. 管理页路径  ADMIN_PATH
#   2. 管理页密码  ADMIN_PASSWORD
#   3. 你第一条节点的 vless 链接（等下粘到管理页里）
#
# 用法：
#   ./sub/make-subscription.sh
#
# 会尽量复用 ~/.nf-node-secrets 里的 NODE_ID 和 WS_PATH。

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
say()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '%s%s%s\n' "$GREEN" "$*" "$OFF"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$OFF"; }
die()  { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

SECRETS="$HOME/.nf-node-secrets"
OUT="$HOME/.nf-node-sub-admin"

command -v openssl >/dev/null 2>&1 || die "缺少 openssl：sudo apt install openssl"

# ───────────────────────────────────────────── 节点凭据
say "1/3  读取节点凭据"
if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
  printf '   已从 %s 读取\n' "$SECRETS"
else
  warn "   没有 $SECRETS —— 请先跑一次 ./deploy.sh 生成 NODE_ID / WS_PATH"
fi
[ -n "${NODE_ID:-}" ] || die "缺少 NODE_ID"
[ -n "${WS_PATH:-}" ] || die "缺少 WS_PATH"

# ───────────────────────────────────────────── 拼节点链接
say "2/3  拼装第一条节点链接"

if [ -f "$OUT" ]; then
  # shellcheck disable=SC1090
  . "$OUT"
fi

printf '   客户端连接的域名（绑到隧道 Worker 上的那个，例如 cdn.example.com）'
[ -n "${CDN_DOMAIN:-}" ] && printf ' [%s]' "$CDN_DOMAIN"
printf ': '
read -r input
CDN_DOMAIN="${input:-${CDN_DOMAIN:-}}"
[ -n "$CDN_DOMAIN" ] || die "必须填域名"
CDN_DOMAIN="${CDN_DOMAIN#http://}"; CDN_DOMAIN="${CDN_DOMAIN#https://}"; CDN_DOMAIN="${CDN_DOMAIN%/}"

printf '   节点显示名 [nf-node]: '
read -r input
NODE_NAME="${input:-${NODE_NAME:-nf-node}}"

ED="${MAX_EARLY_DATA:-2048}"
VLESS="vless://${NODE_ID}@${CDN_DOMAIN}:443?encryption=none&security=tls&sni=${CDN_DOMAIN}"
VLESS+="&type=ws&host=${CDN_DOMAIN}&path=${WS_PATH}"
[ "$ED" != "0" ] && VLESS+="&ed=${ED}"
VLESS+="#${NODE_NAME}"

printf '\n   节点链接：\n     %s\n' "$VLESS"

# ───────────────────────────────────────────── 管理凭据
say "3/3  生成管理凭据"
ADMIN_PATH="$(openssl rand -hex 16)"
ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
ADMIN_USER="${ADMIN_USER:-admin}"

( umask 077; cat > "$OUT" <<EOF
# 由 sub/make-subscription.sh 生成，含凭据，不要提交到任何仓库
CDN_DOMAIN=$CDN_DOMAIN
NODE_NAME=$NODE_NAME
ADMIN_PATH=$ADMIN_PATH
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_USER=$ADMIN_USER
EOF
)
chmod 600 "$OUT"

printf '   管理密码：%s\n' "$ADMIN_PASSWORD"

cat <<EOF

  ─────────────────────────────────────────────────────────────
  部署步骤

  1) Cloudflare 控制台新建一个 Worker，把 sub/worker.js 整个粘进去。

  2) Workers & Pages -> KV -> Create namespace，随便起个名（例如 sub-cfg）。
     回到 Worker 的 Settings -> Bindings -> Add -> KV Namespace：
        Variable name:  KV          <-- 必须正好是 KV
        KV namespace:   选刚建的那个

  3) Settings -> Variables and Secrets 里加三个 Secret：

        ADMIN_USER =
${ADMIN_USER}

        ADMIN_PATH =
${ADMIN_PATH}

        ADMIN_PASSWORD =
${ADMIN_PASSWORD}

  4) Settings -> Domains & Routes -> Add -> Custom Domain，绑你的订阅域名。
     如果列表里有 *.workers.dev，删掉。

  5) 打开管理页：

        https://你的订阅域名/${ADMIN_PATH}

     浏览器会弹认证框，用户名 ${ADMIN_USER}，密码就是上面的管理密码。
     进去后把这条节点链接粘进「节点池」，保存，再新建订阅、勾选节点。

     如果你手里是从 Karing 复制的 JSON 配置（它导不出标准链接），
     点「节点池」上方的「从 JSON 导入节点」，粘进去就能自动转成链接。

  ─────────────────────────────────────────────────────────────
  这些值也存了一份（权限 600）：${OUT}
  想再看：cat ${OUT}

  注意：管理密码是随机串，请存进你的密码管理器。
  它一旦泄露，别人就能改你的全部节点和订阅。
EOF

ok "完成。"
