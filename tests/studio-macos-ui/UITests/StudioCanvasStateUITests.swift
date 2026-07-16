import XCTest

final class StudioCanvasStateUITests: StudioUITestCase {
    func testCanvasEmptyStateIsExplicit() {
        let application = launchStudio(argument: "--ui-testing-canvas-empty")

        requireElement(AccessibilityID.canvas, in: application)
        requireElement(AccessibilityID.canvasEmpty, in: application)
        requireText("No Screen States", in: application)
        attachScreenshot("canvas-empty", of: application)
    }

    func testCanvasFailureOffersRetryWithoutHidingTheWorkspace() {
        let application = launchStudio(argument: "--ui-testing-canvas-error")

        requireElement(AccessibilityID.canvas, in: application)
        requireElement(AccessibilityID.canvasFailure, in: application)
        requireElement(AccessibilityID.canvasRetry, in: application)
        requireText("Screen Graph Unavailable", in: application)
        attachScreenshot("canvas-error", of: application)
    }
}
