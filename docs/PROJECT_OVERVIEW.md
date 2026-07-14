# Vistrea Project Overview

## 1. Product definition

Vistrea is a local-first runtime UI knowledge, design review, tuning, exploration, and verification platform for native iOS and Android applications.

It combines in-app Runtime SDKs, real device automation, a reusable Host Engine, a macOS workspace, a versioned Deep Wiki, and Coding Agent integrations around one stable Runtime Snapshot protocol.

Vistrea is not any single one of the following:

- a screenshot-only black-box UI Agent;
- a FLEX or Lookin replacement that only displays a View Tree;
- a WDA or UIAutomator wrapper that only performs actions;
- a page-flow canvas with no runtime evidence;
- a screenshot annotation tool for design review;
- a one-time generated automation report.

It connects those capabilities into a persistent Runtime UI Knowledge System.

### One-line definition

> Vistrea lets designers, developers, QA engineers, and Coding Agents explore, review, tune, verify, and retain knowledge about the same native application runtime UI.

### Product principles

- Semantic-first, vision-assisted
- Real user interaction through device automation
- Local-first, optionally shared through Vistrea Hub
- One cross-platform protocol with explicit platform adapters
- One runtime fact base for Studio, CLI, Skills, and CI
- Immutable observations and versioned knowledge
- Reversible, protected design tuning
- Clear separation between planned and implemented capabilities

## 2. System overview

```text
┌──────────────────────────────────────────────────────────────┐
│                    Vistrea Studio for macOS                  │
│ Canvas / Deep Wiki / Design Review / Tuning / Inspector     │
└──────────────────────────────┬───────────────────────────────┘
                               │ public use cases
┌──────────────────────────────▼───────────────────────────────┐
│                       Vistrea Host Engine                    │
│ Connection / Automation / Exploration / Design / Validation │
│ Workspace / Knowledge / Operations / Versioning / Sync      │
└──────────────────────────────┬───────────────────────────────┘
                               │ Data API
┌──────────────────────────────▼───────────────────────────────┐
│                          Data Layer                          │
│ Workspace / Metadata / Objects / Versioning / Search / Sync │
└───────────────────┬──────────────────────────┬───────────────┘
                    │ local-first              │ optional sync
             Local Workspace             Vistrea Hub

iOS / Android Runtime SDK ── Runtime Snapshot Protocol
WDA / UIAutomator ────────── Real device interaction
CLI / Skills / CI ────────── Engine adapters
```

### 2.1 Runtime Snapshot protocol

The protocol is the cross-platform contract shared by SDKs, Host Engine, Data Layer, Studio, integrations, tests, and Hub.

It must provide:

- explicit versions and compatibility behavior;
- stable common fields plus platform extension points;
- capability negotiation;
- redaction and sensitive-field handling;
- canonical fixtures for Swift, Kotlin, Host, Data, and Hub implementations;
- generation of platform models from the accepted JSON Schemas once platform code-generation tooling exists.

Platform implementations must not redefine core concepts independently.

### 2.2 iOS and Android Runtime SDKs

The SDK runs inside an authorized Debug/Internal application process and acts as the white-box observation layer.

Responsibilities:

- enumerate visible windows and current screens;
- capture View, ViewGroup, Semantics, and Layer structures through adapters;
- associate UIViewController, Activity, Fragment, route, and business component identity;
- capture node type, stable identity, text, state, frame, interaction, and accessibility properties;
- capture reviewable visual properties such as font, color, corner radius, border, shadow, alpha, and spacing evidence;
- record view insertion, removal, layout, interaction, and transient UI events;
- produce Runtime Snapshots with synchronized screenshots;
- expose the same data to the in-app Inspector and Host connection;
- support protected, reversible, allowlisted visual-property overrides for design tuning.

Initial platform sources:

| Platform | Primary source | Supplemental source |
|---|---|---|
| iOS UIKit | UIWindow, UIViewController, UIView, CALayer | Accessibility and business registration |
| iOS SwiftUI | Accessibility and explicit semantics | UIKit host and test adapter |
| Android View | Activity, Fragment, Window, ViewGroup | Resource ID and accessibility |
| Android Compose | Semantics Tree and TestTag | Host View and explicit semantics |

