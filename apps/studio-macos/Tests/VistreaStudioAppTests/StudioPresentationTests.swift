import AppKit
import QuartzCore
import SwiftUI
import VistreaStudioCore
import VistreaStudioHostRuntime
import VistreaRuntimeModels
import XCTest
@testable import VistreaStudioApp

private final class StudioSnapshotWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

@MainActor
final class StudioPresentationTests: XCTestCase {
    func testCommandNumberShortcutsOpenEveryWorkspaceSection() {
        for section in WorkspaceSection.allCases {
            XCTAssertEqual(
                StudioKeyboardNavigation.section(
                    for: section.shortcutKey,
                    modifiers: .command
                ),
                section
            )
        }

        XCTAssertNil(StudioKeyboardNavigation.section(for: "1", modifiers: []))
        XCTAssertNil(StudioKeyboardNavigation.section(for: "1", modifiers: [.command, .option]))
        XCTAssertNil(StudioKeyboardNavigation.section(for: "7", modifiers: .command))
    }

    func testCriticalAutomationIdentifiersAreStableAndUnique() {
        let identifiers = [
            StudioAccessibilityID.welcome,
            StudioAccessibilityID.welcomeNewWorkspace,
            StudioAccessibilityID.welcomeOpenWorkspace,
            StudioAccessibilityID.welcomeRecentWorkspaces,
            StudioAccessibilityID.workspaceManager,
            StudioAccessibilityID.workspaceManagerList,
            StudioAccessibilityID.workspaceManagerDetail,
            StudioAccessibilityID.workspaceMaintenance,
            StudioAccessibilityID.workspaceMaintenanceStatus,
            StudioAccessibilityID.workspaceMaintenanceProgress,
            StudioAccessibilityID.workspaceMaintenanceResult,
            StudioAccessibilityID.workspaceMaintenanceError,
            StudioAccessibilityID.workspaceMaintenanceRecoveryPoints,
            StudioAccessibilityID.workspaceMaintenanceCreateRecoveryPoint,
            StudioAccessibilityID.workspaceMaintenanceRestoreConfirmation,
            StudioAccessibilityID.workspaceMaintenanceGarbage,
            StudioAccessibilityID.workspaceMaintenanceGarbagePreview,
            StudioAccessibilityID.workspaceMaintenanceGarbageApply,
            StudioAccessibilityID.workspaceMaintenanceGarbageConfirmation,
            StudioAccessibilityID.workspaceMaintenanceRecoverInterruptedRestore,
            StudioAccessibilityID.workspaceMaintenanceRecoverStaleLock,
            StudioAccessibilityID.workspaceMaintenanceRetryOpen,
            StudioAccessibilityID.workspace,
            StudioAccessibilityID.workspaceLoading,
            StudioAccessibilityID.workspaceEmpty,
            StudioAccessibilityID.workspaceFailure,
            StudioAccessibilityID.contextBar,
            StudioAccessibilityID.sectionNavigation,
            StudioAccessibilityID.canvasSection,
            StudioAccessibilityID.canvasLoading,
            StudioAccessibilityID.canvasEmpty,
            StudioAccessibilityID.canvasFailure,
            StudioAccessibilityID.canvasRetry,
            StudioAccessibilityID.canvasViewport,
            StudioAccessibilityID.canvasPathBar,
            StudioAccessibilityID.canvasRoutePicker,
            StudioAccessibilityID.canvasClearSelection,
            StudioAccessibilityID.canvasZoomOut,
            StudioAccessibilityID.canvasZoomIn,
            StudioAccessibilityID.canvasFit,
            StudioAccessibilityID.inspector,
            StudioAccessibilityID.inspectorMode,
            StudioAccessibilityID.inspectorContextToggle,
            StudioAccessibilityID.inspectorContext,
            StudioAccessibilityID.inspectorScreenshot,
            StudioAccessibilityID.inspectorTree,
            StudioAccessibilityID.tuningControls,
            StudioAccessibilityID.tuningPropertyPicker,
            StudioAccessibilityID.tuningAlphaSlider,
            StudioAccessibilityID.tuningActivePreviews,
            StudioAccessibilityID.quality,
            StudioAccessibilityID.qualityMode,
            StudioAccessibilityID.qualityValidateSnapshot,
            StudioAccessibilityID.qualityValidateGraph,
            StudioAccessibilityID.qualityValidationResults,
            StudioAccessibilityID.qualityCompareBuilds,
        ] + WorkspaceSection.allCases.map(StudioAccessibilityID.section)
            + [
                StudioAccessibilityID.canvasState("fixture-state"),
                StudioAccessibilityID.tuningPreview("alpha"),
                StudioAccessibilityID.tuningRevert("fixture-application"),
                StudioAccessibilityID.workspaceMaintenanceRecoveryPoint("sha256:fixture"),
                StudioAccessibilityID.workspaceMaintenanceRestore("sha256:fixture"),
            ]

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertTrue(identifiers.allSatisfy { $0.hasPrefix("studio.") })
    }

