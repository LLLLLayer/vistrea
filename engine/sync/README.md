# Sync Engine

Owns the product-level Hub synchronization use cases. `WorkspaceSyncEngine`
combines caller identity, team project discovery, local/remote ref status,
immutable pack fetch/push, conflict surfacing, and the safe project activity
feed. Its low-level `WorkspaceSyncPort` is supplied by the composition root;
the Engine does not import Hub HTTP or storage implementations.

Fetch and push serialize per Host process, advance only verified fast-forward
refs with compare-and-set preconditions, never force a ref, and return the raw
pack import, the refs advanced by the explicit transfer, any remaining
conflicts, and a fresh ref status. An unknown relation means the other history
has not been fetched locally; it must not be presented as divergence.

Local Workspace behavior remains available when Hub is unavailable. Publish,
subscription, versioned collaboration mutations, and explicit conflict
resolution remain later use cases.
