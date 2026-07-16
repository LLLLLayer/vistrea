# Vistrea Studio for macOS

The desktop workspace for Host and Runtime connection, Snapshot inspection, the Screen State Canvas, the Deep Wiki, design review, exploration runs, Debug Runtime UI tuning, and optional Hub collaboration.

The design-acceptance stack remains implemented and tested behind Engine and Host contracts, but its dedicated workbench is intentionally absent from the default Inspector. Dedicated Coding Agent operation review and the broader versioned Hub collaboration editors remain product follow-ups.

The native SwiftUI workspace is a standalone Swift Package. Its window follows the product interaction design: a persistent context bar on top with an **Application + Version (build) scope picker** — the scopes are derived from the distinct runtime contexts across the persisted Snapshots, and the only scope is selected automatically in the common single-application case — plus the independent Host/Runtime status and the Capture entry; a left navigation column with six sections (**Canvas**, **Evidence**, **Documents**, **Wiki**, **Quality**, **Hub**); and a collapsible **Timeline** strip along the bottom. Documents, Quality, and Hub remain reachable in an empty Workspace. The Screen State Canvas is the landing surface for the selected scope: it loads as soon as the scope is chosen, before any Snapshot is clicked. Selecting a state on the Canvas opens its **single-screen Inspector** as the main right-hand experience — screenshot and 3D evidence above the 2D view tree beside **one scrollable state context column**: the Screen State's persisted fields, its annotations (labels and summary), observations and curation actions, knowledge links, the Runtime Context of the state's canonical observation Snapshot, the selected node's properties with the tuning entry, and the Review Issues — one column, no stacked duplicate panels. All runtime evidence is driven by that state's canonical observation Snapshot resolved through the Host, not by a sidebar capture list. The flat Snapshot list survives as the secondary Evidence library section.

The Inspector layout is responsive. Every structural width lives in `StudioLayoutMetrics` (VistreaStudioCore), including the window minimum, so the panes and the window floor stay provably consistent. Labeled context values truncate in the middle with the full value in a tooltip instead of clipping at the window edge, and when the Inspector's actual width drops below `StudioLayoutMetrics.inspectorSideBySideMinWidth` the context column collapses behind a header **Context** toggle: the Inspector then shows the evidence panes or the context column one at a time rather than painting outside its bounds.

It currently provides:

