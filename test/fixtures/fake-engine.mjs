// A stand-in for any real engine. It reads the prompt from GITGATE_PROMPT_FILE
// and misbehaves on demand so every gitgate safety outcome can be exercised
// without a model or a network. Each keyword is one thing a real agent might do.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const cwd = process.env.GITGATE_WORKSPACE;
const prompt = fs.readFileSync(process.env.GITGATE_PROMPT_FILE, "utf8");
const out = process.env.GITGATE_OUTPUT_FILE;
if (!cwd || !out || cwd !== process.cwd()) {
  process.stderr.write("fake-engine: gitgate contract env missing or cwd mismatch\n");
  process.exit(64);
}
const has = (k) => prompt.includes(k);
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), text);
};
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (has("SLEEP")) {
  // A grandchild that would write AFTER the deadline if only the direct child were killed.
  spawn(
    process.execPath,
    ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.env.FAKE_SENTINEL, 'escaped'), 700); setInterval(() => {}, 1000)"],
    { stdio: "ignore", env: process.env },
  );
  setInterval(() => {}, 1000);
} else {
  if (has("WRITE_ALLOWED")) write("docs/notes.md", "changed by engine\n");
  if (has("WRITE_NEW")) write("docs/new-page.md", "new page\n");
  if (has("WRITE_DENIED")) write("src/index.ts", "// tampered\n");
  if (has("WRITE_OUTSIDE")) write("README.md", "tampered\n");
  if (has("DELETE_FILE")) fs.rmSync(path.join(cwd, "docs/notes.md"));
  if (has("DELETE_OUTSIDE")) fs.rmSync(path.join(cwd, "README.md"));
  if (has("EXEC_FILE")) {
    write("docs/run.sh", "#!/bin/sh\n");
    fs.chmodSync(path.join(cwd, "docs/run.sh"), 0o755);
  }
  if (has("SYMLINK")) fs.symlinkSync("../README.md", path.join(cwd, "docs/link.md"));
  if (has("NESTED_GIT")) {
    fs.mkdirSync(path.join(cwd, "docs/vendor/.git"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs/vendor/.git/HEAD"), "ref: refs/heads/main\n");
    write("docs/vendor/file.md", "vendored\n");
  }
  if (has("ROOT_GIT")) {
    // What a real agent does when it decides to "commit its work".
    git(cwd, "init", "-q");
    git(cwd, "-c", "user.name=m", "-c", "user.email=m@x", "add", "-A");
    write("docs/notes.md", "committed by model\n");
  }
  if (has("IGNORED")) write("build/out.txt", "artifact\n");
  if (has("MANY")) for (let i = 0; i < 5; i++) write(`docs/many-${i}.md`, `${i}\n`);
  if (has("PRINT_ENV")) fs.writeFileSync(out, Object.keys(process.env).sort().join("\n"));
  if (has("PRINT_TMP")) fs.writeFileSync(out, process.env.TMPDIR ?? "");
  if (has("STDOUT_ONLY")) process.stdout.write("reply on stdout\n");
  if (has("BIG_OUTPUT")) {
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) process.stdout.write(chunk);
  }
  if (has("RACE") || has("CONFLICT")) {
    // Someone else lands a commit on the remote while the engine works.
    const remote = process.env.FAKE_REMOTE;
    const other = fs.mkdtempSync(path.join(process.env.TMPDIR, "other-"));
    git(other, "clone", "-q", remote, "wt");
    const wt = path.join(other, "wt");
    if (has("CONFLICT")) fs.writeFileSync(path.join(wt, "docs/notes.md"), "someone else's edit\n");
    else fs.writeFileSync(path.join(wt, "docs/other.md"), "unrelated concurrent edit\n");
    git(wt, "-c", "user.name=o", "-c", "user.email=o@x", "add", "-A");
    git(wt, "-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "concurrent");
    git(wt, "push", "-q", "origin", "HEAD:main");
    write("docs/notes.md", "changed by engine\n");
  }
  if (has("FAIL")) {
    process.stderr.write("engine blew up: specific diagnostic\n");
    process.exit(3);
  }
  if (!fs.existsSync(out) && !has("STDOUT_ONLY") && !has("NO_REPLY")) fs.writeFileSync(out, "fake engine reply\n");
}
