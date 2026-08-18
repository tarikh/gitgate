// The conformance suite: every outcome, one test each, against a real bare
// remote and a fake engine. If you swap the engine for your own and these
// still pass, the safety boundary holds.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, git, job, remoteBranches, remoteFile, remoteHead, root, runDirs } from "./helpers.js";

const { runJob, parseJob } = await import("../dist/index.js");
const quiet = { log: () => {} };
const run = (j, opts = {}) => runJob(parseJob(j), { ...quiet, ...opts });

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("pushed: an allowed edit lands on the remote branch, is verified there, and leaves no run behind", async () => {
  const f = fixture("pushed");
  const before = remoteHead(f);
  const o = await run(job(f), { prompt: "WRITE_ALLOWED" });
  assert.equal(o.status, "pushed", o.reason);
  assert.equal(o.branch, "main");
  assert.equal(o.sha, remoteHead(f));
  assert.notEqual(before, o.sha);
  assert.deepEqual(o.changedPaths, ["docs/notes.md"]);
  assert.equal(remoteFile(f, "docs/notes.md"), "changed by engine");
  assert.equal(o.reply, "fake engine reply");
  assert.deepEqual(runDirs(f), []);
  const log = git(f.dir, "--git-dir", f.remote, "log", "-1", "--format=%an <%ae> %s");
  assert.equal(log, "gitgate <gitgate@localhost> test: engine change");
});

test("pushed: a local clone as `repo` publishes to ITS origin, from origin's tip, without leaking local-only commits", async () => {
  const f = fixture("local-clone");
  fs.writeFileSync(path.join(f.clone, "docs/local-only.md"), "must not leak\n");
  git(f.clone, "-c", "user.name=l", "-c", "user.email=l@x", "add", "-A");
  git(f.clone, "-c", "user.name=l", "-c", "user.email=l@x", "commit", "-qm", "local ahead");
  const o = await run(job(f, { repo: f.clone }), { prompt: "WRITE_ALLOWED" });
  assert.equal(o.status, "pushed", o.reason);
  assert.equal(remoteFile(f, "docs/notes.md"), "changed by engine");
  assert.throws(() => remoteFile(f, "docs/local-only.md"));
});

test("clean: an engine that changes nothing publishes nothing", async () => {
  const f = fixture("clean");
  const before = remoteHead(f);
  const o = await run(job(f), { prompt: "NOOP" });
  assert.equal(o.status, "clean");
  assert.equal(remoteHead(f), before);
  assert.deepEqual(runDirs(f), []);
});

test("audited: --dry-run audits and reports but never publishes", async () => {
  const f = fixture("dry-run");
  const before = remoteHead(f);
  const o = await run(job(f), { prompt: "WRITE_ALLOWED WRITE_NEW", dryRun: true });
  assert.equal(o.status, "audited");
  assert.equal(o.dryRun, true);
  assert.deepEqual(o.changedPaths, ["docs/new-page.md", "docs/notes.md"]);
  assert.equal(remoteHead(f), before);
  // and a dry run of a policy violation still says so
  const r = await run(job(f), { prompt: "WRITE_DENIED", dryRun: true });
  assert.equal(r.status, "rejected");
});

test("replied: read-only runs return the reply and discard anything the engine wrote", async () => {
  const f = fixture("read-only");
  const before = remoteHead(f);
  const o = await run(job(f, { mode: "read-only", policy: undefined }), { prompt: "WRITE_ALLOWED WRITE_DENIED" });
  assert.equal(o.status, "replied");
  assert.equal(o.reply, "fake engine reply");
  assert.deepEqual(o.changedPaths, ["docs/notes.md", "src/index.ts"]);
  assert.equal(remoteHead(f), before);
  assert.deepEqual(runDirs(f), []);
});

test("rejected: every policy violation rejects the WHOLE run and publishes nothing", async () => {
  const f = fixture("rejected");
  const before = remoteHead(f);
  const cases = [
    ["WRITE_ALLOWED WRITE_DENIED", /outside the allow-list: src\/index\.ts/],
    ["WRITE_ALLOWED WRITE_OUTSIDE", /outside the allow-list: README\.md/],
    ["WRITE_ALLOWED DELETE_FILE", /deletion is not allowed/],
    ["WRITE_ALLOWED DELETE_OUTSIDE", /deletion is not allowed/],
    ["WRITE_ALLOWED EXEC_FILE", /executable files are not allowed/],
    ["WRITE_ALLOWED SYMLINK", /symlinks are forbidden/],
    ["WRITE_ALLOWED IGNORED", /ignored file written/],
    ["WRITE_ALLOWED NESTED_GIT", /model-created Git state quarantined: docs\/vendor\/\.git/],
    ["WRITE_ALLOWED ROOT_GIT", /model-created Git state quarantined: \.git/],
    ["MANY", /exceeds max_changed_files=3/],
  ];
  for (const [prompt, expected] of cases) {
    const o = await run(job(f, { policy: { max_changed_files: 3 } }), { prompt });
    assert.equal(o.status, "rejected", `${prompt}: ${o.status} ${o.reason}`);
    assert.match(o.reason, expected, prompt);
    assert.equal(remoteHead(f), before, prompt);
    assert.equal(o.reply, "fake engine reply", `${prompt}: reply still captured`);
  }
  assert.deepEqual(runDirs(f), []);
});

