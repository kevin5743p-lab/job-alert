#!/usr/bin/env python3
"""docx2pdf — a local converter so tailored CVs can go out as PDFs.

WHY THIS EXISTS
---------------
The extension edits your own Word CV in place, which is the only way to keep
your layout, your fonts and your page count exactly as you designed them. But
most application forms want a PDF, and nothing inside a browser can turn a
.docx into a PDF without re-rendering it through HTML — which throws away the
layout we just went to all that trouble to preserve.

LibreOffice can do it properly, because it is a real word processor that reads
Word documents natively. This script is a thin bridge: the extension POSTs a
.docx to 127.0.0.1:8765 and gets back a PDF that LibreOffice rendered.

It is entirely optional. If this isn't running, the extension attaches the
Word file instead, which every major ATS accepts.

NOTHING LEAVES YOUR MACHINE
---------------------------
Binds to 127.0.0.1 only, so it is not reachable from your network. Your CV is
written to a temporary folder that is deleted immediately after each
conversion. There is no logging of document contents and no network access of
any kind.

SETUP
-----
    1. Install LibreOffice (free):  https://www.libreoffice.org/download
       or, with Homebrew:           brew install --cask libreoffice
    2. Run this script:             python3 tools/docx2pdf.py
    3. Leave it running while you apply.

To start it automatically at login on a Mac, see the launchd plist printed by:
    python3 tools/docx2pdf.py --install-help
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765
MAX_BYTES = 25 * 1024 * 1024        # a CV is well under this; a bomb is not
CONVERT_TIMEOUT = 60

# The extension's origin. Chrome sends it on the preflight and on the POST, and
# the browser refuses to hand the response back without a matching header.
# Extension ids differ per install, so any chrome-extension:// origin is
# accepted — the listener is on loopback and the risk this guards against
# (a website on the open internet reading your CV) is covered by that.
ALLOWED_ORIGIN_PREFIX = "chrome-extension://"


def find_soffice():
    """Locate LibreOffice, including the places macOS hides it."""
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    for guess in (
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/opt/homebrew/bin/soffice",
        "/usr/local/bin/soffice",
        "/usr/bin/soffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
    ):
        if os.path.exists(guess):
            return guess
    return None


SOFFICE = find_soffice()


def convert(docx_bytes):
    """.docx bytes -> PDF bytes. Raises RuntimeError with something readable."""
    if not SOFFICE:
        raise RuntimeError(
            "LibreOffice not found. Install it from libreoffice.org, or with "
            "'brew install --cask libreoffice'.")

    # A fresh directory per conversion. LibreOffice writes the PDF next to the
    # input, and a shared directory would let two concurrent conversions
    # collide on the output name.
    workdir = tempfile.mkdtemp(prefix="jobcopilot-")
    try:
        src = os.path.join(workdir, "cv.docx")
        with open(src, "wb") as fh:
            fh.write(docx_bytes)

        # -env:UserInstallation gives this run its own profile directory.
        # Without it, LibreOffice refuses to start headless whenever the user
        # already has the GUI open — which, on the machine of someone who keeps
        # their CV in Word, is often.
        result = subprocess.run(
            [SOFFICE,
             f"-env:UserInstallation=file://{workdir}/profile",
             "--headless", "--norestore", "--invisible",
             "--convert-to", "pdf:writer_pdf_Export",
             "--outdir", workdir, src],
            capture_output=True, timeout=CONVERT_TIMEOUT)

        pdf = os.path.join(workdir, "cv.pdf")
        if not os.path.exists(pdf):
            detail = (result.stderr or result.stdout or b"").decode(
                "utf-8", "replace").strip()
            raise RuntimeError(f"LibreOffice produced no PDF. {detail}")

        with open(pdf, "rb") as fh:
            return fh.read()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith(ALLOWED_ORIGIN_PREFIX):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if self.path != "/health":
            self._send(404, b"not found")
            return
        self._send(200, b"ok" if SOFFICE else b"no-libreoffice")

    def do_POST(self):
        if self.path != "/convert":
            self._send(404, b"not found")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            self._send(413, b"bad or oversized body")
            return

        try:
            pdf = convert(self.rfile.read(length))
        except subprocess.TimeoutExpired:
            self._send(504, b"LibreOffice timed out")
        except Exception as exc:                       # noqa: BLE001
            self._send(500, str(exc).encode("utf-8", "replace"))
        else:
            self._send(200, pdf, "application/pdf")

    def log_message(self, fmt, *args):
        # One line per request, and never the body. This process handles CVs.
        sys.stderr.write("docx2pdf: %s\n" % (fmt % args))


PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jobcopilot.docx2pdf</string>
  <key>ProgramArguments</key>
  <array><string>{python}</string><string>{script}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>"""


def install_help():
    path = os.path.abspath(__file__)
    print(__doc__)
    print("Save this as ~/Library/LaunchAgents/com.jobcopilot.docx2pdf.plist:\n")
    print(PLIST.format(python=sys.executable, script=path))
    print("\nThen run:")
    print("  launchctl load ~/Library/LaunchAgents/com.jobcopilot.docx2pdf.plist")


def main():
    parser = argparse.ArgumentParser(description="Local .docx to PDF converter.")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--install-help", action="store_true",
                        help="print launchd setup for starting this at login")
    args = parser.parse_args()

    if args.install_help:
        install_help()
        return

    if not SOFFICE:
        print("LibreOffice was not found on this machine.", file=sys.stderr)
        print("Install it from https://www.libreoffice.org/download or run:",
              file=sys.stderr)
        print("  brew install --cask libreoffice", file=sys.stderr)
        print("\nStarting anyway — /health will report 'no-libreoffice' and the "
              "extension will keep attaching .docx files.", file=sys.stderr)
    else:
        print(f"Using LibreOffice at {SOFFICE}")

    server = ThreadingHTTPServer((HOST, args.port), Handler)
    print(f"Converting .docx to PDF on http://{HOST}:{args.port} — Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
