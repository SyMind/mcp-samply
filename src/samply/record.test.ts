import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSamplyRecord } from "./record.js";

test("runSamplyRecord builds a save-only invocation and records output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-samply-record-"));
  const fakeSamplyPath = path.join(tempDir, "fake-samply");
  const capturePath = path.join(tempDir, "capture.json");

  await writeFile(
    fakeSamplyPath,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.findIndex((arg) => arg === '--output');",
      "const outputPath = args[outputIndex + 1];",
      "writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({ args, cwd: process.cwd() }, null, 2));",
      "writeFileSync(outputPath, JSON.stringify({ meta: { product: 'fake' }, threads: [] }));",
      "process.stdout.write('fake stdout');",
      "process.stderr.write('fake stderr');",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeSamplyPath, 0o755);

  try {
    const result = await runSamplyRecord({
      samplyPath: fakeSamplyPath,
      cwd: tempDir,
      command: ["node", "-e", "console.log('hello')"],
      rateHz: 321,
      durationSec: 1.5,
      profileName: "fixture",
      mainThreadOnly: true,
      reuseThreads: true,
      gfx: true,
      extraArgs: ["--jit-markers"],
      env: {
        ...process.env,
        FAKE_CAPTURE_PATH: capturePath,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "command");
    assert.ok(result.profilePath);
    assert.match(result.profilePath, /\.json\.gz$/);
    assert.equal(result.stdout, "fake stdout");
    assert.equal(result.stderr, "fake stderr");

    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      cwd: string;
    };

    assert.equal(capture.cwd, await realpath(tempDir));
    assert.deepEqual(capture.args, [
      "record",
      "--save-only",
      "--output",
      result.profilePath,
      "--rate",
      "321",
      "--duration",
      "1.5",
      "--profile-name",
      "fixture",
      "--main-thread-only",
      "--reuse-threads",
      "--gfx",
      "--jit-markers",
      "--",
      "node",
      "-e",
      "console.log('hello')",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runSamplyRecord rejects invalid recording mode combinations", async () => {
  const result = await runSamplyRecord({
    command: ["node", "-e", "console.log('hello')"],
    pid: 123,
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "invalid");
  assert.match(result.error ?? "", /Exactly one of command, pid, or all=true/);
});
