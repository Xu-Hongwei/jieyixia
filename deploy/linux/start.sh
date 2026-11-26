#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
target=${1:-}
if [[ $# -ne 1 ]] || [[ "$target" != local && ! "$target" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
  echo '用法：sudo bash start.sh local 或 sudo bash start.sh 你的域名' >&2
  exit 2
fi
docker compose version >/dev/null
docker info >/dev/null
umask 077
exec 9>.deploy.lock
flock -n 9 || { echo '另一个部署正在运行。' >&2; exit 1; }
if [[ -f .env ]]; then
  grep -Fxq '# Managed by jiexialai start.sh' .env || { echo '发现已有 .env，请在独立部署目录运行。' >&2; exit 1; }
  token=$(sed -n 's/^JXL_API_TOKEN=//p' .env)
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || { echo '部署令牌格式异常，请检查 .env。' >&2; exit 1; }
else
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
fi
if [[ "$target" == local ]]; then
  site=:80
  http=127.0.0.1:18080
  https=127.0.0.1:18443
else
  site=$target
  http=0.0.0.0:80
  https=0.0.0.0:443
fi
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
printf '%s\n' '# Managed by jiexialai start.sh' "JXL_SITE=$site" "HTTP_BIND=$http" "HTTPS_BIND=$https" "JXL_API_TOKEN=$token" > "$tmp"
docker compose --env-file "$tmp" config --quiet
mv -f -- "$tmp" .env
docker compose up -d --build --wait
docker compose ps
if [[ "$target" == local ]]; then
  curl -fsS --max-time 10 http://127.0.0.1:18080/api/healthz
  printf '\n服务器本机入口 http://127.0.0.1:18080/\n'
else
  printf '公网入口 https://%s/ ，首次签发证书可能需要稍等片刻。\n' "$target"
fi
