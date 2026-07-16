# Integrations

External Vistrea entry points. The CLI and CI gate are thin Engine adapters. Skills compose public capabilities into task-oriented Coding Agent workflows. Every entry point shares the same protocol and domain behavior.

The current surface exposes 72 implemented Host operations — Workspace status and recovery points, Snapshots, Runtime events, design acceptance, protected tuning and source suggestions, the Screen Graph, exploration Operations, Wiki nodes and Knowledge Collections, immutable publication, readable exports, validation, build diffs, Hub synchronization and activity, portable packs, and object downloads — through the strict JSON CLI, five Agent Skills, and the headless CI gate. ADR-0008 retired the stdio MCP server: the CLI is the single agent adapter, and `VISTREA_CLI_TOOLSETS` focuses its exposed command surface per composition. Every adapter uses `shared/host-local-client.ts`; none accesses Data or storage implementations. The machine-readable operation manifest keeps Host routes, client dispatch, CLI commands, and the public catalog aligned; each submodule README documents its exact commands, workflows, and flags.

`claude-plugin/` packages the exploration and asset-recording surface as an installable Claude Code plugin: two skills that drive the CLI, with `VISTREA_CLI_TOOLSETS=assets,exploration` masking the verification commands. The verification surface stays implemented in the Host and reachable through the unrestricted CLI; the plugin composition simply masks it (see `cli/README.md`). The repository root's `.claude-plugin/marketplace.json` makes this checkout installable with `/plugin marketplace add`.

See [Agent-facing interfaces](../docs/interfaces/AGENT_INTERFACES.md).
