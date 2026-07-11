# Protocol

The only source of truth for Vistrea cross-platform runtime and collaboration models.

Initial runtime models include `RuntimeSnapshot`, `UiNode`, `ScreenState`, `Transition`, `Event`, and `Artifact`. Design collaboration adds `DesignReference`, `ReviewIssue`, and `TuningPatch`. The protocol must support explicit versions, capability negotiation, platform extensions, redaction, and forward/backward compatibility.

Semantic interface behavior is specified in `docs/interfaces/`. Version 1 Runtime Snapshot, Runtime Event Batch, object, Workspace bootstrap, Commit, Working Set, and Ref contracts now have executable schemas, fixtures, strict JSON parsing, and semantic checks. New machine-readable contracts must extend those boundaries rather than redefine them.
