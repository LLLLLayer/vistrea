import Foundation
import XCTest
@testable import VistreaStudioCore

let hubProjectID = "project_019f0000-0000-7000-8000-000000000051"
let hubBearerToken = String(repeating: "H", count: 43)
let hubRefName = "teams/design/main"
let hubLocalCommitID = "commit:sha256:" + String(repeating: "1", count: 64)
let hubRemoteCommitID = "commit:sha256:" + String(repeating: "2", count: 64)
let hubObjectHash = "sha256:" + String(repeating: "3", count: 64)

final class HubSyncClientTests: XCTestCase {
    private func makeClient(_ transport: HubSyncRecordingTransport) throws -> HTTPHostClient {
        try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: String(repeating: "A", count: 43),
            transport: transport
        )
    }

    private var remote: HubSyncRemote {
        HubSyncRemote(
            baseURL: "https://hub.example.com",
            projectID: hubProjectID,
            bearerToken: hubBearerToken
        )
    }

    private func bodyObject(of request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )
    }

    func testStatusSendsCredentialOnlyInsideLocalHostBodyAndDecodesSanitizedResult() async throws {
        let transport = HubSyncRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: HubSyncFixtures.statusData()),
        ])
        let client = try makeClient(transport)

        let status = try await client.getSyncStatus(remote: remote, refNames: [hubRefName])

        XCTAssertEqual(status.remote.baseURL, "https://hub.example.com")
        XCTAssertEqual(status.remote.projectID, hubProjectID)
        XCTAssertEqual(status.identity.role, .maintainer)
        XCTAssertEqual(status.identity.credentialScope, .team)
        XCTAssertEqual(status.accessibleProjects.map(\.projectID), [hubProjectID])
        XCTAssertEqual(status.refs.first?.relation, .localOnly)

        let recordedRequests = await transport.requests
        let request = try XCTUnwrap(recordedRequests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/sync/status")
        XCTAssertFalse(request.url?.absoluteString.contains(hubBearerToken) ?? true)
        XCTAssertFalse(request.allHTTPHeaderFields?.values.contains(where: { $0.contains(hubBearerToken) }) ?? true)
        let body = try bodyObject(of: request)
        XCTAssertEqual(Set(body.keys), ["remote", "ref_names"])
        let encodedRemote = try XCTUnwrap(body["remote"] as? [String: Any])
        XCTAssertEqual(encodedRemote["base_url"] as? String, "https://hub.example.com")
        XCTAssertEqual(encodedRemote["project_id"] as? String, hubProjectID)
        XCTAssertEqual(encodedRemote["bearer_token"] as? String, hubBearerToken)
        XCTAssertEqual(body["ref_names"] as? [String], [hubRefName])
        XCTAssertFalse(String(data: HubSyncFixtures.statusData(), encoding: .utf8)?.contains(hubBearerToken) ?? true)
    }

    func testFetchPushAndActivityUseFrozenRoutesAndCanonicalBodies() async throws {
        let transport = HubSyncRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: HubSyncFixtures.fetchOutcomeData()),
            HostHTTPResponse(statusCode: 200, body: HubSyncFixtures.pushOutcomeData()),
            HostHTTPResponse(statusCode: 200, body: HubSyncFixtures.activityPageData()),
        ])
        let client = try makeClient(transport)
        let actor = HubSyncActor(kind: "agent", id: "studio-test")

        let fetched = try await client.fetchWorkspace(
            remote: remote,
            refNames: [hubRefName],
            actor: actor
        )
        let pushed = try await client.pushWorkspace(
            remote: remote,
            refNames: [hubRefName],
            actor: actor,
            message: "Publish the reviewed baseline."
        )
        let activity = try await client.getSyncActivity(
            remote: remote,
            afterSequence: 4,
            limit: 25
        )

        XCTAssertEqual(fetched.result.imported.importedCommitIDs, [hubRemoteCommitID])
        XCTAssertEqual(fetched.result.remainingConflicts.first?.name, hubRefName)
        XCTAssertEqual(pushed.result.advancedRefs.first?.revision, 3)
        XCTAssertEqual(pushed.result.remainingConflicts.first?.localCommitID, hubLocalCommitID)
        XCTAssertEqual(activity.items.first?.kind, "HubPackImported")
        XCTAssertEqual(activity.items.first?.actor.principalID, "principal_designer")
        XCTAssertEqual(activity.nextCursor, "5")

        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/sync/fetch",
            "/v1/sync/push",
            "/v1/sync/activity",
        ])
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "POST" })
        let fetchBody = try bodyObject(of: requests[0])
        XCTAssertEqual(Set(fetchBody.keys), ["remote", "ref_names", "created_by"])
        let pushBody = try bodyObject(of: requests[1])
        XCTAssertEqual(pushBody["message"] as? String, "Publish the reviewed baseline.")
        let createdBy = try XCTUnwrap(pushBody["created_by"] as? [String: Any])
        XCTAssertEqual(createdBy["kind"] as? String, "agent")
        XCTAssertEqual(createdBy["id"] as? String, "studio-test")
        XCTAssertEqual(createdBy["extensions"] as? [String: String], [:])
        let activityBody = try bodyObject(of: requests[2])
        XCTAssertEqual(activityBody["after_sequence"] as? Int, 4)
        XCTAssertEqual(activityBody["limit"] as? Int, 25)
    }

    func testSyncInputsAreRejectedBeforeTransport() async throws {
        let transport = HubSyncRecordingTransport(responses: [])
        let client = try makeClient(transport)

        await assertInvalidConfiguration {
            _ = try await client.getSyncStatus(
                remote: HubSyncRemote(
                    baseURL: "http://hub.example.com",
                    projectID: hubProjectID,
                    bearerToken: hubBearerToken
                ),
                refNames: [hubRefName]
            )
        }
        await assertInvalidConfiguration {
            _ = try await client.fetchWorkspace(
                remote: self.remote,
                refNames: [],
                actor: HubSyncActor()
            )
        }
        await assertInvalidConfiguration {
            _ = try await client.pushWorkspace(
                remote: self.remote,
                refNames: [hubRefName, hubRefName],
                actor: HubSyncActor(),
                message: "Duplicate refs"
            )
        }
        await assertInvalidConfiguration {
            _ = try await client.pushWorkspace(
                remote: self.remote,
                refNames: [hubRefName],
                actor: HubSyncActor(),
                message: String(repeating: "x", count: 1_025)
            )
        }
        await assertInvalidConfiguration {
            _ = try await client.fetchWorkspace(
                remote: self.remote,
                refNames: [hubRefName],
                actor: HubSyncActor(kind: "user", id: "studio")
            )
        }
        await assertInvalidConfiguration {
            _ = try await client.getSyncActivity(
                remote: self.remote,
                afterSequence: nil,
                limit: 501
            )
        }

        let recordedRequests = await transport.requests
        XCTAssertTrue(recordedRequests.isEmpty)
    }

    func testStatusRejectsUnknownRemoteField() async throws {
        let source = String(data: HubSyncFixtures.statusData(), encoding: .utf8)!
            .replacingOccurrences(
                of: #""project_id":"\#(hubProjectID)""#,
                with: #""project_id":"\#(hubProjectID)","bearer_token":"leaked""#
            )
        let transport = HubSyncRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(source.utf8)),
        ])
        let client = try makeClient(transport)

        do {
            _ = try await client.getSyncStatus(remote: remote, refNames: [hubRefName])
            XCTFail("Expected strict Hub status decoding to reject the extra credential field.")
        } catch {
            guard case HostClientError.decoding = error else {
                return XCTFail("Expected a decoding error, received \(error)")
            }
        }
    }
}

