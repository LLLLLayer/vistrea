# Vistrea Explorer — Claude Code plugin

Packages the exploration and asset-recording surface of Vistrea as one
installable Claude Code plugin: the authenticated MCP server restricted to the
`assets` and `exploration` toolsets, plus two agent skills that teach the
workflows. The verification surface (design review, review issues, tuning,
validators, build diffs) is deliberately masked by this composition — the Host
still implements it, this plugin simply does not expose it.

## What the plugin contains

- `.mcp.json` — starts the repository's MCP server
  (`.build/typescript/integrations/mcp/main.js`) with
  `VISTREA_MCP_TOOLSETS=assets,exploration`, exposing 19 of the 54 tools:
  Workspace status, Snapshot capture/read, event timeline, digest-proved
  Object downloads, portable packs, exploration Operations, Screen Graph
  reads, version tags, and merge/split curation.
- `skills/vistrea-explore-ui` — bounded exploration, graph reading, and
  identity curation.
- `skills/vistrea-record-assets` — canonical Snapshot capture, evidence
  reading, Object downloads, and pack exchange.

## Prerequisites

1. Build the host stack once from the repository root: `pnpm install
   --frozen-lockfile && pnpm build:host`. The plugin runs the emitted
   JavaScript; there is no separate bundle.
2. Start a Host (`node .build/typescript/apps/host/serve.js --workspace
   <abs-path> --connection-file <abs-path>`), with an automation provider if
   exploration should execute device actions.
3. Export the credentials from the connection descriptor as environment
   variables before launching Claude Code:

   ```bash
   export VISTREA_HOST_URL=...   # from the connection file
   export VISTREA_HOST_TOKEN=... # from the connection file
   ```

   Tokens travel only through the environment — never argv, logs, or commits.

## Install

From this repository checkout:

```text
/plugin marketplace add /absolute/path/to/vistrea
/plugin install vistrea-explorer@vistrea
```

The repository root's `.claude-plugin/marketplace.json` is the marketplace
manifest; the plugin body lives here.

The MCP entry is resolved relative to the plugin root
(`${CLAUDE_PLUGIN_ROOT}/../../.build/...`), so the plugin must run from inside
this checkout. If your Claude Code version installs marketplace plugins by
copying them elsewhere, the server will fail to start — point `.mcp.json` at
the absolute emitted path instead.

## Exposing more surface

`VISTREA_MCP_TOOLSETS` accepts any combination of `workspace`, `assets`,
`exploration`, `knowledge`, and `verification` (unset means all). Edit
`.mcp.json` to widen this plugin, or run the MCP server directly for the full
54-tool surface — see `integrations/mcp/README.md`.
