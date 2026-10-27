#!/bin/bash
# Host-side launcher for the policy-install test container.
# Usage: tools/enterprise/harness/run.sh <dist-dir> <sites-dir> <ext-id> <test-script> [docker args...]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dist="$(cd "$1" && pwd)"; sites="$(cd "$2" && pwd)"; id="$3"; test="$4"; shift 4
exec docker run --rm --platform linux/amd64 \
  --security-opt seccomp=unconfined \
  -e EXT_ID="$id" -e UPDATE_URL="${UPDATE_URL:-http://update.test/update.xml}" \
  -e TEST="$test" -e POLICY_EXTRA="${POLICY_EXTRA:-}" -e CHROME_EXTRA_ARGS="${CHROME_EXTRA_ARGS:-}" \
  -e EXPR -e DELAY -e TEST_FILTER \
  -v "$here":/harness:ro -v "$dist":/dist -v "$sites":/sites:ro \
  "$@" ${IMAGE:-ubo-mv3-chrome:local} /harness/container-entry.sh
