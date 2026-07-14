# Vistrea

Vistrea is a local-first runtime UI knowledge, design review, tuning, exploration, and verification platform for native iOS and Android applications.

It combines in-app runtime SDKs, real device automation, a macOS workspace, a versioned Deep Wiki, design review workflows, and Coding Agent integrations around one stable Runtime Snapshot protocol.

## Product surfaces

- iOS and Android Runtime SDKs
- In-app UI Inspector for internal builds
- Vistrea Studio for macOS
- Runtime UI exploration through WDA and UIAutomator
- Screen State Canvas and versioned UI Deep Wiki
- Design baseline comparison and review issues
- Reversible Debug-only UI tuning
- 2D View Tree and Lookin-style 3D Inspector
- Structural, visual, behavioral, accessibility, design, and build-diff validation
- CLI, Skills, Claude Code plugin, and CI integrations for Coding Agents
- Optional Vistrea Hub for cross-team sharing

## One-line definition

> Vistrea lets designers, developers, QA engineers, and Coding Agents explore, review, tune, verify, and retain knowledge about the same native application runtime UI.

## Architecture at a glance

```text
Studio / CLI / Skills / CI
                 |
                 v
        Reusable Host Engine
                 |
                 v
             Data API
          /             \
Local Workspace      Vistrea Hub

iOS / Android SDK ---- Runtime Snapshot Protocol
WDA / UIAutomator ---- Real user interaction
```

The SDK observes and describes application state. Device automation performs real interactions. The Data Layer isolates all product surfaces from SQLite, files, object storage, version history, and synchronization details.

## Contract-first implementation

Vistrea is designed for parallel implementation behind stable interfaces:

```text
Runtime SDK <-> Host Connection
Automation Provider <-> Automation Engine
Studio / CLI / Skills <-----> Engine Use Cases
Engine <-> Data API <-> Local Workspace / Hub Sync
```

The interface specifications define shared IDs, errors, operation behavior, SDK transport semantics, device actions, Engine commands and queries, Data ports, Agent surfaces, and Hub synchronization. Protocol v1 is executable as JSON Schema and canonical fixtures. The current implementation uses a Node.js/TypeScript Host and Data stack, Swift packages for iOS and Studio, and Gradle/Kotlin modules for Android without changing those language-neutral boundaries.

## Native Demo Apps

The native iOS UIKit and Android View Demo Apps implement the same 17 required cross-platform Scenario IDs. Both provide a verified `demo.navigation.basic` Runtime Snapshot loop through the SDK connection, Host, Studio presentation, SQLite metadata, and content-addressed screenshot storage, plus verified Runtime events, reversible tuning, real-input automation, dangerous-action confirmation, and the deeper Storefront exploration acceptance. The iOS lane additionally proves real `clear_text` and targeted `dismiss` with post-action structural captures. Compose contributes its full semantics tree, while SwiftUI element capture remains accessibility-runtime dependent. Design comparison and validation scenario coverage remain staged, with `examples/scenarios/manifest.json` as the authoritative per-platform status.

- `examples/ios/VistreaDemoApp/`
- `examples/android/VistreaDemoApp/`
- `examples/scenarios/`

## Documentation

- [Project overview](docs/PROJECT_OVERVIEW.md)
- [Repository structure](docs/REPOSITORY_STRUCTURE.md)
- [Data Layer](docs/architecture/DATA_LAYER.md)
- [Executable Data model coverage](docs/protocol/DATA_MODEL_COVERAGE.md)
- [Interface specifications](docs/interfaces/README.md)
- [Studio interaction design](docs/product/STUDIO_INTERACTIONS.md)
- [Studio macOS release](docs/release/STUDIO_MACOS_RELEASE.md)
- [Development and multi-agent workflow](docs/DEVELOPMENT.md)
- [Development progress](docs/DEVELOPMENT_PROGRESS.md)
- [Documentation index](docs/README.md)

## Recommended implementation sequence

