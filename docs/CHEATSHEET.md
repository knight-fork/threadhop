# threadhop cheatsheet

Set up a machine that already has **Claude Code** and/or **Codex**, then the
commands you'll use day to day. Tested on macOS; Linux should work the same.

- **threadhop** continues a conversation from one CLI in another (or from a
  teammate's point), and can keep copies in each CLI's own resume list.
- **cledger** ([conversation-ledger](https://github.com/evintunador/conversation-ledger))
  records your conversations, which threadhop reads. It is installed alongside.

## 1. Install (once per machine)

Needs Node.js 20+ and git. Copy-paste:

```sh
# who you are: conversations are attributed to this email
git config --global user.email "you@company.com"
git config --global user.name  "Your Name"

# threadhop and its two libraries, side by side, at the tested versions
mkdir -p ~/tools && cd ~/tools
git clone https://github.com/evintunador/annals.git
git clone https://github.com/evintunador/conversation-ledger.git
git clone https://github.com/knight-fork/threadhop.git
git -C annals checkout -q dcd06c0f724cf3509b2d61dce7d0b537d4d86340
git -C conversation-ledger checkout -q f9853f7b38ee1fefdb587748055a18e240efb48c

# build, and put `cledger` and `threadhop` (alias `thop`) on your PATH
(cd annals && npm install)
(cd conversation-ledger && npm install && npm link)
(cd threadhop && npm install && npm link)

# keep conversations on this machine: `git push` never uploads them
mkdir -p ~/.config/cledger
echo '{"transport": {"hook": false, "fetchRefspec": false}}' > ~/.config/cledger/config.json

# record conversations from both CLIs
cledger install claude-code
cledger install codex

# optional: after every turn, keep a copy in the other CLI's resume list
threadhop mirror enable codex claude
```

Then, once: open `codex`, type `/hooks`, and approve the new hooks
(`cledger hook codex`, and `threadhop mirror-trigger codex` if you enabled
mirroring). Codex skips a hook until it is approved. Claude Code needs nothing.

Check it: `threadhop mirror status` should show capture (and the mirror
trigger) installed for both CLIs.

## 2. Every day

Start Claude Code or Codex **inside your project's git repo**. Each turn is
recorded into the repo you're in when it ends; outside a repo nothing is
recorded.

| Command | What it does |
|---|---|
| `threadhop list` | your conversations in this repo, drawn as branches |
| `threadhop resume` | pick a conversation, pick a CLI, continue it there |
| `threadhop resume codex` / `threadhop resume claude` | continue straight in that CLI |
| `threadhop list --all` | include teammates' conversations |
| `threadhop list --any-commit` | include conversations from other git branches |
| `threadhop resume --new-copy` | make a separate copy instead of updating the earlier one |
| `threadhop mirror codex claude` | copy your 10 most recent conversations in this repo into those CLIs now (plain `threadhop mirror` uses the CLIs given to `mirror enable`) |
| `threadhop mirror status` | hooks installed, and what recent automatic runs did |
| `threadhop mirror disable` | stop automatic mirroring (copies made so far stay) |
| `cledger conversations` | what has been recorded in this repo |
| `cledger show <id>` | read one recorded conversation |

Reading the list:

```
[1]  Claude Code  2h ago   6 turns  · plan the expression parser
[2]  └─ Codex     1h ago   6 turns  by Bob  ↳ from turn 4, +2 turns  · handle operator precedence
```

`[2]` is a branch of `[1]`: Bob continued it in Codex after turn 4 and added two
turns. Pick `[1]` to carry on from where you left off, `[2]` to carry on from
where Bob did.

## 3. Sharing with teammates (private repos only)

Off by default. To share a **private** repo's conversations with everyone who
can clone it, commit this file at the repo root, once:

```sh
echo '{"transport": {"hook": true, "fetchRefspec": true}}' > .cledger.json
git add .cledger.json && git commit -m "Share conversations with the team"
```

| You want to | Do |
|---|---|
| share your conversations | `git push` (only the branches you push; secrets are scanned first) |
| get teammates' conversations, first time after cloning | `threadhop records sync --fetch-only` |
| get them after that | plain `git pull` or `git fetch` (**not** `git pull origin <branch>`, which skips them) |
| pick up a teammate's work | `threadhop resume`, then choose their branch |

Never commit that `.cledger.json` to a public repo: everything said in its
conversations would be published. Merged pull requests bring their
conversations into `main`'s history; declined ones leave them on their branch.

## 4. Where things live

| What | Where |
|---|---|
| each CLI's own sessions (and threadhop's copies) | `~/.claude/projects/`, `~/.codex/sessions/` |
| recorded conversations | inside each repo's `.git` (git notes, `refs/notes/conversation-ledger`) |
| threadhop settings and the mirror log | `~/.threadhop/config.json`, `~/.threadhop/mirror.log` |
| cledger settings | `~/.config/cledger/config.json`, and `.cledger.json` per repo |

## 5. When something's off

- **`threadhop list` says nothing was captured**: start the CLI inside the repo;
  in Codex, approve the hooks under `/hooks`; `threadhop mirror status` shows
  whether capture is installed.
- **A teammate's conversation is missing**: they must have pushed that branch;
  run a plain `git fetch`; after a fresh clone, run
  `threadhop records sync --fetch-only` once.
- **No copy appeared in the other CLI**: `threadhop mirror status` lists recent
  runs and why one did nothing. Copies show up when that CLI is run from the
  same folder.
- **Don't record a particular repo**: commit `{"enabled": false}` as its
  `.cledger.json`.

## 6. Undo

```sh
threadhop mirror disable                      # removes threadhop's hooks
npm rm -g threadhop conversation-ledger       # removes the commands
```

cledger has no uninstall command: delete the `cledger hook claude-code` entries
from `~/.claude/settings.json` and the `cledger install codex` block from
`~/.codex/config.toml`, or restore the `.bak-*` copy saved next to each file
before it was changed.