The current verified native slice covers UIKit and Android View hierarchy capture, full Compose semantics-tree capture, accessibility-runtime-dependent SwiftUI element capture, synchronized PNG screenshots, protected Debug/Internal Runtime connection, canonical Snapshot delivery to the local Host, and negotiated Runtime Event Batch streaming. The UIKit and Android View adapters implement reversible allowlisted alpha, color, font, spacing, inset, and corner-radius previews; physical-device acceptance of every supported view/property combination remains follow-up work.

The SDK observes. It must not bypass real UI paths by calling arbitrary business methods.

### 2.3 In-app Inspector

The Inspector is available only in protected internal builds and shares protocol models with Studio.

The current Debug Demo Inspectors expose a native tree and basic runtime evidence. The broader Inspector capabilities remain planned:

- select a node directly on screen;
- inspect hierarchy and properties;
- highlight frame, hit area, visible region, and occlusion;
- inspect current controller, activity, fragment, and route;
- search by class, text, ID, accessibility identifier, or TestTag;
- inspect recent UI events and transient states;
- capture and send a Runtime Snapshot to Studio;
- preview reversible visual-property adjustments.

### 2.4 Host Engine and device automation

The Host Engine contains reusable application and domain logic independent of Studio UI.

It manages:

- SDK discovery, connection, session, transport, and capability negotiation;
- WDA and UIAutomator lifecycle and actions;
- exploration planning, safety filtering, backtracking, and state recovery;
- Screen State identity and deduplication;
- design baseline mapping, review issues, and tuning patches;
- Deep Wiki and Runtime Graph behavior;
- validation and build diff;
- Workspace lifecycle, Vistrea versioning, and synchronization policy;
- public use cases consumed by Studio and integrations.

Device automation performs real tap, type, swipe, back, launch, and system UI interaction. SDK-reported nodes may guide targeting, but the action still occurs through the real automation layer.

The implemented Host slice owns authenticated Runtime sessions (plaintext only
on literal loopback, or exact-IP TLS 1.3 with leaf-certificate pinning for the
physical-device profile), canonical Snapshot capture/get/list use cases,
ordered Object-before-metadata persistence, the independent loopback Local API,
and production local Workspace composition. Device automation (`adb` and
WebDriverAgent providers), deterministic exploration with Screen State
identity, bounded crash recovery and state restoration, design review and
reversible tuning, Deep Wiki knowledge, core validation and build diff, and
optional Hub pack sync are implemented behind the same Data ports. The basic
real-input, dangerous-action, and raised Storefront acceptances are verified on
both platforms; iOS also proves real clear and dismiss actions. The physical
vertical runners are implemented but await complete operator-owned hardware
acceptance. Dedicated versioning and generic long-running operation use cases
above the Data ports remain future Engine slices.

### 2.5 Vistrea Studio for macOS

Studio is the primary user workspace.

It includes:

- device and Runtime SDK connection;
- current screenshot and live Snapshot inspection;
- Screen State Canvas;
- versioned Deep Wiki;
- design review and visual tuning workspace;
- 2D View/Semantics Tree;
- Lookin-style 3D View/Layer Inspector;
- validation and build-diff results;
- Coding Agent integration and deep links.

Studio composes Engine use cases. Views and ViewModels must not access SQLite, object paths, automation implementations, or Hub transport directly.

The current native SwiftUI Studio is Canvas-first: an Application Version + Build scope selects a build-scoped Screen State Canvas, and a selected state resolves that build's canonical Snapshot into screenshot, 2D tree, hierarchy-depth 3D, design comparison, node properties, tuning, annotations, knowledge links, and Screen State-scoped Review Issues, while a secondary Evidence library retains raw Snapshots. Runtime events live in a bottom timeline. Wiki creation/editing, Canvas merge/split curation, state annotations, live exploration progress, and the design comparison workbench are implemented. A packaged Studio owns an embedded production Host, opens its last selected or default Application Support Workspace, and can switch Workspace folders from the File menu; environment-provided Host credentials remain an explicit development integration. Validation/build-diff screens, sync/history, and Agent activity surfaces remain follow-up work; `apps/studio-macos/README.md` tracks the exact implemented surface.

