import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SymbolSearchHit {
  line: number;
  kind: "function" | "type" | "module";
  text: string;
}

export interface SymbolSearchMatch {
  root: string;
  filePath: string;
  score: number;
  hits: SymbolSearchHit[];
}

export interface SymbolSearchResult {
  symbol: string;
  functionNames: string[];
  typeNames: string[];
  moduleHints: string[];
  matches: SymbolSearchMatch[];
}

export interface LocateSymbolsResult {
  roots: string[];
  scannedFileCount: number;
  symbols: SymbolSearchResult[];
}

interface SymbolSearchPlan {
  symbol: string;
  functionNames: string[];
  typeNames: string[];
  moduleHints: string[];
  moduleHintSet: Set<string>;
}

interface IndexedFile {
  root: string;
  filePath: string;
  lowerFilePath: string;
  text: string;
}

interface ScoredMatch extends SymbolSearchMatch {
  functionHitCount: number;
  typeHitCount: number;
}

const DEFAULT_EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
]);

const COMMON_NAMESPACE_SEGMENTS = new Set([
  "alloc",
  "async",
  "blocking",
  "closure",
  "core",
  "future",
  "futures",
  "runtime",
  "std",
  "task",
  "tokio",
  "tracing",
]);

const GENERIC_FUNCTION_NAMES = new Set([
  "call",
  "clone",
  "default",
  "drop",
  "fmt",
  "hash",
  "new",
  "poll",
]);

export async function locateSymbolsInRoots(options: {
  roots: string[];
  symbols: string[];
  extensions?: string[] | undefined;
  maxFilesPerSymbol?: number | undefined;
  maxHitsPerFile?: number | undefined;
  maxFilesToScanPerRoot?: number | undefined;
}): Promise<LocateSymbolsResult> {
  const roots = normalizeRoots(options.roots);
  if (roots.length === 0) {
    throw new Error("At least one root directory is required.");
  }

  const symbols = options.symbols
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0);
  if (symbols.length === 0) {
    throw new Error("At least one symbol is required.");
  }

  const extensions = new Set(
    (options.extensions?.length ? options.extensions : [...DEFAULT_EXTENSIONS]).map(
      normalizeExtension,
    ),
  );
  const maxFilesPerSymbol = options.maxFilesPerSymbol ?? 6;
  const maxHitsPerFile = options.maxHitsPerFile ?? 4;
  const maxFilesToScanPerRoot = options.maxFilesToScanPerRoot ?? 20000;

  const filesByRoot = await Promise.all(
    roots.map(async (root) => {
      const files = await collectFiles(root, extensions, maxFilesToScanPerRoot);
      const indexedFiles = await Promise.all(
        files.map(async (filePath) => ({
          root,
          filePath,
          lowerFilePath: filePath.toLowerCase(),
          text: await readFile(filePath, "utf8"),
        })),
      );

      return indexedFiles;
    }),
  );

  const indexedFiles = filesByRoot.flat();
  const plans = symbols.map(buildSearchPlan);

  return {
    roots,
    scannedFileCount: indexedFiles.length,
    symbols: plans.map((plan) => ({
      symbol: plan.symbol,
      functionNames: plan.functionNames,
      typeNames: plan.typeNames,
      moduleHints: plan.moduleHints,
      matches: findSymbolMatches(plan, indexedFiles, maxFilesPerSymbol, maxHitsPerFile),
    })),
  };
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root.trim())).filter(Boolean))];
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

async function collectFiles(
  root: string,
  extensions: Set<string>,
  maxFilesToScan: number,
): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files, extensions, maxFilesToScan);
  return files;
}

async function walk(
  currentDir: string,
  files: string[],
  extensions: Set<string>,
  maxFilesToScan: number,
): Promise<void> {
  if (files.length >= maxFilesToScan) {
    return;
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFilesToScan) {
      return;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      await walk(fullPath, files, extensions, maxFilesToScan);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
}

function buildSearchPlan(symbol: string): SymbolSearchPlan {
  const normalizedSymbol = symbol.replace(/\s+\[[^\]]+\]$/, "");
  const rustPaths = [...normalizedSymbol.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+/g)]
    .map((match) => match[0])
    .filter((match): match is string => typeof match === "string");

  const functionNames = uniqueStrings([
    ...collectRegexMatches(normalizedSymbol, />::([a-z_][A-Za-z0-9_]*)/g),
    ...collectRegexMatches(normalizedSymbol, /::([a-z_][A-Za-z0-9_]*)::\{closure#/g),
    ...collectFunctionNamesFromPaths(rustPaths),
  ]).filter(
    (functionName, index, all) =>
      all.length === 1 || !GENERIC_FUNCTION_NAMES.has(functionName),
  );

  const typeNames = uniqueStrings(
    rustPaths
      .flatMap((pathMatch) => pathMatch.split("::"))
      .filter((segment) => /^[A-Z][A-Za-z0-9_]*$/.test(segment)),
  );

  const moduleHints = uniqueStrings(
    rustPaths
      .flatMap((pathMatch) => pathMatch.split("::"))
      .filter((segment) => /^[a-z_][A-Za-z0-9_]*$/.test(segment))
      .filter((segment) => !COMMON_NAMESPACE_SEGMENTS.has(segment)),
  );

  return {
    symbol,
    functionNames,
    typeNames,
    moduleHints,
    moduleHintSet: new Set(moduleHints.map((hint) => hint.toLowerCase())),
  };
}

function collectRegexMatches(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)]
    .map((match) => match[1])
    .filter((match): match is string => typeof match === "string");
}

