#!/usr/bin/env python3
"""Register a saved report and verify its entry in the local Cockpit library."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--title", default="")
    parser.add_argument("--session", default=os.environ.get("COCKPIT_TERM_ID", ""))
    args = parser.parse_args()
    base = os.environ.get("COCKPIT_URL") or "http://127.0.0.1:" + os.environ.get("COCKPIT_PORT", "3847")
    url = urllib.parse.urlsplit(base)
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1") or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("보고서는 로컬 Cockpit 서버에만 등록할 수 있습니다.")
    endpoint = base.rstrip("/") + "/api/reports"
    # Do not send file metadata through proxy settings or follow a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(body=None):
        req = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with opener.open(req, timeout=5) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                detail = json.load(error).get("error", "HTTP " + str(error.code))
            except (ValueError, AttributeError):
                detail = "HTTP " + str(error.code)
            raise RuntimeError(detail) from error

    body = json.dumps(vars(args), ensure_ascii=False).encode("utf-8")
    saved = request(body)["report"]
    try:
        rows = request()["reports"]
        if not any(row.get("id") == saved["id"] and row.get("path") == saved["path"] for row in rows):
            raise RuntimeError("저장된 보고서를 목록에서 확인하지 못했습니다.")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(json.dumps({"ok": False, "registered": True, "report": saved, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "registered": True, "report": saved}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
