import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: number | string | undefined,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git in `cwd` with a hard timeout and no interactive prompts. Throws GitError on non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL", // a SIGTERM'd rebase is how a half-applied rebase persists
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string; message?: string };
    const stderr = (e.stderr ?? "").toString().trim();
    throw new GitError(
      `git ${args[0]} failed${e.code !== undefined ? ` (${e.code})` : ""}: ${stderr.split("\n")[0] || e.message || "unknown"}`,
      e.code,
      stderr,
    );
  }
}

/** Run git for its exit status only. */
export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

export const splitNul = (value: string): string[] => value.split("\0").filter(Boolean);

/** Filesystem- and ref-safe UTC stamp: 20260818T170500Z */
export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

export function firstLine(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).split("\n")[0] ?? "";
}
