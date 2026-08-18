import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitgate-test-"));
export const fakeEngine = path.resolve("test/fixtures/fake-engine.mjs");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A bare remote seeded with docs/, src/, README, .gitignore — plus a normal clone. */
export function fixture(name) {
  const dir = path.join(root, name);
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  const clone = path.join(dir, "clone");
  fs.mkdirSync(seed, { recursive: true });
  git(dir, "init", "--bare", "-q", remote);
  git(dir, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.name", "seed");
  git(seed, "config", "user.email", "seed@example.com");
  fs.mkdirSync(path.join(seed, "docs"));
  fs.mkdirSync(path.join(seed, "src"));
  fs.writeFileSync(path.join(seed, "docs", "notes.md"), "original\n");
  fs.writeFileSync(path.join(seed, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(seed, "README.md"), "readme\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), "build/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(dir, "clone", "-q", remote, clone);
  return { dir, remote, clone, runs: path.join(dir, "runs"), tmp: path.join(dir, "tmp") };
}

export function job(f, overrides = {}) {
  const { engine: engineOverrides, policy: policyOverrides, publish: publishOverrides, ...rest } = overrides;
  fs.mkdirSync(f.tmp, { recursive: true });
  return {
    name: "test-job",
    repo: f.remote,
    branch: "main",
    mode: "write",
    timeout: "5s",
    runs_dir: f.runs,
    engine: {
      command: [process.execPath, fakeEngine],
      env: { FAKE_REMOTE: f.remote },
      ...engineOverrides,
    },
    policy: { allow: ["docs/**"], deny: ["docs/secret/**"], ...policyOverrides },
    publish: { commit_message: "test: engine change", ...publishOverrides },
    ...rest,
  };
}

export const remoteFile = (f, file, ref = "main") => git(f.dir, "--git-dir", f.remote, "show", `${ref}:${file}`);
export const remoteHead = (f, ref = "main") => git(f.dir, "--git-dir", f.remote, "rev-parse", ref);
export const remoteBranches = (f) => git(f.dir, "--git-dir", f.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
export const runDirs = (f) => (fs.existsSync(f.runs) ? fs.readdirSync(f.runs).filter((n) => n.startsWith("run-")) : []);