    func testGoldenRecordingCannotBypassRequiredBaselineVerification() throws {
        let bitmap = try XCTUnwrap(
            NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: 1,
                pixelsHigh: 1,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 4,
                bitsPerPixel: 32
            )
        )
        let harness = StudioGoldenSnapshotHarness(
            testCase: self,
            snapshotsDirectory: FileManager.default.temporaryDirectory,
            environment: [
                "VISTREA_RECORD_STUDIO_SNAPSHOTS": "1",
                "VISTREA_REQUIRE_STUDIO_SNAPSHOTS": "1",
            ]
        )

        XCTAssertThrowsError(
            try harness.assertMatches(
                bitmap,
                named: "conflicting-policy",
                logicalSize: CGSize(width: 1, height: 1)
            )
        ) { error in
            XCTAssertEqual((error as NSError).domain, "StudioGoldenSnapshotHarness")
            XCTAssertEqual((error as NSError).code, 5)
        }
    }

    func testCanvasArrowNavigationFollowsTheLayeredLayout() {
        let states = [
            positionedState("entry", column: 0, row: 0),
            positionedState("catalog", column: 1, row: 0),
            positionedState("cart", column: 1, row: 1),
            positionedState("detail", column: 2, row: 0),
        ]

        XCTAssertEqual(
            CanvasKeyboardNavigation.destination(
                from: "entry",
                direction: .right,
                states: states
            ),
            "catalog"
        )
        XCTAssertEqual(
            CanvasKeyboardNavigation.destination(
                from: "catalog",
                direction: .down,
                states: states
            ),
            "cart"
        )
        XCTAssertEqual(
            CanvasKeyboardNavigation.destination(
                from: "cart",
                direction: .right,
                states: states
            ),
            "detail"
        )
        XCTAssertNil(
            CanvasKeyboardNavigation.destination(
                from: "entry",
                direction: .up,
                states: states
            )
        )
    }

    func testWelcomeSurfaceProducesANonBlankPresentationSnapshot() throws {
        let view = WorkspaceWelcomeView(
            recentWorkspaces: [],
            currentWorkspaceURL: nil,
            message: nil,
            availability: { _ in .missing },
            onNewWorkspace: {},
            onOpenWorkspace: {},
            onOpenRecent: { _ in },
            onManageRecent: { _ in },
            onReveal: { _ in },
            onRemoveRecent: { _ in },
            onClearRecent: {},
            onReturnToWorkspace: nil
        )
        .environment(\.colorScheme, .light)
        .environment(\.locale, Locale(identifier: "en_US_POSIX"))

        let snapshot = try render(view, size: CGSize(width: 1_200, height: 760))
        let png = try XCTUnwrap(snapshot.representation(using: .png, properties: [:]))

        XCTAssertEqual(snapshot.size, NSSize(width: 1_200, height: 760))
        XCTAssertEqual(snapshot.pixelsWide / 1_200, snapshot.pixelsHigh / 760)
        XCTAssertGreaterThanOrEqual(snapshot.pixelsWide, 1_200)
        XCTAssertGreaterThan(png.count, 20_000)
        XCTAssertGreaterThan(sampledColorRange(in: snapshot), 0.15)

        try goldenHarness.assertMatches(
            snapshot,
            named: "studio-welcome-light",
            logicalSize: CGSize(width: 1_200, height: 760)
        )
    }

    func testWorkspaceManagerProducesANonBlankPresentationSnapshot() throws {
        let workspaceURL = URL(
            fileURLWithPath: "/tmp/Acceptance.vistrea",
            isDirectory: true
        )
        let recent = StudioRecentWorkspace(
            path: workspaceURL.path,
            lastOpenedAt: Date(timeIntervalSince1970: 1_752_710_400)
        )
        let model = WorkspaceMaintenanceViewModel(client: nil)
        let view = WorkspaceManagerView(
            recentWorkspaces: [recent],
            currentWorkspaceURL: nil,
            selectedWorkspaceURL: workspaceURL,
            availability: { _ in .available },
            maintenanceModel: model,
            allowsMaintenance: true,
            canRetryOpen: true,
            onSelect: { _ in },
            onNewWorkspace: {},
            onOpenWorkspace: {},
            onOpenToManage: { _ in },
            onReveal: { _ in },
            onRemoveRecent: { _ in },
            onClose: {},
            onOfflineMaintenance: { _ in },
            onRetryOpen: {}
        )
        .environment(\.colorScheme, .light)
        .environment(\.locale, Locale(identifier: "en_US_POSIX"))

        let snapshot = try render(view, size: CGSize(width: 1_200, height: 760))
        let png = try XCTUnwrap(snapshot.representation(using: .png, properties: [:]))

        XCTAssertGreaterThan(png.count, 20_000)
        XCTAssertGreaterThan(sampledColorRange(in: snapshot), 0.12)
    }

    func testCanvasAndSelectedInspectorProducePresentationSnapshots() async throws {
        let model = try await loadedFixtureModel()
        let documents = fixtureDocuments()

        try assertPresentationSnapshot(
            SnapshotWorkspaceView(
                model: model,
                projectDocuments: documents,
                workspaceName: "Acceptance",
                onManageWorkspaces: {},
                initialSection: .canvas
            ),
            name: "studio-canvas-unselected",
            minimumPNGBytes: 35_000
        )

        let targetStateID = try XCTUnwrap(model.canvasGraph?.states.last?.id)
        await model.selectCanvasState(id: targetStateID)
        XCTAssertEqual(model.canvasStatePhase, .content)
        try assertPresentationSnapshot(
            SnapshotWorkspaceView(
                model: model,
                projectDocuments: documents,
                workspaceName: "Acceptance",
                onManageWorkspaces: {},
                initialSection: .canvas
            ),
            name: "studio-canvas-selected-inspector",
            minimumPNGBytes: 45_000
        )
    }

    func testQualityFindingProducesAPresentationSnapshot() async throws {
        let model = try await loadedFixtureModel()
        await model.validateSelectedSnapshot()
        XCTAssertEqual(model.validationPhase, .content)
        XCTAssertFalse(model.validationFindings.isEmpty)

        try assertPresentationSnapshot(
            SnapshotWorkspaceView(
                model: model,
                projectDocuments: fixtureDocuments(),
                workspaceName: "Acceptance",
                onManageWorkspaces: {},
                initialSection: .quality
            ),
            name: "studio-quality-findings",
            minimumPNGBytes: 35_000
        )
    }

    private func render<Content: View>(
        _ content: Content,
        size: CGSize
    ) throws -> NSBitmapImageRep {
        let hostingView = NSHostingView(rootView: content)
        hostingView.frame = CGRect(origin: .zero, size: size)
        let window = StudioSnapshotWindow(
            contentRect: hostingView.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.isOpaque = true
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .windowBackgroundColor
        hostingView.autoresizingMask = [.width, .height]
        window.contentView = hostingView
        window.contentMinSize = size
        window.contentMaxSize = size
        window.setContentSize(size)
        hostingView.frame = CGRect(origin: .zero, size: size)
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFront(nil)

        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        for _ in 0..<3 {
            hostingView.needsLayout = true
            hostingView.layoutSubtreeIfNeeded()
            hostingView.needsDisplay = true
            hostingView.displayIfNeeded()
            window.displayIfNeeded()
            CATransaction.flush()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01))
        }
        NSAnimationContext.endGrouping()

        let bitmap = try XCTUnwrap(
            hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds),
            "The fixed-size Studio presentation surface did not create a bitmap representation."
        )
        hostingView.cacheDisplay(in: hostingView.bounds, to: bitmap)
        bitmap.size = size
        let expectedPixelSize = NSSize(
            width: size.width * window.backingScaleFactor,
            height: size.height * window.backingScaleFactor
        )
        XCTAssertEqual(bitmap.pixelsWide, Int(expectedPixelSize.width.rounded()))
        XCTAssertEqual(bitmap.pixelsHigh, Int(expectedPixelSize.height.rounded()))
        window.orderOut(nil)
        window.contentView = nil
        window.close()
        return bitmap
    }

    private func assertPresentationSnapshot<Content: View>(
        _ content: Content,
        name: String,
        minimumPNGBytes: Int
    ) throws {
        let snapshot = try render(
            content
                .environment(\.colorScheme, .light)
                .environment(\.locale, Locale(identifier: "en_US_POSIX")),
            size: CGSize(width: 1_440, height: 900)
        )
        let png = try XCTUnwrap(snapshot.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, minimumPNGBytes)
        XCTAssertGreaterThan(sampledColorRange(in: snapshot), 0.15)
        try goldenHarness.assertMatches(
            snapshot,
            named: name,
            logicalSize: CGSize(width: 1_440, height: 900)
        )
    }

    private func loadedFixtureModel() async throws -> SnapshotWorkspaceModel {
        let snapshot = try RuntimeSnapshotCodec.decode(
            Data(
                contentsOf: repositoryRoot.appending(
                    path: "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
                )
            )
        )
        let stateIDs = ["home", "catalog", "product", "reviews", "cart", "profile"]
        let graph = CanvasGraph(
            screenGraphID: "graph-presentation",
            entryStateIDs: ["home"],
            states: stateIDs.map { id in
                CanvasStateSummary(
                    screenStateID: id,
                    title: id.capitalized,
                    kind: "screen",
                    status: "active",
                    labels: id == "home" ? ["entry", "storefront"] : ["storefront", id],
                    summary: "Acceptance evidence for the \(id) state."
                )
            },
            transitions: [
                transition("home-catalog", "home", "catalog"),
                transition("catalog-product", "catalog", "product"),
                transition("product-reviews", "product", "reviews"),
                transition("home-cart", "home", "cart"),
                transition("home-profile", "home", "profile"),
            ]
        )
        let model = SnapshotWorkspaceModel(
            client: FixtureHostClient(snapshots: [snapshot], canvasGraph: graph)
        )
        await model.refresh()
        XCTAssertEqual(model.contentPhase, .content)
        XCTAssertEqual(model.canvasPhase, .content)
        return model
    }

    private func transition(
        _ id: String,
        _ source: String,
        _ target: String
    ) -> CanvasTransitionSummary {
        CanvasTransitionSummary(
            transitionID: id,
            sourceStateID: source,
            targetStateID: target,
            occurrenceCount: 1
        )
    }

    private var repositoryRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }

    private func fixtureDocuments() -> StudioProjectDocuments {
        let suiteName = "VistreaStudioPresentationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        return StudioProjectDocuments(workspaceURL: nil, defaults: defaults)
    }

    private func positionedState(
        _ id: String,
        column: Int,
        row: Int
    ) -> CanvasLayout.PositionedState {
        CanvasLayout.PositionedState(
            state: CanvasStateSummary(
                screenStateID: id,
                title: id,
                kind: "screen",
                status: "active"
            ),
            column: column,
            row: row
        )
    }

    private func sampledColorRange(in bitmap: NSBitmapImageRep) -> CGFloat {
        var minimum: CGFloat = 1
        var maximum: CGFloat = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 16) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 16) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else {
                    continue
                }
                let luminance = 0.2126 * color.redComponent
                    + 0.7152 * color.greenComponent
                    + 0.0722 * color.blueComponent
                minimum = min(minimum, luminance)
                maximum = max(maximum, luminance)
            }
        }
        return maximum - minimum
    }

    private var goldenHarness: StudioGoldenSnapshotHarness {
        StudioGoldenSnapshotHarness(
            testCase: self,
            snapshotsDirectory: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .appending(path: ".goldens", directoryHint: .isDirectory)
        )
    }
}
