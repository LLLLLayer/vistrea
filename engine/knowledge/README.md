# Knowledge Engine

The persistent, searchable, linked Deep Wiki over the shared knowledge models, through `data/api` only.

`KnowledgeEngine` implements the first verified slice:

- creates and revises Wiki Nodes with inline Markdown content, optimistic-concurrency revisions, and the lifecycle `draft -> published -> archived -> published` — published knowledge archives and revives instead of silently reverting to draft;
- links nodes to other nodes or any workspace resource under the canonical relation set, failing closed on missing targets, and removes links with revision preconditions while keeping deletion evidence;
- answers backlinks, resource-related lookups, and text/kind/label/status search through the `WikiRepository` port, so memory and SQLite storage behave identically;
- validates every produced node and link against the canonical knowledge schema before persistence.

Knowledge Collection publication (which binds published collections to Commits and Refs), readable exports, and derived views remain later slices. The engine owns knowledge behavior, not SQLite schemas, physical artifact paths, or Hub transport.
