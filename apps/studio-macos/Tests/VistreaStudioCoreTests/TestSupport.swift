import Foundation
import VistreaRuntimeModels
@testable import VistreaStudioCore

/// Write-surface defaults so read-focused test doubles stay small. These
/// defaults exist only in the test module; the production clients implement
/// every operation explicitly in the Core module.
extension HostClient {
    func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support tuning writes.")
    }

    func applyTuningPatch(
        patchID: String,
        previewTTLMilliseconds: Int?
    ) async throws -> TuningApplicationSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support tuning writes.")
    }

    func revertTuningApplication(id: String) async throws -> TuningApplicationSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support tuning writes.")
    }

    func listActiveTuningApplications() async throws -> TuningApplicationPage {
        TuningApplicationPage(items: [])
    }

    func getReviewIssue(id: String) async throws -> ReviewIssueSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support issue lookups.")
    }

    func transitionReviewIssue(
        id: String,
        _ request: ReviewIssueTransitionRequest
    ) async throws -> ReviewIssueSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support issue writes.")
    }

    func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support wiki writes.")
    }

    func getWikiNode(id: String) async throws -> WikiNodeDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support wiki lookups.")
    }

    func reviseWikiNode(id: String, _ draft: WikiNodeRevisionDraft) async throws -> WikiNodeDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support wiki writes.")
    }

    func getScreenState(id: String) async throws -> ScreenStateDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support Screen State lookups.")
    }

    func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary {
        throw HostClientError.fixtureUnavailable("This test double does not support wiki links.")
    }

    func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage {
        WikiNodePage(items: [])
    }

    func mergeScreenStates(_ command: MergeScreenStatesCommand) async throws -> IdentityCurationResult {
        throw HostClientError.fixtureUnavailable("This test double does not support identity curation.")
    }

    func splitScreenState(_ command: SplitScreenStateCommand) async throws -> IdentityCurationResult {
        throw HostClientError.fixtureUnavailable("This test double does not support identity curation.")
    }

    func listDesignReferences() async throws -> DesignReferencePage {
        DesignReferencePage(items: [])
    }

    func getDesignReference(id: String) async throws -> DesignReferenceDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support design references.")
    }

    func listDesignComparisons(
        designReferenceID: String?,
        targetSnapshotID: String?
    ) async throws -> DesignComparisonPage {
        DesignComparisonPage(items: [])
    }

    func runDesignComparison(_ command: DesignComparisonCommand) async throws -> DesignComparisonDetail {
        throw HostClientError.fixtureUnavailable("This test double does not support design comparisons.")
    }

    func runExploration(_ command: ExplorationRunCommand) async throws -> ExplorationOperationRef {
        throw HostClientError.fixtureUnavailable("This test double does not support exploration.")
    }

    func getExplorationOperation(id: String) async throws -> ExplorationOperationRecord {
        throw HostClientError.fixtureUnavailable("This test double does not support exploration.")
    }

    func cancelExploration(id: String) async throws -> ExplorationOperationRef {
        throw HostClientError.fixtureUnavailable("This test double does not support exploration.")
    }
}

enum StudioTestFixtures {
    static var repositoryRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url.deleteLastPathComponent()
        }
        return url
    }

    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: repositoryRoot.appending(path: relativePath))
    }

    static func snapshot(
        _ relativePath: String = "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
    ) throws -> RuntimeSnapshot {
        try RuntimeSnapshotCodec.decode(try data(relativePath))
    }
}
