#!/bin/sh
# tini forwards shutdown to the shared supervisor; it owns all child services.
set -eu
export ADMIN_PORT="${ADMIN_PORT:-3007}"
export FARM_DATA_DIR="${FARM_DATA_DIR:-/app/core/data}"
export YYB_EXECUTABLE="${YYB_EXECUTABLE:-/usr/local/bin/yyb-go}"
export YYB_RESOURCE_ROOT="${YYB_RESOURCE_ROOT:-/usr/local/share/yyb-go/resource}"
# Allocate a fresh display via Xvfb -displayfd; no stale :99 socket on restart.
unset DISPLAY
exec node /app/scripts/farm.cjs serve
