import Foundation
import SwiftUI
import VistreaStudioCore

/// A deterministic, isolated launch surface for macOS UI automation. The
/// production application never infers this mode from environment state: an
/// explicit process argument is required, and the mode always uses the
/// in-memory canonical Fixture Workspace instead of starting a Host or reading
/// the user's recent Workspace selection.
struct StudioLaunchConfiguration: Equatable {
    enum Content: Equatable {
        case production
        case fixtureWorkspace
        case fixtureWelcome
        case fixtureCanvasEmpty
        case fixtureCanvasFailure
    }

    static let uiTestingWorkspaceArgument = "--ui-testing"
    static let uiTestingWelcomeArgument = "--ui-testing-welcome"
    static let uiTestingCanvasEmptyArgument = "--ui-testing-canvas-empty"
    static let uiTestingCanvasFailureArgument = "--ui-testing-canvas-error"

    let content: Content

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        if arguments.contains(Self.uiTestingCanvasFailureArgument) {
            content = .fixtureCanvasFailure
        } else if arguments.contains(Self.uiTestingCanvasEmptyArgument) {
            content = .fixtureCanvasEmpty
        } else if arguments.contains(Self.uiTestingWelcomeArgument) {
            content = .fixtureWelcome
        } else if arguments.contains(Self.uiTestingWorkspaceArgument) {
            content = .fixtureWorkspace
        } else {
            content = .production
        }
    }

    var isUITesting: Bool {
        content != .production
    }
}

/// Stable automation identifiers for the Studio product surface. These values
/// are UI contracts: presentation tests and future XCUI automation may depend
/// on them, so visual refactors must preserve the identifiers or update the
/// acceptance contract deliberately.
enum StudioAccessibilityID {
    static let welcome = "studio.welcome"
    static let welcomeNewWorkspace = "studio.welcome.new-workspace"
    static let welcomeOpenWorkspace = "studio.welcome.open-workspace"
    static let welcomeRecentWorkspaces = "studio.welcome.recent-workspaces"

    static let workspaceManager = "studio.workspace-manager"
    static let workspaceManagerList = "studio.workspace-manager.list"
    static let workspaceManagerDetail = "studio.workspace-manager.detail"
    static let workspaceManagerClose = "studio.workspace-manager.close"
    static let workspaceMaintenance = "studio.workspace.maintenance"
    static let workspaceMaintenanceStatus = "studio.workspace.maintenance.status"
    static let workspaceMaintenanceProgress = "studio.workspace.maintenance.progress"
    static let workspaceMaintenanceResult = "studio.workspace.maintenance.result"
    static let workspaceMaintenanceError = "studio.workspace.maintenance.error"
    static let workspaceMaintenanceRecoveryPoints =
        "studio.workspace.maintenance.recovery-points"
    static let workspaceMaintenanceCreateRecoveryPoint =
        "studio.workspace.maintenance.create-recovery-point"
    static let workspaceMaintenanceRestoreConfirmation =
        "studio.workspace.maintenance.restore-confirmation"
    static let workspaceMaintenanceGarbage = "studio.workspace.maintenance.gc"
    static let workspaceMaintenanceGarbagePreview = "studio.workspace.maintenance.gc-preview"
    static let workspaceMaintenanceGarbageApply = "studio.workspace.maintenance.gc-apply"
    static let workspaceMaintenanceGarbageConfirmation =
        "studio.workspace.maintenance.gc-confirmation"
    static let workspaceMaintenanceRecoverInterruptedRestore =
        "studio.workspace.maintenance.recover-interrupted-restore"
    static let workspaceMaintenanceRecoverStaleLock =
        "studio.workspace.maintenance.recover-stale-lock"
    static let workspaceMaintenanceRetryOpen = "studio.workspace.maintenance.retry-open"

    static let workspace = "studio.workspace"
    static let workspaceLoading = "studio.workspace.loading"
    static let workspaceEmpty = "studio.workspace.empty"
    static let workspaceFailure = "studio.workspace.failure"
    static let contextBar = "studio.context-bar"
    static let sectionNavigation = "studio.section-navigation"

    static let canvasSection = "studio.canvas"
    static let canvasLoading = "studio.canvas.loading"
    static let canvasEmpty = "studio.canvas.empty"
    static let canvasFailure = "studio.canvas.failure"
    static let canvasRetry = "studio.canvas.retry"
    static let canvasViewport = "studio.canvas.viewport"
    static let canvasPathBar = "studio.canvas.path-bar"
    static let canvasRoutePicker = "studio.canvas.route-picker"
    static let canvasClearSelection = "studio.canvas.clear-selection"
    static let canvasZoomOut = "studio.canvas.zoom-out"
    static let canvasZoomIn = "studio.canvas.zoom-in"
    static let canvasFit = "studio.canvas.fit"