- packaged-app ownership of an embedded loopback Host plus a VS Code-style Workspace entry: Studio restores the last available Workspace, otherwise opens a Welcome surface with recent locations, explicit **New Workspace…** and **Open Workspace…** actions, missing-location recovery, and a return path to the still-open current Workspace. The File menu mirrors New/Open/Open Recent/Manage/Reveal/Close, the window and context bar show the current Workspace, and registered `.vistrea` directory packages can reopen through Finder. Recent preferences contain only canonical paths and last-opened times; source-built `swift run` keeps the canonical fixture mode unless explicit external Host credentials are supplied;
- a Hub collaboration section that connects an HTTPS origin (or loopback HTTP), canonical Project ID, selected canonical refs, and a session-only bearer token through the managed local Host; it displays the effective direct/inherited identity, team-visible projects, local/remote ref relations, fast-forward fetch/push outcomes, explicit divergence conflicts, and a cursor-polled safe activity feed. URL, Project ID, and refs may persist as form preferences; the bearer token never enters `UserDefaults`, command arguments, logs, or response models and is forgotten on disconnect or process exit;
- independent Host and Runtime connection status in the context bar;
- an Application Version + Build scope picker deriving its choices from the listed Snapshot runtime contexts; selecting a scope sends all four scope fields to the Host, filters the Canvas through its build projection and the Evidence library locally, and a refresh never yanks a still-available scope selection;
- a demoted Snapshot Evidence library (per scope) as a secondary navigation section;
- a read-only Project Documents browser that associates each Workspace with one local source checkout, reads repository-owned Markdown roots from `vistrea.project.json` (falling back to `README.md` and `docs/`), filters by title/path/source, previews rendered or source Markdown, and never imports those files into SQLite or the Deep Wiki;
- selected Snapshot identity and canonical `vistrea.scenario_id` context;
- canonical Runtime Snapshot decoding through `VistreaRuntimeModels`;
- screenshot Object loading with explicit missing-object placeholders;
- iterative reconstruction of canonical flat UI nodes into a View Tree outline;
- node selection and canonical property details;
- a collapsible bottom Timeline strip with the persisted Runtime events in newest-first order, transient payload summaries, and the Host event-pump state from `GET /v1/status` (its epoch, persisted sequence, and error code in the tooltip) — events are timeline evidence, not a sidebar destination;
- a Review Issues panel listing only issues whose runtime target belongs to the selected Screen State, with lifecycle state, severity, and category most recently updated first; with no selected state it is deliberately empty rather than falling back to application-wide issues;
- the Screen State Canvas as the landing surface, rendering the materialized Screen Graph with a deterministic layered layout: entry states in the first column, breadth-first depth columns, unreachable states last, and observed cross-state transitions drawn as directional edges. The viewport supports native two-finger panning with momentum, pinch magnification anchored under the gesture, mouse background panning, explicit center-anchored zoom controls, local card repositioning, and reset-to-fit without writing presentation coordinates into Screen State identity. Zoom is layout-driven instead of scaling a composited text layer: Fit never enlarges beyond 100%, final positions snap to the display backing scale, and cards progressively reduce secondary detail at low zoom. Selecting a state enumerates bounded cycle-free routes from every recorded entry, lets the operator choose a concrete route when alternatives exist, and highlights only that route's states and transitions while preserving the Inspector selection;
- a single-screen Screen State Inspector: clicking a Canvas state resolves the state's build-local `canonical_snapshot_id` through the Host and drives the screenshot, 2D tree, node properties, and 3D layers from that observation Snapshot; a canonical Snapshot that no longer resolves is an explicit Inspector failure;
- a 3D Layer Inspector exploding the captured hierarchy into depth-ordered SceneKit layers with camera control. Each layer is textured with the node's real pixels: the logical frame maps through the screenshot coverage and pixel scale into a clamped raster crop. The selected node gets a subtle accent tint; a node outside the covered region keeps a neutral placeholder; and a Snapshot without screenshot bytes (the fixture intentionally ships none) degrades to the role-colored placeholder boxes under an honest caption — pixels are never fabricated;
- a Deep Wiki section searching persisted knowledge nodes by text with kind, status, and label facets;
- Knowledge Collection management beside Wiki nodes: create or revise an exact member set and explicit entry-node subset, search Collections, inspect publication state and revision, and preserve the revision from the beginning of an edit so concurrent writes conflict and reload instead of being silently absorbed;
- a visual tuning preview in the node-details pane for alpha, foreground/background color, font, spacing, and corner radius. Each editor creates a canonical single-change Tuning Patch bound to the selected node and Snapshot, shows applied versus rejected changes with canonical reason codes verbatim, and lists active previews with per-row Revert. Captured properties prefill their real source values; spacing requires an explicit observed original and the Runtime rejects a mismatch. The capability is protected on the server side, not by a Studio build flag: a Host without an authorized Debug Runtime returns HTTP 503 `unavailable`. Release protection belongs to the Runtime SDKs and Host;
- source-oriented handoff for the latest persisted Tuning Patch: Studio requests canonical Coding Agent instructions, shows mapped source context when available, and explicitly reports `needs_source_mapping` without inventing a file path;
- a Quality workspace with Snapshot and Screen Graph validation, exact Finding counts, Finding inspection and justified optimistic-concurrency suppression, plus same-project/application Build Diff across two observed builds. A single-build Workspace gets an explicit two-build requirement instead of fabricated comparison evidence;
- Review Issue lifecycle and acceptance: selecting an issue loads its persisted revision and offers only the legal target states from the canonical lifecycle (`open`, `in_progress`, `ready_for_verification`, `resolved`, `wont_fix`) with an optional reason; a ready issue exposes **Recapture and Verify**, which asks the Host to capture a different real build, rerun the comparison, persist immutable verification evidence, and return the resulting Issue state. The new Snapshot joins the Evidence library and scope picker without silently changing the Inspector's current selection; optimistic-concurrency conflicts reload the issue and show a changed-elsewhere note;
- Deep Wiki editing: a New node sheet (schema kind picker, title, summary, Markdown) and a per-node Edit sheet that loads the full node, revises it guarded by `expected_revision`, and offers only legal status transitions; conflicts reload the node and show a changed-elsewhere note;
- Canvas Screen State details: the Inspector's context column shows the state's persisted title, kind, status, first/last seen, and canonical Snapshot ID, shows how many observations the state deduplicates, lists the Wiki nodes already linked to it, and can create a `relates_to` Wiki link to the state;
- Screen State annotations: Canvas cards render the state's annotation labels as small chips with the summary as a secondary line, and the Inspector context column shows them prominently with an inline **Edit annotations** editor (a comma-separated label field and a summary field with a live 280-character counter). The write posts `POST /v1/screen-graph/state-annotations` guarded by the graph revision the edit **began** against — captured when the editor opens, exactly like merge and split — so a background reload conflicts with the changed-elsewhere note and re-arms after the reloaded graph is shown, instead of laundering a concurrent change into the edit. Emptying the labels field submits the empty array and emptying the summary submits the empty string: both explicitly clear that field on the state;
- a Canvas Explore entry driving the Host's background exploration Operation: a small form (maximum actions, settle milliseconds, excluded stable IDs) starts the run and a status line polls the Operation once per second. The poll loop belongs to the run, not to the visible tab: switching tabs keeps the progress line, the report, the automatic Canvas refresh, and Cancel alive. Cancel stays reachable for as long as the Host has not settled the Operation — including after a rejected start — so a started exploration can never be orphaned. A succeeded run shows the report summary (states discovered, actions, stop reason) and reloads the Canvas graph; failed, cancelled, and `unsupported` Hosts (no automation provider, HTTP 501) surface the error code and message verbatim with the controls re-enabled;
- Canvas identity curation: Cmd-click multi-selects active Screen State cards, a Merge sheet picks the survivor (defaulting to the first selection) with an optional justification; the state-details panel offers a Split sheet that lists the state's observation IDs and moves a strict subset (at least one moved, at least one left behind) into a new state with an optional title and justification. Both writes are guarded by the `graph_revision` the decision **began** against — captured when the sheet opens, not read at submit time — so a background reload (a refresh, or the automatic reload after an exploration succeeds) can never launder a concurrent change into the decision: a stale decision takes the same changed-elsewhere path as an HTTP 409 `conflict` from the Host, and the survivor is revalidated against the current selection before anything is posted. Merged tombstones render dimmed with their status, are excluded from selection, and report their real status when a split is attempted on them;
- an implemented Design Review workbench kept out of the default Inspector by `StudioFeaturePolicy.designReviewVisibleByDefault == false`; its Design Reference, comparison, Difference promotion, and verification models, Host routes, CLI operations, fixtures, and tests remain intact so restoring the product surface does not require rebuilding the capability;
- loading, empty, detail-error, connection-error, capture-error, and write-conflict states;
- a capture action over the Host Local API;
- a canonical fixture-backed development mode when no Host is configured, including in-memory fixture implementations of every write flow above.

