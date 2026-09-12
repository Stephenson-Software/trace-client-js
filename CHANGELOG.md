# Changelog

All notable changes to this project are recorded here. The version in the
header comment of `trace-client.ts` is the one consumers vendor; check it
against this file to see what a re-vendor would bring.

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
