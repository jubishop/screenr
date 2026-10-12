// Screenr has no offline mode. This worker only replaces the browser's error
// when a page load fails offline: docs/installation.md#offline-page
// It carries its one page in this script and stores nothing in Cache Storage,
// so feeds, titles, and other member data always come from the network.
const offlinePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f7f6f0" />
    <title>Offline · Screenr</title>
    <style>
      body {
        margin: 0;
        background: #f7f6f0;
        color: #163c34;
        font: 15px/1.6 "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }
      main {
        max-width: 620px;
        margin: 45px auto;
        padding: 0 24px;
        text-align: center;
      }
      .brand {
        margin: 0;
        font-size: 32px;
        font-weight: 800;
        letter-spacing: -2px;
      }
      .brand span {
        font-size: 12px;
        color: #88a841;
        margin-left: 4px;
        vertical-align: middle;
      }
      section {
        margin: 35px 0 24px;
        background: #fffef9;
        border: 1px solid #dfe5db;
        border-radius: 18px;
        padding: 45px;
        text-align: left;
      }
      h1 {
        margin: 0 0 17px;
        font-size: 36px;
        font-weight: 600;
        line-height: 1.18;
        letter-spacing: -1.8px;
      }
      section p {
        margin: 0 0 23px;
        color: #627068;
      }
      a {
        display: inline-block;
        border-radius: 8px;
        padding: 10px 17px;
        background: #163c34;
        color: #fffef9;
        font-weight: 600;
        text-decoration: none;
      }
      a:hover {
        background: #28554a;
      }
      @media (max-width: 560px) {
        main {
          margin: 24px auto;
        }
        section {
          padding: 28px 23px;
          margin-top: 24px;
        }
        h1 {
          font-size: 30px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="brand">screenr<span aria-hidden="true">●</span></p>
      <section>
        <h1>You’re offline</h1>
        <p>Check your connection and try again.</p>
        <a href="">Try again</a>
      </section>
    </main>
  </body>
</html>
`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Page loads start their network request while the worker starts.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Other requests skip the worker's response and use the network directly.
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) ?? (await fetch(request));
      } catch {
        return new Response(offlinePage, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    })(),
  );
});