Writes that the Host contract stamps with the Studio actor `{"kind": "human", "id": "studio"}` are: Review Issue transitions (`changed_by`), Difference promotion (`created_by`), fresh-build verification (`verified_by`), Wiki node and Knowledge Collection creation (`created_by`), Wiki node and Collection revisions (`updated_by`), Wiki links (`created_by`), Tuning Patch creation (`created_by`), Finding suppression (`created_by`), Screen State merges (`merged_by`), splits (`split_by`), and annotations (`annotated_by`), and design comparisons (`completed_by`). Hub fetch/push uses the separate canonical actor `{"kind": "human", "id": "vistrea-studio", "extensions": {}}`. Capture, validation runs, Build Diff, tuning apply and revert, and exploration run and cancel carry no actor field in the current Host contract.

Runtime product presentation depends on the `HostClient` abstraction and does not access SQLite, Object Store paths, or Runtime transports directly. The application composition root alone selects the user-visible Workspace folder and owns the embedded Host process. Project Documents are a deliberate read-only workspace-shell surface: `StudioProjectDocumentLibrary` owns bounded source-project filesystem access and gives SwiftUI immutable summaries and Markdown content; it never reads or constructs Vistrea artifact paths. Reusable product behavior remains in `engine/`, while storage implementations remain in `data/`.

