# mcp-samply

`mcp-samply` is a TypeScript MCP server for [`samply`](https://github.com/mstange/samply).

It is designed for AI agents that need to:

- record CPU profiles with `samply`
- load existing `profile.json` / `profile.json.gz` files
- turn Firefox Profiler data into compact, agent-friendly hotspot summaries
- drill down into specific threads and functions

The intended runtime is:

```sh
npx mcp-samply
```

## Why this exists

`samply` is excellent at recording profiles and opening them in Firefox Profiler, but AI agents need a second layer:

- a stable MCP interface
- structured summaries instead of raw table-heavy profile JSON
- a way to work offline from saved profiles

`mcp-samply` provides that layer.

## Tools

The server exposes seven MCP tools:

- `samply_doctor`: verify whether the `samply` binary is available and report version / environment details
- `samply_record`: run `samply record --save-only` and save a profile to disk
- `samply_summarize_profile`: generate a compact summary of threads, hotspots, markers, and overall sample distribution
- `samply_inspect_thread`: inspect one thread in detail, including representative stacks
- `samply_search_functions`: search for functions or library names across the loaded profile
- `samply_breakdown_subsystems`: group native functions by namespace prefix so agents can see which Rust / C++ subsystems dominate a profile
- `samply_focus_functions`: recover the most common caller / callee contexts around a target function or namespace

## Presymbolication

By default, `samply_record` enables `--unstable-presymbolicate`.

That causes `samply` to emit a sidecar file such as:

```text
profile.json.gz
profile.json.syms.json
```

`mcp-samply` reads that sidecar automatically and uses it to resolve native addresses into function names during offline analysis. This is critical for AI-driven performance work; without it, saved profiles often contain only raw addresses.

## Use With Codex

Example MCP server config:

```json
{
  "mcpServers": {
    "samply": {
      "command": "npx",
      "args": ["-y", "mcp-samply"],
      "env": {
        "MCP_SAMPLY_BIN": "samply"
      }
    }
  }
}
```

If `samply` is not on `PATH`, set `MCP_SAMPLY_BIN` to an absolute executable path.

You can still use the analysis tools on an existing profile file even when `samply` itself is not installed.

## Typical Agent Workflow

1. Call `samply_doctor`.
2. Call `samply_record` with a command, PID, or `all=true`.
3. Call `samply_summarize_profile` on the produced profile.
4. Use `samply_inspect_thread` for the hottest thread.
5. Use `samply_search_functions` for focused follow-up questions.
6. Use `samply_breakdown_subsystems` to quantify native hotspots by crate / module prefix.
7. Use `samply_focus_functions` to turn syscalls such as `stat` / `read` back into actionable upstream call paths.

## Rust Hotspot Workflow

For native-heavy tools such as Rspack, a productive sequence is:

1. Record with presymbolication enabled.
2. Call `samply_breakdown_subsystems` with `resourceQuery: "rspack"` and a namespace-oriented `query` such as `rspack_`.
3. Identify the hottest crates / modules, for example `rspack_resolver`, `rspack_fs`, or `swc_ecma_parser`.
4. Call `samply_focus_functions` on key functions such as `resolve_tracing`, `find_package_json`, `metadata_sync`, or `read_sync`.
5. Use the returned `before` / `after` context windows to determine whether the real bottleneck is resolution, filesystem probing, parsing, loader execution, or runtime glue.

## Local Development

```sh
npm install
npm run build
npm test
```

Run the MCP server locally:

```sh
npm run dev
```

Build output is published through the `mcp-samply` bin entry so the package can be launched with `npx`.
