# Protocol

The only source of truth for Vistrea cross-platform runtime and collaboration models.

Runtime models include `RuntimeSnapshot`, `UiNode`, `Observation`, `ScreenState`, `Transition`, `RuntimeEvent`, and `Artifact`. Collaboration models include the Deep Wiki graph, design references and mappings, Review Issues, reversible Tuning Patches, validation evidence, Build Diffs, durable Operations, and local version values. The protocol supports explicit versions, capability negotiation, platform extensions, redaction, and forward/backward compatibility.

Semantic interface behavior is specified in `docs/interfaces/`. Phase 0A1 and Phase 0A2 shared values now have executable schemas, manifest-owned fixtures, strict JSON parsing, and aggregate semantic checks. `model-coverage/v1.json` freezes the canonical model surface for every repository in one `DataUnitOfWork`. New machine-readable contracts must extend those boundaries rather than redefine them.
