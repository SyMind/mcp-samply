import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { resolveSidecarPath } from "../samply/record.js";

export interface RawProfileMeta {
  product?: string;
  oscpu?: string;
  interval?: number;
  startTime?: number;
}

export interface RawProfileLib {
  name?: string;
  debugName?: string;
  debugPath?: string;
  breakpadId?: string | null;
  codeId?: string | null;
  path?: string;
  arch?: string | null;
}

export interface RawProfileThread {
  name?: string;
  processName?: string;
  pid?: number;
  tid?: number;
  registerTime?: number;
  unregisterTime?: number | null;
  stringArray?: string[];
  samples?: {
    length?: number;
    stack?: Array<number | null>;
    time?: number[];
  };
  markers?: {
    length?: number;
    name?: Array<number | null>;
  };
  stackTable?: {
    length?: number;
    prefix?: Array<number | null>;
    frame?: Array<number | null>;
  };
  frameTable?: {
    length?: number;
    func?: Array<number | null>;
    address?: Array<number | null>;
    nativeSymbol?: Array<number | null>;
  };
  funcTable?: {
    length?: number;
    name?: Array<number | null>;
    resource?: Array<number | null>;
  };
  resourceTable?: {
    length?: number;
    lib?: Array<number | null>;
    name?: Array<number | null>;
  };
  nativeSymbols?: {
    length?: number;
    name?: Array<number | null>;
  };
}

export interface RawProfile {
  meta: RawProfileMeta;
  libs?: RawProfileLib[];
  threads?: RawProfileThread[];
  processes?: RawProfile[];
}

interface RawSymbolSidecarModule {
  debug_name?: string;
  debug_id?: string | null;
  code_id?: string | null;
  symbol_table?: Array<{
    rva?: number;
    size?: number;
    symbol?: number;
  }>;
  known_addresses?: Array<[number, number]>;
}

interface RawSymbolSidecar {
  string_table?: string[];
  data?: RawSymbolSidecarModule[];
}

interface CachedProfile {
  mtimeMs: number;
  size: number;
  data: LoadedProfile;
}

interface FlattenedProcess {
  index: number;
  path: string;
  profile: RawProfile;
}

interface IndexedModuleRange {
  start: number;
  end: number;
  name: string;
}

interface IndexedSidecarModule {
  exactMatches: Map<number, string>;
  ranges: IndexedModuleRange[];
}

export interface IndexedThread {
  index: number;
  processIndex: number;
  threadIndex: number;
  processPath: string;
  libs: RawProfileLib[];
  thread: RawProfileThread;
}

export interface LoadedProfile {
  profilePath: string;
  sidecarPath: string | null;
  meta: RawProfileMeta;
  processCount: number;
  threads: IndexedThread[];
  symbolicator: Symbolicator;
}

export class ProfileStore {
  private readonly cache = new Map<string, CachedProfile>();

  async load(profilePath: string): Promise<LoadedProfile> {
    const resolvedPath = path.resolve(profilePath);
    const profileStat = await stat(resolvedPath);
    const cached = this.cache.get(resolvedPath);
    if (
      cached !== undefined &&
      cached.mtimeMs === profileStat.mtimeMs &&
      cached.size === profileStat.size
    ) {
      return cached.data;
    }

    const rawProfile = ensureProfile(
      await readJsonFile(resolvedPath),
      resolvedPath,
    );
    const sidecarPath = await findExistingSidecarPath(resolvedPath);
    const rawSidecar =
      sidecarPath === null
        ? null
        : ensureSidecar(await readJsonFile(sidecarPath), sidecarPath);

    const processes = flattenProcesses(rawProfile);
    const threads = processes.flatMap((processNode) =>
      (processNode.profile.threads ?? []).map((thread, threadIndex) => ({
        index: 0,
        processIndex: processNode.index,
        threadIndex,
        processPath: processNode.path,
        libs: processNode.profile.libs ?? [],
        thread,
      })),
    );

    threads.forEach((thread, index) => {
      thread.index = index;
    });

    const loadedProfile: LoadedProfile = {
      profilePath: resolvedPath,
      sidecarPath,
      meta: rawProfile.meta,
      processCount: processes.length,
      threads,
      symbolicator: await Symbolicator.create(rawSidecar, processes),
    };

    this.cache.set(resolvedPath, {
      mtimeMs: profileStat.mtimeMs,
      size: profileStat.size,
      data: loadedProfile,
    });

    return loadedProfile;
  }
}

