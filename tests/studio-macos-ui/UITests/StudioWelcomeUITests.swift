import XCTest

final class StudioWelcomeUITests: StudioUITestCase {
    func testWelcomeExposesWorkspaceEntryActionsAndStableAccessibility() {
        let application = launchStudio(argument: "--ui-testing-welcome")

        requireElement(AccessibilityID.welcome, in: application)
        requireElement(AccessibilityID.welcomeNewWorkspace, in: application)
        requireElement(AccessibilityID.welcomeOpenWorkspace, in: application)
        requireElement(AccessibilityID.welcomeRecentWorkspaces, in: application)
        requireText("No Recent Workspaces", in: application)

        attachScreenshot("welcome-empty", of: application)
    }

    func testWelcomeOpensEmptyWorkspaceManagerAndReturnsWithoutMaintenanceActions() {
        let application = launchStudio(argument: "--ui-testing-welcome")
        requireElement(AccessibilityID.welcome, in: application)

        let fileMenu = application.menuBars.menuBarItems["File"]
        XCTAssertTrue(
            fileMenu.waitForExistence(timeout: 5),
            "Studio did not expose its File menu."
        )
        fileMenu.click()

        let manageWorkspaces = application.menuItems["Manage Workspaces…"]
        XCTAssertTrue(
            manageWorkspaces.waitForExistence(timeout: 2),
            "The File menu did not expose Manage Workspaces…."
        )
        XCTAssertTrue(manageWorkspaces.isEnabled)
        manageWorkspaces.click()

        requireElement(AccessibilityID.workspaceManager, in: application)
        requireElement(AccessibilityID.workspaceManagerList, in: application)
        requireElement(AccessibilityID.workspaceManagerDetail, in: application)
        let back = requireElement(AccessibilityID.workspaceManagerClose, in: application)
        requireText("No Workspaces", in: application)
        requireText("Select a Workspace", in: application)

        XCTAssertEqual(
            query(AccessibilityID.workspaceMaintenance, in: application).count,
            0,
            "An empty no-Host launch must not expose Workspace maintenance."
        )
        XCTAssertEqual(
            query(AccessibilityID.workspaceMaintenanceCreateRecoveryPoint, in: application).count,
            0,
            "Recovery-point creation requires an eligible Workspace and online Host."
        )
        XCTAssertEqual(
            query(AccessibilityID.workspaceMaintenanceGarbage, in: application).count,
            0,
            "Storage cleanup requires an eligible selected Workspace."
        )
        XCTAssertEqual(
            query(
                AccessibilityID.workspaceMaintenanceRecoverInterruptedRestore,
                in: application
            ).count,
            0,
            "Interrupted-restore recovery requires an eligible failed Workspace."
        )
        XCTAssertEqual(
            query(AccessibilityID.workspaceMaintenanceRecoverStaleLock, in: application).count,
            0,
            "Stale-lock recovery requires an eligible failed Workspace."
        )
        attachScreenshot("workspace-manager-empty", of: application)

        XCTAssertTrue(back.isHittable, "The empty Workspace Manager Back action is not hittable.")
        back.click()

        requireElement(AccessibilityID.welcome, in: application)
        XCTAssertTrue(
            element(AccessibilityID.workspaceManager, in: application)
                .waitForNonExistence(timeout: 2),
            "Back did not close the Workspace Manager."
        )
        attachScreenshot("welcome-returned-from-workspace-manager", of: application)
    }
}
