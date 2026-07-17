import XCTest
@testable import VistreaStudioApp

final class StudioLaunchConfigurationTests: XCTestCase {
    func testProductionIsTheDefaultLaunchMode() {
        XCTAssertEqual(
            StudioLaunchConfiguration(arguments: ["VistreaStudio"]).content,
            .production
        )
        XCTAssertFalse(
            StudioLaunchConfiguration(arguments: ["VistreaStudio"]).isUITesting
        )
    }

    func testUITestingUsesTheFixtureWorkspaceOnlyWhenExplicitlyRequested() {
        let configuration = StudioLaunchConfiguration(
            arguments: ["VistreaStudio", StudioLaunchConfiguration.uiTestingWorkspaceArgument]
        )

        XCTAssertEqual(configuration.content, .fixtureWorkspace)
        XCTAssertTrue(configuration.isUITesting)
    }

    func testWelcomeUITestingModeTakesPrecedence() {
        let configuration = StudioLaunchConfiguration(
            arguments: [
                "VistreaStudio",
                StudioLaunchConfiguration.uiTestingWorkspaceArgument,
                StudioLaunchConfiguration.uiTestingWelcomeArgument,
            ]
        )

        XCTAssertEqual(configuration.content, .fixtureWelcome)
        XCTAssertTrue(configuration.isUITesting)
    }

    func testCanvasEmptyAndFailureModesAreExplicit() {
        XCTAssertEqual(
            StudioLaunchConfiguration(
                arguments: [
                    "VistreaStudio",
                    StudioLaunchConfiguration.uiTestingCanvasEmptyArgument,
                ]
            ).content,
            .fixtureCanvasEmpty
        )
        XCTAssertEqual(
            StudioLaunchConfiguration(
                arguments: [
                    "VistreaStudio",
                    StudioLaunchConfiguration.uiTestingCanvasFailureArgument,
                ]
            ).content,
            .fixtureCanvasFailure
        )
    }

    func testPersistedWorkspaceModeRequiresItsOwnExplicitArgument() {
        let configuration = StudioLaunchConfiguration(
            arguments: [
                "VistreaStudio",
                StudioLaunchConfiguration.uiTestingWorkspaceArgument,
                StudioLaunchConfiguration.uiTestingPersistedWorkspaceArgument,
            ]
        )
        XCTAssertEqual(configuration.content, .persistedWorkspace)
        XCTAssertTrue(configuration.isUITesting)
    }
}
