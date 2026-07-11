# Versioning Engine

Owns product-level commit, ref, tag, baseline, diff, and history use cases. It decides when runtime, Wiki, design, and review changes form a Vistrea Commit, while `data/versioning/` only persists version metadata.

Ref updates use optimistic concurrency and never delete immutable history.
