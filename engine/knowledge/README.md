# Knowledge Engine

The persistent, searchable, linked Deep Wiki over the shared knowledge models, through `data/api` only.

`KnowledgeEngine` implements the verified local-first slice:

- creates and revises Wiki Nodes with inline Markdown content, optimistic-concurrency revisions, and the lifecycle `draft -> published -> archived -> published` — published knowledge archives and revives instead of silently reverting to draft;
- links nodes to other nodes or any workspace resource under the canonical relation set, failing closed on missing targets, and removes links with revision preconditions while keeping deletion evidence;
- answers backlinks, resource-related lookups, and text/kind/label/status search through the `WikiRepository` port, so memory and SQLite storage behave identically;
- creates and revises Knowledge Collections with exact node, link, and entry membership, resetting any edited publication to an honest draft revision;
- publishes a Collection only when every member node is published, freezes a canonical Knowledge Graph in the Object Store, and atomically creates the Working Set, Commit, CAS Ref update, and published projection;
- validates every produced node, link, Collection, and frozen Knowledge Graph against the canonical knowledge schema before persistence.

The frozen bundle contains the draft Collection revision and the mutable projection receives the resulting Commit/Ref pointer. This deliberately avoids embedding a Commit ID inside the bytes that determine that same Commit. Markdown/HTML rendering belongs to `data/exchange`; derived graph views remain a later slice. The engine owns knowledge behavior, not SQLite schemas, physical artifact paths, or Hub transport.
