import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

/** "90s" | "5m" | "1h" | 4000 (ms) → milliseconds */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const m = DURATION_RE.exec(value.trim());
  if (!m) throw new Error(`invalid duration: ${value}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

export const PolicySchema = z
  .object({
    /** Globs the model may change. Required: an empty allow-list is a mis-configuration, not "allow all". */
    allow: z.array(z.string().min(1)).min(1),
    /** Globs that always reject, even inside `allow`. */
    deny: z.array(z.string().min(1)).default([]),
    /** Globs the model may modify but not create — for paths some other process owns the creation of. */
    deny_create: z.array(z.string().min(1)).default([]),
    /** Whole-file deletions (and therefore renames, which git reports as delete + add). */
    allow_deletions: z.boolean().default(false),
    /** Files with any execute bit, or tracked files whose base mode is 100755. */
    allow_executable: z.boolean().default(false),
    /** What to do when the model writes a git-ignored file. `reject` is the safe default. */
    ignored_files: z.enum(["reject", "discard"]).default("reject"),
    /** Reject the whole run if the model changes more than this many paths. */
    max_changed_files: z.number().int().positive().optional(),
  })
  .strict();

export const EngineSchema = z
  .object({
    /**
     * The engine is a command. Array form runs directly; string form runs via `sh -c`.
     * Placeholders: {prompt} {prompt_file} {output_file} {workspace}. The same values
     * are always exported as GITGATE_PROMPT_FILE, GITGATE_OUTPUT_FILE, GITGATE_WORKSPACE.
     */
    command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    /** Extra environment for the engine process. Values are literal, not expanded. */
    env: z.record(z.string(), z.string()).default({}),
    /** Names copied verbatim from gitgate's own environment (e.g. an API key). */
    pass_env: z.array(z.string().min(1)).default([]),
    /** HOME for the engine. Defaults to the current user's home so CLI auth works — read THREAT-MODEL.md. */
    home: z.string().optional(),
  })
  .strict();

export const PublishSchema = z
  .object({
    commit_message: z.string().min(1).optional(),
    /** Park branches are created as `<park_prefix>/<UTC stamp>` on the remote. */
    park_prefix: z.string().min(1).default("gitgate/parked"),
    /** Push attempts (fetch → push → verify → rebase) before giving up as `queued`. */
    retries: z.number().int().min(1).max(10).default(3),
    author_name: z.string().min(1).default("gitgate"),
    author_email: z.string().min(1).default("gitgate@localhost"),
  })
  .strict();

export const JobSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "job name: letters, digits, . _ -"),
    /** Anything `git clone` accepts. A local non-bare clone publishes to *its* origin. */
    repo: z.string().min(1),
    branch: z.string().min(1).default("main"),
    mode: z.enum(["read-only", "write"]).default("write"),
    engine: EngineSchema,
    /** Engine deadline. The whole process group is SIGKILLed at the deadline. */
    timeout: z.union([z.string().regex(DURATION_RE), z.number().int().positive()]).default("10m"),
    policy: PolicySchema.optional(),
    publish: PublishSchema.prefault({}),
    /** Where disposable clones live. Default: $XDG_STATE_HOME/gitgate/runs or ~/.local/state/gitgate/runs. */
    runs_dir: z.string().min(1).optional(),
    /** New write runs are refused while this many retained runs await a human. */
    queued_run_cap: z.number().int().positive().default(5),
    /** Default prompt; `gitgate run --prompt` overrides. */
    prompt: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.mode === "write" && !job.policy) {
      ctx.addIssue({ code: "custom", path: ["policy"], message: "write jobs require a policy" });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;
export type EngineConfig = z.infer<typeof EngineSchema>;
export type PublishConfig = z.infer<typeof PublishSchema>;
export type JobConfig = z.infer<typeof JobSchema>;
export type JobInput = z.input<typeof JobSchema>;

export function parseJob(raw: unknown, source = "<inline>"): JobConfig {
  const result = JobSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid job config ${source}:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Load a YAML/JSON job file. Relative `repo` and `runs_dir` resolve against the file's directory. */
export function loadJobFile(file: string): JobConfig {
  const abs = resolve(file);
  const text = readFileSync(abs, "utf8");
  const raw = parseYaml(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new Error(`job file is empty or not a mapping: ${file}`);
  const base = dirname(abs);
  for (const key of ["repo", "runs_dir"] as const) {
    const v = raw[key];
    if (typeof v === "string" && /^\.{1,2}(\/|$)/.test(v)) raw[key] = resolve(base, v);
  }
  return parseJob(raw, file);
}
