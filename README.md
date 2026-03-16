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

The server exposes five MCP tools:

- `samply_doctor`: verify whether the `samply` binary is available and report version / environment details
- `samply_record`: run `samply record --save-only` and save a profile to disk
- `samply_summarize_profile`: generate a compact summary of threads, hotspots, markers, and overall sample distribution
- `samply_inspect_thread`: inspect one thread in detail, including representative stacks
- `samply_search_functions`: search for functions or library names across the loaded profile

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
