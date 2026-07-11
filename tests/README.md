# Cross-module Tests

Root tests protect cross-module behavior: protocol compatibility, SDK-to-Host connection, Data Layer integration, sync contracts, and complete device loops. Unit tests remain with their owning module.

Run the currently implemented contract suite with `pnpm test:contract`, or run schema, fixture, and contract verification together with `pnpm check`.
