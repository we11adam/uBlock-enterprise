#!/usr/bin/env bash
#
# Builds two versions of the Chromium MV3 enterprise build, packs them as
# CRX3 with a TEST key, and runs test-ubo.mjs in the policy-install container
# (genuine Linux managed policy, real Google Chrome, local update host).
#
# Usage: tools/enterprise/harness/run-ubo-tests.sh <test-key.pem> [work-dir]
#
# The test key must live outside the repository. The extension ID derived from
# it is a test ID, not the production ID.
#
# Env: TEST_FILTER (regex of test phases to run), SKIP_BUILD=1,
#      TEST_SCRIPT (default: test-ubo.mjs)

set -euo pipefail

key="${1:?usage: run-ubo-tests.sh <test-key.pem> [work-dir]}"
work="${2:-$(mktemp -d /tmp/ubo-ent-test.XXXXXX)}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
build="$repo/dist/build/uBlock0.chromium-enterprise"

cd "$repo"
mkdir -p "$work"

v1="$(cat dist/version)"
IFS=. read -r -a parts <<< "$v1"
if [ "${#parts[@]}" -eq 3 ]; then
    v2="$v1.1"
else
    v2="${parts[0]}.${parts[1]}.${parts[2]}.$((parts[3] + 1))"
fi

id="$(node tools/enterprise/crx3.mjs id --key "$key")"
echo "*** test extension ID: $id (test key -- not the production ID)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
    UBO_ENT_VERSION="$v2" tools/make-chromium-enterprise.sh
    node tools/enterprise/crx3.mjs pack --dir "$build" --key "$key" --out "$work/ubo-v2.crx"
    UBO_ENT_VERSION="$v1" tools/make-chromium-enterprise.sh
    node tools/enterprise/crx3.mjs pack --dir "$build" --key "$key" --out "$work/ubo.crx"
fi

node tools/enterprise/update-xml.mjs --id "$id" --version "$v1" \
    --codebase http://update.test/ubo.crx --out "$work/update.xml"
node tools/enterprise/update-xml.mjs --id "$id" --version "$v2" \
    --codebase http://update.test/ubo-v2.crx --out "$work/update-v2.xml"
printf '{ "v1": "%s", "v2": "%s" }\n' "$v1" "$v2" > "$work/test-config.json"

# DevTools access to the force-installed extension is needed by the test
# driver only. Test filters are provided through the extension's managed
# storage policy, as an administrator would.
POLICY_EXTRA="$(node -e '
const [ id, filtersFile ] = process.argv.slice(1);
const filters = JSON.parse(require("fs").readFileSync(filtersFile, "utf8"));
console.log(JSON.stringify({
    DeveloperToolsAvailability: 1,
    "3rdparty": { extensions: { [id]: { toOverwrite: { filters } } } },
}));
' "$id" "$here/test-ubo-filters.json")"
export POLICY_EXTRA

echo "*** work dir: $work"
exec "$here/run.sh" "$work" "$here/sites" "$id" "${TEST_SCRIPT:-test-ubo.mjs}"
