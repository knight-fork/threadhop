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

Conversation Ledger and the library under it,
[annals](https://github.com/evintunador/annals), are bundled inside threadhop
(MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)), so there is one
package to install and nothing else to clone.

## Install

Needs Node.js 20 or newer and git.

```sh
npm install -g threadhop
threadhop setup --mirror
```

That's it. `threadhop setup` records conversations from Claude Code and Codex
(whichever you have), keeps them on this machine unless a repository opts in to
sharing, and with `--mirror` keeps a copy of each conversation in the other
CLI's own resume list. If you use Codex, open it once, type `/hooks` and approve
the new hooks: Codex ignores a hook until you do.

Setup stops, changing nothing, if git doesn't know your email yet. Every
recorded turn is attributed to it, which is how threadhop tells your
conversations from a teammate's:

```sh
git config --global user.email "you@company.com"
git config --global user.name  "Your Name"
```

From source instead: `git clone https://github.com/knight-fork/threadhop.git &&
cd threadhop && npm install && npm link`, then `threadhop setup --mirror`.

The package also provides the `cledger` command, so hooks from an earlier
standalone conversation-ledger install keep working. If you installed
conversation-ledger globally before, run `npm rm -g conversation-ledger` first
so the two `cledger` commands don't collide.

[docs/CHEATSHEET.md](docs/CHEATSHEET.md) has setup and the everyday commands on
one page.

## Use cases

Each of these assumes `threadhop setup` has run on every machine involved, and
that Claude Code or Codex was started **inside the project's git repository**:
a turn is recorded into the repository the CLI is in when the turn ends, and
nothing is recorded outside one.

### You hit a usage limit mid-task: carry on in the other CLI

You've spent an hour in Claude Code planning a parser and hit your limit.

```sh
threadhop resume codex
```

Pick the conversation and Codex opens with the whole visible conversation
(your messages, the answers, tool calls and their output) as a native Codex
session, so you keep going where you stopped. It works the other way too
(`threadhop resume claude`). Hidden reasoning doesn't carry across CLIs, and
the session opens with a notice saying exactly what was imported.

### Your conversations are already in the other CLI's list

