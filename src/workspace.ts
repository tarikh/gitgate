// Disposable workspaces. Every write run gets a fresh clone proven equal to the
// remote branch, and its trusted `.git` is moved OUT of the tree the model can
// touch. The model therefore cannot commit, push, rewrite history, install
// hooks, or read the publisher's remote config — it can only change files.
// After the model exits, the trusted metadata is put back and whatever the
// model created that looks like Git state is quarantined, never honoured.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { firstLine, git, splitNul } from "./git.js";

export interface Workspace {
  runId: string;
  runDir: string;
  /** the tree the engine runs in */
  checkout: string;
  /** trusted .git, parked outside the checkout while the engine runs */
  trustedGit: string;
  /** commit the checkout started from (== remote branch tip at prepare time) */
  base: string;
  /** publish target */
  originUrl: string;
  branch: string;
  tmpDir: string;
}

export interface PrepareOptions {
  repo: string;
  branch: string;
  authorName: string;
  authorEmail: string;
}

export interface RunsManagerOptions {
  runsDir?: string;
  queuedRunCap?: number;
  log?: (line: string) => void;
}

export function defaultRunsDir(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "gitgate", "runs");
}

/** Marker files inside a run directory. */
export const MARKERS = {
  active: ".active.json",
  queued: ".queued.json",
  outcome: "outcome.json",
  job: "job.json",
} as const;

