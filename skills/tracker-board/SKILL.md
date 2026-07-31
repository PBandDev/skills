---
name: tracker-board
description: Use when someone asks to view or monitor local Markdown issue trackers under .scratch as a live board, including agent-ready work, blockers, human gates, Digests, or parser/AI disagreements across one or more repositories.
---

# Tracker Board

Open the current repository's local Markdown tracker as a live board without writing to any
watched repository. Runtime state belongs in a private `.tracker-board` directory beneath the home
directory reported by the platform; the board refuses state writes if that directory falls inside
a watched Root and reports any failed Snapshot write through board health.
Repeated invocations add repositories to the same board instead of starting independent copies.

## Preflight

Resolve `server/launch.mjs` relative to this `SKILL.md`, never relative to the caller's working
directory. Resolve the current repository to an absolute Root path and pass that one path to the
launcher. Do not supply a port. Root transport is bounded: both first launch and singleton handoff
refuse paths containing control characters or more than 48 KiB of UTF-8. The Root must name an
existing directory; a missing path or regular file is refused before any watcher starts.

Require Node 22.18+ on the Node 22 release line. The supported ranges are Node 22.18 through 22.x,
Node 23.6+, and Node 24 or later. The launcher is plain JavaScript and checks the semantic-version
components before it attempts to import or load any `.ts` module. On Node 22 below the floor,
surface its plain diagnostic exactly: `tracker-board requires Node 22.18 or newer.` On Node 23 below
its floor, surface exactly:
`tracker-board requires Node 23.6 or newer on the Node 23 release line.` Do not download another Node
through a package runner or let a TypeScript loader error stand in for either answer.

## Launch contract

Choose a launch mechanism for the current platform and verify every invariant:

- The board process survives the spawning shell exiting.
- The board is a singleton on one fixed port. If it is already serving, hand it the current Root,
  print the same URL, and stop or exit the losing invocation.
- A handoff succeeds only when the existing service returns bounded, structured JSON confirming the
  requested Root in its canonical Roots list, reporting the board-safety state, and reporting any
  failed state write. A generic HTTP success is a refusal.
- Roots accrete. Invoking from a new repository registers that repository as a Root, triggers a
  re-scan, and leaves existing Roots registered.
- Lifetime is bound to the browser tab's SSE client. A connected tab holds the process open; after
  no client has been connected for about 15 minutes, the server and its watchers exit.
- On success, print the URL and nothing else to stdout. Send diagnostics to stderr.
- A refused Root handoff is a failure or error, never a successful launch.

Never start a second server on a second port. That failure splits the Roots list and gives each
board an incomplete view. If someone requests another port, refuse that request instead of adding a
port argument or silently changing the fixed port.

Detach `node server/launch.mjs <absolute-root>` using a mechanism appropriate to the current OS and
shell. Capture its stdout and stderr separately, wait for its one URL line, then confirm that URL
still answers after the spawning command has returned. Open it with the available browser tool.

## Reconciliation pass

Run the changed-file Reconciliation pass on every skill invocation after the Root handoff succeeds.
Also run it on demand when asked; on demand means the same changed-only pass, not a forced full
rewrite. Resolve `tools/reconcile.ts` relative to this `SKILL.md`, retain the exact URL printed by
the launcher, and invoke the tool with the current Node executable:

```text
node <absolute-reconciliation-tool> plan --board <launcher-url>
```

The plan covers all registered Roots and contains only files whose content hash has no current
Reconciliation receipt. A steady-state plan has no candidates and costs zero AI work. Each
candidate carries an opaque `candidateId`, its Root-qualified `filePath`, and the exact bounded
`source` bytes captured by the safe tree scan. Independently extract from that `source`; do not
re-open the file path, because the file could change or become a link after the scan. The
candidate id binds the response to those exact source bytes, and apply rejects content that moved.

One plan page carries at most 64 candidates and is bounded to 32 MiB after JSON encoding. Its
`cursor` is `null` on the first page. If `nextCursor` is not `null`, continue the same invocation
with both commands suffixed by `--after <nextCursor>`. Keep advancing until `nextCursor` is `null`;
advancing lets later changed files run even when an earlier page reports a parser bug. Start each
new invocation without `--after`, so unresolved parser-bug files remain pending.

Produce one result for every candidate and no others. The response has this shape:

```json
{
  "schemaVersion": 1,
  "results": [
    {
      "candidateId": "copy from the plan",
      "extraction": {
        "title": "display title",
        "criteria": { "checked": 0, "total": 1 },
        "blockedBy": [],
        "externalBlocker": null,
        "rawStatus": "",
        "ticketType": null,
        "dialect": "task"
      }
    }
  ]
}
```

