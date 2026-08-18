import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, job, root } from "./helpers.js";

const { runJob, parseJob, renderCommand, engineEnvironment } = await import("../dist/index.js");
const run = (j, opts = {}) => runJob(parseJob(j), { log: () => {}, ...opts });
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the engine sees an allowlisted environment, not gitgate's, plus the GITGATE_* contract", async () => {
  const f = fixture("env");
  process.env.SUPER_SECRET_TOKEN = "leak-me";
  process.env.WANTED_KEY = "pass-me";
  try {
    const o = await run(job(f, { mode: "read-only", policy: undefined, engine: { pass_env: ["WANTED_KEY"], env: { FAKE_REMOTE: f.remote, JOB_LEVEL: "1" } } }), { prompt: "PRINT_ENV" });
    assert.equal(o.status, "replied", o.reason);
    const keys = o.reply.split("\n");
    assert.ok(!keys.includes("SUPER_SECRET_TOKEN"), "parent secret leaked");
    for (const k of ["WANTED_KEY", "JOB_LEVEL", "PATH", "HOME", "TMPDIR", "GITGATE_JOB", "GITGATE_MODE", "GITGATE_WORKSPACE", "GITGATE_PROMPT_FILE", "GITGATE_OUTPUT_FILE"]) {
      assert.ok(keys.includes(k), `missing ${k}`);
    }
  } finally {
    delete process.env.SUPER_SECRET_TOKEN;
    delete process.env.WANTED_KEY;
  }
});

test("TMPDIR is scoped to the run so engine scratch never lands in the shared temp dir", async () => {
  const f = fixture("tmp");
  const o = await run(job(f, { mode: "read-only", policy: undefined }), { prompt: "PRINT_TMP" });
  assert.equal(o.status, "replied");
  assert.match(o.reply, /\/run-[^/]+\/tmp$/);
});

test("a runs_dir reached through a symlink still hands the engine canonical paths (macOS /var → /private/var)", async () => {
  const f = fixture("symlinked-runs");
  const real = path.join(f.dir, "real-runs");
  fs.mkdirSync(real);
  const link = path.join(f.dir, "runs-link");
  fs.symlinkSync(real, link);
  // fake-engine exits 64 unless GITGATE_WORKSPACE === process.cwd() (a realpath)
  const o = await run(job(f, { runs_dir: link }), { prompt: "WRITE_ALLOWED" });
  assert.equal(o.status, "pushed", o.reason);
  assert.deepEqual(fs.readdirSync(real), []);
});

test("a job cannot override the GITGATE_* contract via engine.env", () => {
  const ctx = { jobName: "j", mode: "write", workspace: "/w", promptFile: "/p", prompt: "hi", outputFile: "/o", logDir: "/l", tmpDir: "/t" };
  const env = engineEnvironment({ command: ["x"], env: { GITGATE_WORKSPACE: "/evil", HOME: "/other" }, pass_env: [] }, ctx);
  assert.equal(env.GITGATE_WORKSPACE, "/w");
  assert.equal(env.HOME, "/other", "non-contract vars are the job's to set");
});

test("string commands run through sh with placeholders shell-quoted; array commands substitute in place", async () => {
  const ctx = { jobName: "j", mode: "write", workspace: "/w s", promptFile: "/p", prompt: "it's a 'test'", outputFile: "/o", logDir: "/l", tmpDir: "/t" };
  const s = renderCommand({ command: "echo {prompt} > {output_file}", env: {}, pass_env: [] }, ctx);
  assert.equal(s.file, "/bin/sh");
  assert.equal(s.args[1], `echo 'it'\\''s a '\\''test'\\''' > '/o'`);
  const a = renderCommand({ command: ["run", "--cwd", "{workspace}", "{prompt}"], env: {}, pass_env: [] }, ctx);
  assert.deepEqual([a.file, ...a.args], ["run", "--cwd", "/w s", "it's a 'test'"]);

  const f = fixture("sh-engine");
  const o = await run(job(f, { engine: { command: "printf 'via sh\\n' > docs/notes.md && printf 'done' > {output_file}" } }), { prompt: "x" });
  assert.equal(o.status, "pushed", o.reason);
  assert.equal(o.reply, "done");
});

test("stdout is the reply when the engine writes no output file", async () => {
  const f = fixture("stdout-reply");
  const o = await run(job(f, { mode: "read-only", policy: undefined }), { prompt: "STDOUT_ONLY" });
  assert.equal(o.reply, "reply on stdout");
});

test("a missing engine binary is a failed outcome, not a crash", async () => {
  const f = fixture("missing-engine");
  const o = await run(job(f, { engine: { command: ["/nonexistent/engine"] } }), { prompt: "x" });
  assert.equal(o.status, "failed");
  assert.match(o.reason, /ENOENT/);
  assert.deepEqual(fs.existsSync(f.runs) ? fs.readdirSync(f.runs) : [], []);
});

test("the checkout given to the engine has no .git and no hooks reachable", async () => {
  const f = fixture("no-git");
  const probe = path.join(f.dir, "probe.mjs");
  fs.writeFileSync(probe, `
    import fs from "node:fs";
    const has = fs.existsSync(".git");
    fs.writeFileSync(process.env.GITGATE_OUTPUT_FILE, has ? "GIT-VISIBLE" : "hidden");
  `);
  const o = await run(job(f, { mode: "read-only", policy: undefined, engine: { command: [process.execPath, probe] } }), { prompt: "x" });
  assert.equal(o.reply, "hidden");
});
