import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { locateSymbolsInRoots } from "./locate.js";

test("locateSymbolsInRoots maps Rust symbols to likely source files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-samply-locate-"));
  const repoRoot = path.join(tempDir, "repo");
  const cacheDir = path.join(repoRoot, "src");
  await mkdir(cacheDir, { recursive: true });

  const cacheFile = path.join(cacheDir, "cache.rs");
  const boxfsFile = path.join(cacheDir, "boxfs.rs");
  const unrelatedFile = path.join(cacheDir, "other.rs");

  await writeFile(
    cacheFile,
    [
      "pub struct CachedPathImpl;",
      "",
      "impl CachedPathImpl {",
      "  pub async fn package_json(&self) -> Result<(), ()> {",
      "    Ok(())",
      "  }",
      "}",
      "",
      "impl ResolverGeneric {",
      "  async fn load_extensions(&self) {}",
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    boxfsFile,
    [
      "use rspack_resolver::FileSystem;",
      "pub struct BoxFS;",
      "impl BoxFS {",
      "  pub async fn read(&self) -> Result<(), ()> {",
      "    Ok(())",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    unrelatedFile,
    [
      "pub struct SomethingElse;",
      "impl SomethingElse {",
      "  pub fn noop(&self) {}",
      "}",
    ].join("\n"),
    "utf8",
  );

  try {
    const result = await locateSymbolsInRoots({
      roots: [repoRoot],
      symbols: [
        "<rspack_resolver::cache::CachedPathImpl>::package_json::<rspack_core::resolver::boxfs::BoxFS>::{closure#0}",
        "<rspack_resolver::ResolverGeneric<rspack_core::resolver::boxfs::BoxFS>>::load_extensions::{closure#0}",
      ],
      maxFilesPerSymbol: 3,
      maxHitsPerFile: 3,
    });
    const limitedHits = await locateSymbolsInRoots({
      roots: [repoRoot],
      symbols: [
        "<rspack_resolver::cache::CachedPathImpl>::package_json::<rspack_core::resolver::boxfs::BoxFS>::{closure#0}",
      ],
      maxFilesPerSymbol: 3,
      maxHitsPerFile: 1,
    });

    assert.equal(result.scannedFileCount, 3);
    assert.equal(result.symbols[0]?.functionNames.includes("package_json"), true);
    assert.equal(result.symbols[0]?.typeNames.includes("CachedPathImpl"), true);
    assert.equal(result.symbols[0]?.matches[0]?.filePath, cacheFile);
    assert.ok((result.symbols[0]?.matches[0]?.hits.length ?? 0) > 0);

    assert.equal(result.symbols[1]?.functionNames.includes("load_extensions"), true);
    assert.equal(result.symbols[1]?.matches[0]?.filePath, cacheFile);
    assert.equal(limitedHits.symbols[0]?.matches[0]?.filePath, cacheFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
