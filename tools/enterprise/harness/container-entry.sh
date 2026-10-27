#!/bin/bash
# Runs inside the test container. Installs the extension through genuine
# Linux managed policy (/etc/opt/chrome/policies/managed), then runs a test
# script against the real Chrome through CDP.
#
# Env: EXT_ID, UPDATE_URL (update manifest URL), TEST (script under /harness),
#      POLICY_EXTRA (optional JSON object merged into the policy file)
set -euo pipefail

cat >> /etc/hosts <<HOSTS
127.0.0.1 update.test site-a.test site-b.test cdn.test ads.test tracker.test
HOSTS

mkdir -p /etc/opt/chrome/policies/managed
node -e '
const id = process.env.EXT_ID, url = process.env.UPDATE_URL;
const policy = {
  ExtensionInstallForcelist: [ `${id};${url}` ],
  ExtensionSettings: { [id]: { installation_mode: "force_installed", update_url: url, override_update_url: true } },
  ...JSON.parse(process.env.POLICY_EXTRA || "{}"),
};
require("fs").writeFileSync("/etc/opt/chrome/policies/managed/ubo-enterprise-test.json", JSON.stringify(policy, null, 2));
'
echo "== policy"; cat /etc/opt/chrome/policies/managed/ubo-enterprise-test.json

python3 /harness/server.py --port 80 --dist /dist --sites /sites &
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99

id chrome >/dev/null 2>&1 || useradd -m chrome
PROFILE=/home/chrome/profile
mkdir -p "$PROFILE" && chown -R chrome "$PROFILE"
sleep 1

start_chrome() {
  su chrome -s /bin/bash -c "DISPLAY=:99 google-chrome \
    --user-data-dir=$PROFILE --remote-debugging-port=9222 \
    --no-first-run --no-default-browser-check \
    ${CHROME_EXTRA_ARGS:-} about:blank >/tmp/chrome.log 2>&1 &"
}
export -f start_chrome
export PROFILE

start_chrome
set +e
node "/harness/${TEST}"
rc=$?
set -e
if [ "$rc" != "0" ]; then echo "== chrome.log (tail)"; tail -40 /tmp/chrome.log; fi
pkill -f google-chrome || true
exit $rc
