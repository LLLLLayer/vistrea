import Foundation
import XCTest
import VistreaRuntimeModels
@testable import VistreaStudioCore

private let validBearerToken = String(repeating: "A", count: 43)

final class HTTPHostClientTests: XCTestCase {
    func testRoutesRequestsWithBearerAuthenticationRangeAndCanonicalBodies() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let page = SnapshotPage(items: [SnapshotSummary(snapshot: snapshot)], snapshotVersion: "test-v1")
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                body: Data(#"{"status":"ready","runtime_connected":true}"#.utf8)
            ),
            HostHTTPResponse(statusCode: 200, body: try JSONEncoder().encode(page)),
            HostHTTPResponse(statusCode: 200, body: try RuntimeSnapshotCodec.encode(snapshot)),
            HostHTTPResponse(
                statusCode: 206,
                headers: [
                    "Content-Length": "3",
                    "Content-Range": "bytes 2-4/12",
                    "ETag": "\"\(snapshot.screenshot!.object.hash)\"",
                ],
                body: Data([1, 2, 3])
            ),
            HostHTTPResponse(statusCode: 201, body: try RuntimeSnapshotCodec.encode(snapshot)),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        _ = try await client.getStatus()
        _ = try await client.listSnapshots()
        _ = try await client.getSnapshot(id: snapshot.snapshotID.rawValue)
        let range = try ObjectByteRange(lowerBound: 2, upperBound: 4)
        _ = try await client.getObject(hash: snapshot.screenshot!.object.hash, range: range)
        _ = try await client.capture(CaptureRequest())

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 5)
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "GET", "GET", "GET", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/status",
            "/v1/snapshots",
            "/v1/snapshots/\(snapshot.snapshotID.rawValue)",
            "/v1/objects/\(snapshot.screenshot!.object.hash)",
            "/v1/captures",
        ])
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(validBearerToken)"
        })
        XCTAssertTrue(requests.allSatisfy { $0.cachePolicy == .reloadIgnoringLocalCacheData })
        XCTAssertEqual(requests[3].value(forHTTPHeaderField: "Accept"), "*/*")
        XCTAssertEqual(requests[3].value(forHTTPHeaderField: "Range"), "bytes=2-4")
        XCTAssertEqual(requests[4].value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(String(data: requests[4].httpBody ?? Data(), encoding: .utf8), "{}")
        let limits = await transport.maximumResponseBytes
        XCTAssertEqual(limits, [
            HTTPHostClient.maximumJSONResponseBytes,
            HTTPHostClient.maximumJSONResponseBytes,
            HTTPHostClient.maximumJSONResponseBytes,
            HTTPHostClient.maximumObjectResponseBytes,
            HTTPHostClient.maximumJSONResponseBytes,
        ])
    }

    func testWorkspaceMaintenanceRoutesBodiesAndDecoding() async throws {
        let active = try workspaceRecoveryPointJSONObject(active: true)
        let released = try workspaceRecoveryPointJSONObject(active: false)
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                body: try JSONSerialization.data(withJSONObject: ["recovery_points": [active]])
            ),
            HostHTTPResponse(
                statusCode: 201,
                body: try JSONSerialization.data(withJSONObject: active)
            ),
            HostHTTPResponse(
                statusCode: 200,
                body: try JSONSerialization.data(withJSONObject: released)
            ),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        let page = try await client.listRecoveryPoints()
        XCTAssertEqual(page.recoveryPoints.count, 1)
        XCTAssertEqual(page.recoveryPoints[0].recoveryPointID, workspaceRecoveryPointHash)
        XCTAssertEqual(page.recoveryPoints[0].source, .manual)
        XCTAssertEqual(page.recoveryPoints[0].activeRetentionPolicyIDs, ["workspace-recovery:test"])
        let created = try await client.createRecoveryPoint(reason: "Before local tuning.")
        XCTAssertEqual(created.reason, "Before local tuning.")
        let afterRelease = try await client.releaseRecoveryPoint(
            recoveryPointID: workspaceRecoveryPointHash,
            retentionPolicyID: "workspace-recovery:test"
        )
        XCTAssertTrue(afterRelease.activeRetentionPolicyIDs.isEmpty)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/v1/workspace/recovery-points",
            "/v1/workspace/recovery-points",
            "/v1/workspace/recovery-points/release",
        ])
        XCTAssertNil(requests[0].httpBody)
        XCTAssertEqual(
            try jsonDictionary(requests[1].httpBody),
            ["reason": "Before local tuning."]
        )
        XCTAssertEqual(
            try jsonDictionary(requests[2].httpBody),
            [
                "recovery_point_id": workspaceRecoveryPointHash,
                "retention_policy_id": "workspace-recovery:test",
            ]
        )
        XCTAssertEqual(
            requests.dropFirst().map { $0.value(forHTTPHeaderField: "Content-Type") },
            ["application/json", "application/json"]
        )
    }

    func testWorkspaceMaintenanceRejectsInvalidInputAndUnknownResponseFields() async throws {
        let emptyTransport = RecordingTransport(responses: [])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: emptyTransport
        )
        await XCTAssertThrowsErrorAsync(try await client.createRecoveryPoint(reason: " \n ")) { error in
            guard case HostClientError.invalidConfiguration = error else {
                return XCTFail("Expected local reason validation, received \(error)")
            }
        }
        await XCTAssertThrowsErrorAsync(
            try await client.releaseRecoveryPoint(
                recoveryPointID: "sha256:" + String(repeating: "０", count: 64),
                retentionPolicyID: "workspace-recovery:test"
            )
        ) { error in
            guard case HostClientError.invalidIdentifier = error else {
                return XCTFail("Expected canonical recovery-point identity validation, received \(error)")
            }
        }
        await XCTAssertThrowsErrorAsync(
            try await client.releaseRecoveryPoint(
                recoveryPointID: workspaceRecoveryPointHash,
                retentionPolicyID: ""
            )
        ) { error in
            guard case HostClientError.invalidConfiguration = error else {
                return XCTFail("Expected retention policy validation, received \(error)")
            }
        }
        let invalidRequests = await emptyTransport.requests
        XCTAssertTrue(invalidRequests.isEmpty)

        var invalidPage: [String: Any] = [
            "recovery_points": [try workspaceRecoveryPointJSONObject(active: true)],
        ]
        invalidPage["unexpected"] = true
        let invalidTransport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                body: try JSONSerialization.data(withJSONObject: invalidPage)
            ),
        ])
        let invalidClient = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: invalidTransport
        )
        await XCTAssertThrowsErrorAsync(try await invalidClient.listRecoveryPoints()) { error in
            guard case HostClientError.decoding = error else {
                return XCTFail("Expected strict recovery-point decoding, received \(error)")
            }
        }
    }

    func testDecodesFrozenErrorEnvelope() async throws {
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 503,
                body: Data(
                    #"{"request_id":"request-1","error":{"code":"runtime.unavailable","message":"No Runtime is connected.","retryable":true}}"#.utf8
                )
            ),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        do {
            _ = try await client.getStatus()
            XCTFail("Expected the Host error envelope to be surfaced.")
        } catch let error as HostClientError {
            XCTAssertEqual(
                error,
                .server(
                    statusCode: 503,
                    requestID: "request-1",
                    code: "runtime.unavailable",
                    message: "No Runtime is connected.",
                    retryable: true
                )
            )
        }
    }

    func testRejectsUnknownStatusEnvelopeField() async throws {
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                body: Data(#"{"status":"ready","runtime_connected":true,"unexpected":1}"#.utf8)
            ),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        await XCTAssertThrowsErrorAsync(try await client.getStatus()) { error in
            guard case HostClientError.decoding = error else {
                return XCTFail("Expected strict envelope decoding, received \(error)")
            }
        }
    }

    func testCaptureRequiresCreatedStatus() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: try RuntimeSnapshotCodec.encode(snapshot)),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        await XCTAssertThrowsErrorAsync(try await client.capture(CaptureRequest())) { error in
            guard case let HostClientError.server(statusCode, _, code, _, _) = error else {
                return XCTFail("Expected an unexpected-status Host error, received \(error)")
            }
            XCTAssertEqual(statusCode, 200)
            XCTAssertEqual(code, "host.unexpected_status")
        }
    }

    func testAcceptsOnlyLiteralHTTPLoopbackAndGeneratedTokenShape() throws {
        XCTAssertThrowsError(
            try HTTPHostClient(
                baseURL: URL(string: "https://127.0.0.1:47831")!,
                bearerToken: validBearerToken,
                transport: RecordingTransport(responses: [])
            )
        ) { error in
            guard case HostClientError.invalidConfiguration = error else {
                return XCTFail("Expected loopback-only configuration, received \(error)")
            }
        }
        XCTAssertThrowsError(
            try HTTPHostClient(
                baseURL: URL(string: "http://localhost:47831")!,
                bearerToken: validBearerToken,
                transport: RecordingTransport(responses: [])
            )
        )
        XCTAssertThrowsError(
            try HTTPHostClient(
                baseURL: URL(string: "http://127%2e0%2e0%2e1:47831")!,
                bearerToken: validBearerToken,
                transport: RecordingTransport(responses: [])
            )
        )
        XCTAssertThrowsError(
            try HTTPHostClient(
                baseURL: URL(string: "http://127.0.0.1:47831")!,
                bearerToken: "short-token",
                transport: RecordingTransport(responses: [])
            )
        )
        _ = try HTTPHostClient(
            baseURL: URL(string: "http://[::1]:47831")!,
            bearerToken: validBearerToken,
            transport: RecordingTransport(responses: [])
        )
    }

    func testGetSnapshotRejectsMismatchedCanonicalIdentity() async throws {
        let snapshot = try StudioTestFixtures.snapshot()
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try RuntimeSnapshotCodec.encode(snapshot)) as? [String: Any]
        )
        object["snapshot_id"] = "snapshot_019f0000-0000-7000-8000-000000000099"
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(statusCode: 200, body: try JSONSerialization.data(withJSONObject: object)),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        await XCTAssertThrowsErrorAsync(try await client.getSnapshot(id: snapshot.snapshotID.rawValue)) { error in
            guard case HostClientError.decoding = error else {
                return XCTFail("Expected Snapshot identity validation, received \(error)")
            }
        }
    }

    func testRejectsNonASCIIObjectDigestBeforeTransport() async throws {
        let transport = RecordingTransport(responses: [])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        await XCTAssertThrowsErrorAsync(
            try await client.getObject(hash: "sha256:" + String(repeating: "０", count: 64), range: nil)
        ) { error in
            guard case HostClientError.invalidIdentifier = error else {
                return XCTFail("Expected strict ASCII SHA-256 validation, received \(error)")
            }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testRejectsInvalidTypedSnapshotIDBeforeTransport() async throws {
        let transport = RecordingTransport(responses: [])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        await XCTAssertThrowsErrorAsync(try await client.getSnapshot(id: "snapshot_not-a-uuid")) { error in
            guard case HostClientError.invalidIdentifier = error else {
                return XCTFail("Expected canonical Snapshot ID validation, received \(error)")
            }
        }
        let requestLogIsEmpty = await transport.isRequestLogEmpty()
        XCTAssertTrue(requestLogIsEmpty)
    }

    func testVerifiesFullObjectHeadersLengthAndSHA256() async throws {
        let body = Data("abc".utf8)
        let hash = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        let transport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                headers: ["ETag": "\"\(hash)\"", "Content-Length": "3"],
                body: body
            ),
        ])
        let client = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: transport
        )

        let received = try await client.getObject(hash: hash, range: nil)
        XCTAssertEqual(received, body)
    }

    func testRejectsFullObjectDigestMismatchAndMalformedRangeEvidence() async throws {
        let hash = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        let corruptTransport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 200,
                headers: ["ETag": "\"\(hash)\"", "Content-Length": "3"],
                body: Data("abd".utf8)
            ),
        ])
        let corruptClient = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: corruptTransport
        )
        await XCTAssertThrowsErrorAsync(try await corruptClient.getObject(hash: hash, range: nil)) { error in
            guard case HostClientError.integrity = error else {
                return XCTFail("Expected SHA-256 integrity failure, received \(error)")
            }
        }

        let rangeTransport = RecordingTransport(responses: [
            HostHTTPResponse(
                statusCode: 206,
                headers: [
                    "ETag": "\"\(hash)\"",
                    "Content-Length": "3",
                    "Content-Range": "bytes 1-3/12",
                ],
                body: Data([1, 2, 3])
            ),
        ])
        let rangeClient = try HTTPHostClient(
            baseURL: URL(string: "http://127.0.0.1:47831")!,
            bearerToken: validBearerToken,
            transport: rangeTransport
        )
        await XCTAssertThrowsErrorAsync(
            try await rangeClient.getObject(
                hash: hash,
                range: try ObjectByteRange(lowerBound: 2, upperBound: 4)
            )
        ) { error in
            guard case HostClientError.integrity = error else {
                return XCTFail("Expected Content-Range integrity failure, received \(error)")
            }
        }
    }

    func testURLSessionTransportStopsAtConfiguredStreamingLimit() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StreamingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let transport = URLSessionHostHTTPTransport(session: session)
        let request = URLRequest(url: URL(string: "http://127.0.0.1/stream")!)

        await XCTAssertThrowsErrorAsync(
            try await transport.execute(request, maximumResponseBytes: 3)
        ) { error in
            XCTAssertEqual(error as? HostClientError, .responseTooLarge(limit: 3))
        }
    }
}

