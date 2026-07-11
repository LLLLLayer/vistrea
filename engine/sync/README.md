# Sync Engine

Owns fetch, pull, push, publish, subscribe, and conflict-resolution use cases. It applies product policy and coordinates local version state through `data/api` and the low-level `data/sync/` client.

Local Workspace behavior must remain available when Hub is unavailable.
