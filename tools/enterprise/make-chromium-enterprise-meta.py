#!/usr/bin/env python3

# Chromium MV3 enterprise build: finalizes manifest.json.

import json
import os
import re
import sys

if len(sys.argv) == 1 or not sys.argv[1]:
    raise SystemExit('Build dir missing.')

proj_dir = os.path.join(os.path.split(os.path.abspath(__file__))[0], '..', '..')
build_dir = os.path.abspath(sys.argv[1])

# The upstream version, as uBO understands it: 3 components for a release,
# 4 components for a beta/release candidate (uBO then behaves as a dev build).
with open(os.path.join(proj_dir, 'dist', 'version')) as f:
    upstream_version = f.read().strip()

# Production versions track upstream exactly. Only the isolated upgrade test
# harness may synthesize a second version without changing dist/version.
requested_version = os.environ.get('UBO_ENT_VERSION', '').strip()
if requested_version and requested_version != upstream_version:
    raise SystemExit('UBO_ENT_VERSION must equal dist/version; enterprise revisions are no longer supported')
version = os.environ.get('UBO_ENT_TEST_VERSION', '').strip() or upstream_version
# Chrome: 1 to 4 dot-separated integers, each 0-65535, no leading zero
if not re.fullmatch(r'(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}', version) or \
   any(int(p) > 65535 for p in version.split('.')):
    raise SystemExit(f'Invalid extension version: {version}')

manifest_file = os.path.join(build_dir, 'manifest.json')
with open(manifest_file) as f:
    manifest = json.load(f)

manifest['version'] = version
# uBO reads `version_name` first (vAPI.app.version, dev build detection)
manifest['version_name'] = f'{version}-ent'
if re.fullmatch(r'\d+\.\d+\.\d+\.\d+', upstream_version):
    manifest['name'] += ' development build'
    manifest['short_name'] += ' dev build'
    manifest['action']['default_title'] += ' dev build'

update_url = os.environ.get('UBO_ENT_UPDATE_URL', '').strip()
if update_url:
    if not update_url.startswith('https://'):
        raise SystemExit('UBO_ENT_UPDATE_URL must be an https:// URL')
    manifest['update_url'] = update_url
else:
    print('*** warning: UBO_ENT_UPDATE_URL not set, no update_url in manifest '
          '(the ExtensionSettings policy must then set override_update_url)')

public_key = os.environ.get('UBO_ENT_PUBLIC_KEY', '').strip()
if public_key:
    if not re.fullmatch(r'[A-Za-z0-9+/]+=*', public_key):
        raise SystemExit('UBO_ENT_PUBLIC_KEY must be base64 (DER SubjectPublicKeyInfo)')
    manifest['key'] = public_key

with open(manifest_file, 'w') as f:
    json.dump(manifest, f, indent=2, separators=(',', ': '), sort_keys=True)
    f.write('\n')
