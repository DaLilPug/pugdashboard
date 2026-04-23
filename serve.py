import http.server, os

ROOT = r'C:\Users\austi\Documents\pugdashboard'

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path = self.path.split('?')[0].lstrip('/')
        full = os.path.join(ROOT, path) if path else ROOT
        if os.path.exists(full):
            return super().do_GET()
        self.path = '/404.html'
        return super().do_GET()

    def log_message(self, fmt, *args): pass

print("Serving at http://localhost:8080")
http.server.HTTPServer(('', 8080), Handler).serve_forever()