test("rejected: a deny glob wins over an allow glob", async () => {
  const f = fixture("deny-wins");
  const j = job(f, { policy: { allow: ["**"], deny: ["src/**"] } });
  const o = await run(j, { prompt: "WRITE_ALLOWED WRITE_DENIED" });
  assert.equal(o.status, "rejected");
  assert.match(o.reason, /deny pattern "src\/\*\*"/);
});

test("rejected: deny_create allows edits but not creations in owned paths", async () => {
  const f = fixture("deny-create");
  const j = job(f, { policy: { allow: ["docs/**"], deny_create: ["docs/new-*.md"] } });
  const ok = await run(j, { prompt: "WRITE_ALLOWED" });
  assert.equal(ok.status, "pushed", ok.reason);
  const o = await run(j, { prompt: "WRITE_NEW" });
  assert.equal(o.status, "rejected");
  assert.match(o.reason, /creating files matching deny_create pattern "docs\/new-\*\.md"/);
});

test("policy switches: deletions, executables and ignored discards are opt-in and then work", async () => {
  const f = fixture("switches");
  const j = job(f, { policy: { allow: ["docs/**"], allow_deletions: true, allow_executable: true, ignored_files: "discard" } });
  const o = await run(j, { prompt: "DELETE_FILE EXEC_FILE IGNORED WRITE_NEW" });
  assert.equal(o.status, "pushed", o.reason);
  assert.deepEqual(o.changedPaths, ["docs/new-page.md", "docs/notes.md", "docs/run.sh"]);
  assert.deepEqual(o.discardedPaths, ["build/out.txt"]);
  assert.throws(() => remoteFile(f, "docs/notes.md"), /does not exist|exists on disk, but not in/);
  assert.equal(git(f.dir, "--git-dir", f.remote, "ls-tree", "main", "docs/run.sh").split(/\s+/)[0], "100755");
  assert.throws(() => remoteFile(f, "build/out.txt"));
  // deletion outside the allow-list is still a violation
  const r = await run(j, { prompt: "DELETE_OUTSIDE" });
  assert.equal(r.status, "rejected");
  assert.match(r.reason, /outside the allow-list: README\.md/);
});

test("timed_out: the deadline kills the whole process group and nothing is audited or published", async () => {
  const f = fixture("timeout");
  const sentinel = path.join(f.dir, "escaped-grandchild.txt");
  const before = remoteHead(f);
  const j = job(f, { timeout: "300ms", engine: { env: { FAKE_REMOTE: f.remote, FAKE_SENTINEL: sentinel } } });
  const o = await run(j, { prompt: "SLEEP WRITE_ALLOWED" });
  assert.equal(o.status, "timed_out");
  assert.match(o.reason, /process group was killed/);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(fs.existsSync(sentinel), false, "grandchild survived the deadline");
  assert.equal(remoteHead(f), before);
  assert.deepEqual(runDirs(f), []);
});

test("failed: a non-zero engine exit is reported with its diagnostic and publishes nothing", async () => {
  const f = fixture("failed");
  const before = remoteHead(f);
  const o = await run(job(f), { prompt: "WRITE_ALLOWED FAIL" });
  assert.equal(o.status, "failed");
  assert.match(o.reason, /engine exited 3: engine blew up: specific diagnostic/);
  assert.equal(remoteHead(f), before);
});

test("failed: runaway output is cut off at the capture limit", async () => {
  const f = fixture("overflow");
  const o = await run(job(f), { prompt: "BIG_OUTPUT WRITE_ALLOWED" });
  assert.equal(o.status, "failed");
  assert.match(o.reason, /32 MB/);
});

test("pushed: a non-conflicting concurrent remote commit is rebased onto and the push still lands", async () => {
  const f = fixture("race");
  const o = await run(job(f), { prompt: "RACE" });
  assert.equal(o.status, "pushed", o.reason);
  assert.equal(remoteFile(f, "docs/notes.md"), "changed by engine");
  assert.equal(remoteFile(f, "docs/other.md"), "unrelated concurrent edit");
  assert.equal(o.sha, remoteHead(f));
});