export class Symbolicator {
  private readonly indexedByModuleKey = new Map<string, IndexedSidecarModule>();
  private readonly indexedByModuleName = new Map<string, IndexedSidecarModule>();
  private readonly externalByModulePath = new Map<string, Map<number, string>>();
  private readonly demangledNames = new Map<string, string>();

  static async create(
    sidecar: RawSymbolSidecar | null,
    processes: FlattenedProcess[],
  ): Promise<Symbolicator> {
    const symbolicator = new Symbolicator(sidecar);
    await symbolicator.enrichFromExternalTools(processes, sidecar?.string_table ?? []);
    return symbolicator;
  }

  constructor(sidecar: RawSymbolSidecar | null) {
    if (sidecar === null) {
      return;
    }

    const byNameCandidates = new Map<string, IndexedSidecarModule[]>();
    for (const module of sidecar.data ?? []) {
      const indexedModule = buildIndexedSidecarModule(sidecar.string_table ?? [], module);
      const moduleName = (module.debug_name ?? "").toLowerCase();
      if (moduleName.length > 0) {
        const existing = byNameCandidates.get(moduleName) ?? [];
        existing.push(indexedModule);
        byNameCandidates.set(moduleName, existing);
      }

      for (const key of buildSidecarModuleKeys(module)) {
        this.indexedByModuleKey.set(key, indexedModule);
      }
    }

    for (const [moduleName, candidates] of byNameCandidates.entries()) {
      if (candidates.length === 1) {
        this.indexedByModuleName.set(moduleName, candidates[0]!);
      }
    }
  }

  lookup(lib: RawProfileLib | undefined, address: number | null): string | null {
    const resolved = this.lookupRaw(lib, address);
    return this.normalizeName(resolved);
  }

  normalizeName(name: string | null): string | null {
    if (name === null) {
      return null;
    }

    return this.demangledNames.get(name) ?? name;
  }

  private lookupRaw(lib: RawProfileLib | undefined, address: number | null): string | null {
    if (lib === undefined || address === null) {
      return null;
    }

    for (const key of buildProfileLibKeys(lib)) {
      const indexedModule = this.indexedByModuleKey.get(key);
      if (indexedModule !== undefined) {
        const resolved = lookupIndexedSymbol(indexedModule, address);
        if (resolved !== null) {
          return resolved;
        }
      }
    }

    const moduleName = (lib.debugName ?? lib.name ?? "").toLowerCase();
    if (moduleName.length === 0) {
      for (const modulePath of getLibraryPaths(lib)) {
        const resolved = this.externalByModulePath.get(modulePath)?.get(address);
        if (resolved !== undefined) {
          return resolved;
        }
      }
      return null;
    }

    const indexedMatch = lookupIndexedSymbol(this.indexedByModuleName.get(moduleName), address);
    if (indexedMatch !== null) {
      return indexedMatch;
    }

    for (const modulePath of getLibraryPaths(lib)) {
      const resolved = this.externalByModulePath.get(modulePath)?.get(address);
      if (resolved !== undefined) {
        return resolved;
      }
    }

    return null;
  }

