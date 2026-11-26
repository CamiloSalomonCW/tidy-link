#!/usr/bin/env python3
"""Run DOM/clipboard-payload checks in headless Edge, using only Python's stdlib."""
import functools
import html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/acme/repo/pull/"):
            self.path = "/tests/browser.html"
        super().do_GET()

    def log_message(self, *_):
        pass


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    assert manifest["manifest_version"] == 3
    assert manifest["permissions"] == ["clipboardWrite", "scripting"]
    assert manifest["content_scripts"][0]["matches"] == ["https://github.com/*"]
    assert manifest["optional_host_permissions"] == ["https://*/*"]
    for script in manifest["content_scripts"][0]["js"]:
        assert (ROOT / script).is_file()

    browser = os.environ.get("EDGE_BINARY") or shutil.which("microsoft-edge") or "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    if not Path(browser).is_file():
        raise SystemExit("Set EDGE_BINARY to your Edge/Chromium executable.")
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="pr-title-link-test-") as profile:
            result = subprocess.run([
                browser, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", f"--user-data-dir={profile}",
                "--dump-dom", "--virtual-time-budget=9000",
                f"http://127.0.0.1:{server.server_port}/acme/repo/pull/42/files?tab=files#diff",
            ], capture_output=True, text=True, timeout=30, check=True)
        output = re.search(r'<pre id="result">(.*?)</pre>', result.stdout, re.DOTALL)
        if not output:
            raise SystemExit(f"Browser did not return test results.\n{result.stderr[-3000:]}")
        message = html.unescape(output.group(1))
        print(message)
        if not message.startswith("PASS:"):
            raise SystemExit(1)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
