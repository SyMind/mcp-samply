import { spawn } from "node:child_process";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

const OUTPUT_LIMIT = 64 * 1024;

export async function runCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandRunResult> {
  const startedAt = Date.now();

  return await new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendWithLimit(stdout, chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendWithLimit(stderr, chunk.toString("utf8"));
    });

    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function appendWithLimit(existing: string, incoming: string): string {
  const combined = existing + incoming;
  if (combined.length <= OUTPUT_LIMIT) {
    return combined;
  }

  const suffix = "\n...[truncated]";
  return combined.slice(0, OUTPUT_LIMIT - suffix.length) + suffix;
}
