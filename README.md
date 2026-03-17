# mcp-samply

`mcp-samply` is a MCP server for [`samply`](https://github.com/mstange/samply).

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

The server exposes eight MCP tools:

- `samply_doctor`: verify whether the `samply` binary is available and report version / environment details
- `samply_record`: run `samply record --save-only` and save a profile to disk
- `samply_summarize_profile`: generate a compact summary of threads, hotspots, markers, and overall sample distribution
- `samply_inspect_thread`: inspect one thread in detail, including representative stacks
- `samply_search_functions`: search for functions or library names across the loaded profile
- `samply_breakdown_subsystems`: group native functions by namespace prefix so agents can see which Rust / C++ subsystems dominate a profile
- `samply_focus_functions`: recover the most common caller / callee contexts around a target function or namespace
- `samply_locate_symbols`: map hot native symbols back to likely local source files so an agent can inspect implementation details

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
8. Use `samply_locate_symbols` to map the hottest native frames back to local source files before reading or patching code.

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

## Publishing To npm

This repository includes a GitHub Actions workflow at `.github/workflows/publish-npm.yml`.

Before using it, add a repository secret named `NPM_TOKEN` with publish access to the `mcp-samply` package on npm.

The workflow can be triggered in two ways:

1. Publish a GitHub Release whose tag matches the package version, for example `v0.1.0`.
2. Run the workflow manually from the Actions tab with `workflow_dispatch` and provide the exact package version, for example `0.1.0`.

On every publish run, the workflow will:

1. Install dependencies with `npm ci`.
2. Run `npm run check`.
3. Run `npm pack --dry-run`.
4. Publish with `npm publish --provenance --access public`.

## Debugging The MCP Surface

This repository also includes a small local debug client so you can inspect the MCP surface and call tools without wiring up an external MCP host first.

List the exposed MCP surfaces:

```sh
npm run debug:mcp -- list-tools
```

The output includes:

- `tools`: the currently registered MCP tools, including input and output schemas
- `prompts`: prompt definitions, if any
- `resources`: resource definitions, if any

Call a tool and print the full JSON result:

```sh
npm run debug:mcp -- call samply_doctor
```

Summarize one of the sample profiles committed in this repo:

```sh
npm run debug:mcp -- call samply_summarize_profile --args '{"profilePath":".samply/presym-smoke.json.gz"}'
```

Run symbol lookup against a local source tree:

```sh
npm run debug:mcp -- call samply_locate_symbols --args '{"roots":["/absolute/path/to/project"],"symbols":["rspack::Compiler::build"],"extensions":[".rs",".cc",".cpp"]}'
```

For larger payloads, store the tool input in a JSON file and use `--args-file`:

```sh
npm run debug:mcp -- call samply_record --args-file ./tool-args.json
```

Recommended manual debug loop:

1. Run `npm run debug:mcp -- list-tools` to confirm the tool names and schemas.
2. Call `samply_doctor` first to verify environment and binary resolution.
3. Use `samply_record` or a saved `profile.json(.gz)` to generate real inputs.
4. Run `samply_summarize_profile`, then drill into `samply_inspect_thread`, `samply_search_functions`, `samply_breakdown_subsystems`, and `samply_focus_functions`.
5. Use `samply_locate_symbols` with your project root to confirm hotspot symbols map back to the files you expect.
