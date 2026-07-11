# Workspace Engine

Owns Workspace application use cases: create, open, close, upgrade, health checks, import/export orchestration, storage-usage reporting, and garbage-collection policy.

It depends on `data/api` ports and never exposes concrete SQLite, file, or Hub implementations to product surfaces.
