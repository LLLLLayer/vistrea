# Design Review and Tuning Engine

Maps design baselines to Runtime Snapshots and UI Nodes, compares visual properties, manages Review Issue lifecycles, and creates, applies, reverts, stores, and exports `TuningPatch` objects.

- Enable tuning only in Debug/Internal builds.
- Allow only explicit visual properties.
- Display source truth and preview values separately.
- Record target node, original value, preview value, design evidence, and environment.
- Keep every patch reversible and reviewable.
- Never call arbitrary business methods or represent a preview as a source-code change.
