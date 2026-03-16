import type {
  IndexedThread,
  LoadedProfile,
  RawProfileLib,
  RawProfileThread,
} from "./store.js";

export interface HotFunctionSummary {
  name: string;
  resourceName: string | null;
  displayName: string;
  selfSamples: number;
  stackSamples: number;
}

export interface MarkerSummary {
  name: string;
  count: number;
}

export interface ThreadSummary {
  index: number;
  name: string;
  processName: string | null;
  pid: number | null;
  tid: number | null;
  sampleCount: number;
  startTimeMs: number | null;
  endTimeMs: number | null;
  durationMs: number | null;
  topSelfFunctions: HotFunctionSummary[];
  topStackFunctions: HotFunctionSummary[];
  topMarkers: MarkerSummary[];
}

export interface ProfileSummaryResult {
  profilePath: string;
  sidecarPath: string | null;
  presymbolicated: boolean;
  product: string | null;
  oscpu: string | null;
  intervalMs: number | null;
  processCount: number;
  threadCount: number;
  totalSamples: number;
  sampleTimeRangeMs: number | null;
  hottestSelfFunctionsOverall: HotFunctionSummary[];
  hottestStackFunctionsOverall: HotFunctionSummary[];
  threads: ThreadSummary[];
}

export interface ThreadInspectionResult {
  profilePath: string;
  sidecarPath: string | null;
  presymbolicated: boolean;
  thread: ThreadSummary & {
    topStacks: Array<{
      stack: string[];
      sampleCount: number;
    }>;
  };
}

export interface FunctionSearchResult {
  profilePath: string;
  sidecarPath: string | null;
  presymbolicated: boolean;
  query: string;
  matchCount: number;
  matches: Array<HotFunctionSummary & {
    threads: Array<{
      index: number;
      name: string;
      processName: string | null;
      selfSamples: number;
      stackSamples: number;
    }>;
  }>;
}

interface ResolvedFrame {
  key: string;
  name: string;
  resourceName: string | null;
  displayName: string;
}

interface MutableFunctionStat extends HotFunctionSummary {
  key: string;
}

interface ThreadAnalysis {
  thread: IndexedThread;
  sampleCount: number;
  startTimeMs: number | null;
  endTimeMs: number | null;
  durationMs: number | null;
  functions: Map<string, MutableFunctionStat>;
  markers: Map<string, number>;
  stacks: Map<string, { stack: string[]; sampleCount: number }>;
}

const analysisCache = new WeakMap<LoadedProfile, Map<number, ThreadAnalysis>>();

export function summarizeProfile(
  profile: LoadedProfile,
  options: {
    maxThreads?: number | undefined;
    maxFunctions?: number | undefined;
    maxMarkers?: number | undefined;
    includeEmptyThreads?: boolean | undefined;
  } = {},
): ProfileSummaryResult {
  const maxThreads = options.maxThreads ?? 8;
  const maxFunctions = options.maxFunctions ?? 8;
  const maxMarkers = options.maxMarkers ?? 8;
  const includeEmptyThreads = options.includeEmptyThreads ?? false;

  const threadAnalyses = profile.threads
    .map((thread) => getThreadAnalysis(profile, thread))
    .filter((analysis) => includeEmptyThreads || analysis.sampleCount > 0)
    .sort((left, right) => right.sampleCount - left.sampleCount);

  const overallFunctions = aggregateFunctions(threadAnalyses);
  const totalSamples = threadAnalyses.reduce(
    (sum, analysis) => sum + analysis.sampleCount,
    0,
  );

  let globalStartTime: number | null = null;
  let globalEndTime: number | null = null;
  for (const analysis of threadAnalyses) {
    globalStartTime = takeMin(globalStartTime, analysis.startTimeMs);
    globalEndTime = takeMax(globalEndTime, analysis.endTimeMs);
  }

  return {
    profilePath: profile.profilePath,
    sidecarPath: profile.sidecarPath,
    presymbolicated: profile.sidecarPath !== null,
    product: profile.meta.product ?? null,
    oscpu: profile.meta.oscpu ?? null,
    intervalMs: typeof profile.meta.interval === "number" ? profile.meta.interval : null,
    processCount: profile.processCount,
    threadCount: profile.threads.length,
    totalSamples,
    sampleTimeRangeMs:
      globalStartTime !== null && globalEndTime !== null
        ? Math.max(0, globalEndTime - globalStartTime)
        : null,
    hottestSelfFunctionsOverall: sortFunctions(overallFunctions, "selfSamples", maxFunctions),
    hottestStackFunctionsOverall: sortFunctions(overallFunctions, "stackSamples", maxFunctions),
    threads: threadAnalyses
      .slice(0, maxThreads)
      .map((analysis) =>
        toThreadSummary(analysis, {
          maxFunctions,
          maxMarkers,
        }),
      ),
  };
}

