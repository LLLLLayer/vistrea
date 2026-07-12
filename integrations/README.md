# Integrations

External Vistrea entry points. CLI, MCP, and CI are thin Engine adapters. Skills compose public capabilities into task-oriented Coding Agent workflows. Every entry point shares the same protocol and domain behavior.

Phase 0B implements fixture-backed CLI and stdio MCP adapters for Workspace status plus Snapshot capture, list, and get. Both use `shared/host-local-client.ts`; neither accesses Data or storage implementations.

See [Agent-facing interfaces](../docs/interfaces/AGENT_INTERFACES.md).
