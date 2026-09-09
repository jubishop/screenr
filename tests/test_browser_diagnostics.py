import json
from pathlib import Path
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]


class BrowserDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.requests = []

    def server(self, response, delay=0):
        requests = self.requests

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                requests.append(self.request.recv(8192).decode())
                if delay:
                    time.sleep(delay)
                try:
                    self.request.sendall(response)
                except OSError:
                    pass  # A size- or time-bounded probe may have closed.

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def failure(self, port, path="/_next/static/chunks/broken.js", **overrides):
        return {"type": "resource-snapshot", "snapshot": {
            "request": {"url": f"http://localhost:{port}{path}", "method": "GET", **overrides},
            "response": {"status": 0, "_failureText": "net::ERR_INVALID_HTTP_RESPONSE",
                         "headers": [{"name": "Set-Cookie", "value": "private-session"}]},
        }}

    def run_report(self, events, proxy, upstream, trace=None):
        if trace is None:
            trace = Path(self.directory.name) / "trace.zip"
            with zipfile.ZipFile(trace, "w") as archive:
                archive.writestr("0.network", "\n".join(json.dumps(event) for event in events))
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/browser-diagnostics.py")],
            input=json.dumps({"traces": [str(trace)], "proxyPort": proxy, "appPort": upstream}),
            capture_output=True, text=True, timeout=8, check=True,
        )
        return json.loads(result.stdout)

    def test_filters_requests_and_excludes_credentials_from_reports_and_probes(self):
        port = self.server(b"HTTP/1.1 200 OK\r\nSet-Cookie: private-session\r\nContent-Length: 2\r\n\r\nok")
        good = self.failure(port, "/_next/static/chunks/%5Bturbopack%5D.js?token=private-query")
        aborted = self.failure(port)
        aborted["snapshot"]["response"]["_failureText"] = "net::ERR_ABORTED"
        success = self.failure(port)
        success["snapshot"]["response"] = {"status": 200}
        events = [
            self.failure(port, method="POST"), self.failure(port, "/api/auth/session.js"),
            self.failure(port, "/_next/static/%2e%2e/private.js"),
            self.failure(port, url="http://example.com:1234/_next/static/remote.js"),
            self.failure(port, url="http://localhost:invalid/_next/static/invalid.js"),
            self.failure(port, url=f"http://user:password@localhost:{port}/_next/static/private.js"),
            aborted, success, good,
        ]
        report = self.run_report(events, port, port)
        self.assertEqual(len(report["failures"]), 1)
        self.assertEqual(report["failures"][0]["error"], "net::ERR_INVALID_HTTP_RESPONSE")
        self.assertEqual(len(self.requests), 2)
        self.assertNotIn("private-", json.dumps(report))
        for request in self.requests:
            self.assertTrue(request.startswith("GET /_next/static/chunks/%5Bturbopack%5D.js HTTP/1.1\r\n"))
            self.assertNotIn("Cookie", request)
            self.assertNotIn("Authorization", request)
        self.assertEqual(report["comparisons"][0]["proxy"]["headers"], [{"name": "content-length", "value": "2"}])

    def test_limits_probe_count_and_bytes_and_does_not_follow_redirects(self):
        proxy = self.server(b"HTTP/1.1 302 Found\r\nLocation: http://example.com/private\r\nContent-Length: 0\r\n\r\n")
        upstream = self.server(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nContent-Length: 100001\r\n\r\n" + b"x" * 100000)
        report = self.run_report([self.failure(proxy, f"/_next/static/{i}.js") for i in range(8)], proxy, upstream)
        self.assertEqual(len(report["failures"]), 8)
        self.assertEqual(len(report["comparisons"]), 5)
        self.assertEqual(len(self.requests), 10)
        for comparison in report["comparisons"]:
            self.assertEqual(comparison["proxy"]["statusLine"], "HTTP/1.1 302 Found")
            self.assertTrue(comparison["upstream"]["captureLimitReached"])
            self.assertEqual(comparison["upstream"]["capturedBytes"], 4096)
            self.assertEqual([header["value"] for header in comparison["upstream"]["headers"]
                              if header["name"] == "content-length"], ["100000", "100001"])

    def test_stalled_and_empty_responses_are_recorded_without_retries(self):
        proxy = self.server(b"", delay=3)
        upstream = self.server(b"")
        started = time.monotonic()
        report = self.run_report([self.failure(proxy)], proxy, upstream)
        self.assertLess(time.monotonic() - started, 5)
        comparison = report["comparisons"][0]
        self.assertEqual(comparison["proxy"]["error"], "TimeoutError")
        self.assertFalse(comparison["upstream"]["http"])
        self.assertEqual(comparison["upstream"]["capturedBytes"], 0)
        self.assertEqual(len(self.requests), 2)

    def test_missing_and_corrupt_traces_have_explicit_errors(self):
        port = self.server(b"")
        trace = Path(self.directory.name) / "missing.zip"
        report = self.run_report([], port, port, trace)
        self.assertIn("FileNotFoundError", report["traceErrors"][0])
        trace.write_text("not a zip file")
        report = self.run_report([], port, port, trace)
        self.assertIn("BadZipFile", report["traceErrors"][0])
        report = self.run_report([], port, port)
        self.assertIn("No network resource snapshots", report["traceErrors"][0])
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