These are exactly the seven permitted Extraction fields: `title`, the `criteria` ratio,
`blockedBy`, `externalBlocker`, `rawStatus`, `ticketType`, and `dialect`. Use `""` when the Status
field is absent, `null` when the external blocker or ticket type is absent, and one of `task`,
`decision`, `unclassified`, or `unparsed` for dialect. Do not emit a Lane, derived state, Frontier
membership, count, content hash, receipt, or disagreement verdict. Validation rejects the whole
result if a field is missing, malformed, or extra. AI produces Extraction fields only; code
performs the diff and derives Lane, state, HITL routing, status prefix, qualifier, and every count.
Per result, the four text fields together may occupy at most 32 KiB of UTF-8 and `blockedBy` may
hold at most 512 Ticket numbers. Together with the 64-result page cap, every valid response fits
the 16 MiB apply boundary.

Create an unpredictable private directory beneath the platform temporary directory and outside all
watched Roots, create the response file there exclusively, and restrict it to the invoking user
(`0600` on POSIX; the user profile ACL on Windows). Keep response content out of command arguments
and diagnostics. Then run:

```text
node <absolute-reconciliation-tool> apply --board <launcher-url> --input <absolute-response-json>
```

For a later page, append the same `--after <cursor>` used to produce its plan. In a
`finally`-equivalent cleanup, delete the exact response file and verified temporary directory after
apply succeeds or fails. Ordinary deletion is cleanup, not a guarantee of secure erasure.

Apply delegates the transaction to the incumbent board. In one synchronous turn it snapshots the
live Roots, re-reads source files and Annotation state, validates and code-diffs the page, writes
atomically, and publishes one fresh Snapshot. Root registration and another apply therefore
linearize before or after the whole transaction rather than racing its merge. A single
disagreement, or the same parser component disagreeing on two distinct files, becomes a hash-keyed
Override and is marked on the card. The threshold is 3 distinct files disagreeing in the same
parser component, accumulated from current hash-keyed evidence across pages and invocations;
report them once as a parser bug instead of retaining three Overrides.
Parser-bug files receive no receipt and remain pending. Private Annotation state retains only the
independently read fields for each affected component, separate from applied Overrides, and code
re-diffs that evidence against the current parser before counting it again. Evidence pages normally
under the opaque cursor, so later files still advance; fix the shared parser rule, add a fixture, and
run the pass again to replace matching evidence with receipts. If the same file also has an unrelated
one-off disagreement, that field still applies as an Override while the shared component remains
pending. Components are title identity, criteria region, blockers, raw status, type routing, and
dialect scoring; raw private values are never part of a parser-bug report.

An accepted agreement receives a code-stamped receipt but no card marker. An Override and its
receipt both expire when their source content changes, so an edited correction is independently
checked again. A rejected batch writes nothing: `rejected` gives the count and `rejections` surfaces
the bounded field-level details; `rejectionsOmitted` says how many additional details were folded
into the summary. Existing rejected Overrides remain counted and surfaced on the board. A
successful write atomically replaces the exact-key result, preserves unrelated history and Digest
material, and refreshes the incumbent to publish one fresh Snapshot. A mutating success reports
`accepted: true`, `written: true`, and `refreshed: true`. An empty steady state or an identical retry
of already stored parser-bug evidence reports `accepted: true`, `written: false`, and
`refreshed: false`; newly promoted evidence is a write.

Residual risk: if the parser and the AI agree and are both wrong, Reconciliation raises no flag.
The adversarial parser fixtures are the backstop for that class of defect.

## Platform behavior

Verify detachment on the current platform; do not mechanically translate another shell's command.
The runtime attempts recursive file watching and, when the OS or Node runtime does not support it
or a watcher later fails, falls back to a polled full re-scan. Preserve that verify-then-fallback
behavior.

Treat the 250 ms debounce as a measured starting value, not a constant. It was selected after one
save emitted several filesystem events; event coalescing differs by OS and filesystem, so tune only
from a new measurement.

## Windows PowerShell worked example

This is one platform's answer, not the universal command. Run the block as a script and pass the
absolute path to the installed `SKILL.md` as `-SkillMdPath`. The plain-JavaScript detacher gives the
board direct file handles, creates an OS-detached process, reports its PID, and exits before the
caller performs any probe. Generated files stay under the platform temporary directory.

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$SkillMdPath
)

$ErrorActionPreference = 'Stop'
$skillMd = Get-Item -LiteralPath $SkillMdPath -ErrorAction Stop
$skillDir = $skillMd.Directory.FullName
$launcherPath = (Get-Item -LiteralPath (Join-Path $skillDir 'server\launch.mjs') -ErrorAction Stop).FullName
$detacherPath = (Get-Item -LiteralPath (Join-Path $skillDir 'server\detach.mjs') -ErrorAction Stop).FullName

$repository = Get-Item -LiteralPath (Get-Location).Path
while ($null -ne $repository -and
       -not (Test-Path -LiteralPath (Join-Path $repository.FullName '.git'))) {
  $repository = $repository.Parent
}
if ($null -eq $repository) { throw 'tracker-board could not find the repository Root.' }
$rootPath = $repository.FullName
$runId = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "tracker-board-$runId.out"
$stderrPath = Join-Path ([IO.Path]::GetTempPath()) "tracker-board-$runId.err"
$detacherOutPath = Join-Path ([IO.Path]::GetTempPath()) "tracker-board-$runId-detacher.out"
$detacherErrorPath = Join-Path ([IO.Path]::GetTempPath()) "tracker-board-$runId-detacher.err"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodePath = $nodeCommand.Source
[string]$canonicalRoot = & $nodePath -e "process.stdout.write(require('node:fs').realpathSync(process.argv[1]))" $rootPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($canonicalRoot)) {
  throw 'tracker-board could not resolve the repository Root.'
}
$rootPath = $canonicalRoot

