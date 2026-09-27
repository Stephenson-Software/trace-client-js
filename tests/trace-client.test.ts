// Drives the client against a real HTTP server on a loopback port -- Node's
// own, so the tests have no more dependencies than the client does.
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import * as clientModule from "../trace-client.ts";
import { TraceClient, TRACE_CLIENT_VERSION, isBot, pagePath } from "../trace-client.ts";

const { REASON_CONFIG, REASON_ENVIRONMENT, REASON_NO_KEY } = TraceClient;
const environmentOptsOut = (env?: Record<string, string | undefined>) => TraceClient.environmentOptsOut(env);

// The client reads TRACE_USAGE_REPORTING / DO_NOT_TRACK from process.env by
// default, so a developer's own opt-out must not turn the delivery tests into
// no-ops. Cleared for the whole file and put back afterwards.
const OPT_OUT_VARIABLES = ["TRACE_USAGE_REPORTING", "DO_NOT_TRACK"] as const;
const savedEnvironment: Record<string, string | undefined> = {};
before(() => {
  for (const name of OPT_OUT_VARIABLES) {
    savedEnvironment[name] = process.env[name];
    delete process.env[name];
  }
});
after(() => {
  for (const name of OPT_OUT_VARIABLES) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
});

interface Captured {
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

class Capture {
  requests: Captured[] = [];
  replyStatus = 201;
  hang = false; // when true, accept the request and never answer
  private readonly hung: ServerResponse[] = [];
  private waiters: Array<() => void> = [];

  record(request: Captured, response: ServerResponse): void {
    this.requests.push(request);
    for (const wake of this.waiters.splice(0)) wake();
    if (this.hang) {
      this.hung.push(response);
      return;
    }
    response.statusCode = this.replyStatus;
    response.setHeader("Content-Length", "0");
    response.end();
  }

