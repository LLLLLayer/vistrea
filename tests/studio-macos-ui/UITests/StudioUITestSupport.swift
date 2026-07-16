import Foundation
import XCTest

@MainActor
class StudioUITestCase: XCTestCase {
    enum AccessibilityID {
        static let welcome = "studio.welcome"
        static let welcomeNewWorkspace = "studio.welcome.new-workspace"
        static let welcomeOpenWorkspace = "studio.welcome.open-workspace"
        static let welcomeRecentWorkspaces = "studio.welcome.recent-workspaces"

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
    }

    enum Fixture {
        static let catalogStateID = "screenstate_019f0000-0000-7000-8000-0000000000c2"

        static var snapshotPath: String {
            var repositoryRoot = URL(fileURLWithPath: #filePath)
            for _ in 0..<4 {
                repositoryRoot.deleteLastPathComponent()
            }
            return repositoryRoot
                .appending(path: "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json")
                .path
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
