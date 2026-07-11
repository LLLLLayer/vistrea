# Hub Sync

The synchronization client between a local Workspace and Vistrea Hub. It compares refs, exchanges commit manifests, negotiates missing objects, transfers artifacts, and handles authorization, resumability, and conflicts.

Synchronization operates on immutable commits and content hashes. It never copies or remotely locks an entire SQLite database.
