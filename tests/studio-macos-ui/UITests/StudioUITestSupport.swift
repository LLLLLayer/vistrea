import Foundation
import XCTest

@MainActor
class StudioUITestCase: XCTestCase {
    enum AccessibilityID {
        static let welcome = "studio.welcome"
        static let welcomeNewWorkspace = "studio.welcome.new-workspace"
        static let welcomeOpenWorkspace = "studio.welcome.open-workspace"
        static let welcomeRecentWorkspaces = "studio.welcome.recent-workspaces"

        static let workspaceManager = "studio.workspace-manager"
        static let workspaceManagerList = "studio.workspace-manager.list"
        static let workspaceManagerDetail = "studio.workspace-manager.detail"
        static let workspaceManagerClose = "studio.workspace-manager.close"
        static let workspaceMaintenance = "studio.workspace.maintenance"
        static let workspaceMaintenanceCreateRecoveryPoint =
            "studio.workspace.maintenance.create-recovery-point"
        static let workspaceMaintenanceRecoveryPointReason =
            "studio.workspace.maintenance.recovery-point-reason"
        static let workspaceMaintenanceResult = "studio.workspace.maintenance.result"
        static let workspaceMaintenanceGarbage = "studio.workspace.maintenance.gc"
        static let workspaceMaintenanceGarbageAnalyze = "studio.workspace.maintenance.gc-analyze"
        static let workspaceMaintenanceGarbagePreview = "studio.workspace.maintenance.gc-preview"
        static let workspaceMaintenanceGarbageApply = "studio.workspace.maintenance.gc-apply"
        static let workspaceMaintenanceGarbageConfirmationField =
            "studio.workspace.maintenance.gc-confirmation-field"
        static let workspaceMaintenanceRestoreConfirmation =
            "studio.workspace.maintenance.restore-confirmation"
        static let workspaceMaintenanceRecoverInterruptedRestore =
            "studio.workspace.maintenance.recover-interrupted-restore"
        static let workspaceMaintenanceRecoverStaleLock =
            "studio.workspace.maintenance.recover-stale-lock"

        static let workspace = "studio.workspace"
        static let sectionNavigation = "studio.section-navigation"
        static let canvas = "studio.canvas"
        static let canvasViewport = "studio.canvas.viewport"
        static let canvasEmpty = "studio.canvas.empty"
        static let canvasFailure = "studio.canvas.failure"
        static let canvasRetry = "studio.canvas.retry"
        static let canvasPathBar = "studio.canvas.path-bar"
        static let canvasRoutePicker = "studio.canvas.route-picker"
        static let canvasClearSelection = "studio.canvas.clear-selection"
        static let inspector = "studio.inspector"
        static let inspectorContextToggle = "studio.inspector.context-toggle"
        static let inspectorContext = "studio.inspector.context"
        static let inspectorScreenshot = "studio.inspector.screenshot"
        static let inspectorTree = "studio.inspector.tree"
        static let tuningControls = "studio.inspector.tuning-controls"
        static let tuningPropertyPicker = "studio.inspector.tuning-property"
        static let tuningAlphaSlider = "studio.inspector.tuning-alpha-slider"
        static let tuningPreviewAlpha = "studio.inspector.tuning-preview.alpha"
        static let tuningActivePreviews = "studio.inspector.tuning-active-previews"
        static let tuningRevertPrefix = "studio.inspector.tuning-revert."

        static let quality = "studio.quality"
        static let qualityValidateSnapshot = "studio.quality.validate-snapshot"
        static let qualityValidateGraph = "studio.quality.validate-graph"
        static let qualityValidationResults = "studio.quality.validation-results"

        static func section(_ name: String) -> String {
            "studio.section.\(name.lowercased())"
        }

        static func canvasState(_ stateID: String) -> String {
            "studio.canvas.state.\(stateID)"
        }

        static func workspaceMaintenanceRestore(_ recoveryPointID: String) -> String {
            "studio.workspace.maintenance.restore.\(recoveryPointID)"
        }
    }

    enum Fixture {
        static let catalogStateID = "screenstate_019f0000-0000-7000-8000-0000000000c2"
        static let catalogVariantStateID = "screenstate_019f0000-0000-7000-8000-0000000000c3"

        static var snapshotPath: String {
            repositoryRoot
                .appending(path: "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json")
                .path
        }

        static var repositoryRoot: URL {
            var repositoryRoot = URL(fileURLWithPath: #filePath)
            for _ in 0..<4 {
                repositoryRoot.deleteLastPathComponent()
            }
            return repositoryRoot
        }
    }

    struct PersistedWorkspaceFixture: Decodable {
        let rootURL: URL
        let workspacePath: String
        let recoveryPointID: String

