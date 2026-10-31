// Drives the client against a real HTTP server on a loopback port -- Node's
// own, so the tests have no more dependencies than the client does.
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clientModule from "../trace-client.ts";
import { TraceClient, TRACE_CLIENT_VERSION, isBot, pagePath } from "../trace-client.ts";
import type { ReportOptions, TraceClientOptions } from "../trace-client.ts";

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
    const client = new TraceClient(baseUrl + "/", "MyGame", { version: "1.2.3", key: "k-123", debug });
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    const request = capture.requests[0];
    assert.equal(request.path, "/api/metrics", "a trailing slash on the base URL must not double up");
    assert.equal(request.headers.authorization, "Bearer k-123");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["user-agent"], `trace-client-js/${TRACE_CLIENT_VERSION} (MyGame)`);
    assert.deepEqual(JSON.parse(request.body), { application: "MyGame", name: "startup", tags: { version: "1.2.3" } });
    assert.deepEqual(log, []);
    await client.close();
  });

  it("trims the base URL, application and key, and drops every trailing slash", async () => {
    const client = new TraceClient(` ${baseUrl}/// `, "  MyGame ", { version: "1.2.3", key: " k-123  ", debug });
    await client.report("startup");
    assert.equal(capture.requests.length, 1, "surrounding space must not make the base URL unusable");
    const request = capture.requests[0];
    assert.equal(request.path, "/api/metrics", "runs of trailing slashes must not double up");
    assert.equal(request.headers.authorization, "Bearer k-123", "the key is sent trimmed");
    assert.equal(request.headers["user-agent"], `trace-client-js/${TRACE_CLIENT_VERSION} (MyGame)`);
    assert.equal(JSON.parse(request.body).application, "MyGame", "the application is sent trimmed");
    assert.deepEqual(log, []);
    await client.close();
  });

  it("omits value when undefined and carries value and tags when given, plus the program version", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    await client.report("world-load", { value: 2.5, tags: { seed: "42", size: 'the "big" one' } });
    await client.report("plain", { value: undefined, tags: {} });
    await client.report("nan", { value: Number.NaN });
    assert.deepEqual(JSON.parse(capture.requests[0].body), {
      application: "MyGame",
      name: "world-load",
      value: 2.5,
      tags: { seed: "42", size: 'the "big" one', version: "1.2.3" },
    });
    assert.deepEqual(JSON.parse(capture.requests[1].body), { application: "MyGame", name: "plain", tags: { version: "1.2.3" } });
    assert.deepEqual(JSON.parse(capture.requests[2].body), { application: "MyGame", name: "nan", tags: { version: "1.2.3" } });
    await client.close();
  });

  it("never rejects when nothing is listening", async () => {
    const probe = await serve(new Capture());
    const deadUrl = baseUrlOf(probe);
    await stop(probe);
    const client = new TraceClient(deadUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    await client.report("startup"); // must resolve, not reject
    assert.ok(log.some((line) => line.includes("could not deliver")), log.join("\n"));
    await client.close();
  });

  it("never rejects when the server answers 500", async () => {
    capture.replyStatus = 500;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    assert.ok(log.some((line) => line.includes("answered 500")), log.join("\n"));
    await client.close();
  });

  it("never rejects when the server rejects the key", async () => {
    capture.replyStatus = 401;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "revoked", debug });
    await client.report("startup");
    assert.ok(log.some((line) => line.includes("answered 401")), log.join("\n"));
    await client.close();
  });

  it("gives up within the timeout when the server hangs", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", timeoutMs: 300, debug });
    const before = Date.now();
    await client.report("startup");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 2000, `report() took ${elapsed}ms; it must be bounded by the timeout`);
    assert.ok(log.some((line) => line.includes("could not deliver")), log.join("\n"));
    await client.close();
  });

  it("returns already-started work rather than waiting on the network", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", timeoutMs: 500 });
    const before = Date.now();
    const work = client.report("startup");
    assert.ok(Date.now() - before < 100, "report() itself must return at once");
    assert.ok(await capture.arrived(1), "the request should already be on the wire");
    await work;
    await client.close();
  });

  it("caps requests in flight and drops the rest", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", timeoutMs: 1000, debug });
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
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    for (let i = 0; i < TraceClient.IN_FLIGHT_CAPACITY + 10; i++) await client.report("one-at-a-time");
    assert.equal(capture.requests.length, TraceClient.IN_FLIGHT_CAPACITY + 10);
    assert.deepEqual(log, []);
    await client.close();
  });

  it("frees a slot when a request fails or the server rejects it", async () => {
    // A server that is down or refusing the key for longer than the cap must
    // not leave the client full for good: each failure gives its slot back.
    let calls = 0;
    const client = new TraceClient(baseUrl, "MyGame", {
      version: "1.2.3",
      key: "k",
      debug,
      fetch: (async () => {
        calls++;
        if (calls % 2 === 0) throw new Error("connection refused");
        return new Response(null, { status: 500 });
      }) as typeof fetch,
    });
    const total = TraceClient.IN_FLIGHT_CAPACITY + 10;
    for (let i = 0; i < total; i++) await client.report("one-at-a-time");
    assert.equal(calls, total, "every report must reach fetch; a leaked slot would start dropping them");
    assert.ok(!log.some((line) => line.includes("in-flight cap reached")), log.join("\n"));
    assert.equal(log.filter((line) => line.includes("could not deliver")).length, total / 2);
    assert.equal(log.filter((line) => line.includes("answered 500")).length, total / 2);
    await client.close();
  });

  it("frees every slot once requests are given up after the timeout", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", timeoutMs: 500, debug });
    const work: Promise<void>[] = [];
    for (let i = 0; i < TraceClient.IN_FLIGHT_CAPACITY; i++) work.push(client.report("hung"));
    await Promise.all(work); // each one is aborted after the timeout
    assert.equal(
      log.filter((line) => line.includes("could not deliver")).length,
      TraceClient.IN_FLIGHT_CAPACITY,
      "every hung request is given up and logged",
    );
    capture.hang = false;
    await client.report("after");
    assert.ok(
      !log.some((line) => line.includes("in-flight cap reached")),
      "a full set of timed-out requests must not keep the client full",
    );
    assert.ok(
      capture.requests.some((request) => JSON.parse(request.body).name === "after"),
      "the report after the timeouts must be sent",
    );
    await client.close();
  });

  it("sends nothing when disabled or without a key", async () => {
    const clients = [
      new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", enabled: false }),
      new TraceClient(baseUrl, "MyGame", { version: "1.2.3" }),
      new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "  " }),
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

  it("treats a non-string key from untyped code as missing rather than throwing", async () => {
    for (const key of [42, true, {}]) {
      const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: key as unknown as string });
      assert.equal(client.enabled, false, `key=${String(key)} must not enable the client`);
      assert.equal(client.disabledReason, REASON_NO_KEY);
      await client.report("startup");
      await client.close();
    }
    assert.deepEqual(capture.requests, []);
  });

  it("ignores a blank name", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    await client.report("");
    await client.report("   ");
    await client.close();
    assert.deepEqual(capture.requests, []);
  });

  it("logs nothing for a report that was never going to be sent", async () => {
    // Only drops of a report an enabled client meant to send reach debug.
    const off = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", enabled: false, debug });
    await off.report("startup");
    const keyless = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", debug });
    await keyless.report("startup");
    const on = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    for (const name of ["", "   ", 42, undefined, null]) {
      await on.report(name as unknown as string);
    }
    await on.close();
    await on.report("after-close");
    await sleep(100);
    assert.deepEqual(capture.requests, []);
    assert.deepEqual(log, [], "a disabled or closed client, or a blank or non-string name, is not a drop");
  });

  it("omits a value that is not a number", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    for (const value of ["5", null, true]) {
      await client.report("loose", { value: value as unknown as number });
    }
    assert.equal(capture.requests.length, 3);
    for (const request of capture.requests) {
      assert.deepEqual(JSON.parse(request.body), { application: "MyGame", name: "loose", tags: { version: "1.2.3" } });
    }
    await client.close();
  });

  it("sends the event when untyped code passes null or a non-object as options", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    for (const options of [null, 42, "loose"]) {
      await client.report("startup", options as unknown as ReportOptions);
    }
    assert.equal(capture.requests.length, 3, "no options was meant, so nothing is dropped");
    for (const request of capture.requests) {
      assert.deepEqual(JSON.parse(request.body), { application: "MyGame", name: "startup", tags: { version: "1.2.3" } });
    }
    await client.close();
    assert.deepEqual(log, [], "a missing options object is not a serialize failure");
  });

  it("does not throw when reading the options throws", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    const hostile = {
      get value(): number {
        throw new Error("boom");
      },
    };
    await client.report("startup", hostile);
    await client.close();
    assert.deepEqual(capture.requests, []);
    assert.equal(log.length, 1, "the drop goes to debug instead of escaping report()");
    assert.match(log[0], /could not serialize startup/);
  });

  it("rejects a missing baseUrl or application at construction", () => {
    assert.throws(() => new TraceClient("", "MyGame", { version: "1.2.3" }));
    assert.throws(() => new TraceClient("  ", "MyGame", { version: "1.2.3" }));
    assert.throws(() => new TraceClient(baseUrl, "", { version: "1.2.3" }));
    assert.throws(() => new TraceClient(baseUrl, "   ", { version: "1.2.3" }));
  });

  it("names the bad argument when construction fails", () => {
    assert.throws(() => new TraceClient("", "MyGame", { version: "1.2.3" }), /baseUrl/);
    assert.throws(() => new TraceClient(undefined as unknown as string, "MyGame", { version: "1.2.3" }), /baseUrl/);
    assert.throws(() => new TraceClient(baseUrl, "", { version: "1.2.3" }), /application/);
    assert.throws(() => new TraceClient(baseUrl, 42 as unknown as string, { version: "1.2.3" }), /application/);
  });

  it("falls back to the default timeout when timeoutMs is not a positive finite number", async () => {
    // Used as-is, each of these would abort the request before the stub answers.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let aborted: boolean | undefined;
      const client = new TraceClient(baseUrl, "MyGame", {
        version: "1.2.3",
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

  it("drops null and undefined tags, coerces other values to strings, and leaves only the program version when none remain", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
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
      tags: { keep: "x", count: "3", flag: "true", version: "1.2.3" },
    });
    assert.deepEqual(JSON.parse(capture.requests[1].body), { application: "MyGame", name: "empty", tags: { version: "1.2.3" } });
    assert.deepEqual(JSON.parse(capture.requests[2].body), { application: "MyGame", name: "zero", value: 0, tags: { version: "1.2.3" } });
    await client.close();
  });

  it("drops a report whose tags cannot be serialized, without throwing", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
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
    const answered = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    await answered.report("startup");
    await answered.close();
    assert.equal(capture.requests.length, 1);
    const unreadable = new TraceClient(baseUrl, "MyGame", {
      version: "1.2.3",
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
        version: "1.2.3",
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

  it("gives each dropped report one debug line, prefixed [trace], naming the report or the body sent", async () => {
    const sent = (name: string) => JSON.stringify({ application: "MyGame", name, tags: { version: "1.2.3" } });
    const linesFrom = async (options: Partial<TraceClientOptions>, run: (client: TraceClient) => Promise<unknown>) => {
      const lines: string[] = [];
      const client = new TraceClient(baseUrl, "MyGame", {
        version: "1.2.3",
        key: "k",
        debug: (message) => lines.push(message),
        ...options,
      });
      await run(client);
      await client.close();
      return lines;
    };

    capture.replyStatus = 500;
    assert.deepEqual(await linesFrom({}, (client) => client.report("rejected")), [
      `[trace] trace server answered 500 for ${sent("rejected")}`,
    ]);

    const refused = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    assert.deepEqual(await linesFrom({ fetch: refused }, (client) => client.report("failed")), [
      `[trace] could not deliver ${sent("failed")}: Error: connection refused`,
    ]);

    const hostile = {
      toString(): never {
        throw new Error("no string for you");
      },
    };
    assert.deepEqual(
      await linesFrom({}, (client) => client.report("broken", { tags: { bad: hostile as unknown as string } })),
      ["[trace] could not serialize broken: Error: no string for you"],
    );

    // A fetch that holds every slot until its abort, so the next report meets a full client.
    const holding = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const full = await linesFrom({ fetch: holding, timeoutMs: 300 }, async (client) => {
      const work: Promise<void>[] = [];
      for (let i = 0; i < TraceClient.IN_FLIGHT_CAPACITY; i++) work.push(client.report("held"));
      work.push(client.report("overflow"));
      await Promise.all(work);
    });
    assert.equal(full.length, TraceClient.IN_FLIGHT_CAPACITY + 1, "one line per drop, no more");
    assert.equal(full[0], "[trace] in-flight cap reached, dropped overflow");
    for (const line of full.slice(1)) assert.equal(line, `[trace] could not deliver ${sent("held")}: Error: aborted`);
  });

  it("flush() and close() treat a negative or non-finite timeout as zero", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", timeoutMs: 3000 });
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
      version: "1.2.3",
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

  it("never throws or rejects in a runtime with no global fetch", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    assert.ok(descriptor, "Node defines globalThis.fetch");
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
    let work: Promise<void> = Promise.resolve();
    try {
      // report() looks fetch up before it returns, so it only has to be gone meanwhile.
      Object.defineProperty(globalThis, "fetch", { value: undefined, configurable: true, writable: true });
      work = client.report("startup");
    } finally {
      Object.defineProperty(globalThis, "fetch", descriptor);
    }
    await work; // must resolve
    await client.close();
    assert.deepEqual(capture.requests, []);
    assert.ok(
      log.some((line) => line.includes("could not deliver") && line.includes("TypeError")),
      log.join("\n"),
    );
  });

  it("delivers a report followed by an immediate close()", async () => {
    // A CLI reports once and exits at once. close() must drain what is in flight.
    for (let i = 0; i < 30; i++) {
      const client = new TraceClient(baseUrl, "MyCli", { version: "1.2.3", key: "k" });
      client.report("startup", { tags: { run: String(i) } });
      await client.close();
    }
    assert.equal(capture.requests.length, 30, "every report()+close() pair must deliver");
  });

  it("close() returns within the timeout when the server hangs", async () => {
    capture.hang = true;
    const client = new TraceClient(baseUrl, "MyCli", { version: "1.2.3", key: "k" });
    client.report("startup");
    const before = Date.now();
    await client.close(500);
    assert.ok(Date.now() - before < 2000, "draining must be bounded by the timeout");
  });

  it("flush() waits for in-flight work and is bounded too", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
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

  it("flush() and close() with no argument wait at most the client's own timeout, even when fetch ignores the abort", async () => {
    // A fetch that never settles, abort or not: only the drain's own bound can end the wait.
    const client = new TraceClient(baseUrl, "MyGame", {
      version: "1.2.3",
      key: "k",
      timeoutMs: 300,
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    client.report("startup");
    for (const [label, drain] of [
      ["flush()", () => client.flush()],
      ["close()", () => client.close()],
    ] as const) {
      const before = Date.now();
      await drain();
      const elapsed = Date.now() - before;
      assert.ok(elapsed >= 250, `${label} took ${elapsed}ms; it must wait for in-flight work up to the timeout`);
      assert.ok(
        elapsed < 2000,
        `${label} took ${elapsed}ms; it must default to timeoutMs (300), not ${TraceClient.TIMEOUT_MS} or forever`,
      );
    }
    assert.equal(client.enabled, false);
  });

  it("rejects a missing, blank or overlong version at construction", () => {
    const withOptions = (options: unknown) => () => new TraceClient(baseUrl, "MyGame", options as { version: string });
    assert.throws(withOptions(undefined), /version is required/);
    assert.throws(withOptions({}), /version is required/);
    assert.throws(withOptions({ key: "k" }), /version is required/);
    assert.throws(withOptions({ version: "" }), /version is required/);
    assert.throws(withOptions({ version: "   " }), /version is required/);
    assert.throws(withOptions({ version: 3 }), /version is required/);
    const longest = "9".repeat(TraceClient.MAX_VERSION_LENGTH);
    assert.throws(withOptions({ version: longest + "9" }), /longer than 255/);
    // The limit applies after trimming, so surrounding space does not count.
    assert.doesNotThrow(withOptions({ version: ` ${longest} ` }));
  });

  it("tags every event with the program version, trimmed", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: " 2.0.0-SNAPSHOT ", key: "k" });
    await client.report("command", { tags: { name: "home" } });
    await client.report("page-view", { value: 1 });
    await client.report("tool-call", { tags: { tool: "search", version: null as unknown as string } });
    assert.deepEqual(JSON.parse(capture.requests[0].body), {
      application: "MyGame",
      name: "command",
      tags: { name: "home", version: "2.0.0-SNAPSHOT" },
    });
    assert.deepEqual(JSON.parse(capture.requests[1].body), {
      application: "MyGame",
      name: "page-view",
      value: 1,
      tags: { version: "2.0.0-SNAPSHOT" },
    });
    assert.deepEqual(
      JSON.parse(capture.requests[2].body).tags,
      { tool: "search", version: "2.0.0-SNAPSHOT" },
      "a null version tag is dropped, so the program version fills it",
    );
    await client.close();
  });

  it("lets an event's own version tag win over the program version", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    await client.report("startup", { tags: { version: "9.9.9" } });
    assert.deepEqual(JSON.parse(capture.requests[0].body), {
      application: "MyGame",
      name: "startup",
      tags: { version: "9.9.9" },
    });
    await client.close();
  });

  it("never modifies the caller's tags object", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    const tags = Object.freeze({ name: "home" }) as Record<string, string>;
    const unfrozen: Record<string, string> = { name: "home" };
    await client.report("command", { tags });
    await client.report("command", { tags: unfrozen });
    assert.deepEqual(unfrozen, { name: "home" }, "the caller's object must not gain a version");
    assert.equal(capture.requests.length, 2, "a frozen tags object must not stop the report");
    for (const request of capture.requests) {
      assert.deepEqual(JSON.parse(request.body).tags, { name: "home", version: "1.2.3" });
    }
    await client.close();
  });

  it("report() after close() is a no-op, and close() is idempotent", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", debug });
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

describe("installation ID", () => {
  let capture: Capture;
  let server: Server;
  let baseUrl: string;
  let dir: string;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  beforeEach(async () => {
    capture = new Capture();
    server = await serve(capture);
    baseUrl = baseUrlOf(server);
    dir = mkdtempSync(join(tmpdir(), "trace-install-"));
  });

  afterEach(async () => {
    capture.release();
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
    for (const name of OPT_OUT_VARIABLES) delete process.env[name];
  });

  const tagsOf = (index: number) => JSON.parse(capture.requests[index].body).tags;

  it("persists a random ID once, creating parent directories, and reuses it", async () => {
    const file = join(dir, "nested", "deeper", "install-id");
    const first = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installIdFile: file });
    assert.match(first.installId ?? "", UUID);
    assert.equal(readFileSync(file, "utf8"), first.installId + "\n");
    const second = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installIdFile: file });
    assert.equal(second.installId, first.installId);
    assert.equal(TraceClient.installIdFromFile(file), first.installId);
    await first.report("startup");
    assert.deepEqual(tagsOf(0), { version: "1.0", install: first.installId });
    await first.close();
    await second.close();
  });

  it("reads the first valid line, and replaces a file that has none", () => {
    const file = join(dir, "id");
    writeFileSync(file, "\n  not valid!  \n  my-server_1.0  \nsecond\n");
    assert.equal(TraceClient.installIdFromFile(file), "my-server_1.0");
    writeFileSync(file, "nothing usable here\n" + "x".repeat(256) + "\n");
    const made = TraceClient.installIdFromFile(file);
    assert.match(made, UUID);
    assert.equal(readFileSync(file, "utf8"), made + "\n");
  });

  it("falls back to an in-memory ID when the file cannot be read or written, without throwing", () => {
    // A directory cannot be read as a file: left alone, not overwritten.
    const asDirectory = TraceClient.installIdFromFile(dir);
    assert.match(asDirectory, UUID);
    // A parent that is a regular file cannot hold a directory: write fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file\n");
    const underFile = join(blocker, "sub", "id");
    const id = TraceClient.installIdFromFile(underFile);
    assert.match(id, UUID);
    assert.equal(readFileSync(blocker, "utf8"), "a file\n");
    assert.notEqual(TraceClient.installIdFromFile(underFile), id, "nothing persisted, so a new one each call");
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installIdFile: underFile });
    assert.match(client.installId ?? "", UUID);
    for (const bad of ["", "   ", null, undefined, 42]) {
      assert.match(TraceClient.installIdFromFile(bad as unknown as string), UUID);
    }
  });

  it("never creates the file or makes up an ID when disabled", () => {
    const file = join(dir, "sub", "install-id");
    const disabled = [
      new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", enabled: false, installIdFile: file }),
      new TraceClient(baseUrl, "MyGame", { version: "1.0", installIdFile: file }),
      new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", env: { TRACE_USAGE_REPORTING: "off" }, installIdFile: file }),
      new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", env: { DO_NOT_TRACK: "1" }, installIdFile: file, installId: "explicit" }),
    ];
    process.env.DO_NOT_TRACK = "1";
    disabled.push(new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installIdFile: file }));
    for (const client of disabled) {
      assert.equal(client.enabled, false);
      assert.equal(client.installId, null);
    }
    assert.equal(existsSync(join(dir, "sub")), false, "a disabled client must write nothing");
    assert.equal(TraceClient.disabled().installId, null);
  });

  it("sends no install tag when no ID is configured", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k" });
    assert.equal(client.installId, null);
    await client.report("startup");
    assert.deepEqual(tagsOf(0), { version: "1.0" });
    await client.close();
  });

  it("uses an explicit ID, trimmed, over the file; blank means none; overlong throws", async () => {
    const file = join(dir, "install-id");
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: "  abc-123 ", installIdFile: file });
    assert.equal(client.installId, "abc-123");
    assert.equal(existsSync(file), false, "an explicit ID wins, so the file is not touched");
    await client.report("startup");
    assert.deepEqual(tagsOf(0), { version: "1.0", install: "abc-123" });
    await client.close();
    for (const blank of ["", "   ", null, undefined]) {
      assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: blank }).installId, null);
    }
    const blankWithFile = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: " ", installIdFile: file });
    assert.match(blankWithFile.installId ?? "", UUID, "a blank explicit ID falls through to the file");
    const longest = "i".repeat(TraceClient.MAX_VERSION_LENGTH);
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: ` ${longest} ` }).installId, longest);
    assert.throws(
      () => new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: longest + "i" }),
      /installId is longer than 255/,
    );
  });

  it("treats a non-string installId as none, falling through to the file", () => {
    const file = join(dir, "install-id");
    for (const loose of [42, true, {}]) {
      const options = { version: "1.0", key: "k", installId: loose as unknown as string };
      assert.equal(new TraceClient(baseUrl, "MyGame", options).installId, null, `installId=${String(loose)}`);
    }
    const withFile = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: 42 as unknown as string, installIdFile: file });
    assert.match(withFile.installId ?? "", UUID);
    assert.equal(readFileSync(file, "utf8"), withFile.installId + "\n");
    for (const blank of ["", "   ", null]) {
      assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installIdFile: blank }).installId, null);
    }
  });

  it("reads an ID from a file with Windows line endings", () => {
    const file = join(dir, "id");
    writeFileSync(file, "\r\n  my-server_1.0 \r\nsecond\r\n");
    assert.equal(TraceClient.installIdFromFile(file), "my-server_1.0");
    assert.equal(readFileSync(file, "utf8"), "\r\n  my-server_1.0 \r\nsecond\r\n", "a file with an ID is not rewritten");
  });

  it("lets an event's own install tag win, without modifying the caller's tags", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: "mine" });
    const tags = { install: "theirs" };
    await client.report("startup", { tags });
    await client.report("startup", { tags: { install: null as unknown as string } });
    assert.deepEqual(tagsOf(0), { install: "theirs", version: "1.0" });
    assert.deepEqual(tagsOf(1), { version: "1.0", install: "mine" }, "a null install tag is dropped, so the ID fills it");
    assert.deepEqual(tags, { install: "theirs" });
    await client.close();
  });

  it("never pushes an event past the tag cap", async () => {
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.0", key: "k", installId: "mine" });
    const full: Record<string, string> = {};
    for (let i = 0; i < TraceClient.MAX_TAGS - 1; i++) full["t" + i] = String(i);
    await client.report("full", { tags: full }); // 31 + version = 32: no room
    const room: Record<string, string> = {};
    for (let i = 0; i < TraceClient.MAX_TAGS - 2; i++) room["t" + i] = String(i);
    await client.report("room", { tags: room }); // 30 + version = 31: install fits
    assert.equal(TraceClient.MAX_TAGS, 32);
    assert.equal(Object.keys(tagsOf(0)).length, 32);
    assert.equal(tagsOf(0).install, undefined);
    assert.equal(Object.keys(tagsOf(1)).length, 32);
    assert.equal(tagsOf(1).install, "mine");
    await client.close();
  });

  it("keeps the ID in memory where the runtime has no getBuiltinModule", () => {
    const file = join(dir, "install-id");
    const original = process.getBuiltinModule;
    try {
      (process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
      assert.match(TraceClient.installIdFromFile(file), UUID);
    } finally {
      process.getBuiltinModule = original;
    }
    assert.equal(existsSync(file), false);
  });

  it("makes a UUID-shaped ID without throwing where crypto.randomUUID is missing or throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    assert.ok(descriptor, "Node defines globalThis.crypto");
    const standIns = [
      undefined,
      {},
      {
        randomUUID(): never {
          throw new Error("no entropy here");
        },
      },
    ];
    try {
      for (const standIn of standIns) {
        Object.defineProperty(globalThis, "crypto", { value: standIn, configurable: true, writable: true });
        const first = TraceClient.installIdFromFile("");
        const second = TraceClient.installIdFromFile("");
        assert.match(first, UUID, `crypto=${JSON.stringify(standIn)} must still yield a UUID-shaped ID`);
        assert.match(second, UUID);
        assert.notEqual(first, second, "each fallback ID is fresh");
      }
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });
});