    static let inspector = "studio.inspector"
    static let inspectorMode = "studio.inspector.mode"
    static let inspectorContextToggle = "studio.inspector.context-toggle"
    static let inspectorContext = "studio.inspector.context"
    static let inspectorScreenshot = "studio.inspector.screenshot"
    static let inspectorTree = "studio.inspector.tree"
    static let tuningControls = "studio.inspector.tuning-controls"
    static let tuningPropertyPicker = "studio.inspector.tuning-property"
    static let tuningAlphaSlider = "studio.inspector.tuning-alpha-slider"
    static let tuningActivePreviews = "studio.inspector.tuning-active-previews"

    static let quality = "studio.quality"
    static let qualityMode = "studio.quality.mode"
    static let qualityValidateSnapshot = "studio.quality.validate-snapshot"
    static let qualityValidateGraph = "studio.quality.validate-graph"
    static let qualityValidationResults = "studio.quality.validation-results"
    static let qualityCompareBuilds = "studio.quality.compare-builds"

    static func section(_ section: WorkspaceSection) -> String {
        "studio.section.\(section.rawValue.lowercased())"
    }

    static func canvasState(_ stateID: String) -> String {
        "studio.canvas.state.\(stateID)"
    }

    static func tuningRevert(_ applicationID: String) -> String {
        "studio.inspector.tuning-revert.\(applicationID)"
    }

    static func tuningPreview(_ property: String) -> String {
        "studio.inspector.tuning-preview.\(property)"
    }

    static func workspaceMaintenanceRecoveryPoint(_ recoveryPointID: String) -> String {
        "studio.workspace.maintenance.recovery-point.\(recoveryPointID)"
    }

    static func workspaceMaintenanceRestore(_ recoveryPointID: String) -> String {
        "studio.workspace.maintenance.restore.\(recoveryPointID)"
    }

    static func workspaceManagerRow(_ workspacePath: String) -> String {
        "studio.workspace-manager.row.\(workspacePath)"
    }
}

extension View {
    /// Exposes one stable automation element for a logical product region
    /// while preserving the accessibility of its interactive descendants.
    ///
    /// On macOS 15, applying an identifier directly to a SwiftUI container
    /// propagates that identifier to its children. The resulting duplicates
    /// make the region ambiguous and can overwrite identifiers owned by nested
    /// controls. Creating an explicit containing element keeps the region and
    /// its descendants independently addressable across supported macOS
    /// versions.
    func studioAccessibilityContainer(_ identifier: String) -> some View {
        accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }
}

enum StudioKeyboardNavigation {
    static func section(
        for key: KeyEquivalent,
        modifiers: EventModifiers
    ) -> WorkspaceSection? {
        guard modifiers.contains(.command),
              !modifiers.contains(.control),
              !modifiers.contains(.option)
        else {
            return nil
        }
        return WorkspaceSection.allCases.first(where: { $0.shortcutKey == key })
    }
}

enum StudioNavigationRequest {
    static let notification = Notification.Name("dev.vistrea.studio.select-workspace-section")

    static func section(from notification: Notification) -> WorkspaceSection? {
        guard let rawValue = notification.object as? String else { return nil }
        return WorkspaceSection(rawValue: rawValue)
    }
}

enum CanvasKeyboardDirection {
    case up
    case down
    case left
    case right
}

enum CanvasKeyboardNavigation {
    static func destination(
        from stateID: String,
        direction: CanvasKeyboardDirection,
        states: [CanvasLayout.PositionedState]
    ) -> String? {
        guard let current = states.first(where: { $0.id == stateID }) else { return nil }
        let candidates: [CanvasLayout.PositionedState]
        switch direction {
        case .up:
            candidates = states.filter { $0.column == current.column && $0.row < current.row }
        case .down:
            candidates = states.filter { $0.column == current.column && $0.row > current.row }
        case .left:
            candidates = states.filter { $0.column < current.column }
        case .right:
            candidates = states.filter { $0.column > current.column }
        }

        return candidates.min { left, right in
            let leftScore = score(left, from: current, direction: direction)
            let rightScore = score(right, from: current, direction: direction)
            if leftScore != rightScore { return leftScore.lexicographicallyPrecedes(rightScore) }
            return left.id < right.id
        }?.id
    }

    private static func score(
        _ candidate: CanvasLayout.PositionedState,
        from current: CanvasLayout.PositionedState,
        direction: CanvasKeyboardDirection
    ) -> [Int] {
        switch direction {
        case .up, .down:
            [abs(candidate.row - current.row), 0]
        case .left, .right:
            [abs(candidate.column - current.column), abs(candidate.row - current.row)]
        }
    }
}
