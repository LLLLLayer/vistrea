# Integrations

External Vistrea entry points. CLI, MCP, and CI are thin Engine adapters. Skills compose public capabilities into task-oriented Coding Agent workflows. Every entry point shares the same protocol and domain behavior.

The current surface exposes 54 implemented Host operations — Workspace status, Snapshots, Runtime events, design review, tuning, the Screen Graph, exploration Operations, the Deep Wiki, validation, build diffs, portable packs, and object downloads — through the strict JSON CLI, a 54-tool stdio MCP server, five Agent Skills, and the headless CI gate. Every adapter uses `shared/host-local-client.ts`; none accesses Data or storage implementations. Each submodule README documents its exact commands, tools, workflows, and flags.

`claude-plugin/` packages the exploration and asset-recording surface as an installable Claude Code plugin: the MCP server focused to the `assets,exploration` toolsets plus two skills. The verification surface stays implemented in the Host and reachable through the full CLI/MCP; the plugin composition simply masks it (`VISTREA_MCP_TOOLSETS`, see `mcp/README.md`). The repository root's `.claude-plugin/marketplace.json` makes this checkout installable with `/plugin marketplace add`.

See [Agent-facing interfaces](../docs/interfaces/AGENT_INTERFACES.md).
