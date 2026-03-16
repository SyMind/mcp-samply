import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SAMPLY_BIN, findExecutable } from "./executable.js";
import { runCommand } from "./process.js";

export interface SamplyRecordOptions {
  samplyPath?: string | undefined;
  cwd?: string | undefined;
  outputPath?: string | undefined;
  command?: string[] | undefined;
  pid?: number | undefined;
  all?: boolean | undefined;
  rateHz?: number | undefined;
  durationSec?: number | undefined;
  profileName?: string | undefined;
  mainThreadOnly?: boolean | undefined;
  reuseThreads?: boolean | undefined;
  gfx?: boolean | undefined;
  extraArgs?: string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface SamplyRecordResult {
  ok: boolean;
  mode: "command" | "pid" | "all" | "invalid";
  samplyPath: string;
  cwd: string;
  profilePath: string | null;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  error: string | null;
  installHint: string | null;
}

export async function runSamplyRecord(
  options: SamplyRecordOptions,
): Promise<SamplyRecordResult> {
  const mode = getRecordMode(options);
  if (mode === "invalid") {
    return {
      ok: false,
      mode,
      samplyPath: options.samplyPath ?? DEFAULT_SAMPLY_BIN,
      cwd: resolveCwd(options.cwd),
      profilePath: null,
      args: [],
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      error:
        "Exactly one of command, pid, or all=true must be provided to samply_record.",
      installHint: null,
    };
  }

  const requestedSamplyPath = options.samplyPath ?? DEFAULT_SAMPLY_BIN;
  const samplyPath = await findExecutable(requestedSamplyPath);
  if (samplyPath === null) {
    return {
      ok: false,
      mode,
      samplyPath: requestedSamplyPath,
      cwd: resolveCwd(options.cwd),
      profilePath: null,
      args: [],
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      error: `Unable to find a runnable samply executable at "${requestedSamplyPath}".`,
      installHint: [
        "Install samply first, for example:",
        "cargo install --locked samply",
        "or use the official installer from https://github.com/mstange/samply",
      ].join("\n"),
    };
  }

  const cwd = resolveCwd(options.cwd);
  const profilePath = resolveOutputPath(cwd, options.outputPath);
  await mkdir(path.dirname(profilePath), { recursive: true });

  const args = buildSamplyRecordArgs(options, profilePath);
  try {
    const commandResult = await runCommand(samplyPath, args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
      },
    });
    const fileWritten = await fileExists(profilePath);
    const ok = commandResult.exitCode === 0 && fileWritten;
    const error =
      commandResult.exitCode !== 0
        ? `samply exited with code ${commandResult.exitCode}.`
        : !fileWritten
          ? "samply exited successfully but did not produce the expected profile file."
          : null;

    return {
      ok,
      mode,
      samplyPath,
      cwd,
      profilePath: fileWritten ? profilePath : null,
      args,
      exitCode: commandResult.exitCode,
      signal: commandResult.signal,
      durationMs: commandResult.durationMs,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      error,
      installHint: null,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      mode,
      samplyPath,
      cwd,
      profilePath: null,
      args,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
      installHint: null,
    };
  }
}

export function buildSamplyRecordArgs(
  options: SamplyRecordOptions,
  outputPath: string,
): string[] {
  const args = ["record", "--save-only", "--output", outputPath];

  if (options.rateHz !== undefined) {
    args.push("--rate", String(options.rateHz));
  }

  if (options.durationSec !== undefined) {
    args.push("--duration", String(options.durationSec));
  }

  if (options.profileName !== undefined) {
    args.push("--profile-name", options.profileName);
  }

  if (options.mainThreadOnly) {
    args.push("--main-thread-only");
  }

  if (options.reuseThreads) {
    args.push("--reuse-threads");
  }

  if (options.gfx) {
    args.push("--gfx");
  }

  if (options.extraArgs !== undefined) {
    args.push(...options.extraArgs);
  }

  if (options.pid !== undefined) {
    args.push("--pid", String(options.pid));
  } else if (options.all) {
    args.push("--all");
  } else if (options.command !== undefined) {
    args.push("--", ...options.command);
  }

  return args;
}

function getRecordMode(
  options: SamplyRecordOptions,
): "command" | "pid" | "all" | "invalid" {
  const modes = [
    options.command !== undefined ? "command" : null,
    options.pid !== undefined ? "pid" : null,
    options.all ? "all" : null,
  ].filter((value): value is "command" | "pid" | "all" => value !== null);

  return modes.length === 1 ? (modes[0] ?? "invalid") : "invalid";
}

function resolveCwd(cwd: string | undefined): string {
  return path.resolve(cwd ?? process.cwd());
}

function resolveOutputPath(cwd: string, outputPath: string | undefined): string {
  if (outputPath !== undefined) {
    return path.resolve(cwd, outputPath);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, ".samply", `profile-${timestamp}.json.gz`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const entry = await stat(filePath);
    return entry.isFile();
  } catch {
    return false;
  }
}
