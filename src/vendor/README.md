# Vendored libraries

Threadhop ships these two libraries inside its own package, so installing
threadhop is one `npm install` with no sibling checkouts. Both are MIT-licensed
by Evin Tunador; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

| Directory | Upstream | Commit |
|---|---|---|
| `conversation-ledger/` | https://github.com/evintunador/conversation-ledger | `f9853f7b38ee1fefdb587748055a18e240efb48c` (0.27.1) |
| `annals/` | https://github.com/evintunador/annals | `dcd06c0f724cf3509b2d61dce7d0b537d4d86340` (0.1.0) |

The package exposes upstream's CLI as `cledger`
(`dist/vendor/conversation-ledger/cli.js`), so hooks written by an earlier
standalone install (`cledger hook claude-code`) keep working.

## Changes from upstream

Kept as small as possible so updates stay a copy plus these edits:

1. Bare imports `from "annals"` / `from "conversation-ledger"` are rewritten to
   relative paths (`../annals/index.js` and so on).
2. `conversation-ledger/version.ts` is new. Upstream read its version from its
   own `package.json`, which here is threadhop's; `cli.ts` `version()` and
   `adapters/common.ts` `packageVersion()` return `CLEDGER_VERSION` instead, so
   records still name the cledger version that wrote them.
3. `annals/test/secret-corpus.test.ts`: the fixture path points at its new
   location.
4. Not vendored: conversation-ledger's `verification/` harness (live-CLI
   evidence tooling, not runtime code) and the tests that import it
   (`test/verification*.test.ts`, `test/adapter-{aider,crush,droid,kilo,kimi,pi}.test.ts`).

## Updating

```sh
# from the threadhop root, with upstream checked out at the new commit in $UP
rsync -a --delete --exclude README.md --exclude LICENSE "$UP/annals/src/" src/vendor/annals/
rsync -a --delete --exclude README.md --exclude LICENSE --exclude version.ts --exclude 'verification/' \
  --exclude 'test/verification*' "$UP/conversation-ledger/src/" src/vendor/conversation-ledger/
# then re-apply the changes above, bump CLEDGER_VERSION, update the commits
# here and in THIRD_PARTY_NOTICES.md, and run `npm test`
```