Studio distribution remains outside the product-layer boundary: a release tool assembles the SwiftPM executable into a Universal app, embeds pinned architecture-specific Node.js and production Host runtimes plus the pinned Sparkle updater, and produces ZIP/DMG artifacts. The GitHub workflow requires a strictly newer semantic version, Developer ID signing, Apple notarization, and a signed update archive and feed. It publishes the GitHub Release before atomically switching the public GitHub Pages feed, so the feed never points at draft assets; the workflow refuses to replace an already published release. Local ad-hoc packaging and a real packaged-app launch/clean-quit loop are verified; the first credentialed old-to-new installed update remains release acceptance.

### 2.6 Design review and UI tuning

Designers must be able to open a real Screen State from a device, build, Canvas, or Deep Wiki and compare it with a design reference or approved build baseline.

The implemented review foundation includes:

- side-by-side, overlay, opacity-slider, and pixel-diff comparison;
- mapping between design regions and runtime UI nodes;
- frame, alignment, spacing, font, color, corner, border, shadow, and alpha comparison;
- review across device sizes, theme, language, and text scaling;
- screenshot and node annotations;
- Review Issue ownership, severity, state, evidence, and verification history;
- re-verification against a later build.

The implemented tuning foundation includes:

- preview allowlisted visual-property changes in a Debug/Internal application;
- display source value and preview value separately;
- group changes into a reversible `TuningPatch`;
- export a patch as an engineering suggestion or Coding Agent input;
- verify that a later source-code change preserves the approved preview result.

Tuning must never become arbitrary runtime method execution.

### 2.7 Screen State Canvas and Deep Wiki

The global Canvas contains Screen States and Transitions:

```text
Home
├── tap Search -> Search
│   └── submit Query -> Results
│       └── tap Result -> Detail
├── tap Avatar -> Profile
└── tap Messages -> Inbox
```

Individual View and Layer nodes belong inside a selected Screen State Inspector.

Each Screen State may link to:

- screenshot and Runtime Snapshot;
- View/Semantics Tree and Layer Tree;
- controller, activity, fragment, and route;
- interactive nodes and transition paths;
- build, device, account, environment, and feature context;
- design reference, review issues, and tuning patches;
- validation failures and build differences;
- tests, requirements, source components, and documentation.

The Deep Wiki is not just a canvas. It must be persistent, searchable, linked, versioned, traceable, reusable, and collaborative.

### 2.8 Native Demo Apps

Vistrea includes canonical native Demo Apps for iOS and Android. Both applications implement all 17 required shared Scenario IDs and act as executable contract fixtures, not marketing samples. The `demo.navigation.basic` Runtime Snapshot path is verified end to end on iOS UIKit and Android View; Runtime events, reversible tuning, basic real-input automation, state identity, exploration, dangerous-action confirmation, and the Storefront-deep walk are verified on both platforms. The iOS acceptance also proves real search clearing and overlay dismissal; `examples/scenarios/manifest.json` records the authoritative per-platform capability status for the remaining scenario contracts.

Both applications must implement the same required Scenario IDs for:

- navigation and path recording;
- form input and validation;
- transient success feedback;
- loading, success, failure, and retry;
- modal presentation;
- layout occlusion and clipping;
- accessibility defects;
- design comparison and reversible tuning;
- dynamic content normalization;
- dangerous-action blocking;
- new-feature and regression build diff.

UIKit and View/ViewGroup are the implemented initial adapters. SwiftUI and Compose scenarios are explicit later adapters. Platform-specific scenarios use namespaced IDs and never replace the shared core set.

## 3. Core model

### Runtime models

- `Build`: an installable application build and source revision context.
- `Session`: a connected capture or exploration session.
- `RuntimeSnapshot`: synchronized application UI state at a precise time.
- `UiNode`: a normalized semantic runtime UI node.
- `ScreenState`: a user-perceived page or meaningful page state.
- `Action`: an intended real user operation.
- `Transition`: an observed state change caused by an Action.
- `Event`: a transient runtime change such as toast, banner, loading, or dialog lifecycle.
- `Artifact`: screenshot, short video, log, trace, design asset, or validation evidence.
- `Observation`: immutable evidence that a state, transition, event, or artifact was seen under a specific context.