  /** Resolves once at least `count` requests have arrived, or after `ms`. */
  arrived(count = 1, ms = 5000): Promise<boolean> {
    if (this.requests.length >= count) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.requests.length >= count), ms);
      const check = () => {
        if (this.requests.length >= count) {
          clearTimeout(timer);
          resolve(true);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  release(): void {
    for (const response of this.hung.splice(0)) {
      response.statusCode = 201;
      response.end();
    }
  }
}

function serve(capture: Capture): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      capture.record(
        {
          path: request.url ?? "",
          headers: {
            authorization: request.headers.authorization,
            "content-type": request.headers["content-type"],
            "user-agent": request.headers["user-agent"],
          },
          body: Buffer.concat(chunks).toString("utf8"),
        },
        response,
      );
    });
  });
  server.keepAliveTimeout = 100;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function baseUrlOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TraceClient", () => {
  let capture: Capture;
  let server: Server;
  let baseUrl: string;
  let log: string[];

  beforeEach(async () => {
    capture = new Capture();
    server = await serve(capture);
    baseUrl = baseUrlOf(server);
    log = [];
  });

  afterEach(async () => {
    capture.release();
    await stop(server);
  });

  const debug = (message: string) => log.push(message);

  it("posts the event to the metrics endpoint with the key, tolerating a trailing slash", async () => {
    const client = new TraceClient(baseUrl + "/", "MyGame", { key: "k-123", debug });
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    const request = capture.requests[0];
    assert.equal(request.path, "/api/metrics", "a trailing slash on the base URL must not double up");
    assert.equal(request.headers.authorization, "Bearer k-123");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["user-agent"], `trace-client-js/${TRACE_CLIENT_VERSION} (MyGame)`);
    assert.deepEqual(JSON.parse(request.body), { application: "MyGame", name: "startup" });
    assert.deepEqual(log, []);
    await client.close();
  });

  it("omits value when undefined and carries value and tags when given", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k" });
    await client.report("world-load", { value: 2.5, tags: { seed: "42", size: 'the "big" one' } });
    await client.report("plain", { value: undefined, tags: {} });
    await client.report("nan", { value: Number.NaN });
    assert.deepEqual(JSON.parse(capture.requests[0].body), {
      application: "MyGame",
      name: "world-load",
      value: 2.5,
      tags: { seed: "42", size: 'the "big" one' },
    });
    assert.deepEqual(JSON.parse(capture.requests[1].body), { application: "MyGame", name: "plain" });
    assert.deepEqual(JSON.parse(capture.requests[2].body), { application: "MyGame", name: "nan" });
    await client.close();
  });

  it("never rejects when nothing is listening", async () => {
    const probe = await serve(new Capture());
    const deadUrl = baseUrlOf(probe);
    await stop(probe);
    const client = new TraceClient(deadUrl, "MyGame", { key: "k", debug });
    await client.report("startup"); // must resolve, not reject
    assert.ok(log.some((line) => line.includes("could not deliver")), log.join("\n"));
    await client.close();
  });

  it("never rejects when the server answers 500", async () => {
    capture.replyStatus = 500;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", debug });
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    assert.ok(log.some((line) => line.includes("answered 500")), log.join("\n"));
    await client.close();
  });

  it("never rejects when the server rejects the key", async () => {
    capture.replyStatus = 401;
    const client = new TraceClient(baseUrl, "MyGame", { key: "revoked", debug });
    await client.report("startup");
    assert.ok(log.some((line) => line.includes("answered 401")), log.join("\n"));
    await client.close();
  });

  it("gives up within the timeout when the server hangs", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", timeoutMs: 300, debug });
    const before = Date.now();
    await client.report("startup");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 2000, `report() took ${elapsed}ms; it must be bounded by the timeout`);
    assert.ok(log.some((line) => line.includes("could not deliver")), log.join("\n"));
    await client.close();
  });

  it("returns already-started work rather than waiting on the network", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", timeoutMs: 500 });
    const before = Date.now();
    const work = client.report("startup");
    assert.ok(Date.now() - before < 100, "report() itself must return at once");
    assert.ok(await capture.arrived(1), "the request should already be on the wire");
    await work;
    await client.close();
  });

  it("caps requests in flight and drops the rest", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", timeoutMs: 1000, debug });
    const flood = TraceClient.IN_FLIGHT_CAPACITY * 3;
    const work: Promise<void>[] = [];
    for (let i = 0; i < flood; i++) work.push(client.report("flood"));
    const dropped = log.filter((line) => line.includes("in-flight cap reached")).length;
    assert.equal(dropped, flood - TraceClient.IN_FLIGHT_CAPACITY, `an unbounded client would have accepted all ${flood}`);
    assert.ok(await capture.arrived(TraceClient.IN_FLIGHT_CAPACITY, 5000));
    await sleep(200); // give any surplus a chance to arrive before counting
    assert.equal(capture.requests.length, TraceClient.IN_FLIGHT_CAPACITY, "the server must see exactly the cap");
    capture.release();
    await Promise.all(work);
    await client.close();
  });

  it("frees a slot once a request settles", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", debug });
    for (let i = 0; i < TraceClient.IN_FLIGHT_CAPACITY + 10; i++) await client.report("one-at-a-time");
    assert.equal(capture.requests.length, TraceClient.IN_FLIGHT_CAPACITY + 10);
    assert.deepEqual(log, []);
    await client.close();
  });

  it("sends nothing when disabled or without a key", async () => {
    const clients = [
      new TraceClient(baseUrl, "MyGame", { key: "k", enabled: false }),
      new TraceClient(baseUrl, "MyGame"),
      new TraceClient(baseUrl, "MyGame", { key: "  " }),
      TraceClient.disabled(),
    ];
    for (const client of clients) {
      assert.equal(client.enabled, false);
      await client.report("startup");
      await client.close();
    }
    await sleep(200);
    assert.deepEqual(capture.requests, []);
  });

  it("ignores a blank name", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k" });
    await client.report("");
    await client.report("   ");
    await client.close();
    assert.deepEqual(capture.requests, []);
  });

  it("rejects a missing baseUrl or application at construction", () => {
    assert.throws(() => new TraceClient("", "MyGame"));
    assert.throws(() => new TraceClient("  ", "MyGame"));
    assert.throws(() => new TraceClient(baseUrl, ""));
    assert.throws(() => new TraceClient(baseUrl, "   "));
  });

  it("names the bad argument when construction fails", () => {
    assert.throws(() => new TraceClient("", "MyGame"), /baseUrl/);
    assert.throws(() => new TraceClient(undefined as unknown as string, "MyGame"), /baseUrl/);
    assert.throws(() => new TraceClient(baseUrl, ""), /application/);
    assert.throws(() => new TraceClient(baseUrl, 42 as unknown as string), /application/);
  });

  it("falls back to the default timeout when timeoutMs is not a positive finite number", async () => {
    // Used as-is, each of these would abort the request before the stub answers.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let aborted: boolean | undefined;
      const client = new TraceClient(baseUrl, "MyGame", {
        key: "k",
        timeoutMs,
        debug,
        fetch: (async (_url: unknown, init?: RequestInit) => {
          await sleep(100);
          aborted = init?.signal?.aborted;
          return new Response(null, { status: 201 });
        }) as typeof fetch,
      });
      await client.report("startup");
      assert.equal(aborted, false, `timeoutMs=${timeoutMs} must fall back to ${TraceClient.TIMEOUT_MS}`);
      await client.close();
    }
    assert.deepEqual(log, []);
  });

  it("drops null and undefined tags, coerces other values to strings, and omits tags left empty", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k" });
    const loose = (tags: Record<string, unknown>) => tags as Record<string, string>;
    await client.report("mixed", {
      value: Number.POSITIVE_INFINITY,
      tags: loose({ keep: "x", gone: null, missing: undefined, count: 3, flag: true }),
    });
    await client.report("empty", { value: Number.NEGATIVE_INFINITY, tags: loose({ gone: null, missing: undefined }) });
    await client.report("zero", { value: 0 });
    assert.deepEqual(JSON.parse(capture.requests[0].body), {
      application: "MyGame",
      name: "mixed",
      tags: { keep: "x", count: "3", flag: "true" },
    });
    assert.deepEqual(JSON.parse(capture.requests[1].body), { application: "MyGame", name: "empty" });
    assert.deepEqual(JSON.parse(capture.requests[2].body), { application: "MyGame", name: "zero", value: 0 });
    await client.close();
  });

  it("drops a report whose tags cannot be serialized, without throwing", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", debug });
    const hostile = {
      toString(): never {
        throw new Error("no string for you");
      },
    };
    await client.report("startup", { tags: { bad: hostile as unknown as string } }); // must resolve
    await client.close();
    assert.deepEqual(capture.requests, []);
    assert.ok(
      log.some((line) => line.includes("could not serialize startup") && line.includes("no string for you")),
      log.join("\n"),
    );
  });

  it("treats any 2xx as success, even with an unreadable body", async () => {
    capture.replyStatus = 202;
    const answered = new TraceClient(baseUrl, "MyGame", { key: "k", debug });
    await answered.report("startup");
    await answered.close();
    assert.equal(capture.requests.length, 1);
    const unreadable = new TraceClient(baseUrl, "MyGame", {
      key: "k",
      debug,
      fetch: (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.reject(new Error("body gone")),
      })) as unknown as typeof fetch,
    });
    await unreadable.report("startup"); // must resolve
    await unreadable.close();
    assert.deepEqual(log, [], "a 2xx is delivered; an unreadable body is not a failure");
  });

  it("names the cause of a failed delivery in the debug line", async () => {
    const failures: unknown[] = [
      new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
      "plain string failure",
    ];
    for (const failure of failures) {
      const client = new TraceClient(baseUrl, "MyGame", {
        key: "k",
        debug,
        fetch: (async () => {
          throw failure;
        }) as typeof fetch,
      });
      await client.report("startup"); // must resolve
      await client.close();
    }
    assert.ok(log.some((line) => line.includes("Error: fetch failed (connect ECONNREFUSED)")), log.join("\n"));
    assert.ok(log.some((line) => line.includes("plain string failure")), log.join("\n"));
  });

  it("flush() and close() treat a negative or non-finite timeout as zero", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", timeoutMs: 3000 });
    client.report("startup");
    assert.ok(await capture.arrived(1));
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const before = Date.now();
      await client.flush(timeoutMs);
      const elapsed = Date.now() - before;
      assert.ok(elapsed < 1500, `flush(${timeoutMs}) took ${elapsed}ms; it must not wait on the hung request`);
    }
    const before = Date.now();
    await client.close(-1);
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 1500, `close(-1) took ${elapsed}ms; it must not wait on the hung request`);
  });

  it("does not let a throwing debug sink or a broken fetch escape", async () => {
    const client = new TraceClient(baseUrl, "MyGame", {
      key: "k",
      fetch: (() => {
        throw new Error("no network here");
      }) as unknown as typeof fetch,
      debug: () => {
        throw new Error("logger exploded");
      },
    });
    await client.report("startup"); // must resolve
    await client.close();
  });

  it("delivers a report followed by an immediate close()", async () => {
    // A CLI reports once and exits at once. close() must drain what is in flight.
    for (let i = 0; i < 30; i++) {
      const client = new TraceClient(baseUrl, "MyCli", { key: "k" });
      client.report("startup", { tags: { run: String(i) } });
      await client.close();
    }
    assert.equal(capture.requests.length, 30, "every report()+close() pair must deliver");
  });

  it("close() returns within the timeout when the server hangs", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyCli", { key: "k" });
    client.report("startup");
    const before = Date.now();
    await client.close(500);
    assert.ok(Date.now() - before < 2000, "draining must be bounded by the timeout");
  });

  it("flush() waits for in-flight work and is bounded too", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k" });
    client.report("a");
    client.report("b");
    await client.flush();
    assert.equal(capture.requests.length, 2);
    capture.hang = true;
    client.report("c");
    const before = Date.now();
    await client.flush(300);
    assert.ok(Date.now() - before < 2000);
    assert.equal(client.enabled, true, "flush() must not close the client");
    await client.close();
  });

  it("report() after close() is a no-op, and close() is idempotent", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", debug });
    await client.report("startup");
    await client.close();
    await client.close();
    assert.equal(client.enabled, false);
    await client.report("after-close");
    await sleep(100);
    assert.equal(capture.requests.length, 1);
    assert.deepEqual(log, []);
  });
});

