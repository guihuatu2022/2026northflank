#!/usr/bin/env bash
#
# 生成部署订阅 Worker 需要的两个值。
#
#   SUB_KEY   路径里那段随机值
#   NODES     节点列表的 base64 内容（直接粘贴到控制台的变量里）
#
# 用法：
#   ./sub/make-subscription.sh
#
# 它会尽量复用 ~/.nf-node-secrets 里的 NODE_ID 和 WS_PATH，
# 只需要你补一个隧道域名。

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
say()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '%s%s%s\n' "$GREEN" "$*" "$OFF"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$OFF"; }
die()  { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

SECRETS="$HOME/.nf-node-secrets"
EXTRA="$HOME/.nf-node-extra-nodes"
OUT="$HOME/.nf-node-subscriber"

command -v openssl >/dev/null 2>&1 || die "缺少 openssl：sudo apt install openssl"

# ───────────────────────────────────────────── 读取已有的节点凭据
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

# ───────────────────────────────────────────── 拼装节点链接
say "2/3  拼装节点链接"

if [ -f "$OUT" ]; then
  # shellcheck disable=SC1090
  . "$OUT"
fi

printf '   客户端连接的域名（你绑到 Worker 上的那个，例如 cdn.example.com）'
[ -n "${CDN_DOMAIN:-}" ] && printf ' [%s]' "$CDN_DOMAIN"
printf ': '
read -r input
CDN_DOMAIN="${input:-${CDN_DOMAIN:-}}"
[ -n "$CDN_DOMAIN" ] || die "必须填域名"

printf '   节点在客户端里显示的名字 [%s]: ' "${NODE_NAME:-nf-node}"
read -r input
NODE_NAME="${input:-${NODE_NAME:-nf-node}}"

printf '   Clash / sing-box 用的 uTLS 指纹 [chrome]: '
read -r input
FINGERPRINT="${input:-chrome}"

# 清理域名
CDN_DOMAIN="${CDN_DOMAIN#http://}"; CDN_DOMAIN="${CDN_DOMAIN#https://}"; CDN_DOMAIN="${CDN_DOMAIN%/}"

# 早数据 ed 的取值：跟容器里的 MAX_EARLY_DATA 对应
ED="${MAX_EARLY_DATA:-2048}"

VLESS="vless://${NODE_ID}@${CDN_DOMAIN}:443"
VLESS+="?encryption=none&security=tls&sni=${CDN_DOMAIN}"
VLESS+="&type=ws&host=${CDN_DOMAIN}&path=${WS_PATH}"
[ "$ED" != "0" ] && VLESS+="&ed=${ED}"
VLESS+="#${NODE_NAME}"

NODES="$VLESS"

# 允许追加别的节点（一行一个链接）
if [ -f "$EXTRA" ]; then
  extra_count=$(grep -c '://' "$EXTRA" 2>/dev/null || echo 0)
  if [ "$extra_count" -gt 0 ]; then
    NODES="$(printf '%s\n%s' "$NODES" "$(grep '://' "$EXTRA")")"
    ok "   已追加 $extra_count 条来自 $EXTRA 的节点"
  fi
else
  printf '\n'
  warn "   提示：如果还想加别的节点，把它们一行一个写进 $EXTRA 再重跑本脚本"
fi

printf '\n   生成的节点链接：\n     %s\n' "$VLESS"

# ───────────────────────────────────────────── 生成 SUB_KEY 与 base64
say "3/3  生成订阅参数"

SUB_KEY="$(openssl rand -hex 16)"
NODES_B64="$(printf '%s' "$NODES" | base64 -w0)"

# 存档，方便以后重跑（含凭据，所以放家目录并限权）
( umask 077; cat > "$OUT" <<EOF
# 由 sub/make-subscription.sh 生成，含凭据，不要提交到任何仓库
CDN_DOMAIN=$CDN_DOMAIN
NODE_NAME=$NODE_NAME
EOF
)
chmod 600 "$OUT"

cat <<EOF

  ─────────────────────────────────────────────────────────────
  在 Cloudflare 控制台新建一个 Worker，然后把 sub/worker.js 整个粘进去。
  接着在 Settings -> Variables and Secrets 里添加下面两个变量
  （类型选 Secret，两个都选）：

    SUB_KEY =
${SUB_KEY}

    NODES =
${NODES_B64}
  ─────────────────────────────────────────────────────────────

  绑定好你的订阅域名之后，订阅地址就是：

    https://${CDN_DOMAIN}/${SUB_KEY}

  Clash / Mihomo 客户端会自动拿到 base64（除非你另外设置了 NODES_CLASH）。
  想强制指定格式，用：

    https://${CDN_DOMAIN}/${SUB_KEY}/clash
    https://${CDN_DOMAIN}/${SUB_KEY}/base64

  验证（用客户端 UA，否则会被 UA 规则拦掉）：

    curl -s -A 'v2rayN/6.0' 'https://${CDN_DOMAIN}/${SUB_KEY}' | head -c 120; echo

  这两个值也存了一份在这里，权限 600：
    ${OUT}
EOF

ok "完成。"
