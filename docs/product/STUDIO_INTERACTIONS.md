# Vistrea Studio Interaction Design

## 1. Product roles

Vistrea Studio serves four primary roles without creating separate data silos:

| Role | Primary goal |
|---|---|
| Designer | Review real runtime UI, create issues, tune visual properties, and re-verify |
| Developer | Inspect structure, reproduce paths, relate runtime nodes to code, and fix issues |
| QA engineer | Explore paths, validate behavior, inspect evidence, and compare builds |
| Coding Agent operator | Provide bounded runtime context, run Agent workflows, and review actions/results |

The selected Workspace, project, ref, build, device context, and Screen State remain visible across modes.

## 2. Information architecture

Entering a Workspace, Studio scopes to one application and one version
(build) chosen in the persistent context bar; the Screen State Canvas is the
landing surface for that scope. Snapshots are evidence subordinate to Screen
States: the primary way to reach a screenshot or a view tree is selecting a
state on the Canvas and opening its single-screen Inspector, not browsing a
raw capture list. A flat Snapshot library remains available as a secondary
evidence view. Runtime events belong to the bottom timeline panel and to the
selected state's evidence; they are not a standalone sidebar destination.

Primary navigation:

```text
Workspace
├── Canvas
├── Evidence
├── Documents
├── Wiki
├── Quality
└── Hub
```

Canvas owns exploration and the selected Screen State Inspector. Evidence is
the secondary raw Snapshot library. Documents browses source-repository
Markdown without importing it. Wiki owns Vistrea knowledge. Quality owns
Snapshot and Screen Graph validation plus same-application Build Diff, and Hub
owns the optional collaboration workflow. Design Review remains implemented
behind the shared contracts but is intentionally absent from this default
navigation and Inspector surface.

## 3. Main window composition

```text
┌────────────────────────────────────────────────────────────────────┐
│ Workspace / Project / Ref / Build     Device     Sync     Agent    │
├──────────────┬───────────────────────────────────┬─────────────────┤
│ Navigation   │ Main content                      │ Context panel   │
│              │ Canvas / Screenshot / Docs / Tree │ Properties      │
│              │ Quality / Wiki / Hub              │ Findings        │
│              │                                   │ Issues          │
│              │                                   │ Evidence        │
├──────────────┴───────────────────────────────────┴─────────────────┤
│ Timeline / Operations / Runtime Events / Validation / Logs         │
└────────────────────────────────────────────────────────────────────┘
```

### Persistent context bar

The top context bar shows:

- current Workspace and project;
- selected ref or commit;
- application build and source Git SHA;
- environment, device, account profile, locale, theme, and text scale;
- Runtime SDK and automation connection status;
- local changes and sync status;
- active Agent operation.

Changing context never silently discards unsaved Review Issues, tuning previews, or local commits.

### Context panel

The right panel follows selection:

- Screen State summary;
- UI Node properties;
- Review Issues;
- validation findings;
- incoming and outgoing paths;
- related Wiki nodes and code context.

The Review Issues section is scoped to the selected Screen State through the Host query. No selection means no issue list; Studio must not silently substitute an application-wide list. The Canvas and state detail use the exact Application Version + Build context selected in the persistent context bar.

### Timeline panel

The bottom panel correlates:

- device actions;
- Runtime SDK events;
- Snapshot capture;
- screenshots and short video;
- exploration progress;
- validation results;
- Agent tool calls;
- sync and commit events.

## 4. Interaction modes

The main content has explicit modes rather than one overloaded canvas:

| Mode | Primary content | Mutations allowed |
|---|---|---|
| Live | Current screenshot and runtime selection | Capture, device action, open Inspector |
| Explore | Screen State Canvas and operation progress | Start/pause/resume/cancel exploration, curate identity |
| Inspect | Screenshot plus 2D/3D structure | Select node, inspect properties, attach notes |
| Tune | Runtime preview and property editor | Apply/revert allowlisted preview values |
| Verify | Findings and build/graph diff | Run validation, inspect evidence, accept baseline |
| Documents | Repository-owned Markdown | Choose project, filter, preview, and open configuration |
| Wiki | Linked knowledge and search | Edit notes, links, collections, and publication metadata |

