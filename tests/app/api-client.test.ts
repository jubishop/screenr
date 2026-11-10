import { afterEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  anySignal,
  api,
  ApiError,
  read,
  readChanged,
} from "../../src/components/client";

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

// A complete comment, for requests whose reply the tests choose.
const comment = { conversation: "1", body: "Hi", spoiler: false };

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
      () => read("screen", { path: "/" }),
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
    const error = await failure(read("screen", { path: "/" }));
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
    const error = await failure(
      api("activity", {
        title: "movie:1",
        field: "recommended",
        value: true,
      }),
    );
    assert.equal(error.message, message);
    assert.equal(error.status, status);
  }
  reply(JSON.stringify({ id: "comment-1" }), { status: 200 });
  assert.deepEqual(await api("comment", comment), { id: "comment-1" });
});

test("error replies without a server message use a generic one", async () => {
  reply("<html>Payload Too Large</html>", { status: 413 });
  assert.equal(
    (await failure(api("comment", comment))).message,
    "Request failed. Please try again.",
  );
  reply(JSON.stringify({ message: "Upstream failed" }), { status: 503 });
  assert.equal(
    (await failure(read("screen", { path: "/" }))).message,
    unavailable,
  );
});

test("changed reads send the held version and report an unchanged reply as null", async () => {
  const sent: (string | null)[] = [];
  const answer = (response: () => Response) => {
    globalThis.fetch = async (_input, init) => {
      sent.push(new Headers(init!.headers).get("If-None-Match"));
      return response();
    };
  };
  answer(() =>
    Response.json({ kind: "feed" }, { headers: { ETag: 'W/"one"' } }),
  );
  assert.deepEqual(await readChanged("screen", { path: "/" }, null), {
    data: { kind: "feed" },
    version: 'W/"one"',
  });
  answer(
    () => new Response(null, { status: 304, headers: { ETag: 'W/"one"' } }),
  );
  assert.equal(await readChanged("screen", { path: "/" }, 'W/"one"'), null);
  // A reply without a version, such as through a proxy that drops it, reads
  // in full next time.
  answer(() => Response.json({ kind: "people" }));
  assert.deepEqual(
    await readChanged("screen", { path: "/people" }, 'W/"one"'),
    {
      data: { kind: "people" },
      version: null,
    },
  );
  assert.deepEqual(sent, [null, 'W/"one"', 'W/"one"']);
  answer(() => Response.json({ error: "Person not found." }, { status: 404 }));
  const error = await failure(
    readChanged("screen", { path: "/people/x" }, null),
  );
  assert.equal(error.message, "Person not found.");
  assert.equal(error.status, 404);
});

test("reads send their query in the address, and writes post to the action", async () => {
  const sent: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    sent.push([String(input), init?.method ?? "GET", init?.body ?? null]);
    return Response.json({ ok: true });
  };
  await read("episodes", { title: "tv:1", season: "2" });
  await read("search", { q: "The Bear" });
  await readChanged("screen", { path: "/people/alice" }, null);
  // A read leaves out the fields it has no value for.
  await read("notifications", {
    unread: "true",
    before: undefined,
    through: undefined,
  });
  await api("invite", { limit: 1 });
  assert.deepEqual(sent, [
    ["/api/screenr/episodes?title=tv%3A1&season=2", "GET", null],
    ["/api/screenr/search?q=The+Bear", "GET", null],
    ["/api/screenr/screen?path=%2Fpeople%2Falice", "GET", null],
    ["/api/screenr/notifications?unread=true", "GET", null],
    ["/api/screenr/invite", "POST", '{"limit":1}'],
  ]);
});

// Each call may name only the fields its action declares, and must name the
// required ones, so `npm run typecheck` fails on each call below (issue
// #579). The function never runs.
function wrongFields(draft: { bdy: string; spoiler: boolean }) {
  void api("comment", {
    conversation: "1",
    body: "Hi",
    spoiler: false,
    // @ts-expect-error An optional field, misspelled.
    reply_to: "2",
  });
  // @ts-expect-error A spread that misspells a required field leaves it out.
  void api("comment", { conversation: "1", ...draft });
  void read("episodes", {
    title: "tv:1",
    // @ts-expect-error A read's query field, misspelled.
    sesaon: "2",
  });
  // @ts-expect-error An action that reads no fields.
  void api("delete-account", { confirm: true });
  // @ts-expect-error A photo upload sends the image itself.
  void api("photo", { upload: new Blob() });
  // @ts-expect-error A read's query is an object of its fields.
  void read("search", new URLSearchParams({ q: "The Bear" }));
}

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
  const request = failure(read("screen", { path: "/" }));
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
  const request = read("screen", { path: "/" }, controller.signal);
  controller.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.ok(!(error instanceof ApiError));
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

// Safari before 17.4, a supported browser, has no AbortSignal.any
// (docs/interface-design.md#supported-browsers--2026-11-01).
function removeAbortSignalAny(t: TestContext) {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Reflect.deleteProperty(AbortSignal, "any");
  t.after(() => Object.defineProperty(AbortSignal, "any", any));
}

test("without AbortSignal.any, requests stop at their deadline or the caller's cancellation", async (t) => {
  removeAbortSignalAny(t);
  const deadlines = controlDeadlines();
  stall();
  const controller = new AbortController();
  const timedOut = failure(
    api("relationship", { target: "a", action: "x" }, controller.signal),
  );
  deadlines[0].expire();
  assert.equal(
    (await timedOut).message,
    "The request timed out. Please try again.",
  );
  const cancelled = read("screen", { path: "/" }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => {
    assert.ok(!(error instanceof ApiError));
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("anySignal aborts with the first signal to abort, with or without AbortSignal.any", (t) => {
  const check = () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = anySignal([first.signal, second.signal]);
    assert.equal(combined.aborted, false);
    second.abort("second");
    first.abort("first");
    assert.equal(combined.aborted, true);
    assert.equal(combined.reason, "second");
    const done = new AbortController();
    done.abort("already");
    const late = anySignal([new AbortController().signal, done.signal]);
    assert.equal(late.aborted, true);
    assert.equal(late.reason, "already");
  };
  check();
  removeAbortSignalAny(t);
  check();
});

test("network failures produce a connection message", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const error = await failure(api("reaction", { item: "x", kind: null }));
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
    const error = await failure(read("screen", { path: "/" }));
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
