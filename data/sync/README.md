# Hub Sync

The synchronization client between a local Workspace and the optional Vistrea Hub.

`HubPackSync` implements the first slice over the Hub's pack endpoints:

- `push` exports the named local refs as a `.vistrea-pack`, imports it into the Hub, and advances remote refs whose current target is an ancestor of the pushed commit with an explicit `must_match` precondition — divergent refs stay reported as conflicts, never forced;
- `fetch` asks the Hub to export the named refs and imports the pack locally with the same conflict reporting;
- `listRemoteRefs` reads the remote ref listing for status and negotiation.

Synchronization operates on immutable commits and content hashes. It never copies or remotely locks an entire SQLite database. Thin-pack negotiation, resumable object uploads, subscriptions, and conflict resolution workflows remain later slices.