private func assertInvalidConfiguration(
    _ operation: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await operation()
        XCTFail("Expected invalid Hub configuration.", file: file, line: line)
    } catch {
        guard case HostClientError.invalidConfiguration = error else {
            return XCTFail("Expected invalidConfiguration, received \(error)", file: file, line: line)
        }
    }
}

actor HubSyncRecordingTransport: HostHTTPTransport {
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

enum HubSyncFixtures {
    static func statusData(relation: String = "local_only") -> Data {
        Data(
            #"""
            {
              "remote":{"base_url":"https://hub.example.com","project_id":"\#(hubProjectID)"},
              "identity":{
                "principal_id":"principal_designer","role":"maintainer",
                "capabilities":["refs.read","packs.export","refs.update","packs.import"],"credential_scope":"team",
                "permission_sources":[{
                  "scope":"team","role":"maintainer","organization_id":"organization_design",
                  "team_id":"team_product_design"
                }],
                "organization_id":"organization_design","team_id":"team_product_design"
              },
              "accessible_projects":[{
                "project_id":"\#(hubProjectID)","organization_id":"organization_design",
                "team_id":"team_product_design","role":"maintainer",
                "capabilities":["refs.read","packs.export","refs.update","packs.import"]
              }],
              "refs":[{
                "name":"\#(hubRefName)","local_commit_id":"\#(hubLocalCommitID)",
                "remote_commit_id":null,"relation":"\#(relation)"
              }]
            }
            """#.utf8
        )
    }

    static func importReportJSON() -> String {
        #"""
        {
          "mode":"full","imported_commit_ids":["\#(hubRemoteCommitID)"],"existing_commit_ids":[],
          "imported_object_hashes":["\#(hubObjectHash)"],"existing_object_hashes":[],
          "created_refs":[],"unchanged_ref_names":[],
          "conflicting_refs":[{
            "name":"\#(hubRefName)","pack_commit_id":"\#(hubRemoteCommitID)","local_commit_id":"\#(hubLocalCommitID)"
          }]
        }
        """#
    }

    static func fetchOutcomeData() -> Data {
        Data(
            #"""
            {
              "result":{
                "import":\#(importReportJSON()),
                "advanced_refs":[],
                "remaining_conflicts":[{
                  "name":"\#(hubRefName)","pack_commit_id":"\#(hubRemoteCommitID)","local_commit_id":"\#(hubLocalCommitID)"
                }]
              },
              "status":\#(String(data: statusData(relation: "diverged"), encoding: .utf8)!)
            }
            """#.utf8
        )
    }

    static func pushOutcomeData() -> Data {
        Data(
            #"""
            {
              "result":{
                "import":\#(importReportJSON()),
                "advanced_refs":[{"name":"\#(hubRefName)","commit_id":"\#(hubLocalCommitID)","revision":3}],
                "remaining_conflicts":[{
                  "name":"\#(hubRefName)","pack_commit_id":"\#(hubRemoteCommitID)","local_commit_id":"\#(hubLocalCommitID)"
                }]
              },
              "status":\#(String(data: statusData(relation: "diverged"), encoding: .utf8)!)
            }
            """#.utf8
        )
    }

    static func activityPageData() -> Data {
        Data(
            #"""
            {
              "items":[{
                "event_id":"hub_audit_019f0000-0000-7000-8000-000000000005","sequence":5,
                "occurred_at":"2026-07-14T08:00:05.000Z","kind":"HubPackImported",
                "actor":{"principal_id":"principal_designer","role":"maintainer"},
                "resource":"project:\#(hubProjectID)",
                "details":{}
              }],
              "next_cursor":"5"
            }
            """#.utf8
        )
    }
}
