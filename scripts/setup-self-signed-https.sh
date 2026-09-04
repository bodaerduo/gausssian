#!/usr/bin/env bash
set -Eeuo pipefail

# Generate a self-signed certificate for the LAN HTTPS endpoint.
# The private key is intentionally kept outside version control.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TLS_DIR="${TLS_DIR:-$PROJECT_ROOT/runtime/tls}"
TLS_IP="${TLS_IP:-192.168.2.11}"
TLS_DAYS="${TLS_DAYS:-825}"
CERT_FILE="$TLS_DIR/server.crt"
KEY_FILE="$TLS_DIR/server.key"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "未找到 openssl，请先安装 openssl"
[[ "$TLS_IP" =~ ^[0-9.]+$ ]] || die "TLS_IP 必须是 IPv4 地址：$TLS_IP"
[[ "$TLS_DAYS" =~ ^[0-9]+$ ]] || die "TLS_DAYS 必须是正整数：$TLS_DAYS"

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

if [[ -s "$CERT_FILE" && -s "$KEY_FILE" && "${FORCE_REGENERATE:-false}" != "true" ]]; then
  printf '证书已存在，跳过生成：%s\n' "$TLS_DIR"
  exit 0
fi

umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -days "$TLS_DAYS" \
  -subj "/CN=$TLS_IP" \
  -addext "subjectAltName=IP:$TLS_IP,IP:127.0.0.1,DNS:localhost"

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"
printf '已生成自签名证书：%s\n' "$CERT_FILE"
printf '私钥已生成：%s\n' "$KEY_FILE"
