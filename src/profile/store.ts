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
  breakpadId?: string | null;
  codeId?: string | null;
  path?: string;
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
      symbolicator: new Symbolicator(rawSidecar),
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
    if (lib === undefined || address === null) {
      return null;
    }

    for (const key of buildProfileLibKeys(lib)) {
      const indexedModule = this.indexedByModuleKey.get(key);
      if (indexedModule !== undefined) {
        return lookupIndexedSymbol(indexedModule, address);
      }
    }

    const moduleName = (lib.debugName ?? lib.name ?? "").toLowerCase();
    if (moduleName.length === 0) {
      return null;
    }

    return lookupIndexedSymbol(this.indexedByModuleName.get(moduleName), address);
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
