import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const transportPath = "/__screenr_script_transport";
export async function readTransport(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${transportPath}`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new Error(`Transport capture returned HTTP ${response.status}`);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Transport capture exceeded 2 MiB");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (error) {
    return { unavailable: String(error).slice(0, 256) };
  }
}
const limit = 128;
const prefixLimit = 4096;
const safeHeaders = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "cache-control",
  "etag",
  "vary",
  "date",
]);

export function scriptPath(value: string) {
  try {
    const path = value.split("?", 1)[0];
    if (!/^\/_next\/static\/[A-Za-z0-9_./%~@+\[\]-]+\.js$/.test(path)) return;
    const decoded = decodeURIComponent(path);
    if (
      decoded.includes("\\") ||
      decoded.split("/").some((p) => p === "." || p === "..")
    )
      return;
    return path.slice(0, 1024);
  } catch {
    return;
  }
}

class Wire {
  private prefix = Buffer.alloc(0);
  bytes = 0;
  complete = false;
  error?: { code?: string; bytesParsed?: number; reason?: string };
  connection?: { localPort?: number; remotePort?: number };
  events: { event: string; at: string }[] = [];
  observe = (chunk: Buffer) => {
    this.bytes += chunk.length;
    if (this.prefix.length < prefixLimit)
      this.prefix = Buffer.concat([
        this.prefix,
        chunk.subarray(0, prefixLimit - this.prefix.length),
      ]);
  };
  event(event: string) {
    if (this.events.length < 8)
      this.events.push({ event, at: new Date().toISOString() });
  }
  socket(socket: Socket) {
    this.connection = {
      localPort: socket.localPort,
      remotePort: socket.remotePort,
    };
  }
  fail(
    error: NodeJS.ErrnoException & { bytesParsed?: number; reason?: string },
  ) {
    this.error = {
      code: error.code,
      bytesParsed: error.bytesParsed,
      reason: error.reason?.slice(0, 128),
    };
    this.event("error");
  }
  toJSON() {
    const text = this.prefix.toString("latin1");
    const headerEnd = text.indexOf("\r\n\r\n");
    const [first, ...lines] = text
      .slice(0, headerEnd < 0 ? undefined : headerEnd)
      .split("\r\n");
    const statusLine = first.slice(0, 128);
    return {
      statusLine,
      statusLineHex: Buffer.from(statusLine, "latin1").toString("hex"),
      headersComplete: headerEnd >= 0,
      headers: lines
        .flatMap((line) => {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).toLowerCase();
          return colon > 0 && safeHeaders.has(name)
            ? [
                {
                  name,
                  value: line
                    .slice(colon + 1)
                    .trim()
                    .slice(0, 512),
                },
              ]
            : [];
        })
        .slice(0, 40),
      bytes: this.bytes,
      complete: this.complete,
      error: this.error,
      connection: this.connection,
      events: this.events,
      prefixLimitReached: this.prefix.length === prefixLimit,
    };
  }
}

// A bounded in-memory ring; no raw request headers or response bodies leave it.
// Socket observation uses the public stream API without changing the bytes.
export class ScriptTransport {
  private sequence = 0;
  private active = 0;
  private omitted = 0;
  private requests: {
    id: number;
    path: string;
    startedAt: string;
    reusedSocket?: boolean;
    upstream: Wire;
    downstream: Wire;
  }[] = [];
  capture(request: IncomingMessage, response: ServerResponse) {
    const path = request.method === "GET" && scriptPath(request.url ?? "");
    if (!path) return;
    if (this.active >= limit) {
      this.omitted++;
      return;
    }
    this.active++;
    const entry = {
      id: ++this.sequence,
      path,
      startedAt: new Date().toISOString(),
      reusedSocket: false,
      upstream: new Wire(),
      downstream: new Wire(),
    };
    this.requests.push(entry);
    if (this.requests.length > limit) this.requests.shift();
    const socket = request.socket;
    entry.downstream.socket(socket);
    const write = socket.write;
    const observed: typeof socket.write = function (
      this: Socket,
      chunk,
      ...args: unknown[]
    ) {
      entry.downstream.observe(
        typeof chunk !== "string"
          ? Buffer.from(chunk)
          : Buffer.from(
              chunk,
              typeof args[0] === "string"
                ? (args[0] as BufferEncoding)
                : undefined,
            ),
      );
      return Reflect.apply(write, this, [chunk, ...args]);
    };
    socket.write = observed;
    const restore = () => {
      if (socket.write === observed) socket.write = write;
    };
    response.once("finish", () => {
      entry.downstream.complete = true;
      entry.downstream.event("finish");
      restore();
    });
    response.once("close", () => {
      this.active--;
      entry.downstream.event("close");
      restore();
    });
    return (upstream: ClientRequest) => {
      upstream.once("socket", (socket) => {
        const connected = () => entry.upstream.socket(socket);
        connected();
        socket.once("connect", connected);
        // Run before Node's parser, including when it rejects the status line.
        socket.prependListener("data", entry.upstream.observe);
        const detach = () => {
          socket.off("data", entry.upstream.observe);
          socket.off("connect", connected);
        };
        upstream.once("close", detach);
      });
      upstream.once("error", (error) => entry.upstream.fail(error));
      upstream.once("response", (result) => {
        entry.reusedSocket = upstream.reusedSocket;
        entry.upstream.event("headers");
        result.once("end", () => {
          entry.upstream.complete = result.complete;
          entry.upstream.event("end");
        });
        result.once("aborted", () => entry.upstream.event("aborted"));
        result.once("error", (error) => entry.upstream.fail(error));
      });
    };
  }
  snapshot() {
    return {
      limit,
      totalRequests: this.sequence,
      omitted: this.omitted,
      requests: this.requests,
    };
  }
}
