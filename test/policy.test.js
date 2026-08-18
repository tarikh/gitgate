import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { globToRegExp, matchesAny, parseJob, parseDuration, loadJobFile } = await import("../dist/index.js");

test("globs: explicit semantics", () => {
  const ok = (g, p) => assert.ok(globToRegExp(g).test(p), `${g} should match ${p}`);
  const no = (g, p) => assert.ok(!globToRegExp(g).test(p), `${g} should NOT match ${p}`);
  ok("docs/**", "docs/a.md");
  ok("docs/**", "docs/deep/er/a.md");
  ok("docs/", "docs/a.md");
  no("docs/**", "docs");
  no("docs/**", "docsx/a.md");
  ok("*.md", "README.md");
  no("*.md", "docs/README.md");
  ok("**/*.md", "README.md");
  ok("**/*.md", "a/b/c.md");
  ok("**", "anything/at/all");
  ok("docs/*/index.md", "docs/x/index.md");
  no("docs/*/index.md", "docs/x/y/index.md");
  ok("file?.txt", "file1.txt");
  no("file?.txt", "file10.txt");
  ok("src/[ab].ts", "src/a.ts");
  no("src/[ab].ts", "src/c.ts");
  ok("a.b", "a.b");
  no("a.b", "aXb");
  assert.equal(matchesAny("docs/x.md", ["src/**", "docs/**"]), "docs/**");
  assert.equal(matchesAny("docs/x.md", ["src/**"]), undefined);
});

test("durations", () => {
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration(4000), 4000);
  assert.throws(() => parseDuration("5 minutes"));
});

test("job schema: defaults, strictness, and write-requires-policy", () => {
  const j = parseJob({ name: "x", repo: "r", engine: { command: ["e"] }, policy: { allow: ["**"] } });
  assert.equal(j.branch, "main");
  assert.equal(j.mode, "write");
  assert.equal(j.timeout, "10m");
  assert.equal(j.publish.park_prefix, "gitgate/parked");
  assert.equal(j.publish.retries, 3);
  assert.equal(j.policy.allow_deletions, false);
  assert.equal(j.policy.ignored_files, "reject");
  assert.equal(j.queued_run_cap, 5);
  assert.throws(() => parseJob({ name: "x", repo: "r", engine: { command: ["e"] } }), /write jobs require a policy/);
  assert.throws(() => parseJob({ name: "x", repo: "r", engine: { command: ["e"] }, policy: { allow: [] } }), /allow/);
  assert.throws(() => parseJob({ name: "x", repo: "r", engine: { command: ["e"] }, policy: { allow: ["**"] }, bogus: 1 }), /bogus|unrecognized/i);
  assert.throws(() => parseJob({ name: "bad name!", repo: "r", engine: { command: ["e"] }, policy: { allow: ["**"] } }), /job name/);
  assert.throws(() => parseJob({ name: "x", repo: "r", engine: { command: ["e"] }, policy: { allow: ["**"] }, timeout: "soon" }), /timeout/);
  const ro = parseJob({ name: "x", repo: "r", mode: "read-only", engine: { command: "e" } });
  assert.equal(ro.policy, undefined);
});

test("job files: YAML loads and relative repo/runs_dir resolve against the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitgate-job-"));
  const file = path.join(dir, "job.yml");
  fs.writeFileSync(file, `
name: docs-refresh
repo: ../repo
runs_dir: ./runs
engine:
  command: [codex, exec, "{prompt}"]
policy:
  allow: [docs/**]
`);
  const j = loadJobFile(file);
  assert.equal(j.repo, path.resolve(dir, "../repo"));
  assert.equal(j.runs_dir, path.join(dir, "runs"));
  assert.deepEqual(j.engine.command, ["codex", "exec", "{prompt}"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
