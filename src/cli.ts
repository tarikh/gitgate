#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { describeOutcome, exitCodeFor } from "./outcomes.js";
import { loadJobFile } from "./policy.js";
import { runJob } from "./run.js";
import { createRunsManager } from "./workspace.js";

const USAGE = `gitgate — the model proposes, git decides.

Usage:
  gitgate run <job.yml> [--prompt TEXT | --prompt-file FILE] [--dry-run] [--keep]
                        [--json] [--quiet] [--runs-dir DIR]
  gitgate runs list [--json] [--runs-dir DIR]
  gitgate runs clear <run-id|all> [--runs-dir DIR]
  gitgate check <job.yml>            validate a job file and print the resolved config
  gitgate --version | --help

Exit codes (run):
  0  pushed | clean | audited | replied
  2  parked | queued      — work preserved, a human must look
  3  rejected             — policy violation, nothing published
  4  timed_out            — engine killed at the deadline, nothing published
  1  failed               — engine or infrastructure error, nothing published
`;

function die(msg: string, code = 64): never {
  process.stderr.write(`gitgate: ${msg}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      "runs-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
    },
  });

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`gitgate ${pkg.version}\n`);
    return 0;
  }
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 64;
  }
  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);

  switch (cmd) {
    case "run": {
      const file = rest[0] ?? die("run: missing job file");
      const job = loadJobFile(file);
      let prompt = values.prompt;
      if (values["prompt-file"]) prompt = readFileSync(values["prompt-file"], "utf8");
      const outcome = await runJob(job, {
        prompt,
        dryRun: values["dry-run"],
        keep: values.keep,
        runsDir: values["runs-dir"],
        log,
        onOutput: values.quiet || values.json ? undefined : (_s, chunk) => process.stderr.write(chunk),
      });
      if (values.json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      else {
        process.stdout.write(`${outcome.status}: ${describeOutcome(outcome)}\n`);
        if (outcome.changedPaths.length && outcome.status !== "replied") {
          for (const p of outcome.changedPaths) process.stdout.write(`  ${p}\n`);
        }
        if (outcome.reply) process.stdout.write(`\n${outcome.reply}\n`);
      }
      return exitCodeFor(outcome.status);
    }
    case "runs": {
      const sub = rest[0] ?? "list";
      const runs = createRunsManager({ runsDir: values["runs-dir"], log });
      if (sub === "list") {
        const items = runs.list();
        if (values.json) process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        else if (!items.length) process.stdout.write(`no runs in ${runs.runsDir}\n`);
        else {
          for (const r of items) {
            const i = r.info as { job?: string; status?: string; reason?: string; startedAt?: string };
            process.stdout.write(
              `${r.state.padEnd(6)} ${r.runDir}\n       ${i.job ?? "?"} ${i.status ?? ""} ${i.startedAt ?? ""}${i.reason ? `\n       ${i.reason}` : ""}\n`,
            );
          }
        }
        return 0;
      }
      if (sub === "clear") {
        const target = rest[1] ?? die("runs clear: pass a run id or 'all'");
        const items = runs.list().filter((r) => r.state !== "active");
        const victims = target === "all" ? items : items.filter((r) => r.runDir.endsWith(`/${target}`) || r.runDir === target);
        if (!victims.length) die(`no retained run matches ${target}`, 1);
        for (const v of victims) {
          runs.remove(v.runDir);
          log(`gitgate: removed ${v.runDir}`);
        }
        return 0;
      }
      die(`runs: unknown subcommand ${sub}`);
    }
    // falls through (die never returns)
    case "check": {
      const file = rest[0] ?? die("check: missing job file");
      const job = loadJobFile(file);
      process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
      return 0;
    }
    default:
      die(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => die((err as Error).message ?? String(err), 1),
);
