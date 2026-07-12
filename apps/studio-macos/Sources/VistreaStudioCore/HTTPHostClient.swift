import CryptoKit
import Foundation
import VistreaRuntimeModels

public struct HostHTTPResponse: Sendable {
    public let statusCode: Int
    public let headers: [String: String]
    public let body: Data

    public init(statusCode: Int, headers: [String: String] = [:], body: Data) {
        self.statusCode = statusCode
        self.headers = headers.reduce(into: [:]) { result, item in
            result[item.key.lowercased()] = item.value
        }
        self.body = body
    }

    func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

public protocol HostHTTPTransport: Sendable {
    func execute(_ request: URLRequest, maximumResponseBytes: Int) async throws -> HostHTTPResponse
}

public final class URLSessionHostHTTPTransport: HostHTTPTransport, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func execute(_ request: URLRequest, maximumResponseBytes: Int) async throws -> HostHTTPResponse {
        guard maximumResponseBytes >= 0 else {
            throw HostClientError.invalidConfiguration("The response byte limit must be non-negative.")
        }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse else {
                throw HostClientError.invalidResponse
            }
            let effectiveLimit = (200..<300).contains(response.statusCode)
                ? maximumResponseBytes
                : min(maximumResponseBytes, HTTPHostClient.maximumJSONResponseBytes)
            if response.expectedContentLength > Int64(effectiveLimit) {
                throw HostClientError.responseTooLarge(limit: effectiveLimit)
            }

            var data = Data()
            if response.expectedContentLength > 0 {
                data.reserveCapacity(min(effectiveLimit, Int(response.expectedContentLength)))
            }
            // Buffer in bounded chunks: appending Data byte-by-byte is far too
            // slow for Object responses, while the limit check still rejects
            // the stream before it can buffer past effectiveLimit.
            let chunkCapacity = 64 * 1_024
            var chunk = [UInt8]()
            chunk.reserveCapacity(chunkCapacity)
            for try await byte in bytes {
                chunk.append(byte)
                guard data.count + chunk.count <= effectiveLimit else {
                    throw HostClientError.responseTooLarge(limit: effectiveLimit)
                }
                if chunk.count == chunkCapacity {
                    data.append(contentsOf: chunk)
                    chunk.removeAll(keepingCapacity: true)
                }
            }
            data.append(contentsOf: chunk)
            let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
                result[String(describing: item.key).lowercased()] = String(describing: item.value)
            }
            return HostHTTPResponse(statusCode: response.statusCode, headers: headers, body: data)
        } catch let error as HostClientError {
            throw error
        } catch {
            throw HostClientError.transport(error.localizedDescription)
        }
    }
}

public struct HTTPHostClient: HostClient, Sendable {
    static let maximumJSONResponseBytes = 64 * 1_024 * 1_024
    static let maximumObjectResponseBytes = 256 * 1_024 * 1_024

    private let baseURL: URL
    private let bearerToken: String
    private let transport: any HostHTTPTransport

    public init(
        baseURL: URL,
        bearerToken: String,
        transport: any HostHTTPTransport = URLSessionHostHTTPTransport()
    ) throws {
        let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        guard components?.scheme == "http",
              let encodedHost = components?.percentEncodedHost,
              ["127.0.0.1", "[::1]"].contains(encodedHost),
              let host = baseURL.host?.lowercased(),
              ["127.0.0.1", "::1"].contains(host),
              baseURL.user == nil,
              baseURL.password == nil,
              baseURL.query == nil,
              baseURL.fragment == nil,
              baseURL.path.isEmpty || baseURL.path == "/"
        else {
            throw HostClientError.invalidConfiguration(
                "The Host base URL must use literal http://127.0.0.1 or http://[::1] without credentials, path, query, or fragment."
            )
        }
        guard Self.isHostBearerToken(bearerToken) else {
            throw HostClientError.invalidConfiguration(
                "The Host bearer token must be the 43-character base64url token generated for this server start."
            )
        }

        self.baseURL = baseURL
        self.bearerToken = bearerToken
        self.transport = transport
    }