test("parked: a conflicting concurrent commit parks the work on a verified remote branch and touches nothing else", async () => {
  const f = fixture("conflict");
  const o = await run(job(f), { prompt: "CONFLICT" });
  assert.equal(o.status, "parked", o.reason);
  assert.match(o.parkBranch, /^gitgate\/parked\/\d{8}T\d{6}Z$/);
  assert.equal(remoteFile(f, "docs/notes.md"), "someone else's edit", "main was not overwritten");
  assert.equal(remoteFile(f, "docs/notes.md", o.parkBranch), "changed by engine");
  assert.equal(remoteHead(f, o.parkBranch), o.sha);
  assert.ok(remoteBranches(f).includes(o.parkBranch));
  assert.deepEqual(runDirs(f), []);
});

test("queued: a push the remote refuses is retained with the checkout intact, and blocks new writes at the cap", async () => {
  const f = fixture("queued");
  const hook = path.join(f.remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  const j = job(f, { queued_run_cap: 1, publish: { retries: 2 } });
  const o = await run(j, { prompt: "WRITE_ALLOWED" });
  assert.equal(o.status, "queued");
  assert.match(o.reason, /did not land after 2 attempt/);
  assert.ok(o.retainedRun);
  assert.ok(fs.existsSync(path.join(o.retainedRun, "checkout", ".git")), "trusted git restored in retained run");
  assert.ok(fs.existsSync(path.join(o.retainedRun, ".queued.json")));
  assert.ok(fs.existsSync(path.join(o.retainedRun, "outcome.json")));
  assert.equal(fs.readFileSync(path.join(o.retainedRun, "checkout", "docs/notes.md"), "utf8"), "changed by engine\n");
  assert.equal(git(o.retainedRun + "/checkout", "log", "-1", "--format=%s"), "test: engine change");

  const blocked = await run(j, { prompt: "WRITE_ALLOWED" });
  assert.equal(blocked.status, "failed");
  assert.match(blocked.reason, /writes paused: 1 retained run/);
  assert.ok(fs.existsSync(o.retainedRun), "the queued run survives");
});

test("recovery: an interrupted run is restored, quarantined and queued — never audited or pushed", async () => {
  const f = fixture("recovery");
  const { createRunsManager } = await import("../dist/index.js");
  fs.mkdirSync(f.runs, { recursive: true });
  const runDir = path.join(f.runs, "run-interrupted");
  const checkout = path.join(runDir, "checkout");
  fs.mkdirSync(runDir);
  git(runDir, "clone", "-q", f.remote, checkout);
  fs.renameSync(path.join(checkout, ".git"), path.join(runDir, "trusted.git"));
  // no .active.json at all: died before the first marker — still recovered
  fs.writeFileSync(path.join(checkout, "docs/notes.md"), "interrupted edit\n");
  fs.mkdirSync(path.join(checkout, ".git"));
  const before = remoteHead(f);

  const runs = createRunsManager({ runsDir: f.runs, log: () => {} });
  const recovered = await runs.recoverInterrupted();
  assert.deepEqual(recovered, [runDir]);
  assert.ok(fs.existsSync(path.join(checkout, ".git", "HEAD")), "trusted git is back");
  assert.ok(fs.existsSync(path.join(runDir, "quarantined-model-git-0")));
  assert.ok(fs.existsSync(path.join(runDir, ".queued.json")));
  assert.equal(remoteHead(f), before);
  // a live run is left alone
  const live = path.join(f.runs, "run-live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, ".active.json"), JSON.stringify({ pid: process.pid }));
  assert.deepEqual(await runs.recoverInterrupted(), []);
  assert.deepEqual(runs.list().map((r) => [path.basename(r.runDir), r.state]), [["run-interrupted", "queued"], ["run-live", "active"]]);
});

test("--keep retains a rejected run for inspection, with logs, prompt, outcome and the restored checkout", async () => {
  const f = fixture("keep");
  const o = await run(job(f), { prompt: "WRITE_DENIED", keep: true });
  assert.equal(o.status, "rejected");
  assert.ok(o.retainedRun);
  for (const p of ["checkout/.git", "checkout/src/index.ts", "prompt.txt", "reply.txt", "outcome.json", "job.json", "logs/engine.stdout.log"]) {
    assert.ok(fs.existsSync(path.join(o.retainedRun, p)), p);
  }
  assert.equal(fs.existsSync(path.join(o.retainedRun, ".active.json")), false);
  const saved = JSON.parse(fs.readFileSync(path.join(o.retainedRun, "outcome.json"), "utf8"));
  assert.equal(saved.status, "rejected");
});
