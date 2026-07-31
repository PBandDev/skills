# 0002 — Zero dependencies, zero build

## Context

`tracker-board` is delivered as a skill installed by `npx skills add`, invoked from arbitrary
repos on arbitrary machines. Anything it needs at runtime, it must already have.

A dependency list means an install step. An install step means a lockfile, a `node_modules`
inside a skill directory, version drift against whatever the host repo pins, and a failure
mode — "the board won't start" — that lands on the user at the exact moment they wanted to
look at their work.

Supported Node releases strip TypeScript types natively, so `.ts` runs directly with no build.
That behavior is enabled by default from Node 22.18 and Node 23.6, and in later major release
lines. `node --test` runs `.ts` test files the same way. A recursive file watcher and an HTTP
server with SSE are both in the standard library.

## Decision

No runtime dependencies. No `package.json`. No build step. No bundler.

`node server/launch.mjs <absolute-root>` starts or joins the board. `node --test` runs the tests.
The Windows worked example invokes `server/detach.mjs` first so the board owns its output file
handles and survives the launching shell; both entrypoints remain plain standard-library JavaScript.

`tsc --noEmit` and `@types/node` exist in the authoring repo only, and never ship. Type
stripping **erases, it does not check** — so every external input is validated at runtime,
independently of the types. Types are documentation here, not a guarantee.

## Consequences

The skill directory is copyable and immediately runnable. Nothing to install, nothing to
resolve, nothing to keep current.

No React, no chart library, no CSS framework. The UI is one HTML file. This is a real
constraint on the board's visual ambition, accepted deliberately — the alternative costs a
toolchain in every repo the board is ever pointed at.

Node 22.18 is the earliest supported runtime. The Node 23 release line requires 23.6 or newer;
Node 24 and later are supported. The skill must detect an unsupported runtime and say so plainly
rather than emitting a loader error.

The runtime validation requirement is easy to forget precisely because the types look like
they are doing the work. They are not.
