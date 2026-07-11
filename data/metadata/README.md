# SQLite Metadata Store

`SQLiteDataStore` is the durable Phase 0B implementation of the nine transaction-bound repositories in `data/api`.

It provides:

- explicit SQLite read transactions and `BEGIN IMMEDIATE` write transactions;
- deterministic per-resource JSON rows with indexed identities, revisions, and common relations;
- normalized Snapshot-to-ObjectRef associations and durable verified ObjectRef catalog entries;
- separate durable Operation Event and Result rows for restart recovery;
- atomic Validation Run/Finding summaries and Working Set/Commit/Ref compare-and-set behavior;
- forward-only, exact-byte SHA-256 migration discovery and a tamper-evident migration ledger;
- rejection of foreign databases, newer schemas, checksum drift, migration gaps, and failed migration batches;
- the `VSTR` application ID and the WAL/FULL/foreign-key/trusted-schema/busy-timeout/checkpoint policy from ADR-0004.

Large screenshots, videos, Snapshot payload objects, design assets, logs, and backup bytes belong in the Object Store. SQLite stores their canonical `ObjectRef` metadata and transactional relations, never artifact bytes.

The accepted Host/Data stack and driver policy are defined in [ADR-0004](../../docs/decisions/0004-host-data-and-sqlite-migrations.md). Migration filenames, checksums, transactions, recovery, and review requirements are defined in the [migration runbook](MIGRATIONS.md).

Run the emitted-JavaScript contract coverage with:

```bash
pnpm build:host
node data/metadata/copy-migrations.mjs .build/typescript/data/metadata/migrations
node --test .build/typescript/tests/contract/sqlite-metadata.test.js
```
