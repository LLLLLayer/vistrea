# Hub Sync

The synchronization client between a local Workspace and the optional Vistrea Hub.

`HubPackSync` implements the first slice over the Hub's pack endpoints:

- `push` exports the named local refs as a `.vistrea-pack`, imports it into the Hub, and advances remote refs whose current target is an ancestor of the pushed commit with an explicit `must_match` precondition — divergent refs stay reported as conflicts, never forced;
- `fetch` asks the Hub to export the named refs and imports the pack locally with the same conflict reporting;
- `listRemoteRefs` reads the remote ref listing for status and negotiation;
- `getIdentity` returns the effective direct/inherited role and token-free permission provenance for the selected project;
- `listAccessibleProjects` discovers every project visible to a team credential while project credentials remain scoped to their selected project;
- `listActivity` polls the safe project activity projection with a numeric cursor and bounded page size.

All remote JSON is treated as untrusted and validated before it crosses the Data boundary. Credentials are accepted only as request configuration and are never returned by these methods.

`WorkspaceSyncEngine` in `engine/sync/` depends on the structural sync port rather than this concrete client. The local Host composes the two and exposes status, fetch, push, and activity to Studio and the strict CLI. The Engine advances ancestry-proven fetch and push fast-forwards under compare-and-set preconditions while preserving every remaining divergence. Synchronization operates on immutable commits and content hashes; it never copies or remotely locks an entire SQLite database. Thin-pack negotiation, resumable object uploads, subscriptions, searchable discovery, and guided conflict resolution remain later slices.
