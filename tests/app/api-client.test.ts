import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../../src/components/client";

const unavailable =
  "Screenr is temporarily unavailable. Please try again in a moment.";
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

function reply(body: string, init: ResponseInit) {
  globalThis.fetch = async () => new Response(body, init);
}

// Like the browser's fetch, the stub rejects with the abort reason.
function stall() {
  const started: string[] = [];
  globalThis.fetch = (input, init) => {
    started.push(String(input));
    return new Promise((_, reject) =>
      init!.signal!.addEventListener("abort", () =>
        reject(init!.signal!.reason),
      ),
    );
  };
  return started;
}

function controlDeadlines() {
  const deadlines: { ms: number; expire: () => void }[] = [];
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    deadlines.push({
      ms,
      expire: () =>
        controller.abort(new DOMException("timed out", "TimeoutError")),
    });
    return controller.signal;
  };
  return deadlines;
}

async function failure(request: Promise<unknown>): Promise<ApiError> {
  const error = await request.then(
    () => assert.fail("request should fail"),
    (error: unknown) => error,
  );
  if (!(error instanceof ApiError)) assert.fail(String(error));
  return error;
}

test("proxy HTML and empty error pages produce a retryable message", async () => {
  for (const [body, headers] of [
    [
      "<html><title>502 Bad Gateway</title></html>",
      { "Content-Type": "text/html" },
    ],
    ["", {}],
  ] as const) {
    reply(body, { status: 502, headers });
    for (const request of [
      () => api("screen?path=%2F"),
      () => api("invite", { limit: 1 }),
    ]) {
      const error = await failure(request());
      assert.equal(error.message, unavailable);
      assert.equal(error.status, 502);
    }
  }
});

test("unreadable successful replies produce the retryable message", async () => {
  for (const body of ["", "<html>Sign in to the network</html>", "{"]) {
    reply(body, { status: 200 });
    const error = await failure(api("screen?path=%2F"));
    assert.equal(error.message, unavailable);
    assert.equal(error.status, 200);
  }
});

test("server error messages and statuses reach callers", async () => {
  for (const [status, message] of [
    [404, "Title not found."],
    [403, "Complete your profile first."],
    [502, "The movie catalog is temporarily unavailable. Please try again."],
  ] as const) {
    reply(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const error = await failure(api("activity", { title: "movie:1" }));
    assert.equal(error.message, message);
    assert.equal(error.status, status);
  }
  reply(JSON.stringify({ id: "comment-1" }), { status: 200 });
  assert.deepEqual(await api("comment", { body: "Hi" }), { id: "comment-1" });
});

test("error replies without a server message use a generic one", async () => {
  reply("<html>Payload Too Large</html>", { status: 413 });
  assert.equal(
    (await failure(api("comment", { body: "Hi" }))).message,
    "Request failed. Please try again.",
  );
  reply(JSON.stringify({ message: "Upstream failed" }), { status: 503 });
  assert.equal((await failure(api("screen?path=%2F"))).message, unavailable);
});

test("a stalled mutation stops at its deadline with a retryable message", async () => {
  const deadlines = controlDeadlines();
  const started = stall();
  const request = failure(api("relationship", { target: "a", action: "x" }));
  assert.deepEqual(started, ["/api/screenr/relationship"]);
  assert.deepEqual(
    deadlines.map(({ ms }) => ms),
    [15_000],
  );
  deadlines[0].expire();
  const error = await request;
  assert.equal(error.message, "The request timed out. Please try again.");
  assert.equal(error.status, undefined);
});

test("a stalled read body stops at the deadline", async () => {
  const deadlines = controlDeadlines();
  globalThis.fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () =>
            controller.error(init!.signal!.reason),
          );
        },
      }),
      { status: 200 },
    );
  const request = failure(api("screen?path=%2F"));
  await new Promise((resolve) => setImmediate(resolve));
  deadlines[0].expire();
  assert.equal(
    (await request).message,
    "The request timed out. Please try again.",
  );
});

test("caller cancellation keeps its abort error", async () => {
  controlDeadlines();
  stall();
  const controller = new AbortController();
  const request = api("screen?path=%2F", undefined, controller.signal);
  controller.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.ok(!(error instanceof ApiError));
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("network failures produce a connection message", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const error = await failure(api("reaction", { item: "x" }));
  assert.equal(
    error.message,
    "Could not reach Screenr. Check your connection and try again.",
  );
  assert.equal(error.status, undefined);
});

test("an expired session sends the reader to sign in and back to the same page", async (t) => {
  const visits: string[] = [];
  const at = (path: string) => {
    const url = new URL(path, "http://screenr.local");
    Object.assign(globalThis, {
      window: {
        location: {
          pathname: url.pathname,
          search: url.search,
          replace: (target: string) => visits.push(target),
        },
      },
    });
  };
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  reply(JSON.stringify({ error: "Sign in to continue." }), { status: 401 });
  for (const path of [
    "/titles/movie/42?item=post&reply=answer",
    "/setup?next=%2Fpeople%2Falice",
    "/",
    "/setup?next=https%3A%2F%2Fevil.example",
    "/unknown",
  ]) {
    at(path);
    const error = await failure(api("screen?path=%2F"));
    assert.equal(error.status, 401);
  }
  assert.deepEqual(visits, [
    "/login?next=%2Ftitles%2Fmovie%2F42%3Fitem%3Dpost%26reply%3Danswer",
    "/login?next=%2Fpeople%2Falice",
    "/login",
    "/login",
    "/login",
  ]);
});
