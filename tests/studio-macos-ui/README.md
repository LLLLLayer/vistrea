# Vistrea Studio macOS UI regression

This XcodeGen project builds the production `VistreaStudioApp` sources as a
macOS application and drives them through an XCUITest bundle. It complements
the fast SwiftPM presentation and model tests with evidence from the real
macOS accessibility tree, keyboard event routing, and rendered application
window.

The target consumes the existing local `VistreaStudioCore` and
`VistreaStudioHostRuntime` package products plus the same exact Sparkle 2.9.4
release as the production SwiftPM executable. A minimal test-only `Info.plist`
gives the host a separate bundle identity, keeping its `UserDefaults` and
Launch Services registration isolated from an installed production Studio.
No UI, Engine, Host, or persistence behavior is copied into this test directory.

## Deterministic launch contract

The UI tests always pass one explicit process argument:

- `--ui-testing` opens the canonical in-memory Fixture Workspace directly on
  Canvas;
- `--ui-testing-welcome` opens an isolated Welcome surface with no recent
  Workspaces;
- `--ui-testing-canvas-empty` exposes the honest no-Screen-State presentation;
- `--ui-testing-canvas-error` exposes the retryable Screen Graph failure.

All modes use `VISTREA_FIXTURE_PATH` only to locate the checked-in canonical
Runtime Snapshot. They do not start the embedded Host, read or write the
operator's Workspace history, start Sparkle, restore a window frame, use Hub,
or connect to a device.

## Covered acceptance

- Welcome, New Workspace, Open Workspace, and Recent Workspaces AX contracts;
- Welcome to Workspace Manager to Back navigation, including the empty no-Host
  state that must not expose recovery-point, garbage-collection, or repair
  actions without an eligible Workspace;
- Command-1 through Command-6 navigation across Canvas, Evidence, Documents,
  Wiki, Quality, and the optional Hub entry surface;
- Canvas state selection, selected entry path presentation, and Inspector AX
  surfaces;
- Canvas drag-versus-selection isolation plus explicit empty and failure states;
- fixture-backed alpha tuning preview and explicit Revert;
- local Snapshot validation in Quality;
- full-window screenshot attachments for Welcome, Canvas, selected Inspector,
  active tuning, and Quality results.

The screenshots are retained in the `.xcresult` as reviewable interaction
evidence. Version-bucketed SwiftPM presentation tests separately enforce pixel
thresholds because macOS renderer output differs across OS, architecture, and
display scale. These UI tests verify real composition and interaction rather
than treating one machine's pixels as a portable baseline.

Every logical region identifier must resolve to exactly one AX element. SwiftUI
structural containers use a containing accessibility element so macOS 15 cannot
propagate the region identifier over nested buttons, sliders, Canvas cards, or
their own identifiers. The UI tests intentionally fail on either a missing or a
duplicated identifier.

Canvas card positioning wraps the complete semantic element so the visual card,
hit target, and AX frame stay aligned. Node dragging measures translation in the
fixed Canvas coordinate space rather than the moving card's local space. The
drag test verifies the requested visual offset, published accessibility offset,
and AX-frame delta together, keeps the sibling card stationary, and proves the
Inspector stays closed.

## Generate and build without running UI automation

Install the repository-pinned XcodeGen release, generate into this directory,
and compile both targets:

```bash
tools/ci/install-xcodegen.sh /tmp/vistrea-xcodegen
/tmp/vistrea-xcodegen/bin/xcodegen generate \
  --spec tests/studio-macos-ui/project.yml \
  --project tests/studio-macos-ui
xcodebuild -project tests/studio-macos-ui/VistreaStudioUIRegression.xcodeproj \
  -scheme VistreaStudioUIRegression \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  build-for-testing
```

Running the tests launches a visible macOS application and sends real
accessibility keyboard and pointer events. Do that only in an isolated UI test
session where input automation is explicitly allowed:

```bash
xcodebuild -project tests/studio-macos-ui/VistreaStudioUIRegression.xcodeproj \
  -scheme VistreaStudioUIRegression \
  -destination 'platform=macOS' \
  test
```

The generated `.xcodeproj` and Derived Data are build artifacts; `project.yml`
is the source of truth.
