import {
  createServer,
  request as proxyRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { connect } from "node:net";

// The browser fixture routes OAuth to its local provider and all other traffic
// to Next, including the development WebSocket connection.
export function createBrowserProxy(ports: {
  appPort: number;
  googlePort: number;
}) {
  const proxy = createServer((request, response) => {
    const fail = (error: NodeJS.ErrnoException) => {
      if (response.destroyed) return;
      console.error(
        `Browser fixture upstream failure (${request.method} ${request.url}):`,
        error,
      );
      if (response.headersSent) response.destroy(error);
      else
        response
          .writeHead(502, {
            "Content-Type": "text/plain; charset=utf-8",
            Connection: "close",
          })
          .end(
            `Browser fixture upstream failure: ${error.code ?? error.message}`,
          );
    };
    const upstream = proxyRequest(
      {
        hostname: "127.0.0.1",
        port: request.url?.startsWith("/api/auth/")
          ? ports.googlePort
          : ports.appPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        // Playwright's API client can retain idle sockets until Node closes
        // them (six seconds on Node 24). A POST at that boundary can reset
        // before reaching this handler. Close completed fixture responses so
        // no idle client socket can be reused; never retry a mutation.
        const headers: IncomingHttpHeaders = {
          ...result.headers,
          connection: "close",
        };
        delete headers["keep-alive"];
        response.writeHead(result.statusCode!, headers);
        result.on("error", fail);
        result.pipe(response);
      },
    );
    upstream.on("error", fail);
    request.on("error", (error) => upstream.destroy(error));
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = connect(ports.appPort, "127.0.0.1", () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
          request.rawHeaders.reduce(
            (lines, value, index, all) =>
              index % 2 ? lines : lines + `${value}: ${all[index + 1]}\r\n`,
            "",
          ) +
          "\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  return proxy;
}