Mode changes preserve selected Screen State and node when the target mode supports them.

## 5. Workflow: create or open a Workspace

```text
Launch Studio
-> restore the last available Workspace, otherwise show Welcome
-> choose a recent Workspace, open an existing Workspace, or create a new one
-> run Workspace health and migration check
-> display local refs and optional remote status
-> choose project/ref/build context
-> enter Overview
```

The packaged application keeps Workspace selection separate from product
content. Welcome lists recent locations with their full path, last-opened time,
current marker, and available, missing, or unrecognized state. Opening accepts
only an existing Workspace; creating initializes only a new or empty location.
Invalid locations remain untouched and can be removed from Recent. A failed
switch leaves the current Workspace and Host usable. The current Workspace is
visible in the window title and persistent context bar, and `.vistrea`
directory packages can reopen through Finder. Closing a Workspace returns to
Welcome and disables automatic restore until another Workspace is opened.

Recent preferences contain only normalized paths and timestamps. Tokens,
connection descriptors, Workspace metadata, and Hub credentials are excluded.
The managed Host remains responsible for creation, health, migration, locking,
and recovery; the Welcome UI never reads SQLite or initializes storage itself.

Engine mapping:

- `CreateWorkspace`
- `OpenWorkspace`
- `CheckWorkspaceHealth`
- `ListWorkspaceRefs`
- `GetSyncStatus`

Failure states:

- incompatible Workspace version;
- incomplete migration;
- missing objects;
- read-only filesystem;
- remote unavailable while local data remains usable.

## 6. Workflow: connect and inspect live UI

```text
Choose device
-> connect Runtime SDK
-> capture initial Snapshot
-> display screenshot and tree
-> select node on screenshot or tree
-> inspect properties and event timeline

Optional when a real device action is required:

-> open automation session
-> verify automation capabilities and safety policy
```

Engine mapping:

- `ListDevices`
- `ConnectRuntime`
- `CaptureSnapshot`
- `QueryUiNodes`
- `GetEventTimeline`
- `OpenAutomationSession` only for actions or exploration

Connection status is split into SDK and automation indicators because Snapshot inspection requires only the SDK connection, while real actions and exploration additionally require automation.

## 7. Workflow: explore UI paths

```text
Select start state and scope
-> choose build/environment/account profile
-> review action safety policy
-> run exploration
-> watch current state, action, discoveries, and blocked actions
-> pause for manual intervention if required
-> resume or cancel
-> review state identity suggestions
-> select a destination Screen State
-> choose one recorded entry-to-destination path when alternatives exist
-> inspect the highlighted states and directional transitions
-> create Commit and update selected ref
```

The Canvas distinguishes:

- confirmed states and transitions;
- newly discovered local changes;
- conditional or environment-specific paths;
- blocked dangerous actions;
- states missing in the selected build;
- uncertain identity matches requiring review.

The Canvas viewport supports native two-finger panning with momentum, pinch
magnification anchored under the gesture, mouse background panning, explicit
center-anchored zoom controls, and local card repositioning. These presentation
coordinates are session UI state and never rewrite Screen State identity or
Transition evidence. Zoom must lay out cards and text at their final size
rather than transforming a composited graph layer. Final positions snap to the
display backing scale, low zoom progressively removes secondary card detail,
and Reset-to-fit restores the deterministic layered layout without enlarging it
beyond 100%. Selecting a destination keeps the same state selected in the
Inspector and first reserves one deterministic shortest route for each
depth-reachable recorded entry. The global expansion budget limits only
alternative cycle-free routes; `maximumDepth` and `maximumPaths` remain hard
limits, and a route set with more reachable entries than `maximumPaths` is
truncated by sorted entry ID. The chosen route's states and directional
transitions are highlighted. Alternative routes are explicit choices rather
than lines highlighted all at once. A state with no recorded entry route
reports that absence instead of inventing reachability.

Card selection and card repositioning are mutually exclusive interactions: a
click selects the Screen State, while a drag moves only its session-local
presentation and must not open the Inspector. The Canvas exposes distinct
loading, empty, and retryable failure states. An empty graph never appears as
an error, and a graph read failure never hides the active Workspace or silently
falls back to stale content.

Engine mapping:

