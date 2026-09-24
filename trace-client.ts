/**
 * trace-client 0.2.0 -- https://github.com/Stephenson-Software/trace-client-js
 *
 * One call to report that a program was used. Copy this file into a project
 * as is; there is nothing else to add. Zero dependencies and no Node-only
 * APIs -- only `fetch`, `AbortController`, `setTimeout` and `URL`, plus
 * `process.env` when the runtime has one -- so it runs in Node 18+, in the
 * Next.js Edge runtime, and in any other runtime that has those four.
 *
 * MIT licensed. Keep this header when vendoring so the file can be found again.
 */

export const TRACE_CLIENT_VERSION = "0.2.0";

// Everything new in 0.2.0 hangs off TraceClient (static members) rather than
// being a new top-level export, so the file's exported values stay exactly
// those of 0.1.0 -- TRACE_CLIENT_VERSION, TraceClient, pagePath, isBot -- and
// a consumer that re-vendors it (or derives CommonJS from it) needs no change.

/** Why a client reports nothing; see {@link TraceClient.disabledReason}. First match wins, in this order. */
export type DisabledReason = "environment" | "config" | "no key";

/** An environment to read the opt-outs from: `process.env`, or a stand-in. */
export type Environment = Readonly<Record<string, string | undefined>>;

const OFF_VALUES = ["off", "false", "0", "no"];
const DO_NOT_TRACK_VALUES = ["1", "true", "yes"];

// Declared here rather than taken from @types/node so the file still
// type-checks against ES2022 + DOM alone; at runtime `process` may simply not
// exist (a browser-like edge runtime), which processEnvironment() allows for.
declare const process: { env?: Record<string, string | undefined> } | undefined;

export interface TraceClientOptions {
  /** The program's write key. Blank or missing yields a client that does nothing. */
  key?: string;
  /** The opt-out switch. `false` yields a client that does nothing. Default `true`. */
  enabled?: boolean;
  /** Per-request timeout in milliseconds. Default {@link TraceClient.TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The `fetch` to use. Default: the global one. */
  fetch?: typeof fetch;
  /** Receives one line per dropped report. Default: silence. */
  debug?: (message: string) => void;
  /**
   * Where to read `TRACE_USAGE_REPORTING` and `DO_NOT_TRACK` from. Default:
   * `process.env` when the runtime has one, otherwise nothing. Pass the
   * handler's `env` in a runtime that has no `process` (Cloudflare Workers),
   * or a stand-in in tests.
   */
  env?: Environment;
}

export interface ReportOptions {
  /** An optional number to attach to the event. NaN and infinities are omitted. */
  value?: number;
  /** Optional string tags. */
  tags?: Record<string, string>;
}

/**
 * Reports usage events to a trace server, and never gets in the way of the
 * program doing the reporting.
 *
 * Three properties hold for every call to {@link report}:
 *
 * - **It never throws or rejects.** A server that is down, slow, or rejecting
 *   the key is a dropped report, not an exception in the host program.
 *   Failures are passed to the optional `debug` callback and otherwise not
 *   surfaced at all.
 * - **It returns already-started work.** The request is in flight by the time
 *   `report()` returns. Callers may `await` the promise, hand it to
 *   `event.waitUntil()` in an edge runtime, or ignore it.
 * - **It is bounded.** At most {@link IN_FLIGHT_CAPACITY} requests are in
 *   flight; beyond that, new reports are dropped rather than accumulated, and
 *   every request is aborted after `timeoutMs`. A trace server that is
 *   unreachable for a week costs a few kilobytes, not the host's memory.
 *
 * Reporting is opt-out: `enabled: false`, or no key, yields a client that does
 * nothing and costs nothing. So does the environment: the constructor checks
 * `TRACE_USAGE_REPORTING=off` and `DO_NOT_TRACK=1` before it looks at
 * `enabled`, so a user can switch off every trace-reporting program at once.
 * {@link disabledReason} says which of those applied (`"environment"`,
 * `"config"` or `"no key"`; `null` when on) so the program can say so in its
 * notice. Programs that run on other people's machines should expose that
 * switch in their settings and say so once, pointing at
 * https://github.com/Stephenson-Software/trace#usage-reporting.
 *
 * ```ts
 * const trace = new TraceClient("https://trace.example.org", "my-site", {
 *   key: process.env.USAGE_REPORTING_KEY,
 *   enabled: process.env.USAGE_REPORTING_ENABLED !== "false",
 * });
 * if (!trace.enabled) console.log(`Usage reporting is off (${trace.disabledReason}).`);
 * trace.report("startup", { tags: { version: "1.4.0" } });
 * ...
 * await trace.close(); // on shutdown
 * ```
 */
export class TraceClient {
  static readonly IN_FLIGHT_CAPACITY = 256;
  static readonly TIMEOUT_MS = 5000;

