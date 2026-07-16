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
}
