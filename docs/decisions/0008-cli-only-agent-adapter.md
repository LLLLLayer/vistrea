# ADR 0008: The CLI is the single agent adapter

- Status: Accepted
- Date: 2026-07-13
- Owners: Integrations owner
- Related contracts: `docs/interfaces/AGENT_INTERFACES.md`, `docs/interfaces/OPERATION_CATALOG.md`, `integrations/cli/README.md`

## Context

Until this decision the repository shipped two agent-facing adapters over the
same authenticated Host Local API client: the strict JSON CLI and a stdio MCP
server exposing 54 tools name-for-name with the CLI's commands. Both were thin,
tested, and functionally identical — which is exactly the problem: every new
Host operation, every toolset-focus feature, and every piece of agent-facing
documentation had to land twice, and the two surfaces could drift.

The product owner chose to consolidate on one adapter. The CLI won because it
serves every current consumer — humans, CI pipelines, and Coding Agents running
in shell-capable harnesses — while the MCP server served only the last group.

## Decision

1. `integrations/mcp/` is deleted, along with its `@modelcontextprotocol/sdk`
   dependency. The strict JSON CLI (`integrations/cli/`) is the single agent
   adapter over the Host Local API client.
2. The composition-focus capability moves to the CLI: `VISTREA_CLI_TOOLSETS`
   names the exposed command surfaces (`workspace`, `assets`, `exploration`,
   `knowledge`, `verification`, keyed by the first command word; unset means
   all, `workspace` is always on). A masked command group disappears from
   `help` and fails closed as `unsupported` at dispatch; an unknown set name
   fails as `invalid_argument` naming the valid sets.
3. Skills — including the Claude Code plugin's — teach only CLI workflows.
4. `docs/interfaces/OPERATION_CATALOG.md` keeps its name-for-name parity rule
   between `IMPLEMENTED_HOST_OPERATIONS` and the CLI command table; the MCP
   column is gone, not reserved.

## Consequences

- One surface to extend, document, and contract-test per operation.
- Agents need shell access; harnesses without a shell (or with Bash disallowed)
  cannot reach Vistrea until an adapter for them is justified again. Per-tool
  permission granularity is coarser: authorizing the CLI means authorizing
  Bash, not 19 named tools.
- The masking is configuration, not a security boundary: anyone holding the
  Host token can run the unrestricted CLI. That was equally true of the MCP
  toolsets; the Host's own authentication remains the real boundary.
- Reversal is cheap if a non-shell host matters later: the deleted server was
  a single-file adapter over `shared/host-local-client.ts`, and this ADR plus
  git history record its exact shape (last present at commit `9071d78`).
