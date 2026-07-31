# 0005 — The skill states launch invariants, not launch commands

## Context

The Windows worked example invokes `server/detach.mjs`, a plain-JavaScript helper that opens
the board's output files directly, creates an OS-detached process, reports its PID, and exits.
This avoids binding board output to a shell-managed pipe that ends with the spawning shell.

Hard-coding that command ships a skill that is silently broken on macOS and Linux — and
"silently" is the problem. The user gets a skill that appears installed and does nothing.

The invoking agent already knows its platform, its shell, and how detachment works there. It
is better positioned to solve this than a script written on one machine.

## Decision

`SKILL.md` states the launch **invariants**, and the invoking agent satisfies them however its
platform requires:

- the process **survives the spawning shell exiting**
- **singleton** on a fixed port — if already serving, print the URL and stop
- a losing bind hands over its Root only through a bounded, non-redirecting response that
  confirms the canonical Root and reports state health; generic success is a refusal
- roots **accrete**: invoking in a new repo registers it and triggers a re-scan
- a Root must be an existing directory, so its canonical identity cannot change after registration
- lifetime is bound to the **browser tab** — exit once no SSE client has been connected for
  ~15 minutes
- on success, print the URL and nothing else

The loopback server deliberately has no per-launch authorization token. Independent invocations
cannot share an ephemeral secret without adding another trusted coordination channel, which would
move the singleton problem rather than remove it. This is a same operating-system user tool: any
process running as that user can ask the board to register a Root. Its controls are the loopback
bind, Host and browser-origin checks, bounded inputs, and typed handoff identity. It is not a
cross-user security boundary.

The verified Windows PowerShell invocation ships as a **worked example**, explicitly labelled
as one platform's answer rather than as the command. Its `server/detach.mjs` boundary exits
before PowerShell accepts the URL, and readiness still requires the requested Root and an SSE
client.

Platform capabilities that the skill cannot assume are stated as things to **verify, then fall
back**: recursive `fs.watch` support differs by OS and Node version, and where it is
unavailable the watcher degrades to a polled re-scan rather than failing.

## Consequences

The skill works on Node 22.18+, Node 23.6+, and later major release lines, without a per-platform
launcher matrix to maintain.

The agent does slightly more work per invocation. After the first, new server creation is
short-circuited, but each later invocation still hands over its Root and schedules a re-scan.

An invariant can be misread in a way a command cannot. They are written as testable
statements, and the failure the skill must never produce — a second server on a second port,
splitting the roots list — is called out explicitly.

Snapshot persistence is recoverable rather than transactional with Root registration. Once the
running board confirms that a Root accreted, a failed state write is reported in health but does
not turn that successful handoff into a false refusal.

The debounce interval (250 ms, measured from a single write emitting three events) is stated
as a **measured starting value** and not a constant; event coalescing differs by platform and
file system.