describe("0.1.0 compatibility", () => {
  it("exports exactly the values 0.1.0 did, so re-vendoring needs no change", () => {
    assert.deepEqual(Object.keys(clientModule).sort(), ["TRACE_CLIENT_VERSION", "TraceClient", "isBot", "pagePath"]);
  });

  it("keeps the 0.1.0 constructor, report, flush, close and disabled() shapes", async () => {
    const client = new TraceClient("http://127.0.0.1:9", "MyGame", { key: "k", enabled: true, timeoutMs: 50, fetch, debug: () => {}, env: {} });
    assert.equal(client.enabled, true);
    assert.equal(await client.report("startup", { value: 1, tags: { version: "1" } }), undefined);
    assert.equal(await client.flush(50), undefined);
    assert.equal(await client.close(50), undefined);
    assert.equal(TraceClient.disabled().enabled, false);
    assert.equal(TRACE_CLIENT_VERSION, "0.2.0");
  });
});

describe("environment opt-outs", () => {
  let capture: Capture;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    capture = new Capture();
    server = await serve(capture);
    baseUrl = baseUrlOf(server);
  });

  afterEach(async () => {
    capture.release();
    await stop(server);
    for (const name of OPT_OUT_VARIABLES) delete process.env[name];
  });

  it("recognises exactly the documented values, ignoring case and surrounding space", () => {
    for (const value of ["off", "false", "0", "no", "OFF", " No ", "False"]) {
      assert.equal(environmentOptsOut({ TRACE_USAGE_REPORTING: value }), true, `TRACE_USAGE_REPORTING=${value}`);
    }
    for (const value of ["1", "true", "yes", "TRUE", " Yes "]) {
      assert.equal(environmentOptsOut({ DO_NOT_TRACK: value }), true, `DO_NOT_TRACK=${value}`);
    }
    for (const value of ["", "on", "true", "1", "yes", "disabled"]) {
      assert.equal(environmentOptsOut({ TRACE_USAGE_REPORTING: value }), false, `TRACE_USAGE_REPORTING=${value}`);
    }
    for (const value of ["", "0", "false", "no", "off"]) {
      assert.equal(environmentOptsOut({ DO_NOT_TRACK: value }), false, `DO_NOT_TRACK=${value}`);
    }
    assert.equal(environmentOptsOut({}), false);
  });

  it("sends nothing and reports \"environment\" when TRACE_USAGE_REPORTING or DO_NOT_TRACK opts out", async () => {
    const clients = [
      new TraceClient(baseUrl, "MyGame", { key: "k", env: { TRACE_USAGE_REPORTING: "off" } }),
      new TraceClient(baseUrl, "MyGame", { key: "k", env: { DO_NOT_TRACK: "1" } }),
    ];
    for (const client of clients) {
      assert.equal(client.enabled, false);
      assert.equal(client.disabledReason, REASON_ENVIRONMENT);
      await client.report("startup");
      await client.close();
    }
    await sleep(200);
    assert.deepEqual(capture.requests, []);
  });

  it("checks the environment before enabled and the key", () => {
    const off = { TRACE_USAGE_REPORTING: "off" };
    assert.equal(new TraceClient(baseUrl, "MyGame", { key: "k", enabled: false, env: off }).disabledReason, REASON_ENVIRONMENT);
    assert.equal(new TraceClient(baseUrl, "MyGame", { env: off }).disabledReason, REASON_ENVIRONMENT);
    assert.equal(new TraceClient(baseUrl, "MyGame", { enabled: false, env: {} }).disabledReason, REASON_CONFIG);
    assert.equal(new TraceClient(baseUrl, "MyGame", { key: "  ", env: {} }).disabledReason, REASON_NO_KEY);
    assert.equal(TraceClient.disabled().disabledReason, REASON_CONFIG);
  });

  it("reports null as the reason when on, and keeps the build reason after close()", async () => {
    const on = new TraceClient(baseUrl, "MyGame", { key: "k", env: {} });
    assert.equal(on.disabledReason, null);
    assert.equal(on.enabled, true);
    await on.close();
    assert.equal(on.enabled, false);
    assert.equal(on.disabledReason, null, "close() is not a reason the client was built off");
    const off = new TraceClient(baseUrl, "MyGame", { key: "k", enabled: false });
    await off.close();
    assert.equal(off.disabledReason, REASON_CONFIG);
  });

  it("reads process.env by default", async () => {
    process.env.TRACE_USAGE_REPORTING = "off";
    assert.equal(new TraceClient(baseUrl, "MyGame", { key: "k" }).disabledReason, REASON_ENVIRONMENT);
    delete process.env.TRACE_USAGE_REPORTING;
    process.env.DO_NOT_TRACK = "true";
    assert.equal(new TraceClient(baseUrl, "MyGame", { key: "k" }).disabledReason, REASON_ENVIRONMENT);
    delete process.env.DO_NOT_TRACK;
    const client = new TraceClient(baseUrl, "MyGame", { key: "k" });
    assert.equal(client.disabledReason, null);
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    await client.close();
  });

  it("an explicit env replaces process.env rather than adding to it", () => {
    process.env.TRACE_USAGE_REPORTING = "off";
    const client = new TraceClient(baseUrl, "MyGame", { key: "k", env: {} });
    assert.equal(client.disabledReason, null);
    assert.equal(environmentOptsOut(), true);
    assert.equal(environmentOptsOut({}), false);
  });

  it("works in a runtime with no process, or whose environment cannot be read", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
    assert.ok(descriptor, "Node defines globalThis.process");
    const swapIn = (value: unknown) => Object.defineProperty(globalThis, "process", { value, configurable: true, writable: true });
    const built: TraceClient[] = [];
    let noProcess: boolean;
    let throwingEnv: boolean;
    try {
      // Built synchronously while swapped out, so nothing else runs meanwhile.
      swapIn(undefined);
      noProcess = environmentOptsOut();
      built.push(new TraceClient(baseUrl, "MyGame", { key: "k" }));
      swapIn({
        get env(): never {
          throw new Error("env access denied");
        },
      });
      throwingEnv = environmentOptsOut();
      built.push(new TraceClient(baseUrl, "MyGame", { key: "k" }));
      swapIn({});
      built.push(new TraceClient(baseUrl, "MyGame", { key: "k" }));
    } finally {
      Object.defineProperty(globalThis, "process", descriptor);
    }
    assert.equal(noProcess, false);
    assert.equal(throwingEnv, false);
    for (const client of built) {
      assert.equal(client.disabledReason, null);
      await client.report("startup");
      await client.close();
    }
    assert.equal(capture.requests.length, built.length);
  });

  it("an env whose lookups throw opts nothing out and does not escape", () => {
    const hostile = new Proxy({}, {
      get(): never {
        throw new Error("no");
      },
    });
    assert.equal(environmentOptsOut(hostile), false);
    assert.equal(new TraceClient(baseUrl, "MyGame", { key: "k", env: hostile }).disabledReason, null);
  });
});