## Package and update

The SwiftPM executable is the development source of truth. The release helper
builds both supported architectures, assembles `Vistrea Studio.app`, embeds
architecture-matched pinned Node.js 22.14.0 runtimes, the emitted production
Host, exact protocol and migration resources, and the exact Sparkle dependency,
then signs nested code in dependency order and produces ZIP and DMG archives:

```bash
pnpm build:host
tools/release/package-studio-macos.sh \
  --version 0.1.0 \
  --build-number 0.1.0 \
  --output-dir /tmp/vistrea-studio-release
```

Packaging starts the embedded Host against a temporary Workspace, performs an
authenticated status request, and repeats that probe after signing to verify
clean descriptor and lock removal. That local path is ad-hoc signed, uses a
local-only library-validation exemption for its Team-ID-less components, and
intentionally has no update feed. A
`studio-vX.Y.Z` tag drives the public GitHub workflow, which fails closed unless
Developer ID, notarization, and Sparkle signing credentials are configured. A
packaged public app exposes **Vistrea Studio > Check for Updates…**; `swift run`
does not create an updater because it has no release Info.plist metadata.

See [the macOS release runbook](../../docs/release/STUDIO_MACOS_RELEASE.md) and
[ADR-0009](../../docs/decisions/0009-direct-macos-distribution.md).

## Run with the canonical fixture

From the repository root:

```bash
swift run --package-path apps/studio-macos VistreaStudio
```

The app locates `protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json`. Override the path only when running outside the repository checkout:

```bash
VISTREA_FIXTURE_PATH=/absolute/path/to/ios-uikit.json \
  swift run --package-path apps/studio-macos VistreaStudio
```

`FixtureWorkspace.makeClient(snapshot:)` composes that Snapshot with a deterministic in-memory Workspace: a materialized Screen Graph (three active states, two of them mergeable, the entry state carrying two observations so a split is possible), two Deep Wiki nodes, one open Review Issue, and a design baseline minted from the Snapshot's own screenshot Object. Every local read pane and local write flow above is reachable without a Host — the Canvas, Collection editing, source handoff, and validation included — except Hub collaboration, which requires the managed production Host, and fresh-build recapture. Build Diff also requires a second explicitly supplied build. Fixture mode never invents either acceptance or comparison evidence.

The fixture intentionally contains screenshot Object metadata without bundling the binary. The default Inspector displays an honest missing-object evidence placeholder rather than inventing screenshot bytes. The retained Design Review model tests additionally prove that its hidden overlay degrades to inline text and a requested pixel comparison reports the canonical `unavailable` verdict.

## Run against the Host Local API

Every Host route requires an independent bearer token:

```bash
VISTREA_HOST_URL=http://127.0.0.1:47831 \
VISTREA_HOST_TOKEN=replace-with-the-43-character-base64url-token \
  swift run --package-path apps/studio-macos VistreaStudio
```

