import Foundation
import XCTest
@testable import VistreaStudioCore

private let validBearerToken = String(repeating: "A", count: 43)
private let projectID = "project_019f0000-0000-7000-8000-000000000001"
private let applicationID = "dev.vistrea.demo"
private let snapshotID = "snapshot_019f0000-0000-7000-8000-000000000002"
private let treeID = "tree_019f0000-0000-7000-8000-000000000002"
private let nodeID = "node_019f0000-0000-7000-8000-000000000011"
private let designReferenceID = "designref_019f0000-0000-7000-8000-000000000001"
private let comparisonID = "comparison_019f0000-0000-7000-8000-000000000001"
private let differenceID = "difference_019f0000-0000-7000-8000-000000000001"
private let issueID = "issue_019f0000-0000-7000-8000-000000000001"
private let graphID = "graph_019f0000-0000-7000-8000-000000000001"
private let stateOneID = "screenstate_019f0000-0000-7000-8000-000000000001"
private let stateTwoID = "screenstate_019f0000-0000-7000-8000-000000000002"

final class DesignReviewClientTests: XCTestCase {
    private func makeClient(_ transport: DesignRecordingTransport) throws -> HTTPHostClient {
        try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )
    }

    private func bodyObject(of request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )
    }

    private static func referenceJSON() -> String {
        #"""
        {"design_reference_id":"\#(designReferenceID)","protocol_version":{"major":1,"minor":0},
         "revision":1,"kind":"design_artifact","name":"Checkout confirmation baseline",
         "artifact":{"artifact_id":"artifact_019f0000-0000-7000-8000-000000000001",
           "protocol_version":{"major":1,"minor":0},"kind":"design",
           "object":{"hash":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
             "media_type":"image/png","byte_size":1024,"compression":"none",
             "logical_name":"checkout.png","extensions":{}},
           "created_at":"2026-07-12T02:00:00Z","retention":"pinned","extensions":{}},
         "canvas_size":{"width":390,"height":844},"pixel_size":{"width":1170,"height":2532},
         "created_at":"2026-07-12T02:00:00Z","created_by":{"kind":"human","id":"designer-1","extensions":{}},
         "updated_at":"2026-07-12T02:00:00Z","updated_by":{"kind":"human","id":"designer-1","extensions":{}},
         "extensions":{}}
        """#
    }

    private static func comparisonJSON() -> String {
        #"""
        {"comparison_id":"\#(comparisonID)","protocol_version":{"major":1,"minor":0},"revision":1,
         "design_reference_id":"\#(designReferenceID)","target_snapshot_id":"\#(snapshotID)",
         "quality":"partial","mapping_ids":[],
         "differences":[
           {"difference_id":"difference_019f0000-0000-7000-8000-000000000001",
            "runtime_target":{"snapshot_id":"\#(snapshotID)","tree_id":"\#(treeID)","node_id":"\#(nodeID)",
              "stable_id":"demo.home.open_catalog","extensions":{}},
            "category":"frame","severity":"major","delta":12.5,
            "expected":{"kind":"rect","value":{"x":24,"y":108,"width":342,"height":52},"extensions":{}},
            "actual":{"kind":"rect","value":{"x":24,"y":120,"width":342,"height":52},"extensions":{}},
            "evidence":[],"extensions":{}},
           {"difference_id":"difference_019f0000-0000-7000-8000-000000000002",
            "runtime_target":{"snapshot_id":"\#(snapshotID)","tree_id":"\#(treeID)","node_id":"\#(nodeID)",
              "stable_id":"demo.home.open_catalog","extensions":{}},
            "category":"color","severity":"minor","delta":0.08,
            "expected":{"kind":"color_rgba","value":{"red":0.2,"green":0.4,"blue":0.9,"alpha":1},
              "color_space":"srgb","extensions":{}},
            "actual":{"kind":"color_rgba","value":{"red":0.25,"green":0.45,"blue":0.85,"alpha":1},
              "color_space":"srgb","extensions":{}},
            "evidence":[],"extensions":{"vistrea.pixel":{"design_sampled_pixels":100,"screenshot_sampled_pixels":100}}}
         ],
         "evidence":[],"completed_at":"2026-07-12T02:01:30Z",
         "completed_by":{"kind":"human","id":"studio","extensions":{}},
         "extensions":{"vistrea.pixel":{"status":"unavailable","reason":"The Snapshot has no screenshot."}}}
        """#
    }

    private static func issueJSON(revision: Int, state: String) -> String {
        #"{"issue_id":"\#(issueID)","revision":\#(revision),"title":"Design frame differs on demo.home.open_catalog","category":"frame","severity":"major","state":"\#(state)","updated_at":"2026-07-12T02:02:00Z","runtime_target":{"snapshot_id":"\#(snapshotID)"}}"#
    }

    private static func curationResultJSON(revision: Int, stateID: String) -> String {
        #"""
        {"screen_graph_id":"\#(graphID)","graph_revision":\#(revision),
         "decision":{"state_identity_decision_id":"identitydecision_019f0000-0000-7000-8000-000000000001",
           "protocol_version":{"major":1,"minor":0},"revision":1,"created_at":"2026-07-12T02:02:00Z",
           "created_by":{"kind":"human","id":"studio","extensions":{}},"source":"manual","kind":"merge",
           "input_state_ids":["\#(stateOneID)","\#(stateTwoID)"],"output_state_ids":["\#(stateID)"],
           "observation_ids":["observation-b"],"confidence":1,"evidence":[],"extensions":{}},
         "state":{"screen_state_id":"\#(stateID)","protocol_version":{"major":1,"minor":0},"revision":2,
           "title":"Home","kind":"screen","status":"active",
           "canonical_snapshot_id":"\#(snapshotID)",
           "observation_ids":["observation-a","observation-b"],
           "identity":{"strategy":"structural"},
           "first_seen":"2026-07-12T00:00:00Z","last_seen":"2026-07-12T00:00:05Z","extensions":{}}}
        """#
    }

    func testDesignReferenceRoutesDecodeCanonicalDocuments() async throws {
        let transport = DesignRecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                body: Data(#"{"items":[\#(Self.referenceJSON())],"next_cursor":"cursor-1"}"#.utf8)
            ),
            HostHTTPResponse(statusCode: 200, body: Data(Self.referenceJSON().utf8)),
        ])
        let client = try makeClient(transport)

        let page = try await client.listDesignReferences()
        XCTAssertEqual(page.items.map(\.designReferenceID), [designReferenceID])
        XCTAssertEqual(page.nextCursor, "cursor-1")

        let reference = try await client.getDesignReference(id: designReferenceID)
        XCTAssertEqual(reference.name, "Checkout confirmation baseline")
        XCTAssertEqual(reference.kind, "design_artifact")
        XCTAssertEqual(
            reference.artifact.object.hash,
            "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        )
        XCTAssertEqual(reference.artifact.object.mediaType, "image/png")
        XCTAssertEqual(reference.canvasSize, SizeSummary(width: 390, height: 844))
        XCTAssertEqual(reference.pixelSize, PixelSizeSummary(width: 1_170, height: 2_532))

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "GET"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/design-references",
            "/v1/design-references/\(designReferenceID)",
        ])
    }

    func testDesignComparisonRoutesEncodeCommandsAndDecodeDifferences() async throws {
        let transport = DesignRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 201, body: Data(Self.comparisonJSON().utf8)),
            HostHTTPResponse(
                statusCode: 200,
                body: Data(#"{"items":[\#(Self.comparisonJSON())]}"#.utf8)
            ),
        ])
        let client = try makeClient(transport)

        let comparison = try await client.runDesignComparison(
            DesignComparisonCommand(
                designReferenceID: designReferenceID,
                targetSnapshotID: snapshotID,
                includePixel: true,
                completedBy: .studio
            )
        )
        XCTAssertEqual(comparison.comparisonID, comparisonID)
        XCTAssertEqual(comparison.quality, "partial")
        XCTAssertEqual(comparison.differences.count, 2)
        let frame = comparison.differences[0]
        XCTAssertEqual(frame.category, "frame")
        XCTAssertEqual(frame.severity, "major")
        XCTAssertEqual(frame.delta, 12.5)
        XCTAssertEqual(
            frame.expected.rectValue,
            RectValueSummary(x: 24, y: 108, width: 342, height: 52)
        )
        XCTAssertEqual(
            frame.actual.rectValue,
            RectValueSummary(x: 24, y: 120, width: 342, height: 52)
        )
        XCTAssertEqual(frame.runtimeTarget?.nodeID, nodeID)
        XCTAssertEqual(frame.runtimeTarget?.stableID, "demo.home.open_catalog")
        let color = comparison.differences[1]
        XCTAssertEqual(color.category, "color")
        XCTAssertEqual(
            color.expected.colorValue,
            ColorRGBAValueSummary(red: 0.2, green: 0.4, blue: 0.9, alpha: 1)
        )
        XCTAssertEqual(
            color.actual.colorValue,
            ColorRGBAValueSummary(red: 0.25, green: 0.45, blue: 0.85, alpha: 1)
        )
        XCTAssertEqual(comparison.pixel?.status, "unavailable")
        XCTAssertEqual(comparison.pixel?.reason, "The Snapshot has no screenshot.")

        let listed = try await client.listDesignComparisons(
            designReferenceID: designReferenceID,
            targetSnapshotID: snapshotID
        )
        XCTAssertEqual(listed.items.map(\.comparisonID), [comparisonID])

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/design-comparisons")
        let runBody = try bodyObject(of: requests[0])
        XCTAssertEqual(
            Set(runBody.keys),
            ["design_reference_id", "target_snapshot_id", "include_pixel", "completed_by"]
        )
        XCTAssertEqual(runBody["design_reference_id"] as? String, designReferenceID)
        XCTAssertEqual(runBody["target_snapshot_id"] as? String, snapshotID)
        XCTAssertEqual(runBody["include_pixel"] as? Bool, true)
        let actor = try XCTUnwrap(runBody["completed_by"] as? [String: Any])
        XCTAssertEqual(actor["kind"] as? String, "human")
        XCTAssertEqual(actor["id"] as? String, "studio")
        XCTAssertNotNil(actor["extensions"])
        let listComponents = try XCTUnwrap(
            URLComponents(url: XCTUnwrap(requests[1].url), resolvingAgainstBaseURL: false)
        )
        XCTAssertEqual(listComponents.path, "/v1/design-comparisons")
        XCTAssertEqual(
            Set(listComponents.queryItems?.map { "\($0.name)=\($0.value ?? "")" } ?? []),
            [
                "design_reference_id=\(designReferenceID)",
                "target_snapshot_id=\(snapshotID)",
            ]
        )
    }

    func testDifferencePromotionAndFreshBuildRecaptureUseCanonicalRoutes() async throws {
        let snapshotJSON = try XCTUnwrap(
            String(
                data: StudioTestFixtures.data(
                    "protocol/fixtures/v1/runtime-snapshot/valid/ios-uikit.json"
                ),
                encoding: .utf8
            )
        )
        let recaptureJSON = #"{"snapshot":\#(snapshotJSON),"comparison":\#(Self.comparisonJSON()),"verification":{"verification_record_id":"verification_019f0000-0000-7000-8000-000000000001","issue_id":"\#(issueID)","issue_revision":1,"basis":"real_build","result":"passed","verified_snapshot_id":"\#(snapshotID)","verified_build_id":"build_019f0000-0000-7000-8000-000000000002","verified_at":"2026-07-12T02:03:00Z"},"issue":\#(Self.issueJSON(revision: 2, state: "resolved"))}"#
        let transport = DesignRecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 201,
                body: Data(Self.issueJSON(revision: 1, state: "open").utf8)
            ),
            HostHTTPResponse(statusCode: 201, body: Data(recaptureJSON.utf8)),
        ])
        let client = try makeClient(transport)

        let issue = try await client.createReviewIssueFromDifference(
            comparisonID: comparisonID,
            CreateReviewIssueFromDifferenceRequest(differenceID: differenceID)
        )
        XCTAssertEqual(issue.issueID, issueID)
        XCTAssertEqual(issue.state, "open")

        let result = try await client.recaptureAndVerifyReviewIssue(
            id: issueID,
            RecaptureReviewIssueRequest(expectedRevision: 1)
        )
        XCTAssertEqual(result.snapshot.snapshotID.rawValue, snapshotID)
        XCTAssertEqual(result.verification.basis, "real_build")
        XCTAssertEqual(result.verification.result, "passed")
        XCTAssertEqual(
            result.verification.verifiedBuildID,
            "build_019f0000-0000-7000-8000-000000000002"
        )
        XCTAssertEqual(result.issue.state, "resolved")

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/design-comparisons/\(comparisonID)/issues",
            "/v1/review-issues/\(issueID)/recapture-verifications",
        ])
        let promotionBody = try bodyObject(of: requests[0])
        XCTAssertEqual(Set(promotionBody.keys), ["difference_id", "created_by"])
        XCTAssertEqual(promotionBody["difference_id"] as? String, differenceID)
        let recaptureBody = try bodyObject(of: requests[1])
        XCTAssertEqual(Set(recaptureBody.keys), ["expected_revision", "verified_by"])
        XCTAssertEqual(recaptureBody["expected_revision"] as? Int, 1)
        let verifiedBy = try XCTUnwrap(recaptureBody["verified_by"] as? [String: Any])
        XCTAssertEqual(verifiedBy["id"] as? String, "studio")
    }

    func testIdentityCurationRoutesEncodeCanonicalCommands() async throws {
        let transport = DesignRecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 201,
                body: Data(Self.curationResultJSON(revision: 2, stateID: stateOneID).utf8)
            ),
            HostHTTPResponse(
                statusCode: 201,
                body: Data(Self.curationResultJSON(revision: 3, stateID: stateTwoID).utf8)
            ),
        ])
        let client = try makeClient(transport)

        let merged = try await client.mergeScreenStates(
            MergeScreenStatesCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateIDs: [stateOneID, stateTwoID],
                intoStateID: stateOneID,
                expectedGraphRevision: 1,
                mergedBy: .studio,
                justification: "Same product screen"
            )
        )
        XCTAssertEqual(merged.screenGraphID, graphID)
        XCTAssertEqual(merged.graphRevision, 2)
        XCTAssertEqual(merged.decision.kind, "merge")
        XCTAssertEqual(merged.state.screenStateID, stateOneID)
        XCTAssertEqual(merged.state.observationIDs, ["observation-a", "observation-b"])

        let split = try await client.splitScreenState(
            SplitScreenStateCommand(
                projectID: projectID,
                applicationID: applicationID,
                stateID: stateOneID,
                observationIDs: ["observation-b"],
                title: "Variant",
                expectedGraphRevision: 2,
                splitBy: .studio
            )
        )
        XCTAssertEqual(split.graphRevision, 3)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/screen-graph/state-merges",
            "/v1/screen-graph/state-splits",
        ])
        let mergeBody = try bodyObject(of: requests[0])
        XCTAssertEqual(
            Set(mergeBody.keys),
            [
                "project_id", "application_id", "state_ids", "into_state_id",
                "expected_graph_revision", "merged_by", "justification",
            ]
        )
        XCTAssertEqual(mergeBody["state_ids"] as? [String], [stateOneID, stateTwoID])
        XCTAssertEqual(mergeBody["into_state_id"] as? String, stateOneID)
        XCTAssertEqual(mergeBody["expected_graph_revision"] as? Int, 1)
        let mergedBy = try XCTUnwrap(mergeBody["merged_by"] as? [String: Any])
        XCTAssertEqual(mergedBy["kind"] as? String, "human")
        XCTAssertEqual(mergedBy["id"] as? String, "studio")
        let splitBody = try bodyObject(of: requests[1])
        XCTAssertEqual(
            Set(splitBody.keys),
            [
                "project_id", "application_id", "state_id", "observation_ids",
                "title", "expected_graph_revision", "split_by",
            ]
        )
        XCTAssertEqual(splitBody["observation_ids"] as? [String], ["observation-b"])
        XCTAssertEqual(splitBody["title"] as? String, "Variant")
        XCTAssertEqual(splitBody["expected_graph_revision"] as? Int, 2)
    }

    func testMergeRevisionConflictSurfacesVerbatim() async throws {
        let transport = DesignRecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 409,
                body: Data(
                    #"{"request_id":"request-9","error":{"code":"conflict","message":"The Screen Graph revision does not match.","retryable":true}}"#.utf8
                )
            ),
        ])
        let client = try makeClient(transport)

        do {
            _ = try await client.mergeScreenStates(
                MergeScreenStatesCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateIDs: [stateOneID, stateTwoID],
                    expectedGraphRevision: 1,
                    mergedBy: .studio
                )
            )
            XCTFail("Expected the graph-revision conflict to surface.")
        } catch let error as HostClientError {
            guard case let .server(statusCode, _, code, message, retryable) = error else {
                return XCTFail("Expected a Host server error, received \(error)")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(code, "conflict")
            XCTAssertEqual(message, "The Screen Graph revision does not match.")
            XCTAssertTrue(retryable)
        }
    }

    func testDesignAndCurationRoutesValidateInputBeforeTransport() async throws {
        let transport = DesignRecordingTransport(responses: [])
        let client = try makeClient(transport)

        await XCTAssertThrowsClientValidation {
            _ = try await client.getDesignReference(id: "designref_invalid")
        }
        await XCTAssertThrowsClientValidation {
            _ = try await client.listDesignComparisons(
                designReferenceID: designReferenceID,
                targetSnapshotID: "snapshot_invalid"
            )
        }
        await XCTAssertThrowsClientValidation {
            _ = try await client.runDesignComparison(
                DesignComparisonCommand(
                    designReferenceID: "not-a-reference",
                    targetSnapshotID: snapshotID,
                    completedBy: .studio
                )
            )
        }
        await XCTAssertThrowsClientValidation {
            _ = try await client.createReviewIssueFromDifference(
                comparisonID: comparisonID,
                CreateReviewIssueFromDifferenceRequest(differenceID: "difference_invalid")
            )
        }
        await XCTAssertThrowsClientValidation {
            _ = try await client.recaptureAndVerifyReviewIssue(
                id: issueID,
                RecaptureReviewIssueRequest(expectedRevision: 0)
            )
        }
        // A merge names at least two states.
        await XCTAssertThrowsClientValidation {
            _ = try await client.mergeScreenStates(
                MergeScreenStatesCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateIDs: [stateOneID],
                    expectedGraphRevision: 1,
                    mergedBy: .studio
                )
            )
        }
        // The survivor must be one of the merged states.
        await XCTAssertThrowsClientValidation {
            _ = try await client.mergeScreenStates(
                MergeScreenStatesCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateIDs: [stateOneID, stateTwoID],
                    intoStateID: "screenstate_019f0000-0000-7000-8000-0000000000ff",
                    expectedGraphRevision: 1,
                    mergedBy: .studio
                )
            )
        }
        // The graph revision starts at 1.
        await XCTAssertThrowsClientValidation {
            _ = try await client.mergeScreenStates(
                MergeScreenStatesCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateIDs: [stateOneID, stateTwoID],
                    expectedGraphRevision: 0,
                    mergedBy: .studio
                )
            )
        }
        // A split moves at least one observation.
        await XCTAssertThrowsClientValidation {
            _ = try await client.splitScreenState(
                SplitScreenStateCommand(
                    projectID: projectID,
                    applicationID: applicationID,
                    stateID: stateOneID,
                    observationIDs: [],
                    expectedGraphRevision: 1,
                    splitBy: .studio
                )
            )
        }

        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }
}

private func XCTAssertThrowsClientValidation(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected a client-side validation failure.", file: file, line: line)
    } catch let error as HostClientError {
        switch error {
        case .invalidIdentifier, .invalidConfiguration:
            return
        default:
            XCTFail("Expected client validation, received \(error)", file: file, line: line)
        }
    } catch {
        XCTFail("Expected HostClientError, received \(error)", file: file, line: line)
    }
}

private actor DesignRecordingTransport: HostHTTPTransport {
    private var responses: [HostHTTPResponse]
    private(set) var requests: [URLRequest] = []

    init(responses: [HostHTTPResponse]) {
        self.responses = responses
    }

    func execute(_ request: URLRequest, maximumResponseBytes: Int) async throws -> HostHTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else {
            throw HostClientError.transport("No test response remains.")
        }
        return responses.removeFirst()
    }
}