describe("pagePath", () => {
  it("keeps the path and drops query, fragment, host and trailing slash", () => {
    assert.equal(pagePath("/a/b/?x=1#f"), "/a/b");
    assert.equal(pagePath("https://h/x"), "/x");
    assert.equal(pagePath("https://h/x/y/?q=1"), "/x/y");
    assert.equal(pagePath("https://h"), "/");
    assert.equal(pagePath("/"), "/");
    assert.equal(pagePath("/?utm=1"), "/");
    assert.equal(pagePath("//a//b/"), "/a/b");
    assert.equal(pagePath("about"), "/about");
    assert.equal(pagePath(""), "/");
    assert.equal(pagePath(undefined as unknown as string), "/");
  });

  it("truncates long paths to 200 characters", () => {
    const long = "/" + "x".repeat(500);
    assert.equal(pagePath(long).length, 200);
    assert.equal(pagePath(long), "/" + "x".repeat(199));
  });

  it("falls back to the root for a non-string or an unparseable absolute URL", () => {
    assert.equal(pagePath(42 as unknown as string), "/");
    assert.equal(pagePath(null as unknown as string), "/");
    assert.equal(pagePath("http://[not-a-host/page?q=1"), "/");
  });
});

describe("isBot", () => {
  const bots = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
    "curl/8.5.0",
    "Wget/1.21.4",
    "python-requests/2.31.0",
    "Go-http-client/1.1",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
    "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "Twitterbot/1.0",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)",
    "Screaming Frog SEO Spider/19.0",
    "Some Generic Web Crawler 1.0",
  ];
  const humans = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  ];

  it("recognises crawlers, monitors and scripts", () => {
    for (const ua of bots) assert.equal(isBot(ua), true, ua);
  });

  it("does not flag real browsers", () => {
    for (const ua of humans) assert.equal(isBot(ua), false, ua);
  });

  it("treats a missing or empty User-Agent as a bot", () => {
    assert.equal(isBot(null), true);
    assert.equal(isBot(undefined), true);
    assert.equal(isBot(""), true);
    assert.equal(isBot("   "), true);
  });
});
