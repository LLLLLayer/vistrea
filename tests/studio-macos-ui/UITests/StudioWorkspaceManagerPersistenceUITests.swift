import XCTest

final class StudioWorkspaceManagerPersistenceUITests: StudioUITestCase {
    func testWorkspaceManagerUsesRealPersistenceForRecoveryGarbageCollectionAndRestore() throws {
        let fixture = try preparePersistedWorkspaceFixture()
        let application = try launchPersistedStudio(fixture)
        requireElement(AccessibilityID.workspace, in: application, timeout: 15)

        let fileMenu = application.menuBars.menuBarItems["File"]
        XCTAssertTrue(fileMenu.waitForExistence(timeout: 5))
        fileMenu.click()
        let manageWorkspaces = application.menuItems["Manage Workspaces…"]
        XCTAssertTrue(manageWorkspaces.waitForExistence(timeout: 2))
        manageWorkspaces.click()

        requireElement(AccessibilityID.workspaceManager, in: application)
        requireElement(AccessibilityID.workspaceMaintenance, in: application)
        requireElement(
            AccessibilityID.workspaceMaintenanceRestore(fixture.recoveryPointID),
            in: application,
            timeout: 15
        )

        let reason = requireElement(
            AccessibilityID.workspaceMaintenanceRecoveryPointReason,
            in: application
        )
        reason.click()
        reason.typeKey("a", modifierFlags: .command)
        reason.typeText("UI automation checkpoint")
        requireElement(
            AccessibilityID.workspaceMaintenanceCreateRecoveryPoint,
            in: application
        ).click()
        requireElement(AccessibilityID.workspaceMaintenanceResult, in: application, timeout: 15)

        requireElement(
            AccessibilityID.workspaceMaintenanceGarbageAnalyze,
            in: application
        ).click()
        requireElement(
            AccessibilityID.workspaceMaintenanceGarbagePreview,
            in: application,
            timeout: 20
        )
        let confirmation = requireElement(
            AccessibilityID.workspaceMaintenanceGarbageConfirmationField,
            in: application
        )
        confirmation.click()
        confirmation.typeText("DELETE")
        let apply = requireElement(
            AccessibilityID.workspaceMaintenanceGarbageApply,
            in: application
        )
        XCTAssertTrue(waitUntil(timeout: 2) { apply.isEnabled })
        apply.click()
        requireTextContaining(
            "Storage cleanup completed: deleted 1 object(s)",
            in: application,
            timeout: 20
        )

        requireElement(
            AccessibilityID.workspaceMaintenanceRestore(fixture.recoveryPointID),
            in: application,
            timeout: 15
        ).click()
        requireElement(
            AccessibilityID.workspaceMaintenanceRestoreConfirmation,
            in: application
        ).click()
        requireTextContaining("Restored schema 1", in: application, timeout: 20)
        requireElement(AccessibilityID.workspaceMaintenance, in: application)
        attachScreenshot("workspace-manager-persisted-maintenance-complete", of: application)
    }
}
