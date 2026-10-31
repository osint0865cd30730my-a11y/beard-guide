# Локальний сервер для розробки (без кешування). Запуск: python3 serve.py
import http.server, functools, os
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(('0.0.0.0', 8765), H).serve_forever()
