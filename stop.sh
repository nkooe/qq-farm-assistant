#!/usr/bin/env bash
set -Eeuo pipefail
FARM_PROJECT_ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
FARM_NODE_BIN="$FARM_PROJECT_ROOT/runtime/node"
if [[ ! -x "$FARM_NODE_BIN" ]]; then FARM_NODE_BIN=node; fi
exec "$FARM_NODE_BIN" "$FARM_PROJECT_ROOT/scripts/farm.cjs" stop