- `RunExploration`
- `GetExplorationOperation`
- `PauseExploration`
- `ResumeExploration`
- `CancelExploration`
- `MergeScreenStates`
- `SplitScreenState`
- `CommitWorkingSetAndUpdateRef`

## 8. Workflow: design review

This workflow remains implemented through Engine, Host, CLI, persistence, and
tests, but its dedicated Studio workbench is not part of the default product
surface. `StudioFeaturePolicy.designReviewVisibleByDefault` records that
decision so hiding the UI does not delete or fork the underlying capability.

```text
Open Screen State
-> choose design reference or approved build baseline
-> map whole screen or selected regions
-> compare side by side, overlay, or pixel diff
-> select a concrete Difference and runtime node
-> inspect expected versus actual properties
-> promote the Difference to a Review Issue without recopying evidence
-> assign owner and severity
-> save local review Commit
-> optionally publish review ref
```

The comparison toolbar provides:

- side-by-side;
- overlay opacity;
- blink comparison;
- pixel or perceptual diff;
- alignment anchors;
- device and scale normalization;
- issue visibility filters.

Review Issue creation automatically records:

- selected build, ref, Screen State, node, and Snapshot;
- screenshot crop and design-reference region;
- expected and actual values;
- environment and display context;
- actor and time.

## 9. Workflow: tune UI

```text
Open an unresolved Review Issue or selected node
-> verify Debug tuning capability
-> enter Tune mode
-> edit an allowlisted property
-> preview immediately in the running App
-> capture resulting Snapshot
-> compare before, preview, and design reference
-> add changes to Tuning Patch
-> revert preview or intentionally keep it for the session
-> export patch for developer or Coding Agent
-> apply the source change outside the Runtime preview
-> recapture the later build and re-verify the Issue
```

The UI always displays three values when available:

```text
Source value      12 pt
Preview value     16 pt
Design target     16 pt
```

Rules:

- Preview values use a distinct visual treatment.
- Closing the session, disconnecting, or choosing Revert restores source values.
- Saving a Tuning Patch does not claim the source code changed.
- A Review Issue becomes verified only after capture from a real later build.
- Partial patch application lists rejected properties and reasons.
- Automated acceptance previews use a bounded TTL and attempt an explicit
  Revert on both success and later workflow failure. The TTL is the final
  safety bound when immediate best-effort cleanup cannot reach the Host.
- Source handoff is generated from the exact persisted Tuning Patch. Studio
  shows canonical Coding Agent instructions and reports missing source mapping
  explicitly; it never invents a file path.

## 10. Workflow: verify a new build

```text
Select baseline build/ref and candidate build/ref
-> resolve source Git SHAs and environment
-> identify affected Screen States and paths
-> capture or explore missing candidate evidence
-> run rule sets and graph diff
-> inspect added, changed, missing, and uncertain results
-> re-verify Review Issues and Tuning Patches
-> accept or reject candidate baseline
-> create version Commit
```

The current Quality workspace exposes the implemented local subset directly:
it validates one selected Snapshot or the selected Screen Graph, displays exact
Finding counts and subjects, and suppresses an open Finding only with a
canonical reason, justification, and expected revision. Its Build Diff picker
offers only observed builds from the same project and application. Fewer than
two builds produces an explicit empty state; Studio never fabricates a diff.

The diff UI distinguishes:

- added;
- intentionally removed;
- missing but not sufficiently explored;
- structurally changed;
- visually changed;
- behaviorally changed;
- unresolved identity;
- unchanged and content-deduplicated.

## 11. Workflow: project Markdown documents

```text
Open Documents
-> choose the local source project for this Workspace
-> load vistrea.project.json, or use README.md and docs/
-> filter by title, relative path, or configured source
-> select any Markdown file
-> read rendered content or inspect source text
-> open the project configuration in the normal system editor when needed
```

The project commits `vistrea.project.json`; Studio preferences retain only the
machine-local project-folder association for each Workspace. Configured paths
must remain inside the project root. Browsing is read-only and never imports
the files into SQLite, the Object Store, Commits, Hub, or the Deep Wiki. Exact
format, fallback, and safety bounds live in `PROJECT_DOCUMENTS.md`.

