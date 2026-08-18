// The engine is just a process. gitgate does not know or care whether it is
// Codex, Claude Code, aider, or a shell script — it hands the process a
// workspace with no trusted Git metadata in it, a prompt file, an output file,
// a sanitised environment and a hard deadline, and then reads what changed on
// disk. Nothing the process prints is trusted as a description of its writes.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "./policy.js";

const MAX_CAPTURE = 32 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_REPLY = 1024 * 1024;

export interface EngineContext {
  jobName: string;
  mode: "read-only" | "write";
  workspace: string;
  promptFile: string;
  prompt: string;
  outputFile: string;
  logDir: string;
  tmpDir: string;
}

export interface EngineResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflow: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Build the engine environment from an allowlist, never from process.env
 * wholesale. Whatever gitgate itself was started with (tokens for the
 * publisher, unrelated secrets) does not leak into the model's process unless
 * the job names it in `pass_env`.
 */
export function engineEnvironment(engine: EngineConfig, ctx: EngineContext): NodeJS.ProcessEnv {
  const user = safeUsername();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: engine.home ?? homedir(),
    USER: user,
    LOGNAME: user,
    SHELL: process.env.SHELL ?? "/bin/sh",
    LANG: process.env.LANG ?? "C.UTF-8",
    TZ: process.env.TZ ?? "UTC",
    TERM: "dumb",
    TMPDIR: ctx.tmpDir,
    CI: "1",
    NO_COLOR: "1",
    // Belt and braces: even if the model runs `git`, point it nowhere useful.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const name of engine.pass_env) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  Object.assign(env, engine.env);
  // gitgate's own contract wins over anything the job set.
  env.GITGATE_JOB = ctx.jobName;
  env.GITGATE_MODE = ctx.mode;
  env.GITGATE_WORKSPACE = ctx.workspace;
  env.GITGATE_PROMPT_FILE = ctx.promptFile;
  env.GITGATE_OUTPUT_FILE = ctx.outputFile;
  return env;
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "gitgate";
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Substitute {prompt} {prompt_file} {output_file} {workspace} in the command. */
export function renderCommand(engine: EngineConfig, ctx: EngineContext): { file: string; args: string[] } {
  const values: Record<string, string> = {
    prompt: ctx.prompt,
    prompt_file: ctx.promptFile,
    output_file: ctx.outputFile,
    workspace: ctx.workspace,
  };
  const sub = (s: string, quote: (v: string) => string) =>
    s.replace(/\{(prompt|prompt_file|output_file|workspace)\}/g, (_, k: string) => quote(values[k]!));
  if (Array.isArray(engine.command)) {
    const [file, ...rest] = engine.command.map((a) => sub(a, (v) => v));
    return { file: file!, args: rest };
  }
  return { file: "/bin/sh", args: ["-c", sub(engine.command, shellQuote)] };
}

/**
 * Run the engine to completion or the deadline. Never throws for engine
 * behaviour — a non-zero exit, a timeout, or runaway output are results, and
 * the caller decides what they mean. Throws only if the process cannot start.
 */
export function runEngine(
  engine: EngineConfig,
  ctx: EngineContext,
  timeoutMs: number,
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<EngineResult> {
  const { file, args } = renderCommand(engine, ctx);
  const env = engineEnvironment(engine, ctx);
  const startedAt = Date.now();

  const outLog = createWriteStream(join(ctx.logDir, "engine.stdout.log"), { mode: 0o600 });
  const errLog = createWriteStream(join(ctx.logDir, "engine.stderr.log"), { mode: 0o600 });

  return new Promise<EngineResult>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: ctx.workspace,
        env,
        detached: true, // own process group so the deadline kills grandchildren too
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    let stdoutTail = "";
    let stderrTail = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let spawnError: Error | undefined;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const keepTail = (tail: string, text: string) => (tail + text).slice(-TAIL_BYTES);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBytes += chunk.length;
      stdoutTail = keepTail(stdoutTail, text);
      outLog.write(chunk);
      onOutput?.("stdout", text);
      if (stdoutBytes > MAX_CAPTURE) {
        overflow = true;
        killGroup();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBytes += chunk.length;
      stderrTail = keepTail(stderrTail, text);
      errLog.write(chunk);
      onOutput?.("stderr", text);
      if (stderrBytes > MAX_CAPTURE) {
        overflow = true;
        killGroup();
      }
    });
    child.once("error", (err) => {
      spawnError = err;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      outLog.end();
      errLog.end();
      if (spawnError && !timedOut) {
        rejectPromise(spawnError);
        return;
      }
      resolvePromise({
        code,
        signal,
        timedOut,
        overflow,
        durationMs: Date.now() - startedAt,
        stdoutTail,
        stderrTail,
        stdoutBytes,
        stderrBytes,
      });
    });
  });
}

/** The engine's final message: the output file if it wrote one, else its stdout tail. */
export function readReply(ctx: EngineContext, result: EngineResult): string | undefined {
  if (existsSync(ctx.outputFile) && statSync(ctx.outputFile).isFile()) {
    if (statSync(ctx.outputFile).size > MAX_REPLY) return `[reply exceeded ${MAX_REPLY} bytes; see ${ctx.outputFile}]`;
    const text = readFileSync(ctx.outputFile, "utf8").trim();
    if (text) return text;
  }
  const tail = result.stdoutTail.trim();
  return tail || undefined;
}
