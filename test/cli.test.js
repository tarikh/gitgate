import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, job, remoteFile, root } from "./helpers.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function gitgate(...args) {
  try {
    const r = await exec(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env } });
    return { code: 0, ...r };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("cli: run --json emits the outcome and the documented exit codes", async () => {
  const f = fixture("cli");
  const jobFile = path.join(f.dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job(f)));

  const ok = await gitgate("run", jobFile, "--prompt", "WRITE_ALLOWED", "--json", "--quiet");
  assert.equal(ok.code, 0, ok.stderr);
  const outcome = JSON.parse(ok.stdout);
  assert.equal(outcome.status, "pushed");
  assert.equal(remoteFile(f, "docs/notes.md"), "changed by engine");

  const rejected = await gitgate("run", jobFile, "--prompt", "WRITE_DENIED", "--json", "--quiet");
  assert.equal(rejected.code, 3);
  assert.equal(JSON.parse(rejected.stdout).status, "rejected");

  const dry = await gitgate("run", jobFile, "--prompt", "WRITE_NEW", "--dry-run", "--quiet");
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /^audited: audited 1 file/);

  const failed = await gitgate("run", jobFile, "--prompt", "FAIL", "--quiet");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^failed: /);

  const timeout = await gitgate("run", path.join(f.dir, "slow.json"), "--prompt", "SLEEP", "--quiet").catch(() => null);
  fs.writeFileSync(path.join(f.dir, "slow.json"), JSON.stringify(job(f, { timeout: "200ms" })));
  const t = await gitgate("run", path.join(f.dir, "slow.json"), "--prompt", "SLEEP", "--quiet");
  assert.equal(t.code, 4);
  void timeout;
});

test("cli: check validates, runs list/clear manage retained runs", async () => {
  const f = fixture("cli-runs");
  const jobFile = path.join(f.dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job(f)));
  const check = await gitgate("check", jobFile);
  assert.equal(check.code, 0);
  assert.equal(JSON.parse(check.stdout).branch, "main");

  const bad = await gitgate("check", path.join(f.dir, "nope.yml"));
  assert.equal(bad.code, 1);

  const kept = await gitgate("run", jobFile, "--prompt", "WRITE_DENIED", "--keep", "--json", "--quiet");
  const retained = JSON.parse(kept.stdout).retainedRun;
  const list = await gitgate("runs", "list", "--runs-dir", f.runs);
  assert.match(list.stdout, /kept\s+.*run-/);
  assert.match(list.stdout, /rejected/);
  const cleared = await gitgate("runs", "clear", path.basename(retained), "--runs-dir", f.runs);
  assert.equal(cleared.code, 0);
  assert.equal(fs.existsSync(retained), false);
  const empty = await gitgate("runs", "list", "--runs-dir", f.runs);
  assert.match(empty.stdout, /no runs/);
});
