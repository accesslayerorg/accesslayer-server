#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/chaos/docker-compose.chaos.yml"
TOXI=http://localhost:8474
ARTIFACTS=${ARTIFACTS:-$ROOT/chaos/artifacts}
mkdir -p "$ARTIFACTS"

wait_toxi() {
  for i in {1..60}; do curl -fsS "$TOXI/version" >/dev/null && return 0; sleep 1; done
  echo "toxiproxy not ready" >&2; exit 1
}

create_proxies() {
  for p in postgres redis soroban-rpc; do
    curl -fsS -XDELETE "$TOXI/proxies/$p" >/dev/null || true
  done
  curl -fsS -XPOST "$TOXI/proxies" -d '{"name":"postgres","listen":"0.0.0.0:15432","upstream":"postgres:5432","enabled":true}' >/dev/null
  curl -fsS -XPOST "$TOXI/proxies" -d '{"name":"redis","listen":"0.0.0.0:16379","upstream":"redis:6379","enabled":true}' >/dev/null
  curl -fsS -XPOST "$TOXI/proxies" -d '{"name":"soroban-rpc","listen":"0.0.0.0:18081","upstream":"mock-soroban-rpc:8080","enabled":true}' >/dev/null
}

add_toxic() {
  local proxy=$1 name=$2 type=$3 attrs=$4
  curl -fsS -XPOST "$TOXI/proxies/$proxy/toxics" -d "{\"name\":\"$name\",\"type\":\"$type\",\"attributes\":$attrs}" >/dev/null
}
rm_toxic() {
  local proxy=$1 name=$2
  curl -fsS -XDELETE "$TOXI/proxies/$proxy/toxics/$name" >/dev/null || true
}

capture_artifacts() {
  curl -fsS "$TOXI/proxies" > "$ARTIFACTS/toxiproxy.json" || true
  $COMPOSE logs --no-color > "$ARTIFACTS/compose.log" || true
}

trap capture_artifacts EXIT

$COMPOSE up -d --build
wait_toxi
create_proxies

echo "== RPC outage 60s =="
add_toxic soroban-rpc rpc-timeout timeout '{"timeout":60000}'
node "$ROOT/chaos/scenarios/rpc-outage.mjs" || { echo "rpc outage scenario failed"; exit 1; }
rm_toxic soroban-rpc rpc-timeout

echo "== DB disconnect =="
add_toxic postgres db-reset reset_peer '{"timeout":1000}'
node "$ROOT/chaos/scenarios/db-disconnect.mjs" || { echo "db disconnect scenario failed"; exit 1; }
rm_toxic postgres db-reset

echo "== Redis outage =="
add_toxic redis redis-timeout timeout '{"timeout":15000}'
node "$ROOT/chaos/scenarios/redis-outage.mjs" || { echo "redis outage scenario failed"; exit 1; }
rm_toxic redis redis-timeout

capture_artifacts
echo "CHAOS_OK" > "$ARTIFACTS/summary.txt"