function collectFunctionNamesFromPaths(rustPaths: string[]): string[] {
  return rustPaths
    .map((pathMatch) => pathMatch.split("::").at(-1) ?? null)
    .filter((segment): segment is string => typeof segment === "string")
    .filter((segment) => /^[a-z_][A-Za-z0-9_]*$/.test(segment));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function findSymbolMatches(
  plan: SymbolSearchPlan,
  indexedFiles: IndexedFile[],
  maxFilesPerSymbol: number,
  maxHitsPerFile: number,
): SymbolSearchMatch[] {
  const matches: ScoredMatch[] = [];

  for (const file of indexedFiles) {
    const match = scoreFile(plan, file, maxHitsPerFile);
    if (match !== null) {
      matches.push(match);
    }
  }

  const hasFunctionMatch = matches.some((match) => match.functionHitCount > 0);
  const hasTypeMatch = matches.some((match) => match.typeHitCount > 0);

  return matches
    .filter((match) => {
      if (hasFunctionMatch) {
        return match.functionHitCount > 0;
      }

      if (hasTypeMatch) {
        return match.typeHitCount > 0;
      }

      return true;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, maxFilesPerSymbol)
    .map(({ functionHitCount: _functionHitCount, typeHitCount: _typeHitCount, ...rest }) => rest);
}

function scoreFile(
  plan: SymbolSearchPlan,
  file: IndexedFile,
  maxHitsPerFile: number,
): ScoredMatch | null {
  let score = 0;
  const hits: SymbolSearchHit[] = [];
  const fileStem = path.basename(file.filePath, path.extname(file.filePath)).toLowerCase();
  let functionHitCount = 0;
  let typeHitCount = 0;
  const seenFunctionNames = new Set<string>();
  const seenTypeNames = new Set<string>();
  const seenModuleHints = new Set<string>();

  for (const hint of plan.moduleHints) {
    if (fileStem === hint.toLowerCase()) {
      score += 10;
    } else if (file.lowerFilePath.includes(`/${hint.toLowerCase()}.`)) {
      score += 7;
    } else if (file.lowerFilePath.includes(`/${hint.toLowerCase()}/`)) {
      score += 4;
    }
  }

  const lines = file.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    for (const functionName of plan.functionNames) {
      const functionPattern = new RegExp(`\\bfn\\s+${escapeRegExp(functionName)}\\b`);
      if (functionPattern.test(line) && !seenFunctionNames.has(functionName)) {
        seenFunctionNames.add(functionName);
        score += 80;
        functionHitCount += 1;
        pushHitIfRoom(hits, maxHitsPerFile, {
          line: index + 1,
          kind: "function",
          text: trimmed,
        });
        break;
      }
    }

    for (const typeName of plan.typeNames) {
      const typePattern = new RegExp(
        `\\b(?:impl|struct|enum|trait)\\s+(?:<[^>]+>\\s+)?${escapeRegExp(typeName)}\\b|\\b${escapeRegExp(typeName)}\\b`,
      );
      if (typePattern.test(line) && !seenTypeNames.has(typeName)) {
        seenTypeNames.add(typeName);
        score += 26;
        typeHitCount += 1;
        pushHitIfRoom(hits, maxHitsPerFile, {
          line: index + 1,
          kind: "type",
          text: trimmed,
        });
        break;
      }
    }

    const lowerLine = line.toLowerCase();
    for (const hint of plan.moduleHintSet) {
      if (lowerLine.includes(hint) && !seenModuleHints.has(hint)) {
        seenModuleHints.add(hint);
        score += 3;
        pushHitIfRoom(hits, maxHitsPerFile, {
          line: index + 1,
          kind: "module",
          text: trimmed,
        });
        break;
      }
    }
  }

  if (plan.functionNames.length > 0 && functionHitCount === 0) {
    score -= 30;
  }

  if (plan.typeNames.length > 0 && typeHitCount === 0) {
    score -= 12;
  }

  if (score <= 0) {
    return null;
  }

  return {
    root: file.root,
    filePath: file.filePath,
    score,
    hits,
    functionHitCount,
    typeHitCount,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pushHitIfRoom(
  hits: SymbolSearchHit[],
  maxHitsPerFile: number,
  hit: SymbolSearchHit,
): void {
  if (hits.length < maxHitsPerFile) {
    hits.push(hit);
  }
}
