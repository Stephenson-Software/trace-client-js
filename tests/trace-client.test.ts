// Drives the client against a real HTTP server on a loopback port -- Node's
// own, so the tests have no more dependencies than the client does.
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { TraceClient, TRACE_CLIENT_VERSION, isBot, pagePath } from "../trace-client.ts";

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