  /**
   * Environment variables that turn reporting off for every program using a
   * trace client, checked before the program's own setting:
   * `TRACE_USAGE_REPORTING=off` (also `false`, `0`, `no`; case and
   * surrounding space do not matter) or `DO_NOT_TRACK=1` (also `true`, `yes`;
   * see https://consoledonottrack.com). Any other value, including an empty
   * one, leaves the program's own setting in charge.
   */
  static readonly ENV_TRACE_USAGE_REPORTING = "TRACE_USAGE_REPORTING";
  static readonly ENV_DO_NOT_TRACK = "DO_NOT_TRACK";

  /** {@link disabledReason} when `TRACE_USAGE_REPORTING` or `DO_NOT_TRACK` opted out. */
  static readonly REASON_ENVIRONMENT = "environment";
  /** {@link disabledReason} when the program passed `enabled: false`. */
  static readonly REASON_CONFIG = "config";
  /** {@link disabledReason} when the key was missing or blank. */
  static readonly REASON_NO_KEY = "no key";

  /**
   * Whether the environment asks for usage reporting to be off, via
   * `TRACE_USAGE_REPORTING=off` or `DO_NOT_TRACK=1`. Reads `env` when given,
   * otherwise `process.env` if the runtime has one; never throws, and a
   * runtime without an environment opts nothing out.
   */
  static environmentOptsOut(env?: Environment): boolean {
    let trace: unknown;
    let doNotTrack: unknown;
    try {
      const source = env ?? processEnvironment();
      trace = source[TraceClient.ENV_TRACE_USAGE_REPORTING];
      doNotTrack = source[TraceClient.ENV_DO_NOT_TRACK];
    } catch {
      return false; // an environment that cannot be read opts nothing out
    }
    return matches(trace, OFF_VALUES) || matches(doNotTrack, DO_NOT_TRACK_VALUES);
  }

  private readonly endpoint: string;
  private readonly application: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly debug: ((message: string) => void) | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly reason: DisabledReason | null;
  private active: boolean;

  constructor(baseUrl: string, application: string, options: TraceClientOptions = {}) {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new Error("baseUrl is required");
    }
    if (typeof application !== "string" || !application.trim()) {
      throw new Error("application is required");
    }
    this.endpoint = baseUrl.trim().replace(/\/+$/, "") + "/api/metrics";
    this.application = application.trim();
    this.key = (options.key ?? "").trim();
    const timeoutMs = options.timeoutMs;
    this.timeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? timeoutMs
        : TraceClient.TIMEOUT_MS;
    this.fetchImpl = options.fetch;
    this.debug = options.debug;
    // Decided once, here: the environment, then the program's switch, then the key.
    if (TraceClient.environmentOptsOut(options.env)) {
      this.reason = TraceClient.REASON_ENVIRONMENT;
    } else if (options.enabled === false) {
      this.reason = TraceClient.REASON_CONFIG;
    } else if (this.key === "") {
      this.reason = TraceClient.REASON_NO_KEY;
    } else {
      this.reason = null;
    }
    this.active = this.reason === null;
  }

  /** A client that reports nothing. Useful as a default before settings are read. */
  static disabled(): TraceClient {
    return new TraceClient("http://disabled.invalid", "disabled", { enabled: false });
  }

  /**
   * Whether {@link report} will actually send anything. `false` after
   * {@link close} too; {@link disabledReason} keeps the reason the client was
   * built off, if it was.
   */
  get enabled(): boolean {
    return this.active;
  }

  /**
   * Why this client reports nothing: `"environment"` (`TRACE_USAGE_REPORTING`
   * / `DO_NOT_TRACK`), `"config"` (`enabled: false`) or `"no key"`; `null`
   * when it reports. Fixed at construction; {@link close} does not change it.
   */
  get disabledReason(): DisabledReason | null {
    return this.reason;
  }

  /**
   * Report that `name` happened, with an optional numeric value and optional
   * string tags. The returned promise is the delivery attempt itself: it is
   * already running, it settles when the server has answered or the attempt
   * has been given up, and it never rejects. See the class docs.
   */
  report(name: string, options: ReportOptions = {}): Promise<void> {
    if (!this.active || typeof name !== "string" || !name.trim()) {
      return Promise.resolve();
    }
    if (this.inFlight.size >= TraceClient.IN_FLIGHT_CAPACITY) {
      this.log(`in-flight cap reached, dropped ${name}`);
      return Promise.resolve();
    }
    let body: string;
    try {
      body = serialize(this.application, name, options.value, options.tags);
    } catch (failure) {
      this.log(`could not serialize ${name}: ${describe(failure)}`);
      return Promise.resolve();
    }
    let attempt: Promise<void>;
    try {
      attempt = this.send(body).catch((failure) => {
        this.log(`could not deliver ${body}: ${describe(failure)}`);
      });
    } catch (failure) {
      // send() is async, so this only happens if fetch itself is missing.
      this.log(`could not deliver ${body}: ${describe(failure)}`);
      return Promise.resolve();
    }
    this.inFlight.add(attempt);
    const tracked = attempt.then(() => {
      this.inFlight.delete(attempt);
    });
    return tracked;
  }

  /**
   * Wait for the reports currently in flight, for at most `timeoutMs`
   * (default: the client timeout). Never rejects. A serverless handler that
   * cannot use `waitUntil` can `await trace.flush()` before returning.
   */
  flush(timeoutMs: number = this.timeoutMs): Promise<void> {
    if (this.inFlight.size === 0) {
      return Promise.resolve();
    }
    const pending = Promise.all(Array.from(this.inFlight)).then(() => undefined);
    return bounded(pending, timeoutMs);
  }

  /**
   * Flush, then refuse further reports. Reports already in flight get up to
   * `timeoutMs` (default: the client timeout) to finish, so a program that
   * reports and then exits at once does not lose its one event. The bound
   * still holds: an unreachable server delays exit by at most the timeout,
   * never a hang. Safe to call more than once, and on a disabled client.
   */
  close(timeoutMs: number = this.timeoutMs): Promise<void> {
    this.active = false; // report() is a no-op from here on
    return this.flush(timeoutMs);
  }

  // -- internals ------------------------------------------------------------

  private async send(body: string): Promise<void> {
    const doFetch = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await doFetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.key,
          "User-Agent": `trace-client-js/${TRACE_CLIENT_VERSION} (${this.application})`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.log(`trace server answered ${response.status} for ${body}`);
      }
      // Let the connection be reused; never fail on an unreadable body.
      await response.arrayBuffer().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private log(message: string): void {
    if (!this.debug) return;
    try {
      this.debug("[trace] " + message);
    } catch {
      // a debug sink must never be the reason a program stops either
    }
  }
}

