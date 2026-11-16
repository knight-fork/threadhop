# Threadhop

Lossless visible-conversation continuity between coding agent CLIs.

> Threadhop is an independent continuation of
> [evintunador/turnbridge](https://github.com/evintunador/turnbridge) by Evin
> Tunador, used under the MIT License. Thanks to the original project for the
> foundation this builds on.

[Conversation Ledger](https://github.com/evintunador/conversation-ledger)
captures native local transcripts across its twenty-CLI roster incrementally into git
notes. Threadhop is the resume layer on top: one picker across CLIs, honest
session typing, and rehydration of a conversation into a *different* CLI —
without claiming to transfer hidden reasoning or provider-private state, except
where it's verifiably real: a Codex-origin conversation fabricated back into
Codex replays its provider-encrypted reasoning blobs verbatim by default (see
"Encrypted reasoning replay" below), and the imported-session notice discloses
exactly that whenever it happens.

## Usage

```sh
# capture (once per machine): conversation-ledger hooks
cledger install all

# pick a conversation from this repo's history and resume it anywhere
threadhop resume            # interactive: choose conversation, then target CLI
threadhop resume codex      # resume straight into Codex
threadhop resume claude     # resume straight into Claude Code
threadhop resume opencode   # resume straight into opencode
threadhop resume qwen       # native visible-text import where format supported
threadhop resume gemini     # transcript bootstrap
threadhop mirror codex claude   # keep your recent conversations in these CLIs' own pickers
threadhop mirror enable codex claude   # ...automatically, after every turn
threadhop targets           # list implemented routes for all twenty targets
threadhop list              # print compatible conversations
threadhop records --help    # shared cledger records maintenance commands

# options
#   --all                   include collaborators' conversations
#   --any-commit            include conversations from other branches/commits
#   --bootstrap             force transcript rehydration instead of native fabrication
#   --no-reasoning-replay   don't replay Codex-origin encrypted reasoning blobs
#   --new-copy              always create a separate session (see "Bridging again" below)

# optional: make bare `claude --resume` / `codex resume` open the merged picker
threadhop shim install
```

`threadhop records <command>` operates on the **shared cledger conversation
records** at `refs/notes/conversation-ledger`, including threadhop's
continuation events. It uses cledger's exact Ledger factory; threadhop has no
separate notes ref, profile, transport hook, or `transport-push` entrypoint.
`cledger` owns capture, hook installation (`cledger install all`), and notes
transport. For example, `threadhop records sync --fetch-only` fetches the
shared records. `threadhop records review`, `inspect`, `redact`, `allow`, and
manual `reanchor` are human-only operations; run them yourself in a plain
terminal. `threadhop sync`, `review`, `inspect`, `redact`, `allow`, and
`reanchor` are shortcuts to the same records dispatcher.

For standalone annals maintenance, register cledger's existing namespace once:

```sh
annals profile add conversation-ledger \
  --namespace conversation-ledger \
  --incoming cledger-incoming \
  --internal-env CLEDGER_INTERNAL \
  --state-dir conversation-ledger \
  --config-file .cledger.json \
  --user-config-dir cledger \
  --cli-name cledger
```

Same-CLI selections use exact native resume when implemented; Aider and Continue use transcript bootstrap because their current adapters cannot select an exact native session ID. Cross-CLI selections write a
target-native session file and hand off to the target's own resume; when that
is unsupported for the installed CLI version, threadhop falls back to a fresh
session bootstrapped with the literal transcript.

**Bridging again.** Resuming a conversation into Claude Code or Codex a second
time brings the copy made last time up to date instead of adding another
session to that CLI's picker. A copy is only reused when it is on this machine
(for Claude Code, written from the same directory) and you have not typed in
it; a copy you continued is your own branch, so it is left exactly as it is and
a new copy is made. `--new-copy` always makes a separate session.

**Mirroring.** `threadhop mirror <target-cli...>` keeps one up-to-date copy of
each of your recent conversations in each named CLI, so they show up in that
CLI's own resume picker (`claude --resume`, `codex resume`) without running
threadhop first. Each run creates missing copies and brings existing ones up to
date in place; a run with nothing new writes nothing. Only Claude Code and Codex
are supported, because they can update a copy rather than add another session
every time. It is deliberately narrow:

- only **your own** conversations: every human turn must carry your git email,
  so collaborators' and shared conversations are never copied;
- the `--limit` (default 10) most recent, from this repo's ledger;
- never into the CLI a conversation came from, and never a copy threadhop wrote
  that nobody has continued (so copies can't bounce between CLIs);
- a copy you continued is your own branch: it is left exactly as it is and no
  replacement is made (`threadhop resume` makes a fresh copy on demand), while
  the continued copy is itself mirrored like any other conversation of yours;
- no bootstrap fallback, since that would start a live session.

Copies are filed for the directory mirror runs in, which is where those CLIs'
pickers look. `--dry-run` shows what would be created or updated. Targets and
limit can be set once in `~/.threadhop/config.json`:
`{"mirror": {"targets": ["codex", "claude-code"], "limit": 10}}`.

**Automatic mirroring.** `threadhop mirror enable codex claude` does the same
after every turn, with nothing to run by hand:

```sh
cledger install claude-code && cledger install codex   # capture comes first
threadhop mirror enable codex claude
threadhop mirror status    # hooks installed, and what recent runs did
threadhop mirror disable   # removes the hooks; copies made so far stay
```

`enable` adds a `threadhop mirror-trigger <cli>` hook next to cledger's in each
CLI that has somewhere else to send its conversations (`~/.claude/settings.json`,
`~/.codex/config.toml`, each backed up first). It refuses, changing nothing,
until cledger captures that CLI. Codex asks you to approve a new hook once:
open `codex`, run `/hooks` and approve it. Claude Code picks the hook up
without a restart, including in sessions already open.

After each turn, the trigger hands the session to a background worker and
returns at once, so the CLI never waits on it. The worker captures that
session itself (cledger's hook runs alongside and may not have finished),
then mirrors that one conversation under all of the rules above, into the
folder the session ran in. Runs in one repository never overlap: a lock under
`.git/threadhop/` makes back-to-back triggers (a turn's Stop, then
SessionEnd, or several sessions at once) wait and then fold into one run, and
`threadhop resume` and a manual `threadhop mirror` take the same lock.
Each run's result is appended to `~/.threadhop/mirror.log`. Earlier
conversations are copied the next time they change; run `threadhop mirror`
once in a repository to copy its recent ones now. Mirroring refuses to run in
a repository where cledger is turned off (`.cledger.json` `{"enabled": false}`),
because it couldn't record its copies and would make new ones every time.

One gap to know about: a copy that is open in its CLI, not yet typed in, is
still brought up to date on disk when the original changes, but the open
session doesn't see those turns. Reopen it before typing; if you type first,
the copy's file holds turns that session never saw.

opencode works in both directions as of conversation-ledger 0.18.0, which
captures it via a `session.idle` plugin rather than a shell hook. Two things
differ from the other CLIs in practice. Its sessions live in one shared SQLite
DB rather than per-session files, so fabrication goes through `opencode
import`, and a bridged session is filed under the current directory's opencode
project (threadhop looks that up; if the directory isn't a registered opencode
project the session lands in the `global` one and is listed everywhere). And
`threadhop shim install` writes no opencode shim — opencode has no bare
"open my sessions" command to intercept, since `-s` always takes an id.
When the source model isn't one opencode can run, the bridged session uses
the model opencode would start a new session with (your configured `model`,
including `OPENCODE_CONFIG_CONTENT`), and the import notice says so.

Bridging into opencode right after an opencode session ends can fail with
`database is locked`: all opencode processes share one SQLite database, and
cledger is still capturing the session that just ended. threadhop then
falls back to a bootstrap session. Wait a few seconds and re-run to get a
native one. See [the opencode spec](docs/specs/opencode-session-format.md),
§8.

## Encrypted reasoning replay

Codex's `reasoning` response_items carry ciphertext only OpenAI's servers can
decrypt; conversation-ledger preserves it losslessly and opaquely (0.10.0+).
When fabricating a Codex-origin conversation back into Codex, threadhop
replays those blobs verbatim by default, which can restore hidden reasoning
provider-side (verified same-account and cross-account: see
conversation-ledger's roadmap). Replay is gated per-event on the reasoning
event's own `producer.source === "codex"`, so it can never apply to a
Claude Code target — foreign reasoning can't be forged as a native reasoning
item, so the only real switch is whether provider-matched replay happens.
The fabricated session's import notice discloses how many blocks were
replayed; the rest of the conversation is still the literal folded-text
transcript, same as always.

Opt out with `--no-reasoning-replay`, or persistently via
`{"reasoningReplay": false}` in `~/.threadhop/config.json`.

See [product intent](docs/PRODUCT_INTENT.md), the
[roadmap](docs/ROADMAP.md), and the
[WIP technical design](docs/WIP_TECHNICAL_DESIGN.md).

## Development

```sh
npm install   # links ../conversation-ledger
npm test      # build + node --test
npm run verify:plan # planned installed-TUI hub matrix (does not launch CLIs)
```

The [CLI integration program](docs/CLI_INTEGRATION_PROGRAM.md) documents the
implemented twenty-target roster, exact-version evidence and known limitations.
Claude, Codex, OpenCode, Pi, Qwen, Gemini, Goose and Kilo have native import writers; every
roster target has a transcript bootstrap route. Implemented syntax is distinct
from installed certification: authentication blockers, native runtime failures,
and untested versions remain visible in the reports.

```sh
npm run verify:installed -- --cledger /clean/cledger/dist/cli.js --only codex,opencode --mode native-import --output /tmp/thop-evidence
npm run verify:program -- --cledger /clean/cledger/dist/cli.js --runtime-dir /tmp/pinned-clis --output /tmp/thop-matrix
npm run verify:report -- /tmp/thop-matrix/evidence.json
```

Tests use disposable profiles, a bounded local scripted provider, real installed
CLIs and actual PTYs. They retain terminal traces, reconstructed SVG screens,
provider requests and automatically captured records; they never backfill a
failed capture to obtain a pass. Hub campaigns exercise both directions through
Claude/Codex/OpenCode on macOS and Linux. Scheduled candidate reviews create
draft evidence proposals without promoting pins or merging automatically.

For a contributor's local model, pass `--local-model config.json` to
`verify:installed`. The JSON must specify a loopback `endpoint` (server root),
`model`, and `protocol` (`messages`, `responses`, `chat-completions` or `gemini`).
Optional `maxRequests`, `maxOutputTokens` and `timeoutMs` bound the canary.
Each CLI keeps its native protocol; incompatible configurations fail explicitly.
Paid canaries require `--provider-config` with `tier: "usual-provider"`, HTTPS
endpoint, protocol/model, `budgetUsd`, explicit `inputUsdPerMillionTokens` and
`outputUsdPerMillionTokens`, and `apiKeyEnv: "THREADHOP_VERIFY_PROVIDER_API_KEY"`.
Set that dedicated environment variable yourself; ordinary account credentials
are never inherited. Requests reserve a conservative text/token estimate before
inference and reject multimodal inputs. Supplied prices determine the estimate;
it is not a vendor billing guarantee. Paid and local-model evidence remain
separate from scripted passes. Neither live tier has been certified in this run.
Full visual layout judging remains separate work.

## License

[MIT](LICENSE)
