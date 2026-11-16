import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configDir, loadConfig, saveConfig } from "../config.js";

/** Isolate THREADHOP_HOME for the duration of `fn`, cleaning up after. */
async function withThreadhopHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "threadhop-config-test-"));
  const prev = process.env["THREADHOP_HOME"];
  process.env["THREADHOP_HOME"] = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["THREADHOP_HOME"];
    else process.env["THREADHOP_HOME"] = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("configDir honors the THREADHOP_HOME override", async () => {
  await withThreadhopHome(async (dir) => {
    assert.equal(configDir(), dir);
  });
});

test("loadConfig returns {} when no config file exists yet", async () => {
  await withThreadhopHome(async () => {
    assert.deepEqual(await loadConfig(), {});
  });
});

test("saveConfig then loadConfig round-trips", async () => {
  await withThreadhopHome(async () => {
    await saveConfig({ defaultTarget: "codex" });
    assert.deepEqual(await loadConfig(), { defaultTarget: "codex" });

    // overwrite round-trips too, not just first-write
    await saveConfig({ defaultTarget: "claude-code" });
    assert.deepEqual(await loadConfig(), { defaultTarget: "claude-code" });
  });
});

test("saveConfig writes pretty-printed JSON with a trailing newline", async () => {
  await withThreadhopHome(async (dir) => {
    await saveConfig({ defaultTarget: "codex" });
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(dir, "config.json"), "utf8"),
    );
    assert.ok(raw.endsWith("\n"));
    assert.ok(raw.includes("\n  "), "expected indented JSON");
  });
});

test("loadConfig returns {} when the config file is corrupt JSON", async () => {
  await withThreadhopHome(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "{ not valid json");
    assert.deepEqual(await loadConfig(), {});
  });
});

test("loadConfig returns {} when the config file contains JSON null", async () => {
  await withThreadhopHome(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "null");
    assert.deepEqual(await loadConfig(), {});
  });
});

test("configDir falls back to homedir()/.threadhop when THREADHOP_HOME is unset", async () => {
  // homedir() reads HOME live, so a spawned child with a fake HOME and no
  // THREADHOP_HOME exercises the fallback branch without touching the real
  // user home directory.
  const fakeHome = await mkdtemp(join(tmpdir(), "threadhop-config-fakehome-"));
  try {
    const modulePath = fileURLToPath(new URL("../config.js", import.meta.url));
    const script = `import(${JSON.stringify("file://" + modulePath)}).then((m) => { process.stdout.write(m.configDir()); });`;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    delete env["THREADHOP_HOME"];
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, join(fakeHome, ".threadhop"));
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});