## 12. Workflow: Deep Wiki

```text
Search screen, route, component, text, issue, or path
-> open Wiki node
-> inspect backlinks and runtime evidence
-> navigate to Canvas, Snapshot, issue, code, or design context
-> edit knowledge and links
-> switch to Collections
-> choose an exact member set and explicit entry-node subset
-> revise against the revision captured when editing began
-> create Commit
-> publish selected collection if authorized
```

Wiki editing must not duplicate runtime truth into manually maintained fields when a query or reference is sufficient.

## 13. Workflow: Coding Agent

Studio shows Agent operations as reviewable activities:

- requested goal and scope;
- selected Skill or CLI path;
- tool calls and evidence;
- pending dangerous-action confirmation;
- created Snapshots, issues, patches, findings, commits, and refs;
- final status and unresolved warnings.

An Agent never gains broader device, tuning, publication, or deletion authority merely because it runs inside Studio.

## 14. Offline and synchronization behavior

- Offline status is explicit but does not block local capture, review, tuning, Wiki edits, or commits.
- Local changes appear ahead or diverged from a remote ref.
- Pull never silently overwrites local commits.
- The Hub section remains reachable in an empty local Workspace so an initial fetch can populate it.
- Connecting shows the effective direct/inherited role, permission sources, team-visible projects, and the selected refs before any transfer.
- Fetch and push are explicit actions. Both advance only ancestry-proven fast-forward refs under compare-and-set preconditions; a divergence remains a visible conflict with local and remote commit IDs.
- The safe project activity feed polls by cursor and never exposes bearer tokens or administrator-only audit details.
- The Hub token is session-only UI state. Studio may remember the origin, Project ID, and selected refs, but never persists the token in preferences, command arguments, logs, or Workspace content.
- The current Beta presents conflicts and preserves both histories; guided rebase, merge, and authorized overwrite remain a later resolution workflow.
- Artifact upload progress is separate from metadata/ref publication.
- Restricted or redacted artifacts show explicit placeholders.

## 15. Undo and history

- UI navigation undo is local UI state.
- Tuning undo reverts active runtime preview changes.
- Knowledge and review undo creates a new versioned change when already committed.
- Ref rollback moves a ref with authorization and audit; it does not delete commits.
- Object deletion is not a user-facing undo mechanism.

## 16. Empty, loading, and failure states

Every primary screen defines:

- no Workspace;
- empty Workspace;
- no connected device;
- SDK connected without automation;
- automation connected without SDK;
- capture limitation;
- missing or redacted artifact;
- unsupported capability;
- operation in progress;
- operation failed with retry guidance;
- remote unavailable but local data present;
- version conflict.

## 17. Accessibility and keyboard behavior

- Every Canvas and tree action has a non-pointer alternative.
- Selection, focus, and current mode are exposed to accessibility APIs.
- Command-1 through Command-6 navigate the six Workspace sections without
  depending on sidebar focus.
- A focused Canvas card can be selected without a pointer, and arrow-key
  navigation moves to the nearest state in the deterministic layered layout
  while revealing an offscreen destination.
- Diff colors are not the only status indicator.
- Design-property editors support keyboard entry and reset.
- Long operations announce progress without stealing focus.
- Reduced-motion settings disable blink and large 3D transitions.

## 18. Studio milestones

### M1: SDK-to-Snapshot vertical loop

1. Workspace open/create and health status;
2. device and SDK connection status;
3. synchronized screenshot and 2D node tree;
4. node selection and property panel;
5. event timeline;
6. local persistence and reopen;
7. operation and error presentation.

### M2: design review and tuning

1. design-reference and approved-build baseline comparison;
2. Difference-to-Review-Issue promotion;
3. reversible allowlisted alpha, color, font, spacing/insets, and corner-radius tuning;
4. Tuning Patch persistence, source-oriented Agent handoff, and fresh-build re-verification evidence.

Canvas exploration, Deep Wiki and Collection editing, Tuning Patch source handoff, local validation and Build Diff, 3D inspection, and the first Hub ref-sync workspace are implemented. Workspace maintenance controls, searchable Hub discovery, subscriptions, versioned collaboration editors, guided conflict resolution, and dedicated Coding Agent operation review remain later milestones.
