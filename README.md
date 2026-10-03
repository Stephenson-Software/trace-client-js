# trace-client (JavaScript / TypeScript)

**One call to report that a program was used.**

A zero-dependency TypeScript client for a [trace](https://trace.danielstephenson.dev)
server — the central place a fleet of programs reports usage events to. The
whole library is one file, `trace-client.ts`, and the integration on the
program side is meant to stay one call. It uses only `fetch`,
`AbortController`, `setTimeout` and `URL` (plus `process.env` where the
runtime has one), so it runs in Node 18+, in the Next.js Edge runtime, and
anywhere else that has those four. The Python and
Java counterparts are
[trace-client-python](https://github.com/Stephenson-Software/trace-client-python)
and [trace-client-java](https://github.com/Stephenson-Software/trace-client-java);
all three speak the same wire format and make the same promises.

```ts
import { TraceClient } from "./trace-client";

const trace = new TraceClient("https://trace.danielstephenson.dev", "my-site", {
  version: "1.4.0", // the program's own version, required -- see below
  key: process.env.USAGE_REPORTING_KEY,
  enabled: process.env.USAGE_REPORTING_ENABLED !== "false",
});
trace.report("startup"); // tagged version=1.4.0, like every other event
trace.report("world-load", { value: 2.5, tags: { kind: "procedural" } });

// on shutdown -- also before a short-lived program exits, so the event is sent
await trace.close();
```

## Every event carries the program's version

The `version` option is the program's own version, and it is required
(`TraceClientOptions.version` is typed `string`, not optional): a missing or
blank one, or one over 255 characters after trimming, throws an `Error`. It
is trimmed, then sent as the tag `version` on every event the client sends
— `startup`, `page-view`, `command`, anything else — so every event can be
tied to a release, not just `startup`. An event that passes its own
`version` tag keeps it. The caller's `tags` object is never modified.
`TraceClient.disabled()` still takes no arguments.

Before 0.3.0, `version` was not an option and only events tagged by hand
carried a version. Upgrading is one field: pass `version` to the
constructor (the `version` from your `package.json`, or a constant the build
fills in). The hand-added `version` tags can then be dropped if you
like; left in, they still win, so nothing changes on the wire.

## Every event carries a random installation ID

Since 0.4.0, every event can also carry the tag `install`: a random ID for
the installation, so the trace server can count **distinct installations**
("active installs in the last 30 days") rather than raw events. It is the
same idea as trace-client-java 0.5.0's server ID, and it is said out loud
here because it is the one thing the client sends that is the same from one
event to the next.

**What it is.** A random UUID (`crypto.randomUUID()`), made on first run. It
is not derived from anything — not a hostname, an IP address, a MAC address,
a user, an account or a path. It identifies no person and no address; all it
can say is "these events came from the same installation". (The trace server
still sees the IP address of every HTTP request, as every web server does.)

**Where it lives.** Wherever the program says, and nowhere else: there is
no hidden default location, and without one of the two options below no ID
is made up and no `install` tag is sent. A program that wants to be counted
either names a file the client keeps the ID in —

```ts
const trace = new TraceClient(url, "my-game", {
  version,
  key,
  installIdFile: join(configDir, "trace-install-id"), // created on first run
});
```

— or passes an ID it stores itself:

```ts
new TraceClient(url, "my-game", { version, key, installId: settings.installId }); // null or blank: none sent
```

`installIdFile` uses `TraceClient.installIdFromFile(path)`: the first line
made of letters, digits, `_`, `.` and `-` (at most 255 characters) is the ID;
when the file is missing or has no such line, a new UUID is written to it
(parent directories created). If the file cannot be read or written — or the
runtime has no `node:fs`, as in an edge runtime; the file is reached through
`process.getBuiltinModule` (Node 22.3+), never a top-level import — a fresh
ID is used in memory for that run only. It never throws. An explicit
`installId` wins over `installIdFile`; it is trimmed, and over 255
characters throws, the same as `version`.

`trace.installId` is the ID in use (`null` when disabled or when there is
none), so a program can print it. An event that passes its own `install`
tag keeps it, and the tag is not added to an event that already has 32 tags
(`TraceClient.MAX_TAGS`).

**Resetting it.** Delete the file (or its ID line); the next start writes a
new one. Or put your own value in it.

**Opting out.** Every opt-out — `TRACE_USAGE_REPORTING=off`,
`DO_NOT_TRACK=1`, `enabled: false`, no key — also stops the ID: a disabled
client never reads, generates or writes one, so `installIdFile` is never
created. (`TraceClient.installIdFromFile(path)` called directly writes
regardless; pass the path as `installIdFile` to keep that guarantee.)

## What `report` promises

| Property | Meaning |
|---|---|
| **Never throws or rejects** | A server that is down, slow, or rejecting the key is a dropped report, not an exception in your program. Drops are passed to the optional `debug` callback, otherwise surfaced nowhere. |
| **Returns already-started work** | The request is on the wire by the time `report()` returns. `await` the promise, hand it to `event.waitUntil()` in an edge runtime, or ignore it — a request handler never has to wait on the network. |
| **Bounded** | At most 256 requests are in flight; past that, new reports are dropped. Every request is aborted after the timeout (5 s). A trace server that is unreachable for a week costs a few kilobytes, not your memory. |
| **`close()` drains** | Reports already in flight get up to the timeout to finish before `report()` becomes a no-op, so a CLI that reports and exits at once does not lose its event. Still bounded: an unreachable server delays exit by at most the timeout. `flush()` does the same without closing. |

Reporting is **opt-out**: `enabled: false`, or no key at all, yields a client
that does nothing and costs nothing (`TraceClient.disabled()` is a ready-made
one). A program that runs on other people's machines should expose that switch
in its settings — and say so once, so whoever runs it knows it is on and where
to turn it off.

## Options and limits

Besides `version`, `key`, `enabled` and `env`, the constructor's options take:

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | `5000` | How long one request may take before it is aborted. Anything but a positive finite number — `0`, negative, `NaN`, `Infinity`, not a number — falls back to the default. |
| `fetch` | the global `fetch` | The `fetch` to send with, for a runtime that provides its own or for tests. |
| `installId` | none | The installation's ID, sent as the tag `install`; see [above](#every-event-carries-a-random-installation-id). |
| `installIdFile` | none | A file holding the installation's ID, created with a random UUID on first run by an enabled client. |
| `debug` | none | Called with one line per dropped report, prefixed `[trace] `. A `debug` that throws is ignored. |

`flush(timeoutMs)` and `close(timeoutMs)` take their own bound, defaulting to
the client's timeout; a negative or non-finite one counts as `0`, so they
return without waiting on requests in flight.

`debug` hears about every report an enabled client drops: the in-flight cap
was reached, the tags could not be serialized, the request failed or was
aborted after the timeout, or the server answered with a non-`2xx` status.
The last two lines include the JSON body that was sent. A report that was
never going to be sent is not logged: a disabled or closed client, or a
blank or non-string `name`.

Tag values are cleaned before sending: `null` and `undefined` values are
left out, and anything else is converted with `String()`. A value whose
conversion throws drops the whole report, with a `debug` line.

The limits are also available as `TraceClient.TIMEOUT_MS` (5000),
`TraceClient.IN_FLIGHT_CAPACITY` (256) and `TraceClient.MAX_VERSION_LENGTH`
(255).

## Turning it off from the environment

Two environment variables switch off **every** program that uses a trace
client — this one, trace-client-python and trace-client-java alike — and
they are checked before the program's own `enabled` setting and before the
key:

| Variable | Values that turn reporting off |
|---|---|
| `TRACE_USAGE_REPORTING` | `off`, `false`, `0`, `no` |
| `DO_NOT_TRACK` | `1`, `true`, `yes` ([consoledonottrack.com](https://consoledonottrack.com)) |

Case and surrounding space are ignored; any other value, or none, leaves the
program's own setting in charge. The client reads them from `process.env`
when the runtime has one (by their literal names, so Next.js can inline them
into the Edge runtime); a runtime without `process`, or whose environment
cannot be read, simply opts nothing out. Pass `env` to use another source:

```ts
// Cloudflare Workers and other runtimes that hand the environment to the handler
const trace = new TraceClient(endpoint, "my-worker", { version: "1.4.0", key: env.USAGE_REPORTING_KEY, env });
```

`disabledReason` says why a client sends nothing — the first that applies, in
this order — so a program can say so in its startup notice:

| `disabledReason` | Cause |
|---|---|
| `"environment"` | `TRACE_USAGE_REPORTING` or `DO_NOT_TRACK` above |
| `"config"` | `enabled: false` |
| `"no key"` | the key was missing or blank |
| `null` | the client reports |

```ts
console.log(trace.enabled
  ? "Usage reporting is on. Details: https://github.com/Stephenson-Software/trace#usage-reporting"
  : `Usage reporting is off (${trace.disabledReason}).`);
```

The reason is fixed when the client is built: `close()` turns `enabled` off
but leaves `disabledReason` as it was. `TraceClient.environmentOptsOut(env?)`
answers the environment question on its own, for a program that wants to
decide before it builds a client (to skip writing a settings file, say).

## Getting it

**Copy the file.** `trace-client.ts` has no dependencies. Drop it into your
source tree (`lib/trace-client.ts`, `src/trace-client.ts`, wherever imports are
convenient), keep the header comment so the file can be found again, and you
are done — the same way Minecraft plugins vendor bStats' `Metrics.java`.

There is no npm package; the file is the distribution. To pick up a newer
version, copy the file again and read [CHANGELOG.md](CHANGELOG.md).

## Page views from a Next.js site

The typical use in a website is one `page-view` event per HTML page request,
reported from `middleware.ts` so every page is covered and no page component
has to know about it. `pagePath()` and `isBot()` ship in the same file for
exactly this.

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { TraceClient, isBot, pagePath } from "./lib/trace-client";

const trace = new TraceClient(
  process.env.USAGE_REPORTING_ENDPOINT ?? "https://trace.danielstephenson.dev",
  "my-site",
  {
    version: "1.4.0",
    // The key shipped with the site is an identity, not a secret -- see "Keys".
    key: process.env.USAGE_REPORTING_KEY ?? "tk_my-site_xxxxxxxxxxxxxxxxxxxxxxxx",
    enabled: process.env.USAGE_REPORTING_ENABLED !== "false",
  },
);

export function middleware(request: NextRequest, event: NextFetchEvent) {
  if (!isBot(request.headers.get("user-agent"))) {
    // Already started; waitUntil only keeps the runtime alive until it settles.
    event.waitUntil(trace.report("page-view", { tags: { page: pagePath(request.nextUrl.pathname) } }));
  }
  return NextResponse.next();
}

export const config = {
  // HTML page requests only: no static assets, no image optimiser, no
  // favicon, no API routes, and nothing with a file extension.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|.*\\..*).*)"],
};
```

**What a page view records:** the path, and only the path — `/blog/hello`,
never `/blog/hello?utm_source=x#top`. No query string, no IP address, no user
agent, no cookie, no visitor identity of any kind; the trace server sees which
pages get looked at and when, and nothing about who looked. `pagePath()`
enforces the "path only" part (query and fragment stripped, slashes normalised,
capped at 200 characters), `isBot()` keeps crawlers, link previewers and
uptime monitors out of the count, and the middleware above never reads
anything else off the request.

**The opt-out.** Three environment variables, all optional, on top of
`TRACE_USAGE_REPORTING` / `DO_NOT_TRACK` (which the client checks by itself):

| Variable | Default | Meaning |
|---|---|---|
| `USAGE_REPORTING_ENABLED` | `true` | Set to `false` to turn reporting off entirely. |
| `USAGE_REPORTING_ENDPOINT` | the shared trace server | Point at your own trace server instead. |
| `USAGE_REPORTING_KEY` | the key shipped in the repo | Report as a different program. |

Ship the program's key in the repository as the default, the way the example
does, so a fresh checkout reports out of the box; anyone self-hosting the
site can flip `USAGE_REPORTING_ENABLED=false` and nothing is sent.

## The wire format

`POST {baseUrl}/api/metrics` with `Content-Type: application/json`,
`Authorization: Bearer <key>`, `User-Agent: trace-client-js/0.4.0 (<application>)`
and a body of

```json
{"application":"my-site","name":"page-view","tags":{"page":"/blog/hello","version":"1.4.0"}}
```

`value` is omitted when not given (`NaN` and infinities count as not given);
`tags` always holds at least `version`, plus `install` when the program
gave an installation ID. The `User-Agent` carries the
client's version, the `version` tag the program's. The server assigns the timestamp. Any `2xx` is success; anything
else is passed to `debug` and dropped. A trailing slash on `baseUrl` is
tolerated.

## Keys

A key identifies the program to the server and lets the operator revoke it;
it is scoped to *reporting only*. Because it ships inside the program — in a
public repository, in a browser-adjacent runtime — it cannot prove anything;
treat trace data as best-effort telemetry, which is what it is. The reasoning
is written up in the trace repository's
[decision record on per-program write keys](https://github.com/Stephenson-Software/trace/blob/main/docs/decisions/0001-per-program-write-keys.md).
Ask the trace operator for a key for your program.

## Building

```
npm ci
npm run typecheck   # tsc against ES2022 + DOM only -- no @types/node on purpose
npm test            # node --test, Node 22
```

Tests run the client against Node's own `node:http` server on a loopback
port, which can be told to hang or to answer `401`/`500`. The type-check
deliberately has no Node types available: if `trace-client.ts` compiles
against `ES2022` + `DOM` alone, it uses nothing the Edge runtime lacks.

## License

MIT.
