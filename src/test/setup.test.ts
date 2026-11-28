import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

interface Box { home: string; env: NodeJS.ProcessEnv }

/** A private HOME, git identity (optional) and fake CLIs: setup never touches real settings. */
async function withBox(opts: { identity: boolean; clis: string[] }, fn: (box: Box) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "threadhop-setup-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const [name, version] of [["claude", "2.1.316 (Claude Code)"], ["codex", "codex-cli 0.146.0"]] as const) {
    if (!opts.clis.includes(name)) continue;
    await writeFile(join(bin, name), `#!/bin/sh\necho "${version}"\n`);
    await chmod(join(bin, name), 0o755);
  }
  const gitconfig = join(home, ".gitconfig");
  await writeFile(gitconfig, opts.identity ? "[user]\n\temail = me@example.com\n\tname = Me\n" : "");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    THREADHOP_HOME: join(home, ".threadhop"),
  };
  try { await fn({ home, env }); } finally { await rm(home, { recursive: true, force: true }); }
}

async function run(box: Box, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], { env: box.env, cwd: box.home });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("setup refuses without a git identity and changes nothing", async () => {
  await withBox({ identity: false, clis: ["claude", "codex"] }, async (box) => {
    const r = await run(box, "setup");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /git config --global user\.email/);
    assert.equal(existsSync(join(box.home, ".config", "cledger", "config.json")), false);
    assert.equal(existsSync(join(box.home, ".claude", "settings.json")), false);
  });
});

test("setup installs capture for each CLI found, keeps conversations local, and can enable mirroring", async () => {
  await withBox({ identity: true, clis: ["claude", "codex"] }, async (box) => {
    const r = await run(box, "setup", "--mirror");
    assert.equal(r.code, 0, r.stderr);
    const cledgerConfig = JSON.parse(await readFile(join(box.home, ".config", "cledger", "config.json"), "utf8"));
    assert.deepEqual(cledgerConfig, { transport: { hook: false, fetchRefspec: false } });
    const claude = await readFile(join(box.home, ".claude", "settings.json"), "utf8");
    assert.match(claude, /hook claude-code/);
    assert.match(claude, /mirror-trigger claude-code/);
    const codex = await readFile(join(box.home, ".codex", "config.toml"), "utf8");
    assert.match(codex, /hook codex/);
    assert.match(codex, /mirror-trigger codex/);
    assert.match(r.stdout, /\/hooks/);

    const status = await run(box, "mirror", "status");
    assert.match(status.stdout, /Claude Code: capture installed, mirror trigger installed/);
    assert.match(status.stdout, /Codex: capture installed, mirror trigger installed/);
  });
});

test("setup keeps an existing cledger config and skips mirroring with only one CLI", async () => {
  await withBox({ identity: true, clis: ["claude"] }, async (box) => {
    const path = join(box.home, ".config", "cledger", "config.json");
    await mkdir(join(box.home, ".config", "cledger"), { recursive: true });
    await writeFile(path, '{"transport":{"hook":true}}\n');
    const r = await run(box, "setup", "--mirror");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await readFile(path, "utf8"), '{"transport":{"hook":true}}\n');
    assert.match(r.stdout, /mirroring skipped/);
    assert.doesNotMatch(r.stdout, /\/hooks/);
    assert.equal(existsSync(join(box.home, ".codex", "config.toml")), false);
  });
});

test("setup rejects unknown options", async () => {
  await withBox({ identity: true, clis: ["claude"] }, async (box) => {
    const r = await run(box, "setup", "--bogus");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown option: --bogus/);
  });
});
