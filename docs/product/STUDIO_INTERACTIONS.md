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

Primary navigation:

```text
Workspace
├── Overview
├── Live
│   ├── Devices
│   ├── Current Screen
│   └── Event Timeline
├── Explore
│   ├── Screen State Canvas
│   ├── Exploration Runs
│   └── Paths
├── Inspect
│   ├── 2D Tree
│   ├── 3D View/Layer
│   └── Properties
├── Design
│   ├── References
│   ├── Review Issues
│   └── Tuning Patches
├── Verify
│   ├── Validation Runs
│   ├── Findings
│   └── Build Diff
├── Wiki
│   ├── Knowledge Graph
│   ├── Search
│   └── Published Collections
└── Sync
    ├── Local History
    ├── Remotes
    └── Conflicts
```

## 3. Main window composition

```text
┌────────────────────────────────────────────────────────────────────┐
│ Workspace / Project / Ref / Build     Device     Sync     Agent    │
├──────────────┬───────────────────────────────────┬─────────────────┤
│ Navigation   │ Main content                      │ Context panel   │
│              │ Canvas / Screenshot / Diff / Tree │ Properties      │
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
- design expected versus actual values;
- Review Issues;
- validation findings;
- incoming and outgoing paths;
- related Wiki nodes and code context.

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
| Review | Design comparison and issues | Map design, create/update/verify issues |
| Tune | Runtime preview and property editor | Apply/revert allowlisted preview values |
| Verify | Findings and build/graph diff | Run validation, inspect evidence, accept baseline |
| Wiki | Linked knowledge and search | Edit notes, links, collections, and publication metadata |

Mode changes preserve selected Screen State and node when the target mode supports them.

## 5. Workflow: create or open a Workspace

```text
Launch Studio
-> open recent Workspace or create local Workspace
-> run Workspace health and migration check
-> display local refs and optional remote status
-> choose project/ref/build context
-> enter Overview
```

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
-> create Commit and update selected ref
```

The Canvas distinguishes:

- confirmed states and transitions;
- newly discovered local changes;
- conditional or environment-specific paths;
- blocked dangerous actions;
- states missing in the selected build;
- uncertain identity matches requiring review.

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

```text
Open Screen State
-> choose design reference or approved build baseline
-> map whole screen or selected regions
-> compare side by side, overlay, or pixel diff
-> select a runtime node
-> inspect expected versus actual properties
-> create Review Issue with evidence
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

The diff UI distinguishes:

- added;
- intentionally removed;
- missing but not sufficiently explored;
- structurally changed;
- visually changed;
- behaviorally changed;
- unresolved identity;
- unchanged and content-deduplicated.

## 11. Workflow: Deep Wiki

```text
Search screen, route, component, text, issue, or path
-> open Wiki node
-> inspect backlinks and runtime evidence
-> navigate to Canvas, Snapshot, issue, code, or design context
-> edit knowledge and links
-> create Commit
-> publish selected collection if authorized
```

Wiki editing must not duplicate runtime truth into manually maintained fields when a query or reference is sufficient.

## 12. Workflow: Coding Agent

Studio shows Agent operations as reviewable activities:

- requested goal and scope;
- selected Skill or CLI path;
- tool calls and evidence;
- pending dangerous-action confirmation;
- created Snapshots, issues, patches, findings, commits, and refs;
- final status and unresolved warnings.

An Agent never gains broader device, tuning, publication, or deletion authority merely because it runs inside Studio.

## 13. Offline and synchronization behavior

- Offline status is explicit but does not block local capture, review, tuning, Wiki edits, or commits.
- Local changes appear ahead or diverged from a remote ref.
- Pull never silently overwrites local commits.
- Ref conflicts open a resolution view.
- Artifact upload progress is separate from metadata/ref publication.
- Restricted or redacted artifacts show explicit placeholders.

## 14. Undo and history

- UI navigation undo is local UI state.
- Tuning undo reverts active runtime preview changes.
- Knowledge and review undo creates a new versioned change when already committed.
- Ref rollback moves a ref with authorization and audit; it does not delete commits.
- Object deletion is not a user-facing undo mechanism.

## 15. Empty, loading, and failure states

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

## 16. Accessibility and keyboard behavior

- Every Canvas and tree action has a non-pointer alternative.
- Selection, focus, and current mode are exposed to accessibility APIs.
- Diff colors are not the only status indicator.
- Design-property editors support keyboard entry and reset.
- Long operations announce progress without stealing focus.
- Reduced-motion settings disable blink and large 3D transitions.

## 17. Studio milestones

### M1: SDK-to-Snapshot vertical loop

1. Workspace open/create and health status;
2. device and SDK connection status;
3. synchronized screenshot and 2D node tree;
4. node selection and property panel;
5. event timeline;
6. local persistence and reopen;
7. operation and error presentation.

### M2: design review and tuning

1. one design-reference overlay;
2. Review Issue creation;
3. one allowlisted tuning property with apply/revert;
4. Tuning Patch persistence and re-verification evidence.

Canvas exploration, full Deep Wiki, build diff, 3D inspection, and Hub collaboration follow after these interaction loops are stable.
