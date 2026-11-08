# -*- coding: utf-8 -*-
"""画板的小服务：给网页用。

  GET  /            网页
  GET  /state       现在的笔画（json）
  POST /stroke      加一笔 {"stroke": {...}}
  POST /undo        撤一笔
  POST /clear       清空
  GET  /png         出好的图（board.png）
  GET  /refs        可当参考图的列表
  GET  /ref/<name>  参考图

只在本机 127.0.0.1 上跑，不对外。
"""
import json
import mimetypes
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import board as B

HERE = os.path.dirname(os.path.abspath(__file__))
# 参考图目录：重装后用户目录变了，别再写死。优先环境变量，其次当前用户的家目录，
# 最后才退到旧的 ygys1（只为了让老机器上还能跑）。
REF_DIR = os.environ.get('PAINT_REF_DIR') or os.path.join(
    os.path.expanduser('~'), 'Pictures', 'dsh-stickers')
if not os.path.isdir(REF_DIR):
    _legacy = r'C:\Users\ygys1\Pictures\dsh-stickers'  # check-paths:allow 旧机器兜底，只为兼容
    if os.path.isdir(_legacy):
        REF_DIR = _legacy
PORT = int(os.environ.get('PAINT_PORT', '8777'))


class Handler(BaseHTTPRequestHandler):
    server_version = 'paintboard/1.0'

    def log_message(self, fmt, *args):  # 安静点
        pass

    def _send(self, code, body=b'', ctype='application/json; charset=utf-8'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data, ensure_ascii=False), 'application/json; charset=utf-8')

    def _read_body(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode('utf-8', 'replace') or '{}')
        except Exception:
            return {}

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ('/', '/index.html'):
            with open(os.path.join(HERE, 'index.html'), 'rb') as f:
                return self._send(200, f.read(), 'text/html; charset=utf-8')
        if path == '/state':
            return self._json(B.load())
        if path == '/png':
            B.render()
            with open(B.PNG, 'rb') as f:
                return self._send(200, f.read(), 'image/png')
        if path == '/ref/current':
            cur = {}
            try:
                cur = json.load(open(os.path.join(HERE, 'ref.json'), encoding='utf-8'))
            except Exception:
                cur = {}
            return self._json(cur)
        if path == '/refs':
            items = []
            if os.path.isdir(REF_DIR):
                for name in sorted(os.listdir(REF_DIR)):
                    if os.path.splitext(name)[1].lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
                        items.append('/ref/' + urllib.parse.quote(name))
            return self._json({'items': items})
        if path.startswith('/ref/'):
            name = urllib.parse.unquote(path[5:])
            if '/' in name or '\\' in name or name.startswith('.'):
                return self._json({'error': 'bad name'}, 400)
            full = os.path.join(REF_DIR, name)
            if not os.path.isfile(full):
                return self._json({'error': 'missing'}, 404)
            ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
            with open(full, 'rb') as f:
                return self._send(200, f.read(), ctype)
        return self._json({'error': 'not found'}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/stroke':
            data = self._read_body()
            stroke = data.get('stroke')
            if not isinstance(stroke, dict) or not stroke.get('pts'):
                return self._json({'error': 'bad stroke'}, 400)
            state = B.load()
            state['strokes'].append(stroke)
            B.save(state)
            B.render(state)
            return self._json({'count': len(state['strokes'])})
        if path == '/ref':
            data = self._read_body()
            src = str(data.get('src') or '')
            with open(os.path.join(HERE, 'ref.json'), 'w', encoding='utf-8') as f:
                json.dump({'src': src}, f)
            return self._json({'src': src})
        if path == '/undo':
            state = B.load()
            if state['strokes']:
                state['strokes'].pop()
                B.save(state)
                B.render(state)
            return self._json({'count': len(state['strokes'])})
        if path == '/clear':
            state = B.load()
            state['strokes'] = []
            B.save(state)
            B.render(state)
            return self._json({'count': 0})
        return self._json({'error': 'not found'}, 404)


def main():
    os.chdir(HERE)
    if not os.path.exists(B.STATE):
        B.save(B.blank())
        B.render()
    httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('画板在 http://127.0.0.1:%d' % PORT, flush=True)
    httpd.serve_forever()


if __name__ == '__main__':
    main()