### Design collaboration models

- `DesignReference`: a design artifact or approved build baseline mapped to runtime state and nodes.
- `ReviewIssue`: expected versus actual values, evidence, owner, state, and verification history.
- `TuningPatch`: reversible visual-property overrides with original and preview values.

### Knowledge and version models

- `WikiNode` and `WikiLink`: persistent knowledge and backlinks.
- `Commit`: immutable version manifest referencing graph, wiki, design, review, and object roots.
- `Ref`: mutable name pointing to a Commit, such as a team mainline, build, baseline, or user draft.
- `ObjectRef`: content hash and metadata for a stored artifact.

## 4. Exploration model

Vistrea uses a semantic-first, vision-assisted loop:

```text
Read SDK semantic state
-> choose a safe actionable node
-> perform a real WDA/UIAutomator action
-> capture new Snapshot, events, and screenshot
-> identify or create Screen State
-> record Transition and Observation
-> restore or continue
```

The initial implementation may use deterministic BFS/DFS. AI is most useful for business meaning, valuable-path selection, form input, custom-drawn regions, and anomaly explanation.

### Screen State identity

A full text or screenshot hash is insufficient because runtime data changes continuously. Identity should combine:

- route or controller/activity identity;
- stable node set;
- normalized layout structure;
- interactive node roles;
- selected semantic state;
- perceptual screenshot features;
- explicit environment dimensions.

Dynamic fields such as time, balance, username, and feed content require normalization.

### Transient states

Pre-action and post-action screenshots miss short-lived UI. Vistrea combines:

- SDK view/event lifecycle capture;
- short high-frequency sampling after actions;
- lightweight visual change detection;
- device-side video ring buffer;
- failure-window video preservation.

AI reads structured events and key frames by default, not continuous full video.

### Safety

Exploration must protect against payment, deletion, message sending, publishing, account changes, external side effects, and other irreversible actions.

Safety controls include environment isolation, test accounts, explicit action policy, maximum depth and duration, reset strategies, and human confirmation points.

## 5. Validation

All validators consume the same Runtime Snapshot and graph evidence.

### Structural

- existence, visibility, and interaction state;
- occlusion, clipping, and out-of-screen placement;
- minimum hit area;
- invisible interaction interception;
- missing or duplicate stable IDs;
- abnormal View/Layer relationships.

### Visual and design

- screenshot or regional diff;
- truncation, overlap, misalignment, spacing, typography, color, and decoration;
- dark mode, screen size, text scaling, language, and theme;
- visual region versus interaction region;
- design reference or approved build consistency;
- Review Issue resolution and Tuning Patch fidelity.

### Behavioral

- expected state after action;
- path reachability and back behavior;
- toast/dialog timing;
- loading timeout;
- dead-end or unrecoverable states.

### Accessibility

- missing label, role, ID, or content description;
- focus order;
- hit area;
- mismatch between visual and accessibility nodes.

### Build diff

- added, removed, or unreachable Screen States;
- Transition changes;
- View/Layer structure changes;
- layout, screenshot, and hit-region changes;
- new validation failures;
- broken critical paths.

## 6. Local-first Data Layer and versioning

The Deep Wiki experience is Obsidian-like, but the physical storage is hybrid:

- SQLite metadata and relationships;
- content-addressed object files for screenshots, video, complete Snapshots, design assets, and logs;
- Git-like Vistrea Commit/Ref semantics;
- generated Markdown/HTML for reading and exchange;
- rebuildable search, thumbnail, and embedding caches.

Git remains suitable for schemas, source-controlled rules, small manifests, and exported documentation. It is not the runtime artifact database.

Observations are immutable. A Screen State Graph for a build and environment is materialized from relevant observations. This allows Vistrea to distinguish removal from incomplete exploration and to compare builds without destroying history.

See `docs/architecture/DATA_LAYER.md` for the detailed storage and sync design.

## 7. Cross-team sharing

Vistrea Hub is an optional remote coordination layer.

It provides:

