import Foundation
import XCTest
@testable import VistreaStudioCore

private let validBearerToken = String(repeating: "A", count: 43)
private let operationID = "operation_019f0000-0000-7000-8000-000000000001"

final class ExplorationClientTests: XCTestCase {
    private func makeClient(_ transport: ExplorationRecordingTransport) throws -> HTTPHostClient {
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

    private static func runningRefJSON() -> String {
        #"""
        {"operation_id":"\#(operationID)","kind":"RunExploration","state":"running",
         "created_at":"2026-07-12T02:00:00Z","updated_at":"2026-07-12T02:00:01Z"}
        """#
    }

    private static func succeededRecordJSON() -> String {
        #"""
        {"protocol_version":{"major":1,"minor":0},
         "operation":{"operation_id":"\#(operationID)","kind":"RunExploration","state":"succeeded",
           "created_at":"2026-07-12T02:00:00Z","updated_at":"2026-07-12T02:00:06Z"},
         "revision":6,
         "events":[
           {"event_id":"operationevent_019f0000-0000-7000-8000-000000000001","operation_id":"\#(operationID)",
            "sequence":1,"time":"2026-07-12T02:00:01Z","kind":"created","state":"queued","extensions":{}},
           {"event_id":"operationevent_019f0000-0000-7000-8000-000000000002","operation_id":"\#(operationID)",
            "sequence":2,"time":"2026-07-12T02:00:02Z","kind":"started","state":"running","extensions":{}},
           {"event_id":"operationevent_019f0000-0000-7000-8000-000000000003","operation_id":"\#(operationID)",
            "sequence":3,"time":"2026-07-12T02:00:03Z","kind":"progressed","state":"running",
            "progress":{"phase":"exploration.walk","completed_units":1,"total_units":20,"unit":"action",
              "message":"Tapped demo.home.open_catalog and discovered a new state"},"extensions":{}},
           {"event_id":"operationevent_019f0000-0000-7000-8000-000000000004","operation_id":"\#(operationID)",
            "sequence":4,"time":"2026-07-12T02:00:04Z","kind":"progressed","state":"running",
            "progress":{"phase":"exploration.walk","completed_units":2,"total_units":20,"unit":"action",
              "message":"Returned with physical back"},"extensions":{}},
           {"event_id":"operationevent_019f0000-0000-7000-8000-000000000005","operation_id":"\#(operationID)",
            "sequence":5,"time":"2026-07-12T02:00:05Z","kind":"succeeded","state":"succeeded","extensions":{}}
         ],
         "result":{"operation_id":"\#(operationID)","result_type":"ExplorationReport","storage":"inline",
           "value":{"screen_graph_id":"graph_019f0000-0000-7000-8000-000000000001",
             "initial_state_id":"screenstate_019f0000-0000-7000-8000-000000000001",
             "steps":[{"kind":"tap","source_state_id":"a","target_state_id":"b",
               "transition_id":"transition_019f0000-0000-7000-8000-000000000001",
               "created_transition":true,"discovered_new_state":true}],
             "discovered_state_ids":["screenstate_019f0000-0000-7000-8000-000000000001",
               "screenstate_019f0000-0000-7000-8000-000000000002",
               "screenstate_019f0000-0000-7000-8000-000000000003"],
             "action_count":2,"stopped_reason":"frontier_exhausted"}},
         "extensions":{}}
        """#
    }

    func testRunExplorationEncodesCanonicalCommandAndDecodesRef() async throws {
        let transport = ExplorationRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 201, body: Data(Self.runningRefJSON().utf8)),
        ])
        let client = try makeClient(transport)

        let ref = try await client.runExploration(
            ExplorationRunCommand(
                maximumActions: 20,
                settleMilliseconds: 1_500,
                excludedStableIDs: [
                    "android.debug.inspector.open",
                    "vistrea.inspector.capture",
                    "BackButton",
                ]
            )
        )
        XCTAssertEqual(ref.operationID, operationID)
        XCTAssertEqual(ref.kind, "RunExploration")
        XCTAssertEqual(ref.state, "running")
        XCTAssertFalse(ref.isTerminal)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(requests[0].url?.path, "/v1/exploration/operations")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try bodyObject(of: requests[0])
        // maximum_depth and actor_id stay absent when unset.
        XCTAssertEqual(
            Set(body.keys),
            ["maximum_actions", "settle_milliseconds", "excluded_stable_ids"]
        )
        XCTAssertEqual(body["maximum_actions"] as? Int, 20)
        XCTAssertEqual(body["settle_milliseconds"] as? Int, 1_500)
        XCTAssertEqual(
            body["excluded_stable_ids"] as? [String],
            ["android.debug.inspector.open", "vistrea.inspector.capture", "BackButton"]
        )
    }

    func testGetExplorationOperationProjectsProgressEventsAndReport() async throws {
        let transport = ExplorationRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(Self.succeededRecordJSON().utf8)),
        ])
        let client = try makeClient(transport)

        let record = try await client.getExplorationOperation(id: operationID)

        XCTAssertEqual(record.operation.state, "succeeded")
        XCTAssertTrue(record.operation.isTerminal)
        XCTAssertEqual(record.revision, 6)
        XCTAssertEqual(record.events.count, 5)
        XCTAssertEqual(
            record.events.map(\.kind),
            ["created", "started", "progressed", "progressed", "succeeded"]
        )
        let progress = try XCTUnwrap(record.latestProgress)
        XCTAssertEqual(progress.phase, "exploration.walk")
        XCTAssertEqual(progress.completedUnits, 2)
        XCTAssertEqual(progress.totalUnits, 20)
        XCTAssertEqual(progress.unit, "action")
        XCTAssertEqual(record.latestEventMessage, "Returned with physical back")
        let report = try XCTUnwrap(record.report)
        XCTAssertEqual(report.discoveredStateIDs.count, 3)
        XCTAssertEqual(report.actionCount, 2)
        XCTAssertEqual(report.stoppedReason, "frontier_exhausted")

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET"])
        XCTAssertEqual(requests[0].url?.path, "/v1/exploration/operations/\(operationID)")
    }

    func testCancelExplorationPostsWithoutBodyAndDecodesRef() async throws {
        let transport = ExplorationRecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: Data(Self.runningRefJSON().utf8)),
        ])
        let client = try makeClient(transport)

        let ref = try await client.cancelExploration(id: operationID)
        XCTAssertEqual(ref.operationID, operationID)
        XCTAssertEqual(ref.state, "running")

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(
            requests[0].url?.path,
            "/v1/exploration/operations/\(operationID)/cancel"
        )
        // The Host cancel route rejects any request body.
        XCTAssertNil(requests[0].httpBody)
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "Content-Type"))
    }

    func testExplorationRoutesValidateInputBeforeTransport() async throws {
        let transport = ExplorationRecordingTransport(responses: [])
        let client = try makeClient(transport)

        await XCTAssertThrowsInvalidConfiguration {
            _ = try await client.runExploration(ExplorationRunCommand(maximumActions: 0))
        }
        await XCTAssertThrowsInvalidConfiguration {
            _ = try await client.runExploration(ExplorationRunCommand(maximumActions: 501))
        }
        await XCTAssertThrowsInvalidConfiguration {
            _ = try await client.runExploration(
                ExplorationRunCommand(maximumActions: 20, maximumDepth: 33)
            )
        }
        await XCTAssertThrowsInvalidConfiguration {
            _ = try await client.runExploration(
                ExplorationRunCommand(maximumActions: 20, settleMilliseconds: 60_001)
            )
        }
        await XCTAssertThrowsInvalidConfiguration {
            _ = try await client.runExploration(
                ExplorationRunCommand(maximumActions: 20, excludedStableIDs: [""])
            )
        }
        do {
            _ = try await client.getExplorationOperation(id: "operation_not-a-uuid")
            XCTFail("Expected an invalid-identifier failure.")
        } catch {
            guard case HostClientError.invalidIdentifier = error else {
                return XCTFail("Expected invalidIdentifier, received \(error)")
            }
        }
        do {
            _ = try await client.cancelExploration(id: "operation_short")
            XCTFail("Expected an invalid-identifier failure.")
        } catch {
            guard case HostClientError.invalidIdentifier = error else {
                return XCTFail("Expected invalidIdentifier, received \(error)")
            }
        }

        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testRunExplorationSurfacesUnsupportedHostVerbatim() async throws {
        let transport = ExplorationRecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 501,
                body: Data(
                    #"{"request_id":"request-1","error":{"code":"unsupported","message":"No device automation provider is configured on this Host.","retryable":false}}"#.utf8
                )
            ),
        ])
        let client = try makeClient(transport)

        do {
            _ = try await client.runExploration(ExplorationRunCommand(maximumActions: 20))
            XCTFail("Expected the unsupported Host to surface an error.")
        } catch let error as HostClientError {
            guard case let .server(statusCode, _, code, message, retryable) = error else {
                return XCTFail("Expected a Host server error, received \(error)")
            }
            XCTAssertEqual(statusCode, 501)
            XCTAssertEqual(code, "unsupported")
            XCTAssertEqual(message, "No device automation provider is configured on this Host.")
            XCTAssertFalse(retryable)
        }
    }
}

private func XCTAssertThrowsInvalidConfiguration(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected an invalid-configuration failure.", file: file, line: line)
    } catch {
        guard case HostClientError.invalidConfiguration = error else {
            return XCTFail("Expected invalidConfiguration, received \(error)", file: file, line: line)
        }
    }
}

private actor ExplorationRecordingTransport: HostHTTPTransport {
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