    public func getStatus() async throws -> HostStatus {
        try await requestJSON(HostStatus.self, method: "GET", path: ["v1", "status"])
    }

    public func listSnapshots() async throws -> SnapshotPage {
        try await requestJSON(SnapshotPage.self, method: "GET", path: ["v1", "snapshots"])
    }

    public func getSnapshot(id: String) async throws -> RuntimeSnapshot {
        guard (try? SnapshotID(validating: id)) != nil else {
            throw HostClientError.invalidIdentifier(id)
        }
        let response = try await request(method: "GET", path: ["v1", "snapshots", id])
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            let snapshot = try RuntimeSnapshotCodec.decode(response.body)
            guard snapshot.snapshotID.rawValue == id else {
                throw HostClientError.decoding(
                    "GET /v1/snapshots/:id returned \(snapshot.snapshotID.rawValue) for requested Snapshot \(id)."
                )
            }
            return snapshot
        } catch let error as HostClientError {
            throw error
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func getObject(hash: String, range: ObjectByteRange? = nil) async throws -> Data {
        guard Self.isCanonicalSHA256Reference(hash) else {
            throw HostClientError.invalidIdentifier(hash)
        }
        var headers: [String: String] = [:]
        if let range {
            headers["Range"] = range.headerValue
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "objects", hash],
            headers: headers,
            accept: "*/*",
            maximumResponseBytes: Self.maximumObjectResponseBytes
        )
        try requireStatus(response, expected: [range == nil ? 200 : 206])
        if let range {
            try validateRangeObjectResponse(response, hash: hash, requestedRange: range)
        } else {
            try validateFullObjectResponse(response, hash: hash)
        }
        return response.body
    }

