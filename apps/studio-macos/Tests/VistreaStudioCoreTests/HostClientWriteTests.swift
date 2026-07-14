import Foundation
import XCTest
@testable import VistreaStudioCore

private let validBearerToken = String(repeating: "A", count: 43)
private let snapshotID = "snapshot_019f0000-0000-7000-8000-000000000002"
private let treeID = "tree_019f0000-0000-7000-8000-000000000002"
private let nodeID = "node_019f0000-0000-7000-8000-000000000011"
private let patchID = "patch_019f0000-0000-7000-8000-000000000001"
private let applicationID = "tuningapp_019f0000-0000-7000-8000-000000000001"
private let issueID = "issue_019f0000-0000-7000-8000-000000000001"
private let wikiNodeID = "wiki_019f0000-0000-7000-8000-000000000001"
private let wikiLinkID = "wikilink_019f0000-0000-7000-8000-000000000001"
private let screenStateID = "screenstate_019f0000-0000-7000-8000-000000000001"

final class HostClientWriteTests: XCTestCase {
    private func makeClient(_ transport: WriteRecordingTransport) throws -> HTTPHostClient {
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

    private static func patchResponseJSON() -> String {
        #"""
        {"patch_id":"\#(patchID)","protocol_version":{"major":1,"minor":0},"revision":1,
         "title":"Studio alpha preview for demo.home.open_catalog","target_snapshot_id":"\#(snapshotID)",
         "status":"draft","issue_ids":[],"changes":[],"created_at":"2026-07-12T00:00:00Z",
         "extensions":{}}
        """#
    }

    private static func applicationResponseJSON(status: String) -> String {
        #"""
        {"tuning_application_id":"\#(applicationID)","protocol_version":{"major":1,"minor":0},
         "revision":1,"patch_id":"\#(patchID)","patch_revision":1,
         "connection_id":"connection_019f0000-0000-7000-8000-000000000001",
         "expected_snapshot_id":"\#(snapshotID)","status":"\#(status)",
         "applied_changes":[{"tuning_change_id":"tuningchange_019f0000-0000-7000-8000-000000000001",
           "runtime_target":{"snapshot_id":"\#(snapshotID)","tree_id":"\#(treeID)","node_id":"\#(nodeID)","extensions":{}},
           "original_value":{"kind":"number","value":1,"extensions":{}},
           "applied_value":{"kind":"number","value":0.5,"extensions":{}},"extensions":{}}],
         "rejected_changes":[{"tuning_change_id":"tuningchange_019f0000-0000-7000-8000-000000000002",
           "runtime_target":{"snapshot_id":"\#(snapshotID)","tree_id":"\#(treeID)","node_id":"\#(nodeID)","extensions":{}},
           "reason_code":"stale_snapshot","message":"The preview target Snapshot is stale.","extensions":{}}],
         "started_at":"2026-07-12T00:00:01Z","actor":{"kind":"human","id":"studio","extensions":{}},
         "extensions":{}}
        """#
    }

    func testTuningRoutesEncodeCanonicalCommandsAndDecodeApplications() async throws {
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 201, body: Data(Self.patchResponseJSON().utf8)),
            HostHTTPResponse(statusCode: 201, body: Data(Self.applicationResponseJSON(status: "partially_active").utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(Self.applicationResponseJSON(status: "reverted").utf8)),
            HostHTTPResponse(
                statusCode: 200,
                body: Data(#"{"items":[\#(Self.applicationResponseJSON(status: "active"))]}"#.utf8)
            ),
        ])
        let client = try makeClient(transport)

        let patch = try await client.createTuningPatch(
            TuningPatchDraft(
                title: "Studio alpha preview for demo.home.open_catalog",
                targetSnapshotID: snapshotID,
                changes: [
                    TuningChangeDraft(
                        target: TuningNodeTargetDraft(
                            snapshotID: snapshotID,
                            treeID: treeID,
                            nodeID: nodeID,
                            stableID: "demo.home.open_catalog"
                        ),
                        property: "alpha",
                        originalValue: TuningNumberValueDraft(value: 1),
                        previewValue: TuningNumberValueDraft(value: 0.5)
                    ),
                ],
                createdBy: .studio
            )
        )
        XCTAssertEqual(patch.patchID, patchID)
        XCTAssertEqual(patch.targetSnapshotID, snapshotID)

        let application = try await client.applyTuningPatch(
            patchID: patchID,
            previewTTLMilliseconds: 30_000
        )
        XCTAssertEqual(application.status, "partially_active")
        XCTAssertEqual(application.appliedChanges.count, 1)
        XCTAssertEqual(application.rejectedChanges.first?.reasonCode, "stale_snapshot")

        let reverted = try await client.revertTuningApplication(id: applicationID)
        XCTAssertEqual(reverted.status, "reverted")

        let active = try await client.listActiveTuningApplications()
        XCTAssertEqual(active.items.map(\.status), ["active"])

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST", "POST", "GET"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/tuning-patches",
            "/v1/tuning-applications",
            "/v1/tuning-applications/\(applicationID)/revert",
            "/v1/tuning-applications/active",
        ])
        XCTAssertTrue(requests.prefix(3).allSatisfy {
            $0.value(forHTTPHeaderField: "Content-Type") == "application/json"
        })

        let patchBody = try bodyObject(of: requests[0])
        XCTAssertEqual(
            Set(patchBody.keys),
            ["title", "target_snapshot_id", "changes", "created_by"]
        )
        let changes = try XCTUnwrap(patchBody["changes"] as? [[String: Any]])
        XCTAssertEqual(
            Set(changes[0].keys),
            ["runtime_target", "property", "original_value", "preview_value"]
        )
        XCTAssertEqual(changes[0]["property"] as? String, "alpha")
        let target = try XCTUnwrap(changes[0]["runtime_target"] as? [String: Any])
        XCTAssertEqual(target["snapshot_id"] as? String, snapshotID)
        XCTAssertEqual(target["tree_id"] as? String, treeID)
        XCTAssertEqual(target["node_id"] as? String, nodeID)
        XCTAssertEqual(target["stable_id"] as? String, "demo.home.open_catalog")
        let previewValue = try XCTUnwrap(changes[0]["preview_value"] as? [String: Any])
        XCTAssertEqual(previewValue["kind"] as? String, "number")
        XCTAssertEqual(previewValue["value"] as? Double, 0.5)
        XCTAssertNotNil(previewValue["extensions"])
        let actor = try XCTUnwrap(patchBody["created_by"] as? [String: Any])
        XCTAssertEqual(actor["kind"] as? String, "human")
        XCTAssertEqual(actor["id"] as? String, "studio")
        XCTAssertNotNil(actor["extensions"])

        let applyBody = try bodyObject(of: requests[1])
        XCTAssertEqual(Set(applyBody.keys), ["patch_id", "preview_ttl_ms"])
        XCTAssertEqual(applyBody["patch_id"] as? String, patchID)
        XCTAssertEqual(applyBody["preview_ttl_ms"] as? Int, 30_000)

        XCTAssertEqual(
            String(data: try XCTUnwrap(requests[2].httpBody), encoding: .utf8),
            "{}"
        )
    }

    func testReviewIssueRoutesAndConflictSurface() async throws {
        let issueJSON = #"""
        {"issue_id":"\#(issueID)","protocol_version":{"major":1,"minor":0},"revision":2,
         "title":"Button alpha differs from design","category":"alpha","severity":"major",
         "state":"in_progress","updated_at":"2026-07-12T02:06:00Z","extensions":{}}
        """#
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(issueJSON.utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(issueJSON.utf8)),
            HostHTTPResponse(
                statusCode: 409,
                body: Data(
                    #"{"request_id":"request-2","error":{"code":"conflict","message":"The request conflicts with the current Workspace state.","retryable":false}}"#.utf8
                )
            ),
        ])
        let client = try makeClient(transport)

        let loaded = try await client.getReviewIssue(id: issueID)
        XCTAssertEqual(loaded.state, "in_progress")
        XCTAssertEqual(loaded.revision, 2)

        let transitioned = try await client.transitionReviewIssue(
            id: issueID,
            ReviewIssueTransitionRequest(
                expectedRevision: 1,
                toState: "in_progress",
                reason: "Taking this for triage",
                changedBy: .studio
            )
        )
        XCTAssertEqual(transitioned.state, "in_progress")

        do {
            _ = try await client.transitionReviewIssue(
                id: issueID,
                ReviewIssueTransitionRequest(expectedRevision: 1, toState: "resolved", changedBy: .studio)
            )
            XCTFail("Expected the optimistic-concurrency conflict to surface.")
        } catch let error as HostClientError {
            guard case let .server(statusCode, _, code, _, _) = error else {
                return XCTFail("Expected a Host server error, received \(error)")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(code, "conflict")
        }

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/review-issues/\(issueID)",
            "/v1/review-issues/\(issueID)/transitions",
            "/v1/review-issues/\(issueID)/transitions",
        ])
        let transitionBody = try bodyObject(of: requests[1])
        XCTAssertEqual(
            Set(transitionBody.keys),
            ["expected_revision", "to_state", "reason", "changed_by"]
        )
        XCTAssertEqual(transitionBody["expected_revision"] as? Int, 1)
        XCTAssertEqual(transitionBody["to_state"] as? String, "in_progress")
        XCTAssertEqual(transitionBody["reason"] as? String, "Taking this for triage")
    }

    func testBuildScopedCanvasStateAndReviewIssueRoutes() async throws {
        let projectID = "project_019f0000-0000-7000-8000-000000000001"
        let buildID = "build_019f0000-0000-7000-8000-000000000002"
        let applicationVersion = "2.0.0"
        let hiddenStateID = "screenstate_019f0000-0000-7000-8000-000000000002"
        let graphJSON = #"""
        {"screen_graph_id":"graph_019f0000-0000-7000-8000-000000000001","revision":7,
         "entry_state_ids":["\#(screenStateID)"],
         "states":[
           {"screen_state_id":"\#(screenStateID)","title":"Current","kind":"screen","status":"active"},
           {"screen_state_id":"\#(hiddenStateID)","title":"Other build","kind":"screen","status":"active"}],
         "transitions":[],
         "extensions":{"vistrea.build_scope":{"build_id":"\#(buildID)",
           "application_version":"\#(applicationVersion)",
           "screen_state_ids":["\#(screenStateID)"],"transition_ids":[]}}}
        """#
        let stateJSON = #"""
        {"screen_state_id":"\#(screenStateID)","revision":3,"title":"Current","kind":"screen",
         "status":"active","canonical_snapshot_id":"\#(snapshotID)",
         "first_seen":"2026-07-12T00:00:00Z","last_seen":"2026-07-12T00:00:05Z"}
        """#
        let issuesJSON = #"""
        {"items":[{"issue_id":"\#(issueID)","revision":1,"title":"Scoped issue",
          "category":"frame","severity":"major","state":"open",
          "updated_at":"2026-07-12T00:00:05Z",
          "runtime_target":{"snapshot_id":"\#(snapshotID)"}}]}
        """#
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(graphJSON.utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(stateJSON.utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(issuesJSON.utf8)),
        ])
        let client = try makeClient(transport)

        let graph = try await client.getScreenGraph(
            projectID: projectID,
            applicationID: "dev.vistrea.demo",
            applicationVersion: applicationVersion,
            buildID: buildID
        )
        XCTAssertEqual(graph.states.map(\.id), [screenStateID])
        XCTAssertEqual(graph.buildScope?.buildID, buildID)

        let state = try await client.getScreenState(
            id: screenStateID,
            applicationVersion: applicationVersion,
            buildID: buildID
        )
        XCTAssertEqual(state.canonicalSnapshotID, snapshotID)

        let issues = try await client.listReviewIssues(
            states: nil,
            screenStateID: screenStateID
        )
        XCTAssertEqual(issues.items.map(\.id), [issueID])
        XCTAssertEqual(issues.items.first?.targetSnapshotID, snapshotID)

        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/screen-graph",
            "/v1/screen-states/\(screenStateID)",
            "/v1/review-issues",
        ])
        let queries = requests.map { request in
            Set(
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.map { "\($0.name)=\($0.value ?? "")" } ?? []
            )
        }
        XCTAssertEqual(queries[0], [
            "project_id=\(projectID)",
            "application_id=dev.vistrea.demo",
            "application_version=\(applicationVersion)",
            "build_id=\(buildID)",
        ])
        XCTAssertEqual(queries[1], [
            "application_version=\(applicationVersion)",
            "build_id=\(buildID)",
        ])
        XCTAssertEqual(queries[2], ["screen_state_id=\(screenStateID)"])
    }

    func testWikiWriteRoutesEncodeAndDecodeInlineMarkdown() async throws {
        let nodeJSON = { (revision: Int, status: String) in
            #"""
            {"wiki_node_id":"\#(wikiNodeID)","protocol_version":{"major":1,"minor":0},
             "revision":\#(revision),"kind":"note","title":"Alpha rules","summary":"Preview rules.",
             "content":{"storage":"inline","media_type":"text/markdown","text":"# Alpha","extensions":{}},
             "status":"\#(status)","labels":["demo"],"related_resources":[],"attachments":[],
             "created_at":"2026-07-12T00:00:00Z","created_by":{"kind":"human","id":"studio","extensions":{}},
             "updated_at":"2026-07-12T00:00:00Z","updated_by":{"kind":"human","id":"studio","extensions":{}},
             "extensions":{}}
            """#
        }
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 201, body: Data(nodeJSON(1, "draft").utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(nodeJSON(1, "draft").utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(nodeJSON(2, "published").utf8)),
        ])
        let client = try makeClient(transport)

        let created = try await client.createWikiNode(
            WikiNodeDraft(
                kind: "note",
                title: "Alpha rules",
                summary: "Preview rules.",
                markdown: "# Alpha",
                createdBy: .studio
            )
        )
        XCTAssertEqual(created.wikiNodeID, wikiNodeID)
        XCTAssertEqual(created.markdown, "# Alpha")
        XCTAssertEqual(created.revision, 1)

        let loaded = try await client.getWikiNode(id: wikiNodeID)
        XCTAssertEqual(loaded.markdown, "# Alpha")

        let revised = try await client.reviseWikiNode(
            id: wikiNodeID,
            WikiNodeRevisionDraft(
                expectedRevision: 1,
                markdown: "# Alpha v2",
                toStatus: "published",
                updatedBy: .studio
            )
        )
        XCTAssertEqual(revised.revision, 2)
        XCTAssertEqual(revised.status, "published")

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/wiki/nodes",
            "/v1/wiki/nodes/\(wikiNodeID)",
            "/v1/wiki/nodes/\(wikiNodeID)/revisions",
        ])
        let createBody = try bodyObject(of: requests[0])
        XCTAssertEqual(
            Set(createBody.keys),
            ["kind", "title", "summary", "markdown", "created_by"]
        )
        let reviseBody = try bodyObject(of: requests[2])
        XCTAssertEqual(
            Set(reviseBody.keys),
            ["expected_revision", "markdown", "to_status", "updated_by"]
        )
        XCTAssertEqual(reviseBody["expected_revision"] as? Int, 1)
        XCTAssertEqual(reviseBody["to_status"] as? String, "published")
    }

    func testCanvasKnowledgeRoutesEncodeAndDecode() async throws {
        let stateJSON = #"""
        {"screen_state_id":"\#(screenStateID)","protocol_version":{"major":1,"minor":0},
         "revision":3,"title":"Home","kind":"screen","status":"active",
         "canonical_snapshot_id":"\#(snapshotID)",
         "observation_ids":["observation_019f0000-0000-7000-8000-000000000001"],
         "identity":{"strategy":"structural"},
         "first_seen":"2026-07-12T00:00:00Z","last_seen":"2026-07-12T00:00:05Z","extensions":{}}
        """#
        let linkJSON = #"""
        {"wiki_link_id":"\#(wikiLinkID)","protocol_version":{"major":1,"minor":0},"revision":1,
         "source_node_id":"\#(wikiNodeID)","target":{"kind":"screen_state","id":"\#(screenStateID)"},
         "relation":"relates_to","created_at":"2026-07-12T00:00:00Z",
         "created_by":{"kind":"human","id":"studio","extensions":{}},"extensions":{}}
        """#
        let relatedJSON = #"""
        {"items":[{"wiki_node_id":"\#(wikiNodeID)","kind":"note","title":"Alpha rules",
         "summary":"Preview rules.","status":"draft","labels":[]}]}
        """#
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(stateJSON.utf8)),
            HostHTTPResponse(statusCode: 201, body: Data(linkJSON.utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(relatedJSON.utf8)),
        ])
        let client = try makeClient(transport)

        let state = try await client.getScreenState(id: screenStateID)
        XCTAssertEqual(state.title, "Home")
        XCTAssertEqual(state.canonicalSnapshotID, snapshotID)
        XCTAssertEqual(state.firstSeen, "2026-07-12T00:00:00Z")

        let link = try await client.createWikiLink(
            WikiLinkDraft(
                sourceNodeID: wikiNodeID,
                target: ResourceTargetDraft(kind: "screen_state", id: screenStateID),
                relation: "relates_to",
                createdBy: .studio
            )
        )
        XCTAssertEqual(link.wikiLinkID, wikiLinkID)
        XCTAssertEqual(link.relation, "relates_to")

        let related = try await client.relatedWikiNodes(kind: "screen_state", id: screenStateID)
        XCTAssertEqual(related.items.map(\.title), ["Alpha rules"])

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/screen-states/\(screenStateID)")
        XCTAssertEqual(requests[1].url?.path, "/v1/wiki/links")
        XCTAssertEqual(requests[2].url?.path, "/v1/wiki/related")
        let relatedComponents = try XCTUnwrap(
            URLComponents(url: XCTUnwrap(requests[2].url), resolvingAgainstBaseURL: false)
        )
        XCTAssertEqual(
            Set(relatedComponents.queryItems?.map { "\($0.name)=\($0.value ?? "")" } ?? []),
            ["kind=screen_state", "id=\(screenStateID)"]
        )
        let linkBody = try bodyObject(of: requests[1])
        XCTAssertEqual(
            Set(linkBody.keys),
            ["source_node_id", "target", "relation", "created_by"]
        )
        let target = try XCTUnwrap(linkBody["target"] as? [String: Any])
        XCTAssertEqual(target["kind"] as? String, "screen_state")
        XCTAssertEqual(target["id"] as? String, screenStateID)
    }

    func testAnnotateScreenStateEncodesClearingValuesAndDecodesResult() async throws {
        let annotatedJSON = #"""
        {"screen_graph_id":"graph_019f0000-0000-7000-8000-000000000001","graph_revision":4,
         "state":{"screen_state_id":"\#(screenStateID)","protocol_version":{"major":1,"minor":0},
          "revision":3,"title":"Home","kind":"screen","status":"active",
          "canonical_snapshot_id":"\#(snapshotID)",
          "observation_ids":["observation_019f0000-0000-7000-8000-000000000001"],
          "identity":{"strategy":"structural"},
          "first_seen":"2026-07-12T00:00:00Z","last_seen":"2026-07-12T00:00:05Z",
          "labels":["entry","checkout"],"summary":"The landing screen.","extensions":{}}}
        """#
        let clearedJSON = #"""
        {"screen_graph_id":"graph_019f0000-0000-7000-8000-000000000001","graph_revision":5,
         "state":{"screen_state_id":"\#(screenStateID)","protocol_version":{"major":1,"minor":0},
          "revision":4,"title":"Home","kind":"screen","status":"active",
          "canonical_snapshot_id":"\#(snapshotID)",
          "observation_ids":["observation_019f0000-0000-7000-8000-000000000001"],
          "identity":{"strategy":"structural"},
          "first_seen":"2026-07-12T00:00:00Z","last_seen":"2026-07-12T00:00:06Z","extensions":{}}}
        """#
        let transport = WriteRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(annotatedJSON.utf8)),
            HostHTTPResponse(statusCode: 200, body: Data(clearedJSON.utf8)),
        ])
        let client = try makeClient(transport)
        let projectID = "project_019f0000-0000-7000-8000-000000000001"

        let annotated = try await client.annotateScreenState(
            AnnotateScreenStateCommand(
                projectID: projectID,
                applicationID: "dev.vistrea.demo",
                stateID: screenStateID,
                labels: ["entry", "checkout"],
                summary: "The landing screen.",
                expectedGraphRevision: 3,
                annotatedBy: .studio
            )
        )
        XCTAssertEqual(annotated.graphRevision, 4)
        XCTAssertEqual(annotated.state.labels, ["entry", "checkout"])
        XCTAssertEqual(annotated.state.summary, "The landing screen.")

        // Clearing: the empty array and empty string are submitted, and a
        // canonical state without the fields decodes back to empty/nil.
        let cleared = try await client.annotateScreenState(
            AnnotateScreenStateCommand(
                projectID: projectID,
                applicationID: "dev.vistrea.demo",
                stateID: screenStateID,
                labels: [],
                summary: "",
                expectedGraphRevision: 4,
                annotatedBy: .studio
            )
        )
        XCTAssertEqual(cleared.graphRevision, 5)
        XCTAssertEqual(cleared.state.labels, [])
        XCTAssertNil(cleared.state.summary)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(
            requests.map { $0.url?.path },
            ["/v1/screen-graph/state-annotations", "/v1/screen-graph/state-annotations"]
        )
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Content-Type") == "application/json"
        })
        let annotateBody = try bodyObject(of: requests[0])
        XCTAssertEqual(
            Set(annotateBody.keys),
            [
                "project_id", "application_id", "state_id", "labels", "summary",
                "expected_graph_revision", "annotated_by",
            ]
        )
        XCTAssertEqual(annotateBody["state_id"] as? String, screenStateID)
        XCTAssertEqual(annotateBody["labels"] as? [String], ["entry", "checkout"])
        XCTAssertEqual(annotateBody["summary"] as? String, "The landing screen.")
        XCTAssertEqual(annotateBody["expected_graph_revision"] as? Int, 3)
        let actor = try XCTUnwrap(annotateBody["annotated_by"] as? [String: Any])
        XCTAssertEqual(actor["kind"] as? String, "human")
        XCTAssertEqual(actor["id"] as? String, "studio")
        // The clearing write carries the explicit empty values; they are
        // never silently omitted.
        let clearBody = try bodyObject(of: requests[1])
        XCTAssertEqual(clearBody["labels"] as? [String], [])
        XCTAssertEqual(clearBody["summary"] as? String, "")
    }

    func testAnnotateScreenStateValidatesThePayloadBeforeTransport() async throws {
        let transport = WriteRecordingTransport(responses: [])
        let client = try makeClient(transport)
        let projectID = "project_019f0000-0000-7000-8000-000000000001"

        func command(
            labels: [String]?,
            summary: String?,
            revision: UInt64 = 1
        ) -> AnnotateScreenStateCommand {
            AnnotateScreenStateCommand(
                projectID: projectID,
                applicationID: "dev.vistrea.demo",
                stateID: screenStateID,
                labels: labels,
                summary: summary,
                expectedGraphRevision: revision,
                annotatedBy: .studio
            )
        }
        func expectInvalidConfiguration(
            _ command: AnnotateScreenStateCommand,
            file: StaticString = #filePath,
            line: UInt = #line
        ) async {
            do {
                _ = try await client.annotateScreenState(command)
                XCTFail("Expected an invalid-configuration failure.", file: file, line: line)
            } catch {
                guard case HostClientError.invalidConfiguration = error else {
                    return XCTFail(
                        "Expected invalidConfiguration, received \(error)",
                        file: file,
                        line: line
                    )
                }
            }
        }

        // Setting neither field is a caller mistake the Host would refuse.
        await expectInvalidConfiguration(command(labels: nil, summary: nil))
        // Duplicate, empty, and over-long labels; an over-long summary; a
        // revision below 1.
        await expectInvalidConfiguration(command(labels: ["a", "a"], summary: nil))
        await expectInvalidConfiguration(command(labels: [""], summary: nil))
        await expectInvalidConfiguration(
            command(labels: [String(repeating: "l", count: 129)], summary: nil)
        )
        await expectInvalidConfiguration(
            command(labels: nil, summary: String(repeating: "s", count: 281))
        )
        await expectInvalidConfiguration(command(labels: [], summary: "", revision: 0))
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.annotateScreenState(
                AnnotateScreenStateCommand(
                    projectID: projectID,
                    applicationID: "dev.vistrea.demo",
                    stateID: "screenstate_invalid",
                    labels: [],
                    summary: "",
                    expectedGraphRevision: 1,
                    annotatedBy: .studio
                )
            )
        }

        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty, "No rejected annotation may reach the transport.")
    }

    func testWriteRoutesValidateIdentifiersBeforeTransport() async throws {
        let transport = WriteRecordingTransport(responses: [])
        let client = try makeClient(transport)

        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.applyTuningPatch(patchID: "patch_not-a-uuid", previewTTLMilliseconds: nil)
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.revertTuningApplication(id: "tuningapp_short")
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.transitionReviewIssue(
                id: "issue_invalid",
                ReviewIssueTransitionRequest(expectedRevision: 1, toState: "open", changedBy: .studio)
            )
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.getWikiNode(id: "wiki_invalid")
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.reviseWikiNode(
                id: "wiki_invalid",
                WikiNodeRevisionDraft(expectedRevision: 1, updatedBy: .studio)
            )
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.getScreenState(id: "screenstate_invalid")
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.createWikiLink(
                WikiLinkDraft(
                    sourceNodeID: "wiki_invalid",
                    target: ResourceTargetDraft(kind: "screen_state", id: screenStateID),
                    relation: "relates_to",
                    createdBy: .studio
                )
            )
        }
        await XCTAssertThrowsInvalidIdentifier {
            _ = try await client.relatedWikiNodes(kind: "Screen State", id: screenStateID)
        }

        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }
}

private func XCTAssertThrowsInvalidIdentifier(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected an invalid-identifier failure.", file: file, line: line)
    } catch {
        guard case HostClientError.invalidIdentifier = error else {
            return XCTFail("Expected invalidIdentifier, received \(error)", file: file, line: line)
        }
    }
}

private actor WriteRecordingTransport: HostHTTPTransport {
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