export function inspectThread(
  profile: LoadedProfile,
  selector: number | string,
  options: {
    maxFunctions?: number | undefined;
    maxMarkers?: number | undefined;
    maxStacks?: number | undefined;
  } = {},
): ThreadInspectionResult {
  const maxFunctions = options.maxFunctions ?? 10;
  const maxMarkers = options.maxMarkers ?? 10;
  const maxStacks = options.maxStacks ?? 8;
  const selectedThread = selectThread(profile, selector);
  const analysis = getThreadAnalysis(profile, selectedThread);

  return {
    profilePath: profile.profilePath,
    sidecarPath: profile.sidecarPath,
    presymbolicated: profile.sidecarPath !== null,
    thread: {
      ...toThreadSummary(analysis, {
        maxFunctions,
        maxMarkers,
      }),
      topStacks: [...analysis.stacks.values()]
        .sort((left, right) => right.sampleCount - left.sampleCount)
        .slice(0, maxStacks),
    },
  };
}

export function searchFunctions(
  profile: LoadedProfile,
  query: string,
  options: {
    maxResults?: number | undefined;
    maxThreadsPerResult?: number | undefined;
  } = {},
): FunctionSearchResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    throw new Error("The search query must not be empty.");
  }

  const maxResults = options.maxResults ?? 10;
  const maxThreadsPerResult = options.maxThreadsPerResult ?? 5;
  const matches = new Map<
    string,
    HotFunctionSummary & {
      key: string;
      threads: Array<{
        index: number;
        name: string;
        processName: string | null;
        selfSamples: number;
        stackSamples: number;
      }>;
    }
  >();

  for (const thread of profile.threads) {
    const analysis = getThreadAnalysis(profile, thread);
    for (const functionStat of analysis.functions.values()) {
      const haystack = `${functionStat.name}\n${functionStat.resourceName ?? ""}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        continue;
      }

      const existing = matches.get(functionStat.key);
      if (existing === undefined) {
        matches.set(functionStat.key, {
          ...functionStat,
          threads: [
            {
              index: analysis.thread.index,
              name: getThreadName(analysis.thread),
              processName: analysis.thread.thread.processName ?? null,
              selfSamples: functionStat.selfSamples,
              stackSamples: functionStat.stackSamples,
            },
          ],
        });
        continue;
      }

      existing.selfSamples += functionStat.selfSamples;
      existing.stackSamples += functionStat.stackSamples;
      existing.threads.push({
        index: analysis.thread.index,
        name: getThreadName(analysis.thread),
        processName: analysis.thread.thread.processName ?? null,
        selfSamples: functionStat.selfSamples,
        stackSamples: functionStat.stackSamples,
      });
    }
  }

  const sortedMatches = [...matches.values()]
    .map((match) => ({
      name: match.name,
      resourceName: match.resourceName,
      displayName: match.displayName,
      selfSamples: match.selfSamples,
      stackSamples: match.stackSamples,
      threads: match.threads
        .sort((left, right) => right.stackSamples - left.stackSamples)
        .slice(0, maxThreadsPerResult),
    }))
    .sort((left, right) => {
      if (right.stackSamples !== left.stackSamples) {
        return right.stackSamples - left.stackSamples;
      }

      return right.selfSamples - left.selfSamples;
    })
    .slice(0, maxResults);

  return {
    profilePath: profile.profilePath,
    sidecarPath: profile.sidecarPath,
    presymbolicated: profile.sidecarPath !== null,
    query,
    matchCount: sortedMatches.length,
    matches: sortedMatches,
  };
}

function getThreadAnalysis(
  profile: LoadedProfile,
  thread: IndexedThread,
): ThreadAnalysis {
  let cacheForProfile = analysisCache.get(profile);
  if (cacheForProfile === undefined) {
    cacheForProfile = new Map<number, ThreadAnalysis>();
    analysisCache.set(profile, cacheForProfile);
  }

  const cached = cacheForProfile.get(thread.index);
  if (cached !== undefined) {
    return cached;
  }

  const analysis = analyzeThread(profile, thread);
  cacheForProfile.set(thread.index, analysis);
  return analysis;
}

function analyzeThread(profile: LoadedProfile, thread: IndexedThread): ThreadAnalysis {
  const functions = new Map<string, MutableFunctionStat>();
  const markers = new Map<string, number>();
  const stacks = new Map<string, { stack: string[]; sampleCount: number }>();
  const stackCache = new Map<number, ResolvedFrame[]>();
  const sampleTable = thread.thread.samples;
  const stackIndexes = sampleTable?.stack ?? [];
  const sampleTimes = sampleTable?.time ?? [];
  const sampleCount = sampleTable?.length ?? stackIndexes.length;

  let startTimeMs: number | null = null;
  let endTimeMs: number | null = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const time = sampleTimes[index];
    if (typeof time === "number") {
      startTimeMs = takeMin(startTimeMs, time);
      endTimeMs = takeMax(endTimeMs, time);
    }

    const stackIndex = stackIndexes[index];
    if (typeof stackIndex !== "number" || stackIndex < 0) {
      continue;
    }

    const frames = resolveStackFrames(profile, thread, stackIndex, stackCache);
    if (frames.length === 0) {
      continue;
    }

    const leafFrame = frames[frames.length - 1]!;
    incrementFunctionStat(functions, leafFrame, "selfSamples");

    const seenKeys = new Set<string>();
    for (const frame of frames) {
      if (seenKeys.has(frame.key)) {
        continue;
      }

      seenKeys.add(frame.key);
      incrementFunctionStat(functions, frame, "stackSamples");
    }

    const stackLabels = frames.map((frame) => frame.displayName);
    const stackKey = stackLabels.join(" -> ");
    const existingStack = stacks.get(stackKey);
    if (existingStack === undefined) {
      stacks.set(stackKey, {
        stack: stackLabels,
        sampleCount: 1,
      });
    } else {
      existingStack.sampleCount += 1;
    }
  }

  const markerNames = thread.thread.markers?.name ?? [];
  const markerCount = thread.thread.markers?.length ?? markerNames.length;
  for (let index = 0; index < markerCount; index += 1) {
    const markerName = resolveMarkerName(thread.thread, markerNames[index]);
    markers.set(markerName, (markers.get(markerName) ?? 0) + 1);
  }

  return {
    thread,
    sampleCount,
    startTimeMs,
    endTimeMs,
    durationMs:
      startTimeMs !== null && endTimeMs !== null
        ? Math.max(0, endTimeMs - startTimeMs)
        : computeThreadDuration(thread.thread),
    functions,
    markers,
    stacks,
  };
}

function resolveStackFrames(
  profile: LoadedProfile,
  thread: IndexedThread,
  stackIndex: number,
  cache: Map<number, ResolvedFrame[]>,
): ResolvedFrame[] {
  const cached = cache.get(stackIndex);
  if (cached !== undefined) {
    return cached;
  }

  const prefixIndex = getNumber(thread.thread.stackTable?.prefix, stackIndex);
  const frameIndex = getNumber(thread.thread.stackTable?.frame, stackIndex);
  const frames =
    prefixIndex !== null
      ? [...resolveStackFrames(profile, thread, prefixIndex, cache)]
      : [];

  if (frameIndex !== null) {
    frames.push(resolveFrame(profile, thread, frameIndex));
  }

  cache.set(stackIndex, frames);
  return frames;
}

function resolveFrame(
  profile: LoadedProfile,
  thread: IndexedThread,
  frameIndex: number,
): ResolvedFrame {
  const strings = thread.thread.stringArray ?? [];
  const funcIndex = getNumber(thread.thread.frameTable?.func, frameIndex);
  const nameIndex =
    funcIndex !== null ? getNumber(thread.thread.funcTable?.name, funcIndex) : null;
  const rawName = getString(strings, nameIndex);
  const nativeName = resolveNativeSymbolName(thread.thread, frameIndex);
  const resourceIndex =
    funcIndex !== null ? getNumber(thread.thread.funcTable?.resource, funcIndex) : null;
  const resourceName = resolveResourceName(thread, resourceIndex);
  const address = getNumber(thread.thread.frameTable?.address, frameIndex);
  const lib = resolveResourceLib(thread, resourceIndex);
  const sidecarName = profile.symbolicator.lookup(lib, address);
  const chosenName = chooseFrameName(sidecarName, nativeName, rawName, address);
  const displayName =
    resourceName !== null && !chosenName.includes(resourceName)
      ? `${chosenName} [${resourceName}]`
      : chosenName;

  return {
    key: `${chosenName}\u0000${resourceName ?? ""}`,
    name: chosenName,
    resourceName,
    displayName,
  };
}

function resolveNativeSymbolName(
  thread: RawProfileThread,
  frameIndex: number,
): string | null {
  const nativeSymbolIndex = getNumber(thread.frameTable?.nativeSymbol, frameIndex);
  const nameIndex =
    nativeSymbolIndex !== null
      ? getNumber(thread.nativeSymbols?.name, nativeSymbolIndex)
      : null;

  return getString(thread.stringArray ?? [], nameIndex);
}

function resolveResourceName(
  thread: IndexedThread,
  resourceIndex: number | null,
): string | null {
  if (resourceIndex === null) {
    return null;
  }

  const lib = resolveResourceLib(thread, resourceIndex);
  if (lib !== undefined) {
    return lib.debugName ?? lib.name ?? null;
  }

  const nameIndex = getNumber(thread.thread.resourceTable?.name, resourceIndex);
  return getString(thread.thread.stringArray ?? [], nameIndex);
}

function resolveResourceLib(
  thread: IndexedThread,
  resourceIndex: number | null,
): RawProfileLib | undefined {
  if (resourceIndex === null) {
    return undefined;
  }

  const libIndex = getNumber(thread.thread.resourceTable?.lib, resourceIndex);
  if (libIndex === null) {
    return undefined;
  }

  return thread.libs[libIndex];
}

function chooseFrameName(
  sidecarName: string | null,
  nativeName: string | null,
  rawName: string | null,
  address: number | null,
): string {
  if (sidecarName !== null) {
    return sidecarName;
  }

  if (nativeName !== null && !isProbablyAddress(nativeName)) {
    return nativeName;
  }

  if (rawName !== null && !isProbablyAddress(rawName)) {
    return rawName;
  }

  if (nativeName !== null) {
    return nativeName;
  }

  if (rawName !== null) {
    return rawName;
  }

  if (address !== null) {
    return `0x${address.toString(16)}`;
  }

  return "UNKNOWN";
}

function incrementFunctionStat(
  stats: Map<string, MutableFunctionStat>,
  frame: ResolvedFrame,
  field: "selfSamples" | "stackSamples",
): void {
  const existing = stats.get(frame.key);
  if (existing === undefined) {
    stats.set(frame.key, {
      key: frame.key,
      name: frame.name,
      resourceName: frame.resourceName,
      displayName: frame.displayName,
      selfSamples: field === "selfSamples" ? 1 : 0,
      stackSamples: field === "stackSamples" ? 1 : 0,
    });
    return;
  }

  existing[field] += 1;
}

function sortFunctions(
  stats: Map<string, MutableFunctionStat>,
  field: "selfSamples" | "stackSamples",
  limit: number,
): HotFunctionSummary[] {
  return [...stats.values()]
    .sort((left, right) => {
      if (right[field] !== left[field]) {
        return right[field] - left[field];
      }

      if (right.stackSamples !== left.stackSamples) {
        return right.stackSamples - left.stackSamples;
      }

      if (right.selfSamples !== left.selfSamples) {
        return right.selfSamples - left.selfSamples;
      }

      return left.displayName.localeCompare(right.displayName);
    })
    .slice(0, limit)
    .map(({ key: _key, ...rest }) => rest);
}

function aggregateFunctions(
  analyses: ThreadAnalysis[],
): Map<string, MutableFunctionStat> {
  const aggregate = new Map<string, MutableFunctionStat>();

  for (const analysis of analyses) {
    for (const functionStat of analysis.functions.values()) {
      const existing = aggregate.get(functionStat.key);
      if (existing === undefined) {
        aggregate.set(functionStat.key, { ...functionStat });
        continue;
      }

      existing.selfSamples += functionStat.selfSamples;
      existing.stackSamples += functionStat.stackSamples;
    }
  }

  return aggregate;
}

function toThreadSummary(
  analysis: ThreadAnalysis,
  options: {
    maxFunctions: number;
    maxMarkers: number;
  },
): ThreadSummary {
  return {
    index: analysis.thread.index,
    name: getThreadName(analysis.thread),
    processName: analysis.thread.thread.processName ?? null,
    pid:
      typeof analysis.thread.thread.pid === "number"
        ? analysis.thread.thread.pid
        : null,
    tid:
      typeof analysis.thread.thread.tid === "number"
        ? analysis.thread.thread.tid
        : null,
    sampleCount: analysis.sampleCount,
    startTimeMs: analysis.startTimeMs,
    endTimeMs: analysis.endTimeMs,
    durationMs: analysis.durationMs,
    topSelfFunctions: sortFunctions(
      analysis.functions,
      "selfSamples",
      options.maxFunctions,
    ),
    topStackFunctions: sortFunctions(
      analysis.functions,
      "stackSamples",
      options.maxFunctions,
    ),
    topMarkers: [...analysis.markers.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, options.maxMarkers),
  };
}

function selectThread(
  profile: LoadedProfile,
  selector: number | string,
): IndexedThread {
  if (typeof selector === "number") {
    const exactMatch = profile.threads.find((thread) => thread.index === selector);
    if (exactMatch !== undefined) {
      return exactMatch;
    }

    throw new Error(`Could not find thread index ${selector}.`);
  }

  const normalizedSelector = selector.trim().toLowerCase();
  const exactMatches = profile.threads.filter((thread) => {
    const label = getThreadLabel(thread).toLowerCase();
    return label === normalizedSelector || getThreadName(thread).toLowerCase() === normalizedSelector;
  });
  if (exactMatches.length > 0) {
    return exactMatches[0]!;
  }

  const partialMatches = profile.threads
    .filter((thread) => getThreadLabel(thread).toLowerCase().includes(normalizedSelector))
    .sort((left, right) => {
      const leftSamples = getThreadAnalysis(profile, left).sampleCount;
      const rightSamples = getThreadAnalysis(profile, right).sampleCount;
      return rightSamples - leftSamples;
    });

  if (partialMatches.length > 0) {
    return partialMatches[0]!;
  }

  throw new Error(`Could not find a thread matching "${selector}".`);
}

function resolveMarkerName(
  thread: RawProfileThread,
  markerIndex: number | null | undefined,
): string {
  const name = getString(thread.stringArray ?? [], markerIndex ?? null);
  return name ?? "UNKNOWN";
}

function getThreadName(thread: IndexedThread): string {
  if (typeof thread.thread.name === "string" && thread.thread.name.length > 0) {
    return thread.thread.name;
  }

  return `thread-${thread.index}`;
}

function getThreadLabel(thread: IndexedThread): string {
  const processName = thread.thread.processName;
  return processName ? `${getThreadName(thread)} (${processName})` : getThreadName(thread);
}

function computeThreadDuration(thread: RawProfileThread): number | null {
  const startTime =
    typeof thread.registerTime === "number" ? thread.registerTime : null;
  const endTime =
    typeof thread.unregisterTime === "number" ? thread.unregisterTime : null;

  if (startTime !== null && endTime !== null) {
    return Math.max(0, endTime - startTime);
  }

  return null;
}

function getNumber(
  values: Array<number | null> | undefined,
  index: number,
): number | null {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getString(
  values: string[],
  index: number | null,
): string | null {
  if (index === null) {
    return null;
  }

  return values[index] ?? null;
}

function isProbablyAddress(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

function takeMin(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }

  if (current === null) {
    return next;
  }

  return Math.min(current, next);
}

function takeMax(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }

  if (current === null) {
    return next;
  }

  return Math.max(current, next);
}