  private async enrichFromExternalTools(
    processes: FlattenedProcess[],
    sidecarStringTable: string[],
  ): Promise<void> {
    const externalSymbols = await symbolizeUnresolvedAddresses(processes, (lib, address) =>
      this.lookupRaw(lib, address),
    );
    for (const [modulePath, matches] of externalSymbols.exactMatchesByModulePath.entries()) {
      this.externalByModulePath.set(modulePath, matches);
    }

    const demangleCandidates = new Set<string>();
    addRustMangledNames(demangleCandidates, sidecarStringTable);
    addRustMangledNames(demangleCandidates, externalSymbols.rawSymbolNames);
    addRustMangledNames(demangleCandidates, collectRustMangledThreadStrings(processes));

    const demangled = await demangleRustNames(demangleCandidates);
    for (const [rawName, normalizedName] of demangled.entries()) {
      this.demangledNames.set(rawName, normalizedName);
    }
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const buffer = await readFile(filePath);
  const text = isGzip(buffer)
    ? gunzipSync(buffer).toString("utf8")
    : buffer.toString("utf8");
  return JSON.parse(text) as unknown;
}

async function findExistingSidecarPath(profilePath: string): Promise<string | null> {
  const candidates = [resolveSidecarPath(profilePath), `${resolveSidecarPath(profilePath)}.gz`];
  for (const candidate of candidates) {
    try {
      const entry = await stat(candidate);
      if (entry.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function ensureProfile(value: unknown, filePath: string): RawProfile {
  if (!isObject(value) || !isObject(value.meta)) {
    throw new Error(`Invalid Firefox profile JSON in ${filePath}.`);
  }

  return value as unknown as RawProfile;
}

function ensureSidecar(value: unknown, filePath: string): RawSymbolSidecar {
  if (!isObject(value)) {
    throw new Error(`Invalid samply symbol sidecar JSON in ${filePath}.`);
  }

  return value as RawSymbolSidecar;
}

function flattenProcesses(rootProfile: RawProfile): FlattenedProcess[] {
  const flattened: FlattenedProcess[] = [];

  const visit = (profile: RawProfile, processPath: string): void => {
    flattened.push({
      index: flattened.length,
      path: processPath,
      profile,
    });

    for (const [index, childProfile] of (profile.processes ?? []).entries()) {
      visit(childProfile, `${processPath}.${index}`);
    }
  };

  visit(rootProfile, "0");

  return flattened;
}

function buildIndexedSidecarModule(
  stringTable: string[],
  module: RawSymbolSidecarModule,
): IndexedSidecarModule {
  const exactMatches = new Map<number, string>();
  const ranges: IndexedModuleRange[] = [];
  const symbolTable = module.symbol_table ?? [];

  symbolTable.forEach((entry) => {
    if (typeof entry.rva !== "number") {
      return;
    }

    ranges.push({
      start: entry.rva,
      end: entry.rva + Math.max(entry.size ?? 1, 1),
      name: getStringTableValue(stringTable, entry.symbol),
    });
  });

  for (const [address, symbolIndex] of module.known_addresses ?? []) {
    const symbolEntry = symbolTable[symbolIndex];
    if (symbolEntry === undefined) {
      continue;
    }

    exactMatches.set(address, getStringTableValue(stringTable, symbolEntry.symbol));
  }

  ranges.sort((left, right) => left.start - right.start);

  return {
    exactMatches,
    ranges,
  };
}

function lookupIndexedSymbol(
  indexedModule: IndexedSidecarModule | undefined,
  address: number,
): string | null {
  if (indexedModule === undefined) {
    return null;
  }

  const exactMatch = indexedModule.exactMatches.get(address);
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  let low = 0;
  let high = indexedModule.ranges.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = indexedModule.ranges[mid];
    if (candidate === undefined) {
      return null;
    }
    if (address < candidate.start) {
      high = mid - 1;
    } else if (address >= candidate.end) {
      low = mid + 1;
    } else {
      return candidate.name;
    }
  }

  return null;
}

function buildProfileLibKeys(lib: RawProfileLib): string[] {
  const moduleName = (lib.debugName ?? lib.name ?? "").toLowerCase();
  const codeId = normalizeId(lib.codeId);
  const debugId = normalizeId(lib.breakpadId);

  return [
    buildModuleKey(moduleName, codeId),
    buildModuleKey(moduleName, debugId),
  ].filter((value) => value !== null);
}

function buildSidecarModuleKeys(module: RawSymbolSidecarModule): string[] {
  const moduleName = (module.debug_name ?? "").toLowerCase();
  const codeId = normalizeId(module.code_id);
  const debugId = normalizeId(module.debug_id);

  return [
    buildModuleKey(moduleName, codeId),
    buildModuleKey(moduleName, debugId),
  ].filter((value) => value !== null);
}

function buildModuleKey(
  moduleName: string,
  identifier: string | null,
): string | null {
  if (moduleName.length === 0 || identifier === null) {
    return null;
  }

  return `${moduleName}::${identifier}`;
}

function normalizeId(identifier: string | null | undefined): string | null {
  if (identifier === undefined || identifier === null || identifier.length === 0) {
    return null;
  }

  return identifier.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function getStringTableValue(
  stringTable: string[],
  index: number | undefined,
): string {
  if (typeof index !== "number") {
    return "UNKNOWN";
  }

  return stringTable[index] ?? "UNKNOWN";
}

function isGzip(buffer: Buffer): boolean {
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ExternalSymbolizationResult {
  exactMatchesByModulePath: Map<string, Map<number, string>>;
  rawSymbolNames: Set<string>;
}

interface SymbolizationTarget {
  modulePath: string;
  addresses: number[];
}

async function symbolizeUnresolvedAddresses(
  processes: FlattenedProcess[],
  sidecarLookup: (lib: RawProfileLib | undefined, address: number | null) => string | null,
): Promise<ExternalSymbolizationResult> {
  const atosPath = resolveToolPath("MCP_SAMPLY_ATOS_BIN", process.platform === "darwin" ? "atos" : null);
  if (atosPath === null) {
    return {
      exactMatchesByModulePath: new Map(),
      rawSymbolNames: new Set(),
    };
  }

  const targets = collectUnresolvedSymbolizationTargets(processes, sidecarLookup);
  const exactMatchesByModulePath = new Map<string, Map<number, string>>();
  const rawSymbolNames = new Set<string>();

  for (const target of targets) {
    const resolved = await symbolizeAddressesWithAtos(atosPath, target);
    if (resolved.size === 0) {
      continue;
    }

    exactMatchesByModulePath.set(target.modulePath, resolved);
    for (const name of resolved.values()) {
      rawSymbolNames.add(name);
    }
  }

  return {
    exactMatchesByModulePath,
    rawSymbolNames,
  };
}

function collectUnresolvedSymbolizationTargets(
  processes: FlattenedProcess[],
  sidecarLookup: (lib: RawProfileLib | undefined, address: number | null) => string | null,
): SymbolizationTarget[] {
  const byModulePath = new Map<string, Set<number>>();

  for (const processNode of processes) {
    const libs = processNode.profile.libs ?? [];
    for (const thread of processNode.profile.threads ?? []) {
      const frameCount = thread.frameTable?.length ?? thread.frameTable?.func?.length ?? 0;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const address = getNumber(thread.frameTable?.address, frameIndex);
        if (address === null) {
          continue;
        }

        const lib = resolveThreadFrameLib(libs, thread, frameIndex);
        if (lib === undefined || sidecarLookup(lib, address) !== null) {
          continue;
        }

        const rawName = resolveThreadFrameName(thread, frameIndex);
        const nativeName = resolveThreadNativeSymbolName(thread, frameIndex);
        if (
          (rawName !== null && !isProbablyAddress(rawName)) ||
          (nativeName !== null && !isProbablyAddress(nativeName))
        ) {
          continue;
        }

        const modulePath = resolveLibraryPath(lib);
        if (modulePath === null) {
          continue;
        }

        const existing = byModulePath.get(modulePath) ?? new Set<number>();
        existing.add(address);
        byModulePath.set(modulePath, existing);
      }
    }
  }

  return [...byModulePath.entries()].map(([modulePath, addresses]) => ({
    modulePath,
    addresses: [...addresses.values()].sort((left, right) => left - right),
  }));
}

async function symbolizeAddressesWithAtos(
  atosPath: string,
  target: SymbolizationTarget,
): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();

  for (const chunk of chunkAddresses(target.addresses, 200)) {
    const output = await runProcess(atosPath, [
      "-o",
      target.modulePath,
      ...chunk.map((address) => `0x${address.toString(16)}`),
    ]);
    if (output === null) {
      continue;
    }

    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let index = 0; index < Math.min(lines.length, chunk.length); index += 1) {
      const line = lines[index]!;
      const address = chunk[index]!;
      const symbol = normalizeAtosOutput(line, address);
      if (symbol !== null) {
        resolved.set(address, symbol);
      }
    }
  }

  return resolved;
}

async function demangleRustNames(rawNames: Set<string>): Promise<Map<string, string>> {
  const rustfiltPath = resolveToolPath("MCP_SAMPLY_RUSTFILT_BIN", "rustfilt");
  if (rustfiltPath === null || rawNames.size === 0) {
    return new Map();
  }

  const decoratedByCore = new Map<string, Set<string>>();
  for (const rawName of rawNames) {
    const decorated = splitRustSymbolDecoration(rawName);
    if (decorated === null) {
      continue;
    }

    const existing = decoratedByCore.get(decorated.core) ?? new Set<string>();
    existing.add(rawName);
    decoratedByCore.set(decorated.core, existing);
  }

  if (decoratedByCore.size === 0) {
    return new Map();
  }

  const cores = [...decoratedByCore.keys()];
  const output = await runProcess(rustfiltPath, [], `${cores.join("\n")}\n`);
  if (output === null) {
    return new Map();
  }

  const lines = output.split(/\r?\n/);
  const demangled = new Map<string, string>();
  cores.forEach((core, index) => {
    const resolvedCore = lines[index]?.trim();
    if (!resolvedCore || resolvedCore === core) {
      return;
    }

    for (const rawName of decoratedByCore.get(core) ?? []) {
      demangled.set(rawName, replaceRustSymbolCore(rawName, core, resolvedCore));
    }
  });

  return demangled;
}

function addRustMangledNames(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) {
    if (splitRustSymbolDecoration(value) !== null) {
      target.add(value);
    }
  }
}

function collectRustMangledThreadStrings(processes: FlattenedProcess[]): Set<string> {
  const mangledNames = new Set<string>();

  for (const processNode of processes) {
    for (const thread of processNode.profile.threads ?? []) {
      addRustMangledNames(mangledNames, thread.stringArray ?? []);
    }
  }

  return mangledNames;
}

function resolveThreadFrameLib(
  libs: RawProfileLib[],
  thread: RawProfileThread,
  frameIndex: number,
): RawProfileLib | undefined {
  const funcIndex = getNumber(thread.frameTable?.func, frameIndex);
  const resourceIndex =
    funcIndex === null ? null : getNumber(thread.funcTable?.resource, funcIndex);
  const libIndex =
    resourceIndex === null ? null : getNumber(thread.resourceTable?.lib, resourceIndex);
  return libIndex === null ? undefined : libs[libIndex];
}

function resolveThreadFrameName(
  thread: RawProfileThread,
  frameIndex: number,
): string | null {
  const funcIndex = getNumber(thread.frameTable?.func, frameIndex);
  const nameIndex =
    funcIndex === null ? null : getNumber(thread.funcTable?.name, funcIndex);
  return getString(thread.stringArray ?? [], nameIndex);
}

function resolveThreadNativeSymbolName(
  thread: RawProfileThread,
  frameIndex: number,
): string | null {
  const nativeSymbolIndex = getNumber(thread.frameTable?.nativeSymbol, frameIndex);
  const nameIndex =
    nativeSymbolIndex === null
      ? null
      : getNumber(thread.nativeSymbols?.name, nativeSymbolIndex);
  return getString(thread.stringArray ?? [], nameIndex);
}

function resolveLibraryPath(lib: RawProfileLib): string | null {
  for (const candidate of getLibraryPaths(lib)) {
    if (path.isAbsolute(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getLibraryPaths(lib: RawProfileLib): string[] {
  return [...new Set([lib.debugPath, lib.path].filter(isNonEmptyString))];
}

function resolveToolPath(
  envName: string,
  defaultTool: string | null,
): string | null {
  const configured = process.env[envName]?.trim();
  if (configured) {
    return configured;
  }

  return defaultTool;
}

function normalizeAtosOutput(line: string, address: number): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedAddress = `0x${address.toString(16)}`.toLowerCase();
  if (trimmed.toLowerCase() === normalizedAddress) {
    return null;
  }

  return trimmed;
}

function splitRustSymbolDecoration(
  value: string,
): { core: string; suffix: string } | null {
  const trimmed = value.trim();
  const inIndex = trimmed.indexOf(" (in ");
  const core = inIndex >= 0 ? trimmed.slice(0, inIndex) : trimmed;
  if (!isRustMangledName(core)) {
    return null;
  }

  return {
    core,
    suffix: inIndex >= 0 ? trimmed.slice(inIndex) : "",
  };
}

function replaceRustSymbolCore(
  value: string,
  core: string,
  demangledCore: string,
): string {
  const decorated = splitRustSymbolDecoration(value);
  if (decorated === null || decorated.core !== core) {
    return value;
  }

  return `${demangledCore}${decorated.suffix}`;
}

function isRustMangledName(value: string): boolean {
  return /^_R[A-Za-z0-9_]+$/.test(value) || /^_?_ZN[A-Za-z0-9_]+E$/.test(value);
}

function isProbablyAddress(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

function chunkAddresses(values: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runProcess(
  command: string,
  args: string[],
  input?: string,
): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", () => {
      resolve(null);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      if (stderr.length > 0) {
        resolve(null);
        return;
      }

      resolve(null);
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function getString(
  stringTable: string[],
  index: number | null,
): string | null {
  if (index === null) {
    return null;
  }

  return stringTable[index] ?? null;
}

function getNumber(
  values: Array<number | null> | undefined,
  index: number,
): number | null {
  const value = values?.[index];
  return typeof value === "number" ? value : null;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
