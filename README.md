# mcp-samply

`mcp-samply` is a TypeScript MCP server that helps AI agents record CPU profiles with [`samply`](https://github.com/mstange/samply) and analyze the resulting Firefox Profiler JSON.

The package is designed to be launched with:

```sh
npx mcp-samply
```

This repository is being built from scratch in incremental commits. The first step provides the TypeScript MCP CLI scaffold and a `samply_doctor` tool for environment checks.
