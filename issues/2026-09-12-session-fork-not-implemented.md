# Issue: session fork (`/fork` — branch a conversation from a specific message) is not implemented

- **Status:** open / upstream feature gap
- **Area:** `@deepseek-ai/dsh-session` (primitive exists) + `@dsh-tui/dsh-tui` (no UI) + front ends generally
- **Filed in this repo:** yes — local write-up, because this is a gap in the packaged stack
- **Upstream targets (per [`CONTRIBUTING.md`](../CONTRIBUTING.md)):**
  - Harness/session API: <https://github.com/deepseek-ai/deepseek-harness/discussions>
  - TUI front end: <https://github.com/dsh-tui/dsh-tui/issues>

## Environment

| Item | Value |
|---|---|
| Nix package | `deepseek-harness-tui-0.1.2-rc.1` (this repo, `flake.nix`) |
| Harness pin | `deepseek-ai/deepseek-harness@76fda729799fe9b3848dbe2c211d4b231032b81e` |
| TUI pin | `dsh-tui/dsh-tui@8bdc850732464e2c10278f47b4f2b82da38d801e` (v0.1.2) |
| Plugin versions | `@deepseek-ai/dsh-session` 0.1.2-rc.1, `@deepseek-ai/dsh-agent` 0.1.2-rc.1 |
| Profile | `~/.dsh/profiles/deepseek-harness-tui` (`@deepseek-ai/dsh-base` + `@dsh-tui/dsh-tui`) |
| Session store | `@deepseek-ai/dsh-session-persistence-jsonl`, root `~/.dsh/sessions` |

## Summary

There is no way for a user to fork a session — to copy the conversation up to a chosen
message and continue in a new session, leaving the original intact. The TUI offers
`/resume` and `--resume <session>`, which reopen a whole session at its end; there is no
`/fork`, no message-level rewind, and no "branch from here" affordance anywhere in the
shipped front ends.

## Expected behavior

A user should be able to say "fork this conversation at (or before) message N" and get a new
session whose history is exactly the prefix through N, resumable like any other session, with
the source session untouched. Typical uses:

- Explore a different approach from a decision point without destroying the original thread.
- Re-run from just before a wrong turn / bad tool call instead of restarting the whole session.
- Trim an expensive 1M-token session back to the point where it was still useful.
- Keep long-running sessions small while preserving the context that matters.

## Actual behavior

- The TUI registers exactly these commands
  (`@dsh-tui/dsh-tui/src/index.ts:1350-1408`): `/help`, `/model`, `/clear`, `/details`,
  `/palette`, `/reload`, `/resume`, `/status`, `/exit`, `/quit`. Plus harness commands from
  mounted plugins: `/goal` (`dsh-command-goal`) and `/compact` (`dsh-command-compact`).
  None of them forks.
- The app's only session CLI flag is resume by id
  (`@dsh-tui/dsh-tui/src/startup.ts:55`):
  `--resume <session>  resume a persisted session by id`.
- `/resume` is a picker that re-execs the TUI with `--resume <id>`
  (`src/chat/resume.ts`, `installResumeHost` in `src/startup.ts`). It continues the *same*
  session id; it cannot start a child at a boundary and cannot fork at all.
- No package in the profile's dependency set is a fork command. There is no
  `dsh-command-fork` equivalent to `dsh-command-compact` / `dsh-command-goal`.
- The TUI does not read or display session lineage at all: `parentSession`,
  `inheritedEventCount`, and `lineage` appear nowhere in `src/`, and the only occurrence of
  the word "fork" in the TUI source is a code comment (`src/chat/resume.ts:99`).

## Root cause

The durable primitive already exists in the harness; **nothing user-facing calls it.**

`ctx.sessions.fork(source, boundary?, childSessionId?)`
(`@deepseek-ai/dsh-session/lib/index.js:1804`) selects source events through an inclusive
`boundary` seq (default: last event), requires the prefix to end outside an open turn
(`OPEN_TURN`, line 1835), and creates a live child session with lineage metadata —
`parentSession: liveSource.id`, `isSeeded: true`, `inheritedEventCount`
(lines 1809-1815). The JSONL backend persists that as a seeded header
(`seedLength` + `parentSession`; `dsh-session-persistence-jsonl/lib/index.js:1636-1652`),
and resume already restores such a prefix.

Within this package the only fork-shaped feature is **subagent delegation**, and it does not
use it: `dsh-subagent-fork-in-process` builds its own seed from the parent's last completed
turn (`dsh-subagent-fork-in-process/lib/index.js:18-54`) and is wired as the `fork` subagent
provider exposing the one-shot `subagent_fork` tool
(`@deepseek-ai/dsh-base/cordis.patch.yml:243-269`). That is model-side delegation, not a
user-visible branch of the session.

`@deepseek-ai/dsh-session-reference` is mounted for the TUI
(`@dsh-tui/dsh-tui/cordis.patch.yml:31-32`) and gives `@session` mentions — a **read-only
snapshot** of another session as background context. Useful, but it neither branches nor
preserves the source conversation as a live session.