private actor RecordingTransport: HostHTTPTransport {
    private var responses: [HostHTTPResponse]
    private(set) var requests: [URLRequest] = []
    private(set) var maximumResponseBytes: [Int] = []

    init(responses: [HostHTTPResponse]) {
        self.responses = responses
    }

    func execute(_ request: URLRequest, maximumResponseBytes: Int) async throws -> HostHTTPResponse {
        requests.append(request)
        self.maximumResponseBytes.append(maximumResponseBytes)
        guard !responses.isEmpty else {
            throw HostClientError.transport("No test response remains.")
        }
        return responses.removeFirst()
    }

    func isRequestLogEmpty() -> Bool {
        requests.isEmpty
    }
}

private final class StreamingURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([1, 2]))
        client?.urlProtocol(self, didLoad: Data([3, 4]))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw.", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}

private let workspaceRecoveryPointHash = "sha256:" + String(repeating: "a", count: 64)

private func workspaceRecoveryPointJSONObject(active: Bool) throws -> [String: Any] {
    [
        "recovery_point_id": workspaceRecoveryPointHash,
        "backup": [
            "hash": workspaceRecoveryPointHash,
            "media_type": "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
            "byte_size": 128,
            "compression": "none",
            "logical_name": "metadata-schema-v1.sqlite",
            "extensions": [:],
        ],
        "source": "manual",
        "reason": "Before local tuning.",
        "created_at": "2026-07-17T08:00:00.000Z",
        "schema_version": 1,
        "generation": 4,
        "retention_policies": [[
            "policy_id": "workspace-recovery:test",
            "reason": "Keep this recovery point.",
        ]],
        "active_retention_policy_ids": active ? ["workspace-recovery:test"] : [],
    ]
}

private func jsonDictionary(_ data: Data?) throws -> [String: String] {
    guard let data,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: String]
    else {
        throw HostClientError.decoding("Expected a string-valued JSON object in the test request.")
    }
    return object
}