function Quote-WindowsPath([string]$value) {
  if ($value.Contains('"') -or $value.IndexOf([char]0) -ge 0) {
    throw 'tracker-board received an invalid path argument.'
  }
  return '"' + [Regex]::Replace($value, '(\\+)$', '$1$1') + '"'
}

$detacherArguments = @($detacherPath, $launcherPath, $rootPath, $stdoutPath, $stderrPath) |
  ForEach-Object { Quote-WindowsPath $_ }
$detacherProcess = Start-Process `
  -FilePath $nodePath `
  -ArgumentList ($detacherArguments -join ' ') `
  -RedirectStandardOutput $detacherOutPath `
  -RedirectStandardError $detacherErrorPath `
  -WindowStyle Hidden `
  -PassThru
if (-not $detacherProcess.WaitForExit(10000)) {
  $detacherProcess | Stop-Process -Force
  throw 'tracker-board detacher did not exit.'
}
$detacherProcess.WaitForExit()
[string]$pidText = Get-Content -LiteralPath $detacherOutPath -Raw
[string]$detacherDetail = Get-Content -LiteralPath $detacherErrorPath -Raw
[IO.File]::Delete($detacherOutPath)
[IO.File]::Delete($detacherErrorPath)
if (-not [string]::IsNullOrWhiteSpace($detacherDetail)) {
  [Console]::Error.Write($detacherDetail)
  exit 1
}

$nodeProcessId = 0
if (-not [int]::TryParse($pidText.Trim(), [ref]$nodeProcessId)) {
  throw 'tracker-board detacher did not report one child process.'
}
$launchedProcess = Get-Process -Id $nodeProcessId -ErrorAction SilentlyContinue

function Stop-LosingLauncher {
  if ($null -ne $launchedProcess -and -not $launchedProcess.HasExited) {
    $launchedProcess | Stop-Process -Force
    $launchedProcess.WaitForExit(5000) | Out-Null
  }
}

$expectedUrl = 'http' + '://' + '127.0.0.1:4317/'
function Read-BoardUrl([string]$path, [string]$expected) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    [string]$candidate = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
  } catch {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
  if ($candidate -ceq "$expected`n" -or $candidate -ceq "$expected`r`n") {
    return $expected
  }
  return $null
}

$deadline = [DateTime]::UtcNow.AddSeconds(20)
$url = $null
do {
  $url = Read-BoardUrl $stdoutPath $expectedUrl
  if (-not $url) { Start-Sleep -Milliseconds 100 }
} while (-not $url -and [DateTime]::UtcNow -lt $deadline)

if (-not $url) {
  Stop-LosingLauncher
  [string]$detail = if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -LiteralPath $stderrPath -Raw
  } else {
    ''
  }
  $detail = $detail.Trim()
  if ([string]::IsNullOrWhiteSpace($detail)) { $detail = 'no diagnostic was produced' }
  if ($detail -eq 'tracker-board requires Node 22.18 or newer.' -or
      $detail -eq 'tracker-board requires Node 23.6 or newer on the Node 23 release line.') {
    [Console]::Error.WriteLine($detail)
    exit 1
  }
  throw "tracker-board did not become ready: $detail"
}

$healthDeadline = [DateTime]::UtcNow.AddSeconds(10)
$health = $null
$rootPresent = $false
do {
  try {
    $health = Invoke-RestMethod -Uri ([Uri]::new([Uri]$url, 'health')) -TimeoutSec 5
    $rootPresent = @($health.roots | Where-Object { $_.path -eq $rootPath }).Count -gt 0
  } catch {
    $rootPresent = $false
  }
  if (-not $rootPresent) { Start-Sleep -Milliseconds 100 }
} while (-not $rootPresent -and [DateTime]::UtcNow -lt $healthDeadline)
if (-not $rootPresent) {
  Stop-LosingLauncher
  throw 'tracker-board did not register the repository Root.'
}

Start-Process -FilePath $url | Out-Null
$clientDeadline = [DateTime]::UtcNow.AddSeconds(10)
$clientConnected = $false
do {
  Start-Sleep -Milliseconds 100
  try {
    $clientHealth = Invoke-RestMethod -Uri ([Uri]::new([Uri]$url, 'health')) -TimeoutSec 5
    $clientConnected = [int]$clientHealth.clients -gt 0
  } catch {
    $clientConnected = $false
  }
} while (-not $clientConnected -and [DateTime]::UtcNow -lt $clientDeadline)
if (-not $clientConnected) {
  Stop-LosingLauncher
  throw 'tracker-board opened no browser SSE client.'
}

$url
```
