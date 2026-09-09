#!/usr/bin/env python3
"""Summarize failed Playwright script loads and compare later loopback responses.

Input and output are JSON. No archive entries are extracted to the filesystem.
This runs only in the disposable browser harness, never in the application.
"""

import concurrent.futures
import datetime
import json
import re
import socket
import sys
import time
import urllib.parse
import zipfile


SAFE_HEADERS = {
    "content-type", "content-length", "content-encoding", "transfer-encoding",
    "connection", "cache-control", "etag", "vary", "date",
}
MAX_TRACE_BYTES = 32 * 1024 * 1024
MAX_RESPONSE_BYTES = 4096
MAX_PATHS = 5
PROBE_SECONDS = 2


def script_path(request, port):
    try:
        url = urllib.parse.urlsplit(request.get("url", ""))
        request_port = url.port
    except ValueError:
        return None
    if (request.get("method") != "GET" or url.scheme != "http"
            or url.hostname not in ("localhost", "127.0.0.1")
            or request_port != port or url.username or url.password
            or not re.fullmatch(r"/_next/static/[A-Za-z0-9_./%~@+\[\]-]+\.js", url.path)):
        return None
    # Do not turn an encoded traversal into a request to an application route.
    decoded = urllib.parse.unquote(url.path)
    if "\\" in decoded or any(part in (".", "..") for part in decoded.split("/")):
        return None
    return url.path  # Query strings, cookies, and credentials are not replayed.


def safe_headers(headers):
    # Keep duplicate framing headers: they can explain a parser rejection.
    return [{"name": entry["name"].lower(), "value": str(entry.get("value", ""))[:512]}
            for entry in headers if entry.get("name", "").lower() in SAFE_HEADERS][:40]


def read_failures(traces, port):
    failures, errors = [], []
    remaining = MAX_TRACE_BYTES
    saw_snapshot = False
    for trace in traces[:10]:
        try:
            with zipfile.ZipFile(trace) as archive:
                for entry in archive.infolist():
                    if not entry.filename.endswith(".network"):
                        continue
                    if entry.file_size > remaining:
                        errors.append("Network trace exceeded the 32 MiB scan limit.")
                        continue
                    remaining -= entry.file_size
                    with archive.open(entry) as source:
                        for line in source:
                            event = json.loads(line)
                            if event.get("type") != "resource-snapshot":
                                continue
                            saw_snapshot = True
                            snapshot = event.get("snapshot", {})
                            path = script_path(snapshot.get("request", {}), port)
                            response = snapshot.get("response", {})
                            status = response.get("status", 0)
                            failure = response.get("_failureText") or ""
                            if not path or (status < 400 and (not failure or failure == "net::ERR_ABORTED")):
                                continue
                            failures.append({
                                "path": path, "status": status,
                                "error": failure[:256],
                                "startedDateTime": snapshot.get("startedDateTime"),
                                "httpVersion": response.get("httpVersion"),
                                "serverIPAddress": snapshot.get("serverIPAddress"),
                                "headers": safe_headers(response.get("headers", [])),
                            })
                            if len(failures) == 20:
                                errors.append("Failure list limited to the first 20 script requests.")
                                return failures, errors
        except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
            errors.append(f"Could not read network trace: {type(error).__name__}")
    if not traces:
        errors.append("No failure trace was attached; enable retain-on-failure tracing.")
    elif not saw_snapshot and not errors:
        errors.append("No network resource snapshots were found in the attached traces.")
    return failures, errors


def probe(port, host_port, path):
    started = time.monotonic()
    data = bytearray()
    report = {"port": port, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=PROBE_SECONDS) as connection:
            connection.sendall((f"GET {path} HTTP/1.1\r\nHost: localhost:{host_port}\r\n"
                                "Accept-Encoding: gzip, deflate, br, zstd\r\n"
                                "Connection: close\r\n\r\n").encode("ascii"))
            while len(data) < MAX_RESPONSE_BYTES:
                remaining = PROBE_SECONDS - (time.monotonic() - started)
                if remaining <= 0:
                    raise TimeoutError()
                connection.settimeout(remaining)
                chunk = connection.recv(MAX_RESPONSE_BYTES - len(data))
                if not chunk:
                    break
                data.extend(chunk)
    except OSError as error:
        report["error"] = type(error).__name__
    raw = bytes(data)
    first = raw.split(b"\r\n", 1)[0][:128]
    report.update({
        "statusLine": first.decode("ascii", errors="replace"),
        "http": bool(re.fullmatch(rb"HTTP/1\.[01] [0-9]{3}(?: .*|)", first)),
        "capturedBytes": len(raw),
        "captureLimitReached": len(raw) == MAX_RESPONSE_BYTES,
        "elapsedMs": round((time.monotonic() - started) * 1000),
    })
    # Preserve enough wire information to distinguish a bad status line from
    # an ordinary HTTP error, without storing Set-Cookie or arbitrary headers.
    if not report["http"]:
        report["statusLineHex"] = first.hex()
    header_block, separator, body = raw.partition(b"\r\n\r\n")
    headers = []
    for line in header_block.split(b"\r\n")[1:]:
        name, colon, value = line.partition(b":")
        if colon:
            headers.append({"name": name.decode("ascii", "replace"),
                            "value": value.strip().decode("ascii", "replace")})
    report["headers"] = safe_headers(headers)
    report["headersComplete"] = bool(separator)
    return report


def main():
    args = json.load(sys.stdin)
    for name in ("proxyPort", "appPort"):
        if not isinstance(args[name], int) or not 1024 <= args[name] <= 65535:
            raise ValueError(f"Invalid {name}")
    failures, errors = read_failures(args.get("traces", []), args["proxyPort"])
    paths = list(dict.fromkeys(failure["path"] for failure in failures))[:MAX_PATHS]
    # At most ten GETs run concurrently, each bounded to two seconds and 4 KiB.
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PATHS * 2) as pool:
        pending = [(path, pool.submit(probe, args["proxyPort"], args["proxyPort"], path),
                    pool.submit(probe, args["appPort"], args["proxyPort"], path)) for path in paths]
        comparisons = [{"path": path, "proxy": proxy.result(), "upstream": upstream.result()}
                       for path, proxy, upstream in pending]
    json.dump({
        "schemaVersion": 1,
        "runtime": args.get("runtime", {}),
        "configuration": {"proxyPort": args["proxyPort"], "appPort": args["appPort"]},
        "failures": failures,
        "comparisons": comparisons,
        "traceErrors": errors,
        "note": "Comparisons are later GET observations, not the original failed response. "
                "Successful probes do not disprove an intermittent failure. "
                "Only the first five distinct failed local script paths are probed; "
                "redirects are not followed and requests are never retried.",
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
