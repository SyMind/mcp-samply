import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  breakdownBySubsystem,
  focusFunctions,
  inspectThread,
  searchFunctions,
  summarizeProfile,
} from "./analyze.js";
import { ProfileStore } from "./store.js";

test("profile analysis uses samply sidecar symbols to produce summaries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-samply-profile-"));
  const profilePath = path.join(tempDir, "fixture.json.gz");
  const sidecarPath = path.join(tempDir, "fixture.json.syms.json");

  const profile = {
    meta: {
      product: "fixture",
      oscpu: "test-os",
      interval: 1,
      startTime: 0,
    },
    libs: [
      {
        name: "node",
        debugName: "node",
        breakpadId: "DBG",
        codeId: "ABC",
      },
    ],
    threads: [
      {
        name: "MainThread",
        processName: "node",
        pid: 42,
        tid: 7,
        stringArray: ["0x1000", "0x2000", "0x3000", "node", "GC"],
        samples: {
          length: 3,
          stack: [1, 2, 1],
          time: [10, 11, 12],
        },
        markers: {
          length: 2,
          name: [4, 4],
        },
        stackTable: {
          length: 3,
          prefix: [null, 0, 0],
          frame: [0, 1, 2],
        },
        frameTable: {
          length: 3,
          func: [0, 1, 2],
          address: [4096, 8192, 12288],
        },
        funcTable: {
          length: 3,
          name: [0, 1, 2],
          resource: [0, 0, 0],
        },
        resourceTable: {
          length: 1,
          lib: [0],
          name: [3],
        },
      },
    ],
  };

  const sidecar = {
    string_table: ["UNKNOWN", "root_fn", "hot_fn", "cold_fn"],
    data: [
      {
        debug_name: "node",
        debug_id: "DBG",
        code_id: "ABC",
        symbol_table: [
          { rva: 4096, size: 16, symbol: 1 },
          { rva: 8192, size: 16, symbol: 2 },
          { rva: 12288, size: 16, symbol: 3 },
        ],
        known_addresses: [
          [4096, 0],
          [8192, 1],
          [12288, 2],
        ],
      },
    ],
  };

  await writeFile(profilePath, gzipSync(JSON.stringify(profile)));
  await writeFile(sidecarPath, JSON.stringify(sidecar), "utf8");

  try {
    const store = new ProfileStore();
    const loadedProfile = await store.load(profilePath);
    const summary = summarizeProfile(loadedProfile, {
      maxThreads: 5,
      maxFunctions: 5,
      maxMarkers: 5,
    });
    const threadInspection = inspectThread(loadedProfile, 0, {
      maxFunctions: 5,
      maxMarkers: 5,
      maxStacks: 5,
    });
    const search = searchFunctions(loadedProfile, "hot", {
      maxResults: 5,
      maxThreadsPerResult: 5,
    });

    assert.equal(summary.presymbolicated, true);
    assert.equal(summary.product, "fixture");
    assert.equal(summary.totalSamples, 3);
    assert.equal(summary.threads[0]?.name, "MainThread");
    assert.equal(summary.threads[0]?.topMarkers[0]?.name, "GC");
    assert.equal(summary.threads[0]?.topMarkers[0]?.count, 2);
    assert.equal(summary.hottestSelfFunctionsOverall[0]?.name, "hot_fn");
    assert.equal(summary.hottestSelfFunctionsOverall[0]?.selfSamples, 2);
    assert.equal(summary.hottestStackFunctionsOverall[0]?.name, "root_fn");
    assert.equal(summary.hottestStackFunctionsOverall[0]?.stackSamples, 3);

    assert.equal(threadInspection.thread.topStacks[0]?.stack.join(" -> "), "root_fn [node] -> hot_fn [node]");
    assert.equal(threadInspection.thread.topStacks[0]?.sampleCount, 2);

    assert.equal(search.matchCount, 1);
    assert.equal(search.matches[0]?.name, "hot_fn");
    assert.equal(search.matches[0]?.selfSamples, 2);
    assert.equal(search.matches[0]?.threads[0]?.index, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("profile analysis can group Rust subsystems and recover hotspot contexts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-samply-rust-"));
  const profilePath = path.join(tempDir, "fixture.json");

  const profile = {
    meta: {
      product: "fixture",
      oscpu: "test-os",
      interval: 1,
      startTime: 0,
    },
    libs: [
      {
        name: "rspack.node",
        debugName: "rspack.node",
      },
      {
        name: "libsystem_kernel.dylib",
        debugName: "libsystem_kernel.dylib",
      },
    ],
    threads: [
      {
        name: "tokio-runtime-worker",
        processName: "node",
        pid: 42,
        tid: 11,
        stringArray: [
          "rspack_core::resolver::resolve_tracing",
          "<rspack_fs::native_fs::NativeFileSystem as rspack_paths::FileMetadata>::metadata_sync",
          "stat",
          "<rspack_fs::native_fs::NativeFileSystem as rspack_paths::ReadRef>::read_sync",
          "__open",
          "rspack.node",
          "libsystem_kernel.dylib",
        ],
        samples: {
          length: 3,
          stack: [2, 2, 4],
          time: [10, 11, 12],
        },
        stackTable: {
          length: 5,
          prefix: [null, 0, 1, 0, 3],
          frame: [0, 1, 2, 3, 4],
        },
        frameTable: {
          length: 5,
          func: [0, 1, 2, 3, 4],
        },
        funcTable: {
          length: 5,
          name: [0, 1, 2, 3, 4],
          resource: [0, 0, 1, 0, 1],
        },
        resourceTable: {
          length: 2,
          lib: [0, 1],
          name: [5, 6],
        },
      },
    ],
  };

  await writeFile(profilePath, JSON.stringify(profile), "utf8");

  try {
    const store = new ProfileStore();
    const loadedProfile = await store.load(profilePath);
    const subsystemBreakdown = breakdownBySubsystem(loadedProfile, {
      resourceQuery: "rspack",
      prefixSegments: 2,
      maxGroups: 5,
      maxExamplesPerGroup: 5,
      maxThreadsPerGroup: 5,
    });
    const focus = focusFunctions(loadedProfile, "metadata_sync", {
      resourceQuery: "rspack",
      beforeDepth: 2,
      afterDepth: 1,
      maxMatches: 5,
      maxThreads: 5,
      maxContexts: 5,
    });

    assert.equal(subsystemBreakdown.groups[0]?.name, "rspack_core::resolver");
    assert.equal(subsystemBreakdown.groups[0]?.stackSamples, 3);
    assert.equal(subsystemBreakdown.groups[1]?.name, "rspack_fs::native_fs");
    assert.equal(subsystemBreakdown.groups[1]?.stackSamples, 3);
    assert.equal(
      subsystemBreakdown.groups[1]?.exampleFunctions[0]?.name,
      "<rspack_fs::native_fs::NativeFileSystem as rspack_paths::FileMetadata>::metadata_sync",
    );

    assert.equal(focus.totalMatchedSamples, 2);
    assert.equal(focus.matches[0]?.sampleCount, 2);
    assert.equal(focus.threads[0]?.name, "tokio-runtime-worker");
    assert.deepEqual(focus.topCallers[0]?.path, [
      "rspack_core::resolver::resolve_tracing [rspack.node]",
    ]);
    assert.deepEqual(focus.topCallees[0]?.path, [
      "stat [libsystem_kernel.dylib]",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("subsystem grouping prefers the namespace that matches the query", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-samply-grouping-"));
  const profilePath = path.join(tempDir, "fixture.json");

  const profile = {
    meta: {
      product: "fixture",
      oscpu: "test-os",
      interval: 1,
      startTime: 0,
    },
    libs: [{ name: "rspack.node", debugName: "rspack.node" }],
    threads: [
      {
        name: "tokio-runtime-worker",
        processName: "node",
        stringArray: [
          "<tokio::runtime::task::Harness<rspack_core::resolver::Resolver>>::poll",
          "rspack.node",
        ],
        samples: {
          length: 1,
          stack: [0],
          time: [1],
        },
        stackTable: {
          length: 1,
          prefix: [null],
          frame: [0],
        },
        frameTable: {
          length: 1,
          func: [0],
        },
        funcTable: {
          length: 1,
          name: [0],
          resource: [0],
        },
        resourceTable: {
          length: 1,
          lib: [0],
          name: [1],
        },
      },
    ],
  };

  await writeFile(profilePath, JSON.stringify(profile), "utf8");

  try {
    const store = new ProfileStore();
    const loadedProfile = await store.load(profilePath);
    const subsystemBreakdown = breakdownBySubsystem(loadedProfile, {
      query: "rspack_",
      resourceQuery: "rspack",
      prefixSegments: 2,
      maxGroups: 5,
      maxExamplesPerGroup: 5,
      maxThreadsPerGroup: 5,
    });

    assert.equal(subsystemBreakdown.groups[0]?.name, "rspack_core::resolver");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