    public func getEventTimeline(eventEpochID: String? = nil) async throws -> EventTimeline {
        if let eventEpochID {
            guard (try? EventEpochID(validating: eventEpochID)) != nil else {
                throw HostClientError.invalidIdentifier(eventEpochID)
            }
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "events"],
            query: eventEpochID.map { [URLQueryItem(name: "event_epoch_id", value: $0)] } ?? []
        )
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(EventTimeline.self, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func listReviewIssues(states: [String]? = nil) async throws -> ReviewIssuePage {
        if let states {
            guard !states.isEmpty,
                  states.count <= 8,
                  states.allSatisfy({ $0.range(of: "^[a-z_]{1,32}$", options: .regularExpression) != nil })
            else {
                throw HostClientError.invalidIdentifier(states.joined(separator: ","))
            }
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "review-issues"],
            query: states.map { [URLQueryItem(name: "states", value: $0.joined(separator: ","))] } ?? []
        )
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(ReviewIssuePage.self, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func getScreenGraph(projectID: String, applicationID: String) async throws -> CanvasGraph {
        guard projectID.range(of: "^project_[0-9a-f-]{36}$", options: .regularExpression) != nil,
              applicationID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$", options: .regularExpression) != nil
        else {
            throw HostClientError.invalidIdentifier("\(projectID)/\(applicationID)")
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "screen-graph"],
            query: [
                URLQueryItem(name: "project_id", value: projectID),
                URLQueryItem(name: "application_id", value: applicationID),
            ]
        )
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(CanvasGraph.self, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func searchWikiNodes(text: String?) async throws -> WikiNodePage {
        if let text {
            guard !text.isEmpty, text.utf8.count <= 512 else {
                throw HostClientError.invalidIdentifier("wiki search text")
            }
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "wiki", "nodes"],
            query: text.map { [URLQueryItem(name: "text", value: $0)] } ?? []
        )
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(WikiNodePage.self, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func createTuningPatch(_ draft: TuningPatchDraft) async throws -> TuningPatchSummary {
        guard (try? SnapshotID(validating: draft.targetSnapshotID)) != nil else {
            throw HostClientError.invalidIdentifier(draft.targetSnapshotID)
        }
        return try await sendJSON(
            TuningPatchSummary.self,
            path: ["v1", "tuning-patches"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func applyTuningPatch(
        patchID: String,
        previewTTLMilliseconds: Int? = nil
    ) async throws -> TuningApplicationSummary {
        guard Self.isTypedIdentifier(patchID, prefix: "patch") else {
            throw HostClientError.invalidIdentifier(patchID)
        }
        if let previewTTLMilliseconds {
            guard (100...3_600_000).contains(previewTTLMilliseconds) else {
                throw HostClientError.invalidConfiguration(
                    "The tuning preview TTL must be between 100 and 3600000 milliseconds."
                )
            }
        }
        return try await sendJSON(
            TuningApplicationSummary.self,
            path: ["v1", "tuning-applications"],
            body: TuningApplicationRequestBody(
                patchID: patchID,
                previewTTLMilliseconds: previewTTLMilliseconds
            ),
            expectedStatus: 201
        )
    }

    public func revertTuningApplication(id: String) async throws -> TuningApplicationSummary {
        guard Self.isTypedIdentifier(id, prefix: "tuningapp") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await sendJSON(
            TuningApplicationSummary.self,
            path: ["v1", "tuning-applications", id, "revert"],
            body: EmptyJSONBody(),
            expectedStatus: 200
        )
    }

    public func listActiveTuningApplications() async throws -> TuningApplicationPage {
        try await requestJSON(
            TuningApplicationPage.self,
            method: "GET",
            path: ["v1", "tuning-applications", "active"]
        )
    }

    public func getReviewIssue(id: String) async throws -> ReviewIssueSummary {
        guard Self.isTypedIdentifier(id, prefix: "issue") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            ReviewIssueSummary.self,
            method: "GET",
            path: ["v1", "review-issues", id]
        )
    }

    public func transitionReviewIssue(
        id: String,
        _ transition: ReviewIssueTransitionRequest
    ) async throws -> ReviewIssueSummary {
        guard Self.isTypedIdentifier(id, prefix: "issue") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await sendJSON(
            ReviewIssueSummary.self,
            path: ["v1", "review-issues", id, "transitions"],
            body: transition,
            expectedStatus: 200
        )
    }

    public func createWikiNode(_ draft: WikiNodeDraft) async throws -> WikiNodeDetail {
        try await sendJSON(
            WikiNodeDetail.self,
            path: ["v1", "wiki", "nodes"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func getWikiNode(id: String) async throws -> WikiNodeDetail {
        guard Self.isTypedIdentifier(id, prefix: "wiki") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            WikiNodeDetail.self,
            method: "GET",
            path: ["v1", "wiki", "nodes", id]
        )
    }

    public func reviseWikiNode(
        id: String,
        _ draft: WikiNodeRevisionDraft
    ) async throws -> WikiNodeDetail {
        guard Self.isTypedIdentifier(id, prefix: "wiki") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await sendJSON(
            WikiNodeDetail.self,
            path: ["v1", "wiki", "nodes", id, "revisions"],
            body: draft,
            expectedStatus: 200
        )
    }

    public func getScreenState(id: String) async throws -> ScreenStateDetail {
        guard Self.isTypedIdentifier(id, prefix: "screenstate") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            ScreenStateDetail.self,
            method: "GET",
            path: ["v1", "screen-states", id]
        )
    }

    public func createWikiLink(_ draft: WikiLinkDraft) async throws -> WikiLinkSummary {
        guard Self.isTypedIdentifier(draft.sourceNodeID, prefix: "wiki") else {
            throw HostClientError.invalidIdentifier(draft.sourceNodeID)
        }
        return try await sendJSON(
            WikiLinkSummary.self,
            path: ["v1", "wiki", "links"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func relatedWikiNodes(kind: String, id: String) async throws -> WikiNodePage {
        guard kind.range(of: "^[a-z][a-z0-9._-]*$", options: .regularExpression) != nil,
              !id.isEmpty,
              id.utf8.count <= 320
        else {
            throw HostClientError.invalidIdentifier("\(kind)/\(id)")
        }
        return try await requestJSON(
            WikiNodePage.self,
            method: "GET",
            path: ["v1", "wiki", "related"],
            query: [
                URLQueryItem(name: "kind", value: kind),
                URLQueryItem(name: "id", value: id),
            ]
        )
    }

    public func capture(_ requestValue: CaptureRequest = CaptureRequest()) async throws -> RuntimeSnapshot {
        let body: Data
        do {
            body = try JSONEncoder().encode(requestValue)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
        let response = try await request(
            method: "POST",
            path: ["v1", "captures"],
            headers: ["Content-Type": "application/json"],
            body: body
        )
        try requireStatus(response, expected: [201])
        try requireJSONSize(response.body)
        do {
            return try RuntimeSnapshotCodec.decode(response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    private func requestJSON<Value: Decodable>(
        _ type: Value.Type,
        method: String,
        path: [String],
        query: [URLQueryItem] = []
    ) async throws -> Value {
        let response = try await request(method: method, path: path, query: query)
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(type, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    /// Encodes one write command, posts it, and decodes the frozen result.
    private func sendJSON<Body: Encodable, Value: Decodable>(
        _ type: Value.Type,
        path: [String],
        body: Body,
        expectedStatus: Int
    ) async throws -> Value {
        let encodedBody: Data
        do {
            encodedBody = try JSONEncoder().encode(body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
        let response = try await request(
            method: "POST",
            path: path,
            headers: ["Content-Type": "application/json"],
            body: encodedBody
        )
        try requireStatus(response, expected: [expectedStatus])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(type, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    private func request(
        method: String,
        path: [String],
        query: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil,
        accept: String = "application/json",
        maximumResponseBytes: Int = Self.maximumJSONResponseBytes
    ) async throws -> HostHTTPResponse {
        var url = baseURL
        for component in path {
            url.append(path: component)
        }
        if !query.isEmpty {
            url.append(queryItems: query)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let response = try await transport.execute(request, maximumResponseBytes: maximumResponseBytes)
        let effectiveLimit = (200..<300).contains(response.statusCode)
            ? maximumResponseBytes
            : min(maximumResponseBytes, Self.maximumJSONResponseBytes)
        guard response.body.count <= effectiveLimit else {
            throw HostClientError.responseTooLarge(limit: effectiveLimit)
        }
        return response
    }

    private func requireStatus(_ response: HostHTTPResponse, expected: Set<Int>) throws {
        guard expected.contains(response.statusCode) else {
            if let envelope = try? JSONDecoder().decode(HostErrorEnvelope.self, from: response.body) {
                throw HostClientError.server(
                    statusCode: response.statusCode,
                    requestID: envelope.requestID,
                    code: envelope.error.code,
                    message: envelope.error.message,
                    retryable: envelope.error.retryable
                )
            }
            throw HostClientError.server(
                statusCode: response.statusCode,
                requestID: nil,
                code: "host.unexpected_status",
                message: "The Host returned HTTP \(response.statusCode); expected \(expected.sorted().map(String.init).joined(separator: " or ")).",
                retryable: response.statusCode >= 500
            )
        }
    }

    private func requireJSONSize(_ data: Data) throws {
        guard data.count <= Self.maximumJSONResponseBytes else {
            throw HostClientError.responseTooLarge(limit: Self.maximumJSONResponseBytes)
        }
    }

    private static func isCanonicalSHA256Reference(_ value: String) -> Bool {
        guard value.hasPrefix("sha256:") else {
            return false
        }
        let digest = value.dropFirst("sha256:".count).utf8
        return digest.count == 64 && digest.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x61...0x66).contains(byte)
        }
    }

    /// Validates one canonical typed UUIDv7 identifier such as
    /// `patch_019f0000-0000-7000-8000-000000000001`.
    private static func isTypedIdentifier(_ value: String, prefix: String) -> Bool {
        let pattern =
            "^\(prefix)_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        return value.range(of: pattern, options: .regularExpression) != nil
    }

    private static func isHostBearerToken(_ value: String) -> Bool {
        let bytes = value.utf8
        return bytes.count == 43 && bytes.allSatisfy { byte in
            (0x41...0x5A).contains(byte)
                || (0x61...0x7A).contains(byte)
                || (0x30...0x39).contains(byte)
                || byte == 0x2D
                || byte == 0x5F
        }
    }

    private func validateFullObjectResponse(_ response: HostHTTPResponse, hash: String) throws {
        try validateETag(response, hash: hash)
        try validateContentLength(response)
        let digest = SHA256.hash(data: response.body)
        let actual = "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
        guard actual == hash else {
            throw HostClientError.integrity("SHA-256 was \(actual), expected \(hash).")
        }
    }

    private func validateRangeObjectResponse(
        _ response: HostHTTPResponse,
        hash: String,
        requestedRange: ObjectByteRange
    ) throws {
        try validateETag(response, hash: hash)
        try validateContentLength(response)
        guard let header = response.header("content-range"),
              let parsed = Self.parseCanonicalContentRange(header)
        else {
            throw HostClientError.integrity("The Range response is missing a canonical Content-Range header.")
        }
        guard parsed.start == requestedRange.lowerBound, parsed.total > 0 else {
            throw HostClientError.integrity("Content-Range does not begin at the requested byte.")
        }
        let requestedEnd = requestedRange.upperBound.map { min($0, parsed.total - 1) }
            ?? (parsed.total - 1)
        guard parsed.end == requestedEnd else {
            throw HostClientError.integrity("Content-Range does not end at the expected byte.")
        }
        let expectedLength = parsed.end - parsed.start + 1
        guard expectedLength == UInt64(response.body.count) else {
            throw HostClientError.integrity("Content-Range length does not match the response body.")
        }
    }

    private func validateETag(_ response: HostHTTPResponse, hash: String) throws {
        guard response.header("etag") == "\"\(hash)\"" else {
            throw HostClientError.integrity("ETag is missing or does not identify the requested Object.")
        }
    }

    private func validateContentLength(_ response: HostHTTPResponse) throws {
        guard let value = response.header("content-length"),
              let length = Self.parseCanonicalUInt(value),
              length == UInt64(response.body.count)
        else {
            throw HostClientError.integrity("Content-Length is missing, non-canonical, or does not match the response body.")
        }
    }

    private static func parseCanonicalContentRange(
        _ value: String
    ) -> (start: UInt64, end: UInt64, total: UInt64)? {
        guard value.hasPrefix("bytes ") else { return nil }
        let components = value.dropFirst("bytes ".count).split(separator: "/", omittingEmptySubsequences: false)
        guard components.count == 2,
              let total = parseCanonicalUInt(String(components[1])),
              total > 0
        else { return nil }
        let bounds = components[0].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2,
              let start = parseCanonicalUInt(String(bounds[0])),
              let end = parseCanonicalUInt(String(bounds[1])),
              start <= end,
              end < total,
              value == "bytes \(start)-\(end)/\(total)"
        else { return nil }
        return (start, end, total)
    }

    private static func parseCanonicalUInt(_ value: String) -> UInt64? {
        guard !value.isEmpty,
              value.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
              let parsed = UInt64(value),
              value == String(parsed)
        else { return nil }
        return parsed
    }
}

/// The `POST /v1/tuning-applications` command body.
private struct TuningApplicationRequestBody: Encodable {
    let patchID: String
    let previewTTLMilliseconds: Int?

    private enum CodingKeys: String, CodingKey {
        case patchID = "patch_id"
        case previewTTLMilliseconds = "preview_ttl_ms"
    }
}

/// An explicit empty JSON object body for parameterless POST routes.
private struct EmptyJSONBody: Encodable {}
