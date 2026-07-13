# Vistrea Explorer — Claude Code plugin

Packages the exploration and asset-recording surface of Vistrea as one
installable Claude Code plugin: two agent skills that teach the workflows over
the strict JSON CLI. The verification surface (design review, review issues,
tuning, validators, build diffs) is deliberately masked by this composition —
the Host still implements it, this plugin simply does not teach it, and the
CLI enforces the mask when `VISTREA_CLI_TOOLSETS` is set.

## What the plugin contains

- `skills/vistrea-explore-ui` — bounded exploration, graph reading, and
  identity curation through `explore`, `graph`, and `screen` commands.
- `skills/vistrea-record-assets` — canonical Snapshot capture, evidence
  reading, digest-proved Object downloads, and pack exchange through
  `snapshot`, `events`, `object`, and `pack` commands.

Both skills drive `node .build/typescript/integrations/cli/main.js` from the
repository root. There is no bundled server; the CLI is the agent surface.

## Prerequisites

1. Build the host stack once from the repository root: `pnpm install
   --frozen-lockfile && pnpm build:host`. The skills run the emitted
   JavaScript.
2. Start a Host (`node .build/typescript/apps/host/serve.js --workspace
   <abs-path> --connection-file <abs-path>`), with an automation provider if
   exploration should execute device actions. For iOS, `pnpm wda up` boots a
   pinned WebDriverAgent (Simulator by default, `--device <udid>` for
   hardware) and prints the exact `--wda-url` to pass.
3. Export the credentials from the connection descriptor, plus the toolset
   focus, before launching Claude Code:

   ```bash
   export VISTREA_HOST_URL=...   # from the connection file
   export VISTREA_HOST_TOKEN=... # from the connection file
   export VISTREA_CLI_TOOLSETS=assets,exploration
   ```

   Tokens travel only through the environment — never argv, logs, or commits.
   With `VISTREA_CLI_TOOLSETS` set, the masked command groups disappear from
   `help` and fail closed as `unsupported` at dispatch, so the focus holds
   even if an agent tries a command the skills never taught.

## Install

From this repository checkout:

```text
/plugin marketplace add /absolute/path/to/vistrea
/plugin install vistrea-explorer@vistrea
```

The repository root's `.claude-plugin/marketplace.json` is the marketplace
manifest; the plugin body lives here.

## Exposing more surface

`VISTREA_CLI_TOOLSETS` accepts any combination of `workspace`, `assets`,
`exploration`, `knowledge`, and `verification` (unset means all). Widen the
export or unset it to reach the full command surface — see
`integrations/cli/README.md`.
