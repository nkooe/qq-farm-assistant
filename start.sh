#!/usr/bin/env bash
set -Eeuo pipefail
FARM_PROJECT_ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ -x "$FARM_PROJECT_ROOT/runtime/node" ]]; then
  exec "$FARM_PROJECT_ROOT/runtime/node" "$FARM_PROJECT_ROOT/scripts/farm.cjs" serve
fi
exec node "$FARM_PROJECT_ROOT/scripts/farm.cjs" serve