- organization, team, and project namespaces;
- shared commits and refs;
- content-addressed object transfer;
- publish, subscribe, push, and pull;
- RBAC, auditing, retention, and redaction policy;
- organization-wide search and stable deep links;
- review and tuning collaboration.

Teams publish versioned knowledge collections rather than sharing a mutable SQLite folder. Local Workspaces remain usable offline and cache subscribed content.

## 8. Coding Agent integration

Vistrea exposes the same Engine use cases through:

- CLI for deterministic local, script, CI, and Agent operations;
- Skills for task-oriented workflows composed from the CLI or local APIs;
- CI for repeatable build validation;
- deep links for exact projects, states, commits, issues, and artifacts.

Public commands, queries, events, errors, and lifecycle behavior are specified under `docs/interfaces/`. Studio workflows map to those same use cases under `docs/product/STUDIO_INTERACTIONS.md`.

The implemented Agent slice exposes 65 Host operations — Workspace status, Snapshot capture and inspection, Runtime event timelines, design review and acceptance, reversible tuning, the Screen Graph, exploration Operations, Wiki nodes and Collections, immutable publication, readable export, validation, build diffs, portable packs, and object downloads — through one authenticated Host Local API client. The strict JSON CLI (with named toolset focus through `VISTREA_CLI_TOOLSETS`), the Skills, the installable Claude Code plugin, and the headless CI gate consume that same client without accessing SQLite or artifact paths. ADR-0008 retired the stdio MCP server in favor of the single CLI adapter; `docs/interfaces/OPERATION_CATALOG.md` is the authoritative operation inventory.

Additional Skill concepts:

- explore a bounded UI area and update the Deep Wiki;
- review a Screen State against a design baseline;
- tune allowlisted visual properties and produce a patch;
- verify a source change against affected paths and baselines.

## 9. Security and boundaries

Initial scope:

- authorized native iOS and Android applications;
- Debug/Internal/Test variants;
- local macOS Studio;
- local-first Workspace;
- semantic structure with screenshot evidence;
- optional organization-controlled Hub.

Do not promise by default:

- SDK-free internal inspection of arbitrary third-party applications;
- internal structure of system UI or other processes;
- replacement of production APM or server tracing;
- unrestricted business actions;
- automatic semantic recovery from all custom rendering.

Required controls:

- Release exclusion or strong signed authorization;
- sensitive-field redaction;
- tuning-property allowlist;
- reversible preview with source/preview distinction;
- artifact access, retention, and deletion policy;
- Hub RBAC and audit;
- no arbitrary method-execution endpoint.

## 10. Repository modules

```text
vistrea/
├── protocol/          # canonical cross-platform models and fixtures
├── sdks/              # iOS and Android Runtime SDKs and Inspectors
├── engine/            # reusable application and domain logic
├── data/              # Data API and local-first storage/sync implementations
├── apps/              # Vistrea Studio and future user-facing applications
├── services/          # optional Vistrea Hub and organization services
├── integrations/      # CLI, Skills, Claude Code plugin, CI
├── examples/          # cross-platform scenarios and native Demo Apps
├── tests/             # cross-module contract, integration, and E2E tests
├── tools/             # generation, validation, and repository tooling
└── docs/              # product, architecture, decisions, and roadmap
```

See `docs/REPOSITORY_STRUCTURE.md` for ownership and dependency rules.

## 11. Delivery roadmap

Phase markers summarize the current boundary status; `docs/DEVELOPMENT_PROGRESS.md` records the exact per-workstream truth and verification evidence.

### Phase 0: contracts and local data foundation — verified

- Core runtime, design, version, and object models are verified as protocol v1 schemas and fixtures.
- Common, Runtime connection, automation, Engine, Data, Agent, and Hub interfaces are documented.
- The language-owned Data API, in-memory reference adapter, SQLite metadata, content-addressed local Object Store, and Commit/Ref persistence are verified.
- Portable full and thin `.vistrea-pack` export/import and immutable Knowledge Collection publication with readable Markdown/HTML exports are verified over the shared Commit and ObjectRef identity.

### Phase 1: native Snapshot loops — verified for UIKit and Android View