export function createRunsManager(options: RunsManagerOptions = {}) {
  const runsDir = resolve(options.runsDir ?? defaultRunsDir());
  const queuedRunCap = options.queuedRunCap ?? 5;
  const log = options.log ?? ((line: string) => console.error(line));

  function ensureRunsDir(): void {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    chmodSync(runsDir, 0o700);
  }

  function assertRunDir(runDir: string): void {
    const target = resolve(runDir);
    if (dirname(target) !== runsDir || !basename(target).startsWith("run-")) {
      throw new Error(`refusing to touch a path outside the runs directory: ${runDir}`);
    }
  }

  function remove(runDir: string): void {
    assertRunDir(runDir);
    rmSync(runDir, { recursive: true, force: true });
  }

  function marker(runDir: string, name: string, value: unknown): void {
    writeFileSync(join(runDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  function markQueued(runDir: string, reason: string): void {
    marker(runDir, MARKERS.queued, { reason, queuedAt: new Date().toISOString() });
    rmSync(join(runDir, MARKERS.active), { force: true });
  }

  function markDone(runDir: string): void {
    rmSync(join(runDir, MARKERS.active), { force: true });
  }

  function findModelGitPaths(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.name.toLowerCase() === ".git") {
          found.push(full);
          continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      }
    };
    walk(root);
    // shallowest first so a nested repo inside a quarantined dir is moved with it
    return found.sort((a, b) => a.split(sep).length - b.split(sep).length);
  }

  /**
   * Put trusted .git back and quarantine anything the model left that looks
   * like Git state. Returns the repo-relative paths that were quarantined.
   * Idempotent: safe to call again after a partial failure.
   */
  function restoreTrustedGit(ws: Pick<Workspace, "runDir" | "checkout" | "trustedGit">): string[] {
    if (!existsSync(ws.trustedGit)) {
      if (!existsSync(join(ws.checkout, ".git"))) throw new Error("trusted Git metadata is missing");
      return []; // already restored
    }
    const modelGit = findModelGitPaths(ws.checkout);
    let n = 0;
    for (const path of modelGit) {
      if (!existsSync(path)) continue; // moved with a parent already
      renameSync(path, join(ws.runDir, `quarantined-model-git-${n++}`));
    }
    renameSync(ws.trustedGit, join(ws.checkout, ".git"));
    if (!existsSync(join(ws.checkout, ".git"))) {
      throw new Error("trusted Git metadata restoration could not be verified");
    }
    return modelGit.map((p) => relative(ws.checkout, p) || ".git");
  }

  function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A run whose owning process died mid-flight (crash, OOM, reboot) is
   * restored and retained as queued — never audited, never pushed. Its
   * process may legitimately be alive across a long git retry, so liveness,
   * not age, decides.
   */
  async function recoverInterrupted(): Promise<string[]> {
    ensureRunsDir();
    const recovered: string[] = [];
    for (const name of readdirSync(runsDir)) {
      if (!name.startsWith("run-")) continue;
      const runDir = join(runsDir, name);
      if (!lstatSync(runDir).isDirectory()) continue;
      if (existsSync(join(runDir, MARKERS.queued))) continue; // already waiting for a human
      if (existsSync(join(runDir, MARKERS.outcome))) continue; // finished run kept with --keep
      const activePath = join(runDir, MARKERS.active);
      if (existsSync(activePath)) {
        try {
          const active = JSON.parse(readFileSync(activePath, "utf8")) as { pid?: number };
          if (active.pid && pidAlive(active.pid)) continue;
        } catch {
          // unreadable marker: cannot prove liveness, recover conservatively
        }
      }
      // No markers at all (died between mkdtemp and the first marker) is
      // recovered too: a run that cannot prove it is live is not live.
      const ws = { runDir, checkout: join(runDir, "checkout"), trustedGit: join(runDir, "trusted.git") };
      let reason = "interrupted run recovered without audit or publication";
      try {
        const quarantined = restoreTrustedGit(ws);
        await git(ws.checkout, "status", "--porcelain=v1", "-z", "-uall", "--no-renames");
        if (quarantined.length) reason += `; quarantined model-created Git state: ${quarantined.join(", ")}`;
      } catch (err) {
        reason += `; Git restoration needs manual repair: ${firstLine(err)}`;
      }
      markQueued(runDir, reason);
      recovered.push(runDir);
      log(`gitgate: ${reason} at ${runDir}`);
    }
    return recovered;
  }

  function queued(): string[] {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .filter((n) => n.startsWith("run-") && existsSync(join(runsDir, n, MARKERS.queued)))
      .map((n) => join(runsDir, n));
  }

  /** Every run directory (retained or in flight) with its markers, for `gitgate runs list`. */
  function list(): Array<{ runDir: string; state: "active" | "queued" | "kept"; info: Record<string, unknown> }> {
    if (!existsSync(runsDir)) return [];
    const out: Array<{ runDir: string; state: "active" | "queued" | "kept"; info: Record<string, unknown> }> = [];
    for (const n of readdirSync(runsDir).sort()) {
      if (!n.startsWith("run-")) continue;
      const runDir = join(runsDir, n);
      const read = (f: string) => {
        try {
          return JSON.parse(readFileSync(join(runDir, f), "utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      };
      const state = existsSync(join(runDir, MARKERS.queued))
        ? "queued"
        : existsSync(join(runDir, MARKERS.active))
          ? "active"
          : "kept";
      out.push({ runDir, state, info: { ...(read(MARKERS.job) ?? {}), ...(read(MARKERS.queued) ?? {}), ...(read(MARKERS.outcome) ?? {}) } });
    }
    return out;
  }

  /** Where does this job publish? A local clone publishes to its origin; anything else is cloned directly. */
  async function resolveSource(repo: string): Promise<{ originUrl: string; reference?: string }> {
    const local = isAbsolute(repo) || /^\.{0,2}\//.test(repo) ? resolve(repo) : undefined;
    if (local && existsSync(local)) {
      const bare = (await git(local, "rev-parse", "--is-bare-repository").catch(() => "false")).trim() === "true";
      if (!bare) {
        const origin = (await git(local, "remote", "get-url", "origin").catch(() => "")).trim();
        if (!origin) throw new Error(`local repo has no 'origin' remote to publish to: ${repo}`);
        return { originUrl: origin, reference: local };
      }
    }
    return { originUrl: repo };
  }

  /**
   * Fresh clone at exactly the remote branch tip, then hide trusted .git.
   * Throws (and cleans up) if any step cannot be proven.
   */
  async function prepare(opts: PrepareOptions): Promise<Workspace> {
    await recoverInterrupted();
    const held = queued();
    if (held.length >= queuedRunCap) {
      throw new Error(
        `writes paused: ${held.length} retained run(s) need human attention (cap ${queuedRunCap}); see \`gitgate runs list\``,
      );
    }
    ensureRunsDir();
    const runDir = mkdtempSync(join(runsDir, "run-"));
    chmodSync(runDir, 0o700);
    marker(runDir, MARKERS.active, { pid: process.pid, startedAt: new Date().toISOString() });
    const checkout = join(runDir, "checkout");
    const trustedGit = join(runDir, "trusted.git");
    const tmpDir = join(runDir, "tmp");
    const noHooks = join(runDir, "no-hooks");
    mkdirSync(tmpDir, { mode: 0o700 });
    mkdirSync(noHooks, { mode: 0o700 });
    const remoteRef = `refs/remotes/origin/${opts.branch}`;

    try {
      const { originUrl, reference } = await resolveSource(opts.repo);
      if (reference) {
        // Local objects for speed; the remote for truth.
        await git(runDir, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--no-tags", reference, checkout);
        await git(checkout, "remote", "set-url", "origin", originUrl);
      } else {
        await git(runDir, "clone", "--quiet", "--no-checkout", "--no-tags", "--single-branch", "--branch", opts.branch, originUrl, checkout);
      }
      await git(checkout, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${opts.branch}:${remoteRef}`);
      await git(checkout, "checkout", "--quiet", "-B", opts.branch, remoteRef);
      await git(checkout, "reset", "--quiet", "--hard", remoteRef);
      const base = (await git(checkout, "rev-parse", "HEAD")).trim();
      const remoteBase = (await git(checkout, "rev-parse", remoteRef)).trim();
      const status = await git(checkout, "status", "--porcelain=v1", "-z", "-uall", "--no-renames");
      if (!base || base !== remoteBase || status.length) {
        throw new Error(`disposable clone did not start clean at origin/${opts.branch}`);
      }
      // No global identity, no signing, no hooks: the publisher must work on a
      // bare box and must never execute anything the repository ships.
      await git(checkout, "config", "user.name", opts.authorName);
      await git(checkout, "config", "user.email", opts.authorEmail);
      await git(checkout, "config", "commit.gpgsign", "false");
      await git(checkout, "config", "core.hooksPath", noHooks);
      renameSync(join(checkout, ".git"), trustedGit);
      if (existsSync(join(checkout, ".git")) || !existsSync(trustedGit)) {
        throw new Error("could not isolate trusted Git metadata from the engine");
      }
      return { runId: basename(runDir), runDir, checkout, trustedGit, base, originUrl, branch: opts.branch, tmpDir };
    } catch (err) {
      remove(runDir);
      throw err;
    }
  }

  /** Repo-relative changed paths (status + ignored creations) — used for read-only reporting. */
  async function changedPaths(checkout: string): Promise<string[]> {
    const status = splitNul(await git(checkout, "status", "--porcelain=v1", "-z", "-uall", "--no-renames"));
    const paths = new Set(status.map((e) => e.slice(3)));
    for (const p of splitNul(await git(checkout, "ls-files", "--others", "-z"))) paths.add(p);
    return [...paths].sort();
  }

  return {
    runsDir,
    prepare,
    restoreTrustedGit,
    recoverInterrupted,
    queued,
    list,
    remove,
    marker,
    markQueued,
    markDone,
    changedPaths,
  };
}

export type RunsManager = ReturnType<typeof createRunsManager>;
