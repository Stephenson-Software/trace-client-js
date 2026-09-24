# Changelog

All notable changes to this project are recorded here. The version in the
header comment of `trace-client.ts` is the one consumers vendor; check it
against this file to see what a re-vendor would bring.

## 0.2.0 — 2026-09-24

The environment opt-outs the Java and Python clients gained in 0.2.0, so a
user can switch off every trace-reporting program at once. API-compatible
with 0.1.0: the file exports exactly the same values, and every existing
constructor call, `report`, `flush`, `close` and `TraceClient.disabled()`
behaves as before unless the environment opts out.

- The constructor checks `TRACE_USAGE_REPORTING=off` (also `false`, `0`,
  `no`) and `DO_NOT_TRACK=1` (also `true`, `yes`) — case and surrounding
  space ignored — **before** `enabled` and the key. Either one yields a
  client that sends nothing.
- The environment is `process.env` when the runtime has one, read by the
  two literal names (so bundlers such as Next.js can inline them for the Edge
  runtime); a runtime with no `process`, or one whose `process.env` throws,
  opts nothing out and never fails. The new `env` option replaces
  `process.env` — for runtimes that hand the environment to the handler
  (Cloudflare Workers) and for tests.
- `disabledReason`: `"environment"`, `"config"` (`enabled: false`) or
  `"no key"`, first match wins; `null` when the client reports. Fixed at
  construction, so `close()` changes `enabled` but not the reason. The values
  are also `TraceClient.REASON_ENVIRONMENT`, `REASON_CONFIG` and
  `REASON_NO_KEY`, matching trace-client-python and trace-client-java.
- `TraceClient.environmentOptsOut(env?)`, and the variable names as
  `TraceClient.ENV_TRACE_USAGE_REPORTING` / `ENV_DO_NOT_TRACK`, for a program
  that wants to decide before building a client (to skip writing a settings
  file, say).
- `User-Agent: trace-client-js/0.2.0 (<application>)`.

## 0.1.0 — 2026-09-12

First release. One file, zero dependencies, no Node-only APIs (Node 18+ and
the Next.js Edge runtime):

- `TraceClient(baseUrl, application, { key, enabled, timeoutMs, fetch, debug })`
  then `report(name, { value, tags })`. Never throws or rejects; returns
  already-started work suitable for `event.waitUntil()`; at most 256 requests
  in flight, every one aborted after the timeout (5 s). No key or
  `enabled: false` is a no-op.
- `flush(timeoutMs)` waits for what is in flight, bounded. `close(timeoutMs)`
  flushes and then makes `report()` a no-op, so a program that reports and
  exits at once does not lose its event.
- `pagePath(urlOrPath)` and `isBot(userAgent)` helpers for reporting one
  `page-view` per HTML page request from a Next.js middleware.
- Same wire format and promises as trace-client-python 0.1.1 and
  trace-client-java 0.1.1.
