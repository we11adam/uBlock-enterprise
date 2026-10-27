#!/usr/bin/env bash
#
# Chromium MV3 enterprise build: uBO's network filtering engine (webRequest,
# webRequestBlocking) in a MV3 service worker, for installation through
# enterprise policy only. See platform/chromium-enterprise/README.md.
#
# Usage: tools/make-chromium-enterprise.sh
#
# Environment (all optional):
#   UBO_ENT_VERSION     Extension version, default: content of dist/version
#   UBO_ENT_UPDATE_URL  `update_url` in the manifest (HTTPS update manifest)
#   UBO_ENT_PUBLIC_KEY  `key` in the manifest: base64 DER SubjectPublicKeyInfo
#                       of the production signing key, so that unpacked
#                       builds have the same extension ID as the CRX

set -e

echo "*** uBlock0.chromium-enterprise: Creating package"

DES=dist/build/uBlock0.chromium-enterprise
rm -rf $DES
mkdir -p $DES

echo "*** uBlock0.chromium-enterprise: Copying common files"
bash ./tools/copy-common-files.sh $DES

echo "*** uBlock0.chromium-enterprise: Copying chromium-specific files"
cp platform/chromium/*.js $DES/js/
# The enterprise vapi-background-ext.js extends the chromium one
mv $DES/js/vapi-background-ext.js $DES/js/vapi-background-ext-chromium.js
# MV2-only: background page, WebRTC detection page
rm -f $DES/background.html
rm -f $DES/js/is-webrtc-supported.js

echo "*** uBlock0.chromium-enterprise: Copying enterprise-specific files"
for f in platform/chromium-enterprise/*.js; do
    case "$(basename "$f")" in
        sw.js) cp "$f" $DES/ ;;
        *) cp "$f" $DES/js/ ;;
    esac
done
cp platform/chromium-enterprise/*.html $DES/
cp platform/chromium-enterprise/manifest.json $DES/

# Chrome store-specific
cp -R $DES/_locales/nb $DES/_locales/no


echo "*** uBlock0.chromium-enterprise: Generating meta"
python3 tools/enterprise/make-chromium-enterprise-meta.py $DES

echo "*** uBlock0.chromium-enterprise: Checking service worker module graph"
node tools/enterprise/check-sw-graph.mjs $DES

echo "*** uBlock0.chromium-enterprise: Package done."