A repo-wide grep for callers of `.fork(` over the packaged plugin set finds only the
definition and two read-only signature strings in `dsh-tool-cordis` (the `cordis_inspect_query`
service listing). So `sessions.fork()` is effectively dead code for users: correct,
tested, and unreachable.

## Impact

Every user who wants to branch must hand-copy and truncate the on-disk log, which requires
knowing the storage internals (project directory key, session id escaping, checksummed
zstd frames, header rewriting, turn-boundary rules). That is a footgun for a normal user and
an obvious missing feature for anyone coming from tools that offer rewind/fork.

## Current workaround (verified)

Offline fork of the JSONL artifact: decompress the log, cut at a clean boundary, rewrite the
header as a seeded child (`parentSession` + `seedLength`), write it as a new session.

An exploratory offline probe verified this on the pinned package; the probe is not
part of the distribution. Private session identifiers, conversation content, and
local probe paths are intentionally omitted.

Verification performed on this exact package:

1. Forked a three-turn session before its second user message.
2. Booted the TUI against the child in a pty (`--resume <child>`): it rendered turn 1 only
   and **not** turns 2-3; a control run on the original rendered all three turns.
3. On load, the harness appended `session/end-seed` at the inherited boundary, proving the
   hand-written `seedLength` / `parentSession` header was interpreted exactly like
   `ctx.sessions.fork()` output.

So the data model already supports this end to end — only the command/UI is missing.

## Proposed fix

Any one of these closes the gap; (a) + (b) is the smallest complete change.

**(a) Harness command plugin — `@deepseek-ai/dsh-command-fork`.** Register `/fork` next to
`/compact` and `/goal` so every front end (TUI, web, headless) gets it. It resolves the
source session (current by default, or an id/mention), resolves a boundary, and calls
`ctx.sessions.fork(source, boundary, childSessionId)`.

**(b) TUI surface.** `/fork [session] [--at <seq|turn|message>]` plus a `--fork <session>`
CLI flag mirroring `--resume`, reusing the existing `installResumeHost` execve handoff to
switch into the child in place. Default boundary: the current session's last completed turn
(i.e. fork at "now").

**(c) Transcript affordance.** A "fork from here" action on a message/turn in the transcript
(the closest thing to the requested `/fork`; default = the turn the cursor is on).

**(d) Resume picker action.** From `/resume`, fork the highlighted session instead of
continuing it.

### Acceptance criteria

- `/fork` on a running session creates a new session id whose history is exactly the prefix
  through the chosen message/turn; the source log is byte-for-byte untouched.
- The child appears in `/resume` (same workspace) and resumes with the correct history and
  lineage.
- A boundary inside an open turn is handled by the UI: snap to the previous `turn/end`
  (or refuse with a clear message), never produce an `OPEN_TURN` error from a normal user action.
- Forking at "now" and forking at an earlier turn both work; forking an empty session is
  either allowed (empty child) or refused with a clear message.
- The user ends up in the child session (in-place handoff), not merely told its id.

### Design notes / edge cases

- **Boundaries are logical seqs, not storage rows.** The JSONL backend packs runs of
  `assistant/chunk` deltas into `text-chunks` / `reasoning-chunks` / `tool-call-chunks` rows
  (`dsh-session` chunk-rows codec); any offline/manual implementation must address logical
  event seqs, not line offsets. An API-level implementation gets this for free.
- **Child identity.** `sessions.fork` rejects a child id that already exists
  (`SESSION_ALREADY_EXISTS`) and the store keeps single-writer ownership per session id, so
  the parent process must not keep writing the child; the front end should hand off to it.
- **Attachments** live outside the log and are content-addressed
  (`@deepseek-ai/dsh-attachment-local`), so no attachment copying is needed.
- **Derived state**: titles (`dsh-session-title`), the projection cache, and the
  session-query index must observe the new child; the UI should label it as a fork of its
  parent so the picker is not two identical-looking rows.
- **Model route / request envelope**: the fork primitive carries cwd and lineage; a front
  end that lets the user switch model for the branch should do so explicitly rather than
  silently inheriting the last `request/header`.

## References

- `@deepseek-ai/dsh-session/lib/index.js:1804-1840` — `fork()`, `_forkSeed()`, `OPEN_TURN` guard.
- `@deepseek-ai/dsh-session/lib/index.js` — `SessionHeader.isSeeded`, `inheritedEventCount`, `ownEvents()`.
- `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:1636-1652` — seeded header encoding.
- `@dsh-tui/dsh-tui/src/index.ts:1350-1408` — the complete TUI command table.
- `@dsh-tui/dsh-tui/src/startup.ts:55` — the only session CLI flag, `--resume`.
- `@dsh-tui/dsh-tui/src/chat/resume.ts` — resume picker / handoff.
- `@deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:18-54` — delegation seed, not a session fork.
- `@deepseek-ai/dsh-base/cordis.patch.yml:243-269` — `fork` subagent provider + `subagent_fork` tool.
- `@dsh-tui/dsh-tui/cordis.patch.yml:31-32` — mounted `dsh-session-reference` (`@session` mentions).
- Session log layout: `@deepseek-ai/dsh-session-persistence-jsonl/README.md` ("On-disk layout").
