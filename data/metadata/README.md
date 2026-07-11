# Metadata Store

This module owns the SQLite implementation for Screen States, Transitions, Observations, Wiki nodes, Review Issues, Tuning Patches, commit metadata, relations, migrations, transactions, and query indexes.

Large screenshots, videos, and complete Snapshot payloads belong in the Object Store.

The accepted Host/Data stack and driver policy are defined in [ADR-0004](../../docs/decisions/0004-host-data-and-sqlite-migrations.md). Migration filenames, checksums, transactions, recovery, and review requirements are defined in the [migration runbook](MIGRATIONS.md).