/**
 * The path of a URL or path string, and nothing else: no query string, no
 * fragment, no host; runs of `/` collapsed; no trailing slash except for the
 * root itself; at most 200 characters. What a `page-view` should record.
 */
export function pagePath(urlOrPath: string): string {
  let path = typeof urlOrPath === "string" ? urlOrPath : "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = "";
    }
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path.length > 200) path = path.slice(0, 200);
  return path;
}

const BOT_PATTERN =
  /bot\b|bot[\/_-]|crawler|crawling|spider|slurp|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|libwww|httpclient|headlesschrome|lighthouse|pagespeed|uptimerobot|pingdom|statuscake|site24x7|monitor|facebookexternalhit|discordbot|twitterbot|telegrambot|whatsapp|slackbot|linkedinbot|embedly|quora link preview|bitlybot|skypeuripreview|nuzzel|vkshare|w3c_validator|redditbot|applebot|yandex|baiduspider|duckduckbot|bingpreview|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt-user|claudebot|anthropic-ai|ccbot|perplexitybot|scrapy|axios\/|node-fetch|undici|postmanruntime|insomnia|httpie|phantomjs|selenium|puppeteer|playwright/i;

/**
 * Whether a User-Agent header belongs to a crawler, a monitor, or a script
 * rather than a person's browser. A missing or empty header counts as a bot:
 * every real browser sends one.
 */
export function isBot(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== "string" || !userAgent.trim()) return true;
  return BOT_PATTERN.test(userAgent);
}

// -- helpers ----------------------------------------------------------------

/**
 * The two opt-out variables from `process.env`, or an empty environment where
 * there is no `process` (or reading it throws, as a permission-gated runtime
 * may). Each is read by its literal name, which is what lets bundlers such as
 * Next.js inline it for the Edge runtime.
 */
function processEnvironment(): Environment {
  try {
    if (typeof process === "undefined" || !process || !process.env) return {};
    return {
      TRACE_USAGE_REPORTING: process.env.TRACE_USAGE_REPORTING,
      DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    };
  } catch {
    return {};
  }
}

function matches(value: unknown, accepted: readonly string[]): boolean {
  return typeof value === "string" && accepted.includes(value.trim().toLowerCase());
}

function serialize(
  application: string,
  name: string,
  value: number | undefined,
  tags: Record<string, string> | undefined,
): string {
  const payload: { application: string; name: string; value?: number; tags?: Record<string, string> } = {
    application,
    name,
  };
  if (typeof value === "number" && Number.isFinite(value)) {
    payload.value = value;
  }
  if (tags && typeof tags === "object") {
    const clean: Record<string, string> = {};
    let any = false;
    for (const [k, v] of Object.entries(tags)) {
      if (k === null || k === undefined || v === null || v === undefined) continue;
      clean[String(k)] = String(v);
      any = true;
    }
    if (any) payload.tags = clean;
  }
  return JSON.stringify(payload);
}

function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  const ms = typeof timeoutMs === "number" && timeoutMs >= 0 && Number.isFinite(timeoutMs) ? timeoutMs : 0;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function describe(failure: unknown): string {
  if (failure instanceof Error) {
    const cause = (failure as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (${cause.message})` : "";
    return `${failure.name}: ${failure.message}${causeText}`;
  }
  return String(failure);
}