        private enum CodingKeys: String, CodingKey {
            case workspacePath = "workspace_path"
            case recoveryPointID = "recovery_point_id"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            workspacePath = try container.decode(String.self, forKey: .workspacePath)
            recoveryPointID = try container.decode(String.self, forKey: .recoveryPointID)
            rootURL = URL(fileURLWithPath: workspacePath, isDirectory: true)
                .deletingLastPathComponent()
        }
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: Fixture.snapshotPath),
            "The canonical Runtime Snapshot fixture is required by the isolated UI-test launch."
        )
    }

    func launchStudio(argument: String) -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments = [argument]
        application.launchEnvironment["VISTREA_FIXTURE_PATH"] = Fixture.snapshotPath
        application.launch()
        addTeardownBlock { @MainActor in
            if application.state != .notRunning {
                application.terminate()
            }
        }
        addTeardownBlock { @MainActor [weak self] in
            guard let self,
                  application.state != .notRunning,
                  self.testRun?.failureCount ?? 0 > 0
            else {
                return
            }
            self.attachScreenshot("failure-\(self.sanitizedTestName)", of: application)
        }
        XCTAssertTrue(
            waitUntil(timeout: 5) { application.state == .runningForeground },
            "Studio did not reach the foreground after launch."
        )
        return application
    }

    func preparePersistedWorkspaceFixture() throws -> PersistedWorkspaceFixture {
        let environment = ProcessInfo.processInfo.environment
        let nodePath = try XCTUnwrap(
            environment["VISTREA_UI_TEST_NODE"],
            "VISTREA_UI_TEST_NODE must name the CI Node.js executable."
        )
        let root = FileManager.default.temporaryDirectory
            .appending(path: "vistrea-studio-ui-\(UUID().uuidString)", directoryHint: .isDirectory)
        let workspace = root.appending(path: "workspace", directoryHint: .isDirectory)
        let manifest = root.appending(path: "fixture.json", directoryHint: .notDirectory)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath, isDirectory: false)
        process.currentDirectoryURL = Fixture.repositoryRoot
        process.arguments = [
            Fixture.repositoryRoot
                .appending(path: ".build/typescript/tools/acceptance/disposable-workspace.js")
                .path,
            "--workspace", workspace.path,
            "--manifest", manifest.path,
        ]
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.standardOutput = standardOutput
        process.standardError = standardError
        try process.run()
        process.waitUntilExit()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        XCTAssertEqual(
            process.terminationStatus,
            0,
            "Disposable Workspace generation failed: \(String(decoding: errorData, as: UTF8.self))"
        )
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "VistreaStudioUITests", code: Int(process.terminationStatus))
        }
        let decoded = try JSONDecoder().decode(
            PersistedWorkspaceFixture.self,
            from: Data(contentsOf: manifest)
        )
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        return decoded
    }

    func launchPersistedStudio(_ fixture: PersistedWorkspaceFixture) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let hostResources = try XCTUnwrap(
            environment["VISTREA_UI_TEST_HOST_RESOURCES"],
            "VISTREA_UI_TEST_HOST_RESOURCES must contain HostRuntime."
        )
        let applicationSupport = fixture.rootURL
            .appending(path: "application-support", directoryHint: .isDirectory)
        let application = XCUIApplication()
        application.launchArguments = ["--ui-testing-persisted-workspace"]
        application.launchEnvironment["VISTREA_UI_TEST_WORKSPACE_PATH"] = fixture.workspacePath
        application.launchEnvironment["VISTREA_UI_TEST_HOST_RESOURCES"] = hostResources
        application.launchEnvironment["VISTREA_UI_TEST_APPLICATION_SUPPORT_PATH"] =
            applicationSupport.path
        // The disposable candidate is intentionally new. Select the same
        // explicit zero-age policy as packaged acceptance while production
        // keeps the conservative seven-day default.
        application.launchEnvironment["VISTREA_UI_TEST_GC_MINIMUM_AGE_DAYS"] = "0"
        application.launch()
        addTeardownBlock { @MainActor in
            if application.state != .notRunning {
                application.terminate()
            }
        }
        XCTAssertTrue(
            waitUntil(timeout: 15) { application.state == .runningForeground },
            "Studio did not reach the foreground with the persisted fixture."
        )
        return application
    }

    func openInspectorContext(in application: XCUIApplication) -> XCUIElement {
        let context = element(AccessibilityID.inspectorContext, in: application)
        if context.waitForExistence(timeout: 1) {
            return context
        }
        let toggle = requireElement(
            AccessibilityID.inspectorContextToggle,
            in: application
        )
        XCTAssertTrue(
            waitUntil(timeout: 2) { toggle.isHittable },
            "The compact Inspector context toggle did not become actionable."
        )
        toggle.click()
        return requireElement(AccessibilityID.inspectorContext, in: application)
    }

    func query(
        _ identifier: String,
        in application: XCUIApplication
    ) -> XCUIElementQuery {
        application
            .descendants(matching: .any)
            .matching(identifier: identifier)
    }

    func element(
        _ identifier: String,
        in application: XCUIApplication
    ) -> XCUIElement {
        query(identifier, in: application).firstMatch
    }

    func query(
        withIdentifierPrefix prefix: String,
        in application: XCUIApplication
    ) -> XCUIElementQuery {
        application
            .descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    func element(
        withIdentifierPrefix prefix: String,
        in application: XCUIApplication
    ) -> XCUIElement {
        query(withIdentifierPrefix: prefix, in: application).firstMatch
    }

    @discardableResult
    func requireElement(
        _ identifier: String,
        in application: XCUIApplication,
        timeout: TimeInterval = 8,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let matchingElements = query(identifier, in: application)
        let result = matchingElements.firstMatch
        XCTAssertTrue(
            result.waitForExistence(timeout: timeout),
            "Expected accessibility element \(identifier).",
            file: file,
            line: line
        )
        XCTAssertTrue(
            waitUntil(timeout: 1) { matchingElements.count == 1 },
            "Expected exactly one accessibility element \(identifier), found \(matchingElements.count).",
            file: file,
            line: line
        )
        return result
    }

    @discardableResult
    func requireElement(
        withIdentifierPrefix prefix: String,
        in application: XCUIApplication,
        timeout: TimeInterval = 8,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let matchingElements = query(withIdentifierPrefix: prefix, in: application)
        let result = matchingElements.firstMatch
        XCTAssertTrue(
            result.waitForExistence(timeout: timeout),
            "Expected accessibility identifier beginning with \(prefix).",
            file: file,
            line: line
        )
        XCTAssertTrue(
            waitUntil(timeout: 1) { matchingElements.count == 1 },
            "Expected exactly one accessibility identifier beginning with \(prefix), found \(matchingElements.count).",
            file: file,
            line: line
        )
        return result
    }

    func requireText(
        _ label: String,
        in application: XCUIApplication,
        timeout: TimeInterval = 8,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            application.staticTexts[label].waitForExistence(timeout: timeout),
            "Expected visible text \(label).",
            file: file,
            line: line
        )
    }

    func requireTextContaining(
        _ fragment: String,
        in application: XCUIApplication,
        timeout: TimeInterval = 8,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let result = application.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", fragment))
            .firstMatch
        XCTAssertTrue(
            result.waitForExistence(timeout: timeout),
            "Expected visible text containing \(fragment).",
            file: file,
            line: line
        )
    }

    func pressCommand(_ key: String, in application: XCUIApplication) {
        application.typeKey(key, modifierFlags: .command)
    }

    @discardableResult
    func waitUntil(
        timeout: TimeInterval,
        pollInterval: TimeInterval = 0.05,
        condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() {
                return true
            }
            let pause = XCTestExpectation(description: "UI state polling interval")
            pause.isInverted = true
            _ = XCTWaiter.wait(
                for: [pause],
                timeout: min(pollInterval, max(0, deadline.timeIntervalSinceNow))
            )
        } while Date() < deadline
        return condition()
    }

    func assertRemainsAbsent(
        _ target: XCUIElement,
        duration: TimeInterval,
        message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let unexpectedAppearance = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true"),
            object: target
        )
        unexpectedAppearance.isInverted = true
        XCTAssertEqual(
            XCTWaiter.wait(for: [unexpectedAppearance], timeout: duration),
            .completed,
            message,
            file: file,
            line: line
        )
    }

    func reveal(
        _ target: XCUIElement,
        inside container: XCUIElement,
        attempts: Int = 12
    ) {
        guard !target.isHittable else { return }
        let scrollPoint = container.coordinate(
            withNormalizedOffset: CGVector(dx: 0.88, dy: 0.58)
        )
        for _ in 0..<attempts where !target.isHittable {
            scrollPoint.scroll(byDeltaX: 0, deltaY: -220)
            if waitUntil(timeout: 0.2, condition: { target.isHittable }) {
                break
            }
        }
        XCTAssertTrue(target.isHittable, "The target could not be revealed inside its pane.")
    }

    func attachScreenshot(
        _ name: String,
        of application: XCUIApplication
    ) {
        let attachment = XCTAttachment(screenshot: application.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private var sanitizedTestName: String {
        name
            .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
    }
}
