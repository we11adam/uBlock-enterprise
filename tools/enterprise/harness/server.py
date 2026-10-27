#!/usr/bin/env python3
"""
Local, controllable test web server for the enterprise MV3 harness.

- Serves the update manifest and CRX from --dist (the "update host").
- Serves test sites from --sites/<hostname>/... based on the Host header,
  so site-a.test, site-b.test, cdn.test, etc. (mapped to 127.0.0.1 in
  /etc/hosts) behave as distinct first-/third-party origins.
- Every request is recorded; GET /__hits returns them as JSON and
  GET /__reset clears them. This is the ground truth for "did the request
  reach the network?".
- /probe/* endpoints return small text bodies; /probe/headers sets
  X-Probe-Remove so header modification can be checked.
"""

import argparse
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HITS = []
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype='text/plain; charset=utf-8', headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', '*')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts = urlsplit(self.path)
        host = (self.headers.get('Host') or '').split(':')[0]
        if parts.path == '/__hits':
            with LOCK:
                return self._send(200, json.dumps(HITS), 'application/json')
        if parts.path == '/__reset':
            with LOCK:
                HITS.clear()
            return self._send(200, 'ok')
        with LOCK:
            HITS.append({
                't': time.time(),
                'host': host,
                'path': parts.path,
                'query': parts.query,
                'referer': self.headers.get('Referer', ''),
                'ua': self.headers.get('User-Agent', ''),
            })
        if parts.path.startswith('/probe/'):
            headers = {}
            if parts.path.startswith('/probe/headers'):
                headers['X-Probe-Remove'] = 'present'
            return self._send(200, f'probe:{parts.path}', headers=headers)
        if host in ('update.test', 'localhost', '127.0.0.1'):
            root = self.server.dist_root
        else:
            root = os.path.join(self.server.sites_root, host)
        rel = parts.path.lstrip('/') or 'index.html'
        if rel.endswith('/'):
            rel += 'index.html'
        fpath = os.path.realpath(os.path.join(root, rel))
        if not fpath.startswith(os.path.realpath(root) + os.sep) or not os.path.isfile(fpath):
            return self._send(404, 'not found')
        ctype = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
        if fpath.endswith('.crx'):
            ctype = 'application/x-chrome-extension'
        elif fpath.endswith('.xml'):
            ctype = 'text/xml'
        elif fpath.endswith('.html'):
            ctype = 'text/html; charset=utf-8'
        elif fpath.endswith('.js'):
            ctype = 'text/javascript; charset=utf-8'
        with open(fpath, 'rb') as f:
            body = f.read()
        extra = {}
        csp_path = fpath + '.csp'
        if os.path.isfile(csp_path):
            with open(csp_path) as f:
                extra['Content-Security-Policy'] = f.read().strip()
        return self._send(200, body, ctype, extra)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=80)
    ap.add_argument('--dist', required=True)
    ap.add_argument('--sites', required=True)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(('0.0.0.0', args.port), Handler)
    srv.dist_root = args.dist
    srv.sites_root = args.sites
    srv.serve_forever()


if __name__ == '__main__':
    main()