With `threadhop setup --mirror`, a copy of each conversation is kept up to date
in the other CLI after every turn, so `codex resume` lists your Claude Code
conversations and `claude --resume` lists your Codex ones, when run from the
same folder. Nothing to run. Only conversations that are entirely yours are
mirrored (never a teammate's), and `threadhop mirror status` shows what it has
done.

### Hand a conversation to a teammate

Alice explored a bug with Claude Code, has to switch tasks, and wants Bob to
pick it up with all the context: what was tried, what failed, what the agent
found.

**Once per repository** (private repositories only, because everything said in
the conversations travels with the code), someone commits:

```sh
echo '{"transport": {"hook": true, "fetchRefspec": true}}' > .cledger.json
git add .cledger.json && git commit -m "Share agent conversations with the team"
git push
```

**Alice** keeps working as usual and pushes her branch. `git push` uploads the
conversations behind the commits she pushes, after scanning them for secrets.
Work she hasn't pushed, and uncommitted changes, stay on her machine.

**Bob**, after `threadhop setup` on his machine:

```sh
git clone git@github.com:acme/calculator.git && cd calculator
threadhop records sync --fetch-only   # once after cloning; later a plain `git pull` or `git fetch` brings them
threadhop list --all
```
```
[1]  Claude Code  2h ago   4 turns  by Alice  · Plan the expression parser for our calculator
```
```sh
threadhop resume --all          # pick [1], then pick Claude Code or Codex
```

Bob's CLI opens with Alice's conversation, and he continues it in whichever CLI
he prefers. Without `--all`, `list` and `resume` show conversations you took
part in, branches other people made of them, and older ones with no recorded
author. Naming a branch (`git pull origin feature`) makes git skip the
conversations, so use a plain `git pull` to get them.

### See where a teammate took your conversation

When Bob continues Alice's conversation and pushes, the conversation now has a
branch. Alice runs `git pull` then `threadhop list`, and sees it drawn the way
`git log --graph` draws commits:

```
[1]  Claude Code  2h ago   6 turns  · plan the expression parser
[2]  └─ Codex     1h ago   6 turns  by Bob  ↳ from turn 4, +2 turns  · handle operator precedence
```

Pick `[1]` to carry on from where she left off, or `[2]` to carry on from where
Bob did: her first four turns, then his two. Neither copy overwrites the other.
A copy nobody has typed in is the same point as its original, so it isn't
listed separately.

### Review a pull request with the conversation that produced it

Conversations are anchored to the commits they were made on, so they follow
the branch. To see why an agent-written PR looks the way it does:

```sh
git fetch && git switch feature/precedence
threadhop list --all              # conversations behind this branch
cledger conversations             # every recorded conversation id in this repo
cledger show <id>                 # read one without resuming it
```

When the PR merges, its conversations become part of `main`'s history. When it
is declined they stay on its branch (`threadhop list --any-commit` still finds
them).

### Move between your own laptop and desktop

Same mechanism as handing off to a teammate, with you on both ends: in a
repository that shares conversations, push from the laptop, then on the desktop
run `git pull` and `threadhop resume`. Both machines use the same git email, so
the conversation is listed as yours without `--all`.

### Keep a repository's conversations out of it entirely

For a repository that must never record conversations (a client repo, or
anything public), commit this as its `.cledger.json`:

```sh
echo '{"enabled": false}' > .cledger.json
```

`threadhop setup` turns sharing off for every repository on your machine
(`~/.config/cledger/config.json`), so a repository only carries conversations
if someone commits the sharing `.cledger.json` above. Never commit that one to
a public repository.

## Usage

```sh
# once per machine: capture Claude Code + Codex, optionally auto-mirror
threadhop setup --mirror

# pick a conversation from this repo's history and resume it anywhere
threadhop resume            # interactive: choose conversation, then target CLI
threadhop resume codex      # resume straight into Codex
threadhop resume claude     # resume straight into Claude Code
threadhop resume opencode   # any of the twenty targets; `threadhop targets` shows each one's route
threadhop list              # print compatible conversations
threadhop mirror codex claude          # copy your recent conversations into these CLIs' pickers now
threadhop mirror enable codex claude   # ...automatically, after every turn
threadhop mirror status | disable
threadhop targets           # native import / exact resume / bootstrap, per target
threadhop records --help    # maintain the shared conversation records
threadhop --version

# options
#   --all                   include collaborators' conversations
#   --any-commit            include conversations from other branches/commits
#   --bootstrap             force transcript rehydration instead of native fabrication
#   --no-reasoning-replay   don't replay Codex-origin encrypted reasoning blobs
#   --new-copy              always create a separate session (see "Bridging again" below)

# optional: make bare `claude --resume` / `codex resume` open the merged picker
threadhop shim install
```

**Records.** Conversations are stored once, by the bundled `cledger`, as git
notes at `refs/notes/conversation-ledger`; threadhop's own continuation events
go into the same notes, with no separate ref. `threadhop records <command>`
maintains them (for example `threadhop records sync --fetch-only`), and
`threadhop sync`, `review`, `inspect`, `redact`, `allow` and `reanchor` are
shortcuts for the same commands. `review`, `inspect`, `redact`, `allow` and a
manual `reanchor` are for you to run yourself in a plain terminal, not for an
agent. Capture for CLIs other than Claude Code and Codex is installed with
`cledger install <cli>` (`cledger --help` lists them).

**Routes.** Resuming in the same CLI uses that CLI's own exact resume, except
Aider and Continue, which can't open a session by id and get a transcript
bootstrap instead. Resuming in a different CLI writes a
target-native session file and hands off to the target's own resume; when that
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

**Automatic mirroring.** `threadhop setup --mirror`, or `threadhop mirror
enable codex claude` on a machine where capture is already set up, does the
same after every turn. `threadhop mirror status` shows the hooks and what
recent runs did; `threadhop mirror disable` removes the hooks and keeps the
copies made so far.

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

**opencode** works in both directions. Its capture is a `session.idle` plugin
rather than a shell hook, installed with `cledger install opencode`. Two things
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
decrypt; the recorder keeps it byte for byte without reading it.
When fabricating a Codex-origin conversation back into Codex, threadhop
replays those blobs verbatim by default, which can restore hidden reasoning
provider-side (verified same-account and cross-account; see
[conversation-ledger's roadmap](https://github.com/evintunador/conversation-ledger)). Replay is gated per-event on the reasoning
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
npm install   # no sibling checkouts: conversation-ledger and annals live in src/vendor
npm test      # build + node --test (threadhop and the vendored libraries)
npm run verify:plan # planned installed-TUI hub matrix (does not launch CLIs)
```

The [CLI integration program](docs/CLI_INTEGRATION_PROGRAM.md) documents the
implemented twenty-target roster, exact-version evidence and known limitations.
Claude, Codex, OpenCode, Pi, Qwen, Gemini, Goose and Kilo have native import writers; every
roster target has a transcript bootstrap route. Implemented syntax is distinct
from installed certification: authentication blockers, native runtime failures,
and untested versions remain visible in the reports.

```sh
npm run verify:installed -- --cledger dist/vendor/conversation-ledger/cli.js --only codex,opencode --mode native-import --output /tmp/thop-evidence
npm run verify:program -- --cledger dist/vendor/conversation-ledger/cli.js --runtime-dir /tmp/pinned-clis --output /tmp/thop-matrix
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
separate from scripted passes. Neither live tier is certified yet, and judging
full visual layout is separate work.

Updating the vendored libraries: see [src/vendor/README.md](src/vendor/README.md).

## License

[MIT](LICENSE). Bundled conversation-ledger and annals: MIT, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