- Both native Demo Apps implement the required shared Scenario IDs.
- Real UIKit and Android View adapters capture canonical Runtime Snapshots and PNG evidence.
- Protected Runtime clients connect to the production macOS Host.
- Snapshot Studio renders screenshot, tree, node, and source context.
- SQLite metadata and content-addressed objects persist and reopen the identical Snapshot.
- CLI reads the same persisted result; platform implementation remains in progress beyond Snapshot and connection capabilities.

### Phase 2: SDKs, Inspector, and design workflow — verified

- platform adapters and in-app Inspector;
- transient event capture;
- design reference import and overlay;
- Review Issues;
- allowlisted tuning and reversible Tuning Patches.

Runtime events and reversible alpha/color/font/spacing/insets/corner-radius tuning are implemented on both native platforms, and the Studio design comparison and tuning workbenches are implemented. Design acceptance can promote a captured screenshot into a content-addressed approved-build baseline, compare mapped regions with per-pixel metrics, promote a Difference directly into an Issue, generate source-oriented Coding Agent suggestions from a Tuning Patch, and recapture/re-verify a ready Issue. Compose supplies its full semantics tree; SwiftUI remains an accessibility-element bridge whose content is observable only while an accessibility runtime is active.

### Phase 3: exploration and Deep Wiki — core verified on both platforms

- WDA/UIAutomator execution;
- deterministic exploration;
- state identity, deduplication, recovery, and safety;
- Canvas, paths, backlinks, search, and version history.

The basic real-input automation, dangerous-action confirmation, and raised Storefront-deep exploration acceptances have passed on both platforms. Both providers implement `clear_text` and targeted/targetless `dismiss`; the iOS lane verifies clear and targeted dismiss through fresh structural captures. Exploration relaunches after a lost Runtime capture, replays the known stable-ID path, validates every restored structural state, and retries inside the original action budget. That recovery is integration-verified; deliberate real-device crash injection remains follow-up acceptance work.

### Phase 4: validation and advanced inspection — implemented

- structural, design, visual, behavioral, and accessibility rules;
- build graph and Snapshot diff;
- 3D View/Layer Inspector;
- failure evidence replay.

### Phase 5: expanded Agents and Vistrea Hub — implemented for the local surface

- extend the initial Snapshot CLI and Skill adapters to all stable Engine use cases;
- affected-subgraph verification;
- Hub push/pull, team spaces, permissions, discovery, and collaboration.

The Agent adapters cover all 65 implemented Host operations through one strict JSON CLI, with a machine-readable operation manifest enforcing Host/CLI/catalog parity. An optional multi-project Hub pack relay serves fast-forward push and fetch over loopback or TLS with per-project read-write and read-only tokens; user-facing sync, team spaces, auditing, richer permissions, discovery, and collaboration remain future Hub work.

## 12. First complete demonstration

A meaningful first complete demonstration should:

1. connect a canonical native Demo App through a Runtime SDK;
2. inspect and select a runtime node in-app;
3. display synchronized screenshot and node structure in Studio;
4. perform a real device automation action;
5. capture before/after Snapshots and transient events;
6. persist and reopen the session from a local Workspace;
7. generate a small Screen State Canvas and path history;
8. compare one state with a design reference and create a Review Issue;
9. preview and revert at least one allowlisted visual change;
10. save a Tuning Patch and verify it against a later capture;
11. run at least one validator and one build diff;
12. export a portable `.vistrea-pack`.

## 13. Open decisions

- dynamic-field normalization beyond the current structural Screen State identity;
- initial design source: image, local file, Figma, or approved build;
- design-to-runtime node mapping strategy;
- physical-device acceptance for every broader tuning adapter/property combination;
- automatic physical-iPhone discovery/forwarding beyond the accepted explicit
  CoreDevice/operator IP and pinned-TLS authorization profile;
- hierarchy-depth 3D versus native View/Layer tree inspection;
- packaging and distribution for the macOS Studio and native SDK artifacts;
- Hub deployment, identity, permissions, and storage providers.

These choices may evolve without changing the central definition: Vistrea connects runtime structure, design review and tuning, real exploration, versioned knowledge, validation, and Agent workflows around one shared application UI fact base.
