"""Static server for local development.

    python ops/web_serve.py              # 127.0.0.1 only
    python ops/web_serve.py --lan        # also other devices on the network

Exists instead of `python -m http.server` for one reason: **no caching**.
`SimpleHTTPRequestHandler` sends no `Cache-Control`, so browsers fall back to
heuristic caching and happily keep an ES module for hours. The failure that
causes is nasty because it does not look like caching - you get a *mixture* of
old and new modules, and the error surfaces somewhere unrelated ("Cannot read
properties of undefined") in a file that is perfectly correct on disk.

Port 8899 matches the OAuth client's authorised origin, so the Google sign-in
flow works locally. Use `?dev=1` to skip Google entirely and read dev-data.xlsx.

WARNING: --lan serves dev-data.xlsx - your real account data - to anybody who
can reach this machine. It also usually needs a firewall rule:

    New-NetFirewallRule -DisplayName "AssetWeb dev 8899" -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort 8899 -Profile Any   # 需系統管理員
    Remove-NetFirewallRule -DisplayName "AssetWeb dev 8899"        # 看完收掉
"""

from __future__ import annotations

import argparse
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):        # one line per request, no noise
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def local_addresses() -> list[str]:
    """Every IPv4 this machine answers on, so a phone can be pointed at one."""
    out = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if addr not in out and not addr.startswith("127."):
                out.append(addr)
    except OSError:
        pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--lan", action="store_true",
                    help="bind 0.0.0.0 so phones on the same network can load it")
    args = ap.parse_args()

    if not (ROOT / "dev-data.xlsx").exists():
        print("[!] 沒有 dev-data.xlsx，?dev=1 會失敗。")
        print(r'    copy "<你的 Drive 同步資料夾>\AssetSync.xlsx" dev-data.xlsx' + "\n")

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    handler = partial(NoCacheHandler, directory=str(ROOT))
    server = ThreadingHTTPServer((host, args.port), handler)

    print(f"服務 {ROOT}")
    print(f"  本機      http://127.0.0.1:{args.port}/index.html")
    print(f"  離線      http://127.0.0.1:{args.port}/index.html?dev=1")
    print(f"  自我測試  http://127.0.0.1:{args.port}/index.html?dev=1&selftest=1")
    if args.lan:
        for addr in local_addresses():
            print(f"  區網      http://{addr}:{args.port}/index.html?dev=1")
        print("  （連不進來就是防火牆擋著，指令見本檔開頭的說明）")
    print("Ctrl+C 結束")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