describe("API shape", () => {
  it("exports exactly the values 0.1.0 did", () => {
    assert.deepEqual(Object.keys(clientModule).sort(), ["TRACE_CLIENT_VERSION", "TraceClient", "isBot", "pagePath"]);
  });

  it("keeps the constructor, report, flush, close and disabled() shapes, with version now required", async () => {
    const client = new TraceClient("http://127.0.0.1:9", "MyGame", { version: "1.2.3", key: "k", enabled: true, timeoutMs: 50, fetch, debug: () => {}, env: {} });
    assert.equal(client.enabled, true);
    assert.equal(await client.report("startup", { value: 1, tags: { version: "1" } }), undefined);
    assert.equal(await client.flush(50), undefined);
    assert.equal(await client.close(50), undefined);
    assert.equal(TraceClient.disabled().enabled, false);
    assert.equal(TRACE_CLIENT_VERSION, "0.4.1");
  });

  it("keeps the documented values of its public constants, which the Python and Java clients share", () => {
    assert.equal(TraceClient.IN_FLIGHT_CAPACITY, 256);
    assert.equal(TraceClient.TIMEOUT_MS, 5000);
    assert.equal(TraceClient.MAX_VERSION_LENGTH, 255);
    assert.equal(TraceClient.MAX_TAGS, 32);
    assert.equal(TraceClient.INSTALL_TAG, "install");
    assert.equal(TraceClient.ENV_TRACE_USAGE_REPORTING, "TRACE_USAGE_REPORTING");
    assert.equal(TraceClient.ENV_DO_NOT_TRACK, "DO_NOT_TRACK");
    assert.equal(REASON_ENVIRONMENT, "environment");
    assert.equal(REASON_CONFIG, "config");
    assert.equal(REASON_NO_KEY, "no key");
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
      new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", env: { TRACE_USAGE_REPORTING: "off" } }),
      new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", env: { DO_NOT_TRACK: "1" } }),
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
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", enabled: false, env: off }).disabledReason, REASON_ENVIRONMENT);
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", env: off }).disabledReason, REASON_ENVIRONMENT);
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", enabled: false, env: {} }).disabledReason, REASON_CONFIG);
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "  ", env: {} }).disabledReason, REASON_NO_KEY);
    assert.equal(TraceClient.disabled().disabledReason, REASON_CONFIG);
  });

  it("reports null as the reason when on, and keeps the build reason after close()", async () => {
    const on = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", env: {} });
    assert.equal(on.disabledReason, null);
    assert.equal(on.enabled, true);
    await on.close();
    assert.equal(on.enabled, false);
    assert.equal(on.disabledReason, null, "close() is not a reason the client was built off");
    const off = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", enabled: false });
    await off.close();
    assert.equal(off.disabledReason, REASON_CONFIG);
  });

  it("reads process.env by default", async () => {
    process.env.TRACE_USAGE_REPORTING = "off";
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" }).disabledReason, REASON_ENVIRONMENT);
    delete process.env.TRACE_USAGE_REPORTING;
    process.env.DO_NOT_TRACK = "true";
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" }).disabledReason, REASON_ENVIRONMENT);
    delete process.env.DO_NOT_TRACK;
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" });
    assert.equal(client.disabledReason, null);
    await client.report("startup");
    assert.equal(capture.requests.length, 1);
    await client.close();
  });

  it("an explicit env replaces process.env rather than adding to it", () => {
    process.env.TRACE_USAGE_REPORTING = "off";
    const client = new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", env: {} });
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
      built.push(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" }));
      swapIn({
        get env(): never {
          throw new Error("env access denied");
        },
      });
      throwingEnv = environmentOptsOut();
      built.push(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" }));
      swapIn({});
      built.push(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k" }));
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
    assert.equal(new TraceClient(baseUrl, "MyGame", { version: "1.2.3", key: "k", env: hostile }).disabledReason, null);
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

  it("leaves no trailing slash when the cut at 200 characters lands on one", () => {
    const path = pagePath("/" + "a".repeat(198) + "/b");
    assert.equal(path, "/" + "a".repeat(198), "a truncated path must not end in a slash");
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
    // HTTP libraries and API tools
    "okhttp/4.12.0",
    "Java/17.0.10",
    "Apache-HttpClient/4.5.14 (Java/17.0.8)",
    "axios/1.6.8",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "undici",
    "PostmanRuntime/7.37.3",
    "insomnia/2023.5.8",
    "HTTPie/3.2.2",
    "Python-urllib/3.11",
    "libwww-perl/6.72",
    "Scrapy/2.11.1 (+https://scrapy.org)",
    // AI crawlers
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "CCBot/2.0 (https://commoncrawl.org/faq/)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    // Link previewers
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "WhatsApp/2.23.20.0",
    "TelegramBot (like TwitterBot)",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "redditbot/1.0",
    // Search engines and SEO crawlers
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
    "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
    "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
    // Uptime monitors
    "Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
    "Mozilla/5.0 (compatible; StatusCake)",
  ];
  const humans = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
    "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
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
