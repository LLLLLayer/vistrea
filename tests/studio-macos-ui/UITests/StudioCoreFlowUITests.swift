import XCTest

final class StudioCoreFlowUITests: StudioUITestCase {
    func testCommandOneThroughSixNavigatesTheWorkspace() {
        let application = launchStudio(argument: "--ui-testing")

        requireElement(AccessibilityID.workspace, in: application)
        requireElement(AccessibilityID.sectionNavigation, in: application)
        requireElement(AccessibilityID.canvas, in: application)
        requireElement(AccessibilityID.canvasViewport, in: application)
        requireElement(
            AccessibilityID.canvasState(Fixture.catalogStateID),
            in: application
        )
        attachScreenshot("workspace-canvas", of: application)

        pressCommand("2", in: application)
        requireText("Snapshot Evidence", in: application)
        requireElement(AccessibilityID.section("evidence"), in: application)

        pressCommand("3", in: application)
        requireText("Project Documents", in: application)
        requireElement(AccessibilityID.section("documents"), in: application)

        pressCommand("4", in: application)
        requireText("Deep Wiki", in: application)
        requireElement(AccessibilityID.section("wiki"), in: application)

        pressCommand("5", in: application)
        requireElement(AccessibilityID.quality, in: application)
        requireElement(AccessibilityID.qualityValidateSnapshot, in: application)
        requireElement(AccessibilityID.qualityValidateGraph, in: application)
        requireText("Run Local Validation", in: application)
        attachScreenshot("workspace-quality", of: application)

        pressCommand("6", in: application)
        requireText("Team Hub", in: application)
        requireElement(AccessibilityID.section("hub"), in: application)

        pressCommand("1", in: application)
        requireElement(AccessibilityID.canvas, in: application)
        requireElement(AccessibilityID.section("canvas"), in: application)
        requireElement(
            AccessibilityID.canvasState(Fixture.catalogStateID),
            in: application
        )
    }

    func testCanvasSelectionTuningRevertAndQualityValidation() {
        let application = launchStudio(argument: "--ui-testing")
        requireElement(AccessibilityID.canvas, in: application)

        let catalogState = requireElement(
            AccessibilityID.canvasState(Fixture.catalogStateID),
            in: application
        )
        XCTAssertTrue(
            waitUntil(timeout: 2) { catalogState.isHittable },
            "The fixture Catalog state did not become actionable."
        )
        catalogState.click()

        requireElement(AccessibilityID.inspector, in: application)
        requireElement(AccessibilityID.canvasPathBar, in: application)
        requireText("Path to Catalog", in: application)
        requireElement(AccessibilityID.canvasRoutePicker, in: application)
        requireElement(AccessibilityID.inspectorScreenshot, in: application)
        requireElement(AccessibilityID.inspectorTree, in: application)

        let context = openInspectorContext(in: application)
        let tuningControls = element(AccessibilityID.tuningControls, in: application)
        reveal(tuningControls, inside: context)
        requireElement(AccessibilityID.tuningControls, in: application)
        attachScreenshot("canvas-selection-and-inspector", of: application)
        requireElement(AccessibilityID.tuningPropertyPicker, in: application)
        let alphaSlider = requireElement(AccessibilityID.tuningAlphaSlider, in: application)
        reveal(alphaSlider, inside: context)
        alphaSlider.adjust(toNormalizedSliderPosition: 0.55)
        XCTAssertTrue(
            waitUntil(timeout: 2) {
                abs(alphaSlider.normalizedSliderPosition - 0.55) <= 0.08
            },
            "The alpha slider did not settle near the requested preview value."
        )

        let preview = requireElement(AccessibilityID.tuningPreviewAlpha, in: application)
        reveal(preview, inside: context)
        preview.click()

        let activePreviews = element(AccessibilityID.tuningActivePreviews, in: application)
        reveal(activePreviews, inside: context)
        requireElement(AccessibilityID.tuningActivePreviews, in: application)
        let revert = requireElement(
            withIdentifierPrefix: AccessibilityID.tuningRevertPrefix,
            in: application
        )
        reveal(revert, inside: context)
        let revertIdentifier = revert.identifier
        attachScreenshot("inspector-active-tuning-preview", of: application)
        revert.click()
        XCTAssertTrue(
            element(revertIdentifier, in: application).waitForNonExistence(timeout: 8),
            "Revert must remove the application from the active preview list."
        )
        requireText("No active tuning previews.", in: application)

        pressCommand("5", in: application)
        requireElement(AccessibilityID.quality, in: application)
        let idleValidation = application.staticTexts["Run Local Validation"]
        XCTAssertTrue(idleValidation.waitForExistence(timeout: 5))
        let validateSnapshot = requireElement(
            AccessibilityID.qualityValidateSnapshot,
            in: application
        )
        validateSnapshot.click()
        let validationResults = requireElement(
            AccessibilityID.qualityValidationResults,
            in: application
        )
        XCTAssertTrue(
            validationResults.staticTexts["accessibility.minimum-touch-target"]
                .waitForExistence(timeout: 10),
            "Fixture Snapshot validation did not reach its completed finding presentation."
        )
        XCTAssertTrue(idleValidation.waitForNonExistence(timeout: 1))
        attachScreenshot("quality-validation-results", of: application)
    }

    func testDraggingACanvasCardDoesNotSelectIt() {
        let application = launchStudio(argument: "--ui-testing")
        requireElement(AccessibilityID.canvas, in: application)

        let catalogState = requireElement(
            AccessibilityID.canvasState(Fixture.catalogStateID),
            in: application
        )
        XCTAssertTrue(
            waitUntil(timeout: 2) { catalogState.isHittable },
            "The fixture Catalog state did not become actionable."
        )
        let catalogVariant = requireElement(
            AccessibilityID.canvasState(Fixture.catalogVariantStateID),
            in: application
        )
        let originalFrame = catalogState.frame
        let originalVariantFrame = catalogVariant.frame
        let source = catalogState.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let destination = source
            .withOffset(CGVector(dx: 72, dy: 44))
        source.click(forDuration: 0.15, thenDragTo: destination)

        XCTAssertTrue(
            waitUntil(timeout: 3) {
                let movedFrame = self.element(
                    AccessibilityID.canvasState(Fixture.catalogStateID),
                    in: application
                ).frame
                let deltaX = movedFrame.origin.x - originalFrame.origin.x
                let deltaY = movedFrame.origin.y - originalFrame.origin.y
                return abs(abs(deltaX) - 72) <= 4 && abs(abs(deltaY) - 44) <= 4
            },
            "The dragged Catalog card and its accessibility frame did not move by the requested offset."
        )
        assertRemainsAbsent(
            element(AccessibilityID.inspector, in: application),
            duration: 1,
            message: "Dragging a Canvas card must not select it or open the Inspector."
        )
        let currentVariantFrame = element(
            AccessibilityID.canvasState(Fixture.catalogVariantStateID),
            in: application
        ).frame
        XCTAssertEqual(currentVariantFrame.origin.x, originalVariantFrame.origin.x, accuracy: 1)
        XCTAssertEqual(currentVariantFrame.origin.y, originalVariantFrame.origin.y, accuracy: 1)
        attachScreenshot("canvas-card-dragged-without-selection", of: application)
    }
}