The client accepts only literal `http://127.0.0.1` and `http://[::1]` endpoints plus the fresh 43-character base64url token returned by that Host start. Hostnames, HTTPS, remote addresses, and arbitrary bearer strings fail closed.

The adapter consumes these frozen local endpoints:

- `GET /v1/status`
- `GET /v1/snapshots`
- `GET /v1/snapshots/:id`
- `GET /v1/objects/:hash`
- `POST /v1/captures`
- `GET /v1/events`
- `GET /v1/review-issues` and `GET /v1/review-issues/:id`
- `POST /v1/review-issues/:id/transitions`
- `POST /v1/design-comparisons/:id/issues`
- `POST /v1/review-issues/:id/recapture-verifications`
- `POST /v1/tuning-patches`
- `GET /v1/tuning-patches/:id/source-suggestions`
- `POST /v1/tuning-applications`, `POST /v1/tuning-applications/:id/revert`, and `GET /v1/tuning-applications/active`
- `GET /v1/screen-graph` and `GET /v1/screen-states/:id`
- `POST /v1/screen-graph/state-merges`, `POST /v1/screen-graph/state-splits`, and `POST /v1/screen-graph/state-annotations`
- `GET /v1/design-references` and `GET /v1/design-references/:id`
- `GET /v1/design-comparisons` and `POST /v1/design-comparisons`
- `GET /v1/wiki/nodes`, `POST /v1/wiki/nodes`, `GET /v1/wiki/nodes/:id`, and `POST /v1/wiki/nodes/:id/revisions`
- `GET /v1/knowledge-collections`, `POST /v1/knowledge-collections`, `GET /v1/knowledge-collections/:id`, and `POST /v1/knowledge-collections/:id/revisions`
- `POST /v1/wiki/links` and `GET /v1/wiki/related`
- `POST /v1/exploration/operations`, `GET /v1/exploration/operations/:id`, and `POST /v1/exploration/operations/:id/cancel`
- `POST /v1/validation/snapshot-runs`, `POST /v1/validation/graph-runs`, and `GET /v1/validation/runs/:id`
- `GET /v1/validation/findings` and `POST /v1/validation/findings/:id/suppress`
- `POST /v1/validation/build-diffs` and `GET /v1/validation/build-diffs/:id`
- `POST /v1/sync/status`, `POST /v1/sync/fetch`, `POST /v1/sync/push`, and `POST /v1/sync/activity`

Canonical Runtime Snapshot responses use the strict shared decoder. Host envelopes also reject unknown core fields.
URLSession streams into bounded buffers before decoding: JSON responses are capped at 64 MiB and Object responses at 256 MiB. Full Object reads verify `ETag`, `Content-Length`, and SHA-256; byte ranges verify `ETag`, `Content-Length`, canonical `Content-Range`, and exact body length.

## Verify

```bash
swift test --package-path apps/studio-macos
swift build --package-path apps/studio-macos --product VistreaStudio
```

See [Studio interaction design](../../docs/product/STUDIO_INTERACTIONS.md) and [Engine use cases](../../docs/interfaces/ENGINE_API.md).

`VistreaStudioAcceptanceProbe` is a non-UI end-to-end verifier used by the real
iOS and Android vertical acceptances. `StudioCoreAcceptanceWorkflow` drives the
production `SnapshotWorkspaceModel` through Host/Runtime status, build scopes,
the Evidence library, canonical Snapshot and screenshot, Canvas and entry state,
Review Issues, Runtime events, Deep Wiki, active tuning, and design references.
The probe fails closed if the expected Snapshot, screenshot integrity, Canvas,
or any supporting pane is unavailable; it emits the resulting evidence as
strict JSON before the native window launch smoke test. Credentials and the
expected Snapshot ID are accepted only through environment variables; output
contains evidence identity and counts, never credentials.
