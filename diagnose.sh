#!/usr/bin/env bash
#
# 诊断脚本：直连源站能用、套了 CDN 却不行时，用它定位问题出在哪一段。
#
# 用法：
#   ./diagnose.sh
#
# 它会问你几个值（只在本地使用，不会显示在屏幕上，也不会发到任何地方），
# 然后逐项测试，最后给出结论。
#
# 不需要 root，不改任何配置。

set -uo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say()  { printf '\n%s── %s %s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '   %s✔ %s%s\n' "$GREEN" "$*" "$OFF"; }
bad()  { printf '   %s✘ %s%s\n' "$RED" "$*" "$OFF"; }
warn() { printf '   %s! %s%s\n' "$YELLOW" "$*" "$OFF"; }
info() { printf '     %s\n' "$*"; }

command -v curl >/dev/null 2>&1 || { echo "缺少 curl，请先 sudo apt install curl"; exit 1; }

mask() {
  # 只回显长度和指纹，不泄露值本身
  local s="$1"
  local n=${#s}
  local h
  h=$(printf '%s' "$s" | sha256sum | cut -c1-8)
  printf '(长度 %s, 指纹 %s)' "$n" "$h"
}

clean_host() {
  local h="$1"
  h="${h#http://}"; h="${h#https://}"; h="${h%/}"; h="${h%%/*}"
  printf '%s' "$h"
}

# ─────────────────────────────────────────────── 收集输入
say "输入参数（只在本地使用）"

if [ -f "$HOME/.nf-node-secrets" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nf-node-secrets"
  info "已从 ~/.nf-node-secrets 读取到部分值"
fi

printf '   1) 你的 CDN 域名（例如 cdn.example.com）: '
read -r CDN_DOMAIN
CDN_DOMAIN=$(clean_host "${CDN_DOMAIN:-}")
[ -n "$CDN_DOMAIN" ] || { bad "必须填 CDN 域名"; exit 1; }

printf '   2) 你的 WS_PATH（容器和 Worker 里填的那个，输入时不显示）: '
read -rs WS_PATH; echo
WS_PATH="${WS_PATH:-}"
[ -n "$WS_PATH" ] || { bad "必须填 WS_PATH"; exit 1; }

printf '   3) 容器的 code.run 域名（Northflank 的 Ports & DNS 里那个）: '
read -r ORIGIN_HOST
ORIGIN_HOST=$(clean_host "${ORIGIN_HOST:-}")
[ -n "$ORIGIN_HOST" ] || { bad "必须填容器域名"; exit 1; }

printf '   4) 容器的 ORIGIN_SECRET（没设置就直接回车，输入时不显示）: '
read -rs ORIGIN_SECRET; echo
ORIGIN_SECRET="${ORIGIN_SECRET:-}"

say "确认（值本身不会显示）"
info "CDN 域名     : $CDN_DOMAIN"
info "WS_PATH      : $WS_PATH $(mask "$WS_PATH")"
info "容器域名     : $ORIGIN_HOST"
info "ORIGIN_SECRET: $( [ -n "$ORIGIN_SECRET" ] && mask "$ORIGIN_SECRET" || echo '(空)' )"
printf '\n   按回车开始测试...'
read -r _

WSKEY='dGhlIHNhbXBsZSBub25jZQ=='

first_line() { printf '%s' "$1" | head -1 | tr -d '\r'; }
has()  { printf '%s' "$1" | grep -qiE "$2"; }

# 带 Upgrade 的探测：返回完整响应头（成功 101 后连接会挂住，所以限时）
probe_upgrade() {
  local url="$1"; shift
  # 注意：不能把 stderr 合并进来。成功升级后 curl 会因为连接被挂住而超时，
  # 那条超时信息会排在状态行前面，导致误读。
  curl -sS -i -m 5 --http1.1 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $WSKEY" \
    "$@" "$url" 2>/dev/null | head -15
}

# ─────────────────────────────────────────────── 测试 1：CDN 上的站点
say "测试 1：CDN 域名上的伪装站是否正常"
T1H=$(curl -sS -m 15 -o /dev/null -D - "https://$CDN_DOMAIN/" || true)
T1S=$(printf '%s' "$T1H" | head -1 | tr -d '\r')
T1B=$(curl -sS -m 15 "https://$CDN_DOMAIN/" || true)
info "状态行: $T1S"
if has "$T1B" 'Slatepath|<!doctype html'; then ok "站点内容返回正常"; else bad "站点内容异常"; fi
if has "$T1B" 'Just a moment|cf-challenge|Attention Required'; then
  bad "检测到 Cloudflare 挑战页 —— 这会让代理客户端无法连接"
elif has "$T1B" 'Page not found'; then
  warn "根路径返回了 404 页，说明 Worker 在处理但不是预期行为"
else
  ok "没有 Cloudflare 挑战页"
fi

# ─────────────────────────────────────────────── 测试 2：Worker 是否在处理请求
say "测试 2：Worker 脚本是否在运行（用一个不存在的路径）"
T2B=$(curl -sS -m 15 "https://$CDN_DOMAIN/__diagnose_nonexistent__" || true)
if has "$T2B" 'Page not found'; then
  ok "返回的是站点自己的 404 —— Worker 正常运行"
elif has "$T2B" 'Just a moment|cf-challenge'; then
  bad "返回的是 Cloudflare 挑战页"
else
  warn "返回的不是站点 404，可能是 Cloudflare 默认错误页"
  info "$(printf '%s' "$T2B" | head -c 160)"
fi

# ─────────────────────────────────────────────── 测试 3：秘密路径不带 Upgrade
say "测试 3：秘密路径（不带 WebSocket 升级）在 CDN 上应返回 404"
T3S=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$CDN_DOMAIN$WS_PATH" || true)
info "HTTP 状态码: $T3S"
if [ "$T3S" = "404" ]; then
  ok "符合预期（探测者看到 404）"
elif [ "$T3S" = "101" ]; then
  bad "居然直接升级了 —— Worker 的路径判断可能没生效"
else
  warn "期望 404，实际 $T3S"
fi

# ─────────────────────────────────────────────── 测试 4：秘密路径带 Upgrade（CDN）
say "测试 4 ★：秘密路径 + WebSocket 升级，经 CDN（关键）"
T4=$(probe_upgrade "https://$CDN_DOMAIN$WS_PATH")
T4L=$(first_line "$T4")
info "状态行: ${T4L:-（无响应）}"
if has "$T4L" '101'; then
  ok "CDN 侧升级成功（101）"
elif has "$T4L" '404'; then
  bad "CDN 侧返回 404 —— Worker 的 WS_PATH 与请求的路径不匹配"
  info "也就是说：Worker 代码里写的 WS_PATH 和你现在用的这个不一样"
elif has "$T4L" '502'; then
  bad "CDN 侧返回 502 —— Worker 转发了，但源站没有接受升级"
  info "可能原因：ORIGIN_HOST 填错 / 容器侧 WS_PATH 不同 / 容器要求 ORIGIN_SECRET"
elif [ -z "$T4L" ]; then
  bad "完全没有响应 —— 连接被中断（可能是 Cloudflare 挑战或域名未生效）"
else
  warn "非预期响应"
fi

# ─────────────────────────────────────────────── 测试 5：直连源站带 Upgrade（对照）
say "测试 5 ★：秘密路径 + WebSocket 升级，直连源站（对照）"
EXTRA=()
[ -n "$ORIGIN_SECRET" ] && EXTRA=(-H "X-Origin-Key: $ORIGIN_SECRET")
T5=$(probe_upgrade "https://$ORIGIN_HOST$WS_PATH" "${EXTRA[@]+"${EXTRA[@]}"}")
T5L=$(first_line "$T5")
info "状态行: ${T5L:-（无响应）}"
if has "$T5L" '101'; then
  ok "源站侧升级成功（101）—— 容器与 sing-box 没问题"
elif has "$T5L" '404'; then
  if [ -n "$ORIGIN_SECRET" ]; then
    bad "源站侧返回 404，且你已经填了 ORIGIN_SECRET"
    info "两种可能：容器里的密钥与这个不同，或者 X-Origin-Key 头在中间层被剥掉了"
    info "建议先把两边的 ORIGIN_SECRET 都清空，确认能通之后再一起设上"
  else
    bad "源站侧返回 404 —— 可能是容器里的 WS_PATH 与这个不一致"
    info "如果容器里其实设置了 ORIGIN_SECRET（这里留空了），也会是这个结果"
  fi
else
  warn "源站响应异常"
fi

# ─────────────────────────────────────────────── 测试 6：源站的基础行为
say "测试 6：源站的普通 HTTP 响应（容器是否活着）"
T6S=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$ORIGIN_HOST/" || true)
info "根路径状态码: $T6S（容器正常时是 404，这是刻意的设计）"
T6B=$(curl -sS -m 15 "https://$ORIGIN_HOST/" || true)
if has "$T6B" 'The requested resource is not available'; then
  ok "容器的统一响应正常"
else
  warn "源站返回的内容不像容器"
fi

# ─────────────────────────────────────────────── 结论
say "结论"
T4R=""; T5R=""
has "$T4L" '101' && T4R=ok
has "$T5L" '101' && T5R=ok

if [ "$T5R" = "ok" ] && [ "$T4R" != "ok" ]; then
  cat <<'EOF'
   源站直连(101) 但 CDN 不通过 —— 问题在 Cloudflare 这一段的 WebSocket 转发。

   按可能性排序：
     1. Worker 里的 WS_PATH 与容器里的不一致（手动编辑最容易出这个）
        对照：上面测试 4 是 404 就走这条
     2. Worker 里的 ORIGIN_HOST 填错（少了字符、多了 http:// 等）
        对照：上面测试 4 是 502 就走这条
     3. Cloudflare 的 Bot Fight Mode / 安全挑战在拦升级请求
        对照：测试 1 或 2 出现了挑战页

   把上面的完整输出发给我，我按结果给出具体改法。
EOF
elif [ "$T5R" = "ok" ] && [ "$T4R" = "ok" ]; then
  cat <<'EOF'
   两段都返回 101，说明 WebSocket 通道本身是通的。

   那就不是路径/域名的问题，而是"升级成功但数据不流动"，
   或者客户端配置与 Worker 侧不一致。请提供：
     - 客户端里填的配置（地址/SNI/Host/Path/ed 四项）
     - 浏览器访问 CDN 域名是否能看到站点
EOF
elif [ "$T5R" != "ok" ]; then
  cat <<'EOF'
   连源站直连都没有返回 101 —— 问题在容器侧，不是 Cloudflare。

   请检查：
     - 容器域名是否正确（Northflank 的 Ports & DNS）
     - 容器里的 WS_PATH 是否与这里输入的一致
     - 如果容器设置了 ORIGIN_SECRET，本脚本第 4 个问题要填对
EOF
else
  cat <<'EOF'
   结果不明确，请把上面的完整输出发出来。
EOF
fi
echo