1. Add dedicated Studio controls for source suggestions and Knowledge Collection management; Difference promotion and fresh-build recapture verification are implemented.
2. Run the remaining Android adb physical vertical lane, extend the verified iOS pinned-TLS lane across the broader native tuning matrix, and strengthen the iOS Release artifact boundary.
3. Add real-device crash-injection acceptance and automatic native event observation before introducing AI-assisted exploration planning.
4. Add Hub organization/team inheritance, discovery, subscriptions, versioned
   collaboration mutations, and user-facing Studio sync on top of the verified
   project permission and audit Beta.

Parallel work should follow [the multi-agent workflow](docs/DEVELOPMENT.md) and use fixture-backed interfaces rather than private module models.

## Current status

Phase 0 is verified: the shared `DataUnitOfWork` surface has machine-readable JSON Schemas, 89 canonical fixtures, language-owned Data ports, an in-memory reference adapter, SQLite metadata, a file-backed content-addressed Object Store, portable full/thin `.vistrea-pack` exchange, and immutable Knowledge Collection publication with readable Markdown/HTML exports over the same Commit and ObjectRef identity.

The Phase 1 native Snapshot milestone is verified on both iOS UIKit and Android View, and Runtime event streaming plus protected reversible tuning of alpha, color, font, spacing/insets, and corner radius are implemented on both platforms. Device automation, deterministic exploration, dangerous-action confirmation, the Screen Graph, design acceptance, the Deep Wiki, core validation and build diff, and an optional Hub pack relay are implemented behind the same production Host. Design acceptance includes content-addressed approved-build baselines, real per-pixel region metrics, Difference-to-Issue promotion, Coding Agent source suggestions, and automatic real-build recapture/re-verification. The basic and raised Storefront real-input acceptances are verified on both platforms; iOS also has real structural verification for `clear_text` and targeted `dismiss`. Agents consume this surface through 65 Host operations exposed by the strict CLI, five Skills, an installable Claude Code plugin, and a headless CI gate. A machine-readable operation manifest and contract test keep Host, CLI, and interface documentation aligned. `docs/DEVELOPMENT_PROGRESS.md` records the exact per-workstream status and verification evidence.

The iOS physical-device vertical is verified on an iPhone 14 Pro running iOS
26.5: its exact-IP TLS 1.3 Runtime listener and leaf-certificate-pinned client
completed Snapshot capture, production Studio/CLI equality, Workspace reopen,
credential rotation, secret scanning, and deterministic app/resource cleanup.
The Android physical lane reuses the one-shot-token and `adb reverse` path and
remains implemented but hardware-unverified. Both lanes stay opt-in and fail
closed unless a specific physical device is supplied.

The optional Hub Beta now adds five project roles, named-principal rotating
tokens, a private append-only audit log, administrator permission/audit views,
and a safe cursor-paginated activity feed to the existing multi-project pack
relay. Administrators can grant, re-role, revoke, and rotate principals online;
private atomic role state survives restart while all plaintext tokens rotate.
The focused Hub suite and full Host gate verify these boundaries. Organization
and team inheritance, discovery, subscriptions, versioned collaboration
endpoints, and Studio sync remain follow-up work.

Vistrea Studio now has a verified local Universal `.app`, ZIP, and DMG packaging path with pinned Sparkle integration and a tag-driven GitHub release workflow. The application embeds architecture-matched Node.js and production Host runtimes, owns a default Application Support Workspace, and can switch Workspaces from its File menu, so a packaged app no longer depends on shell-provided Host credentials. The first real Developer ID notarization, GitHub Pages feed deployment, and installed old-to-new update remain credentialed release acceptance rather than completed product evidence.

Pull requests run six independent, immutable-revision CI jobs for Node/Host,
Studio, the iOS SDK, the iOS Demo App, the Android SDK, and the Android Demo
App. Device-backed end-to-end acceptance remains an explicit opt-in lane.

Run the current executable checks with:

```bash
pnpm install --frozen-lockfile
pnpm check
```
