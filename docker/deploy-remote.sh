#!/usr/bin/env bash
# app41 测试机部署（GitHub Actions 经受限 SSH 密钥调用；强制命令，密钥只能触发本脚本）。
# 本文件是版本化副本——线上生效的是测试机 /opt/apps/app41/deploy.sh，改动两处同步。
# 退出码：0 = pull+up+冒烟全过；非 0 = pull 三败或冒烟 45 秒未就绪（CI 因此红）。
set -uo pipefail
cd /opt/apps/app41
ok=0
for i in 1 2 3; do
  if docker compose pull; then ok=1; break; fi
  echo "pull 失败,第 $i 次重试"; sleep 8
done
[ "$ok" = 1 ] || { echo "ACR pull 三次均失败"; exit 1; }
docker compose up -d
for i in $(seq 15); do
  C=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18083/ || true)
  case "$C" in 200|302|401) echo "app41 就绪($C,第 $i 轮)"; exit 0;; esac
  sleep 3
done
echo "app41 未就绪"; docker logs app41 --tail 20; exit 1
