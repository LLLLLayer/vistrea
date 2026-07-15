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
        try await listReviewIssues(states: states, screenStateID: nil)
    }

    public func listReviewIssues(
        states: [String]?,
        screenStateID: String?
    ) async throws -> ReviewIssuePage {
        if let states {
            guard !states.isEmpty,
                  states.count <= 8,
                  states.allSatisfy({ $0.range(of: "^[a-z_]{1,32}$", options: .regularExpression) != nil })
            else {
                throw HostClientError.invalidIdentifier(states.joined(separator: ","))
            }
        }
        if let screenStateID, !Self.isTypedIdentifier(screenStateID, prefix: "screenstate") {
            throw HostClientError.invalidIdentifier(screenStateID)
        }
        var query = states.map {
            [URLQueryItem(name: "states", value: $0.joined(separator: ","))]
        } ?? []
        if let screenStateID {
            query.append(URLQueryItem(name: "screen_state_id", value: screenStateID))
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "review-issues"],
            query: query
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
        try await getScreenGraph(
            projectID: projectID,
            applicationID: applicationID,
            scope: nil
        )
    }

    public func getScreenGraph(
        projectID: String,
        applicationID: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> CanvasGraph {
        guard Self.isTypedIdentifier(buildID, prefix: "build"),
              !applicationVersion.isEmpty,
              applicationVersion.count <= 128
        else {
            throw HostClientError.invalidIdentifier("\(applicationVersion)/\(buildID)")
        }
        return try await getScreenGraph(
            projectID: projectID,
            applicationID: applicationID,
            scope: (applicationVersion, buildID)
        )
    }

    private func getScreenGraph(
        projectID: String,
        applicationID: String,
        scope: (applicationVersion: String, buildID: String)?
    ) async throws -> CanvasGraph {
        guard projectID.range(of: "^project_[0-9a-f-]{36}$", options: .regularExpression) != nil,
              applicationID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$", options: .regularExpression) != nil
        else {
            throw HostClientError.invalidIdentifier("\(projectID)/\(applicationID)")
        }
        var query = [
            URLQueryItem(name: "project_id", value: projectID),
            URLQueryItem(name: "application_id", value: applicationID),
        ]
        if let scope {
            query.append(URLQueryItem(name: "build_id", value: scope.buildID))
            query.append(
                URLQueryItem(name: "application_version", value: scope.applicationVersion)
            )
        }
        let response = try await request(
            method: "GET",
            path: ["v1", "screen-graph"],
            query: query
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

    public func listKnowledgeCollections(
        text: String?,
        publicationStates: [String]?
    ) async throws -> KnowledgeCollectionPage {
        if let text {
            guard !text.isEmpty, text.utf8.count <= 512 else {
                throw HostClientError.invalidIdentifier("collection search text")
            }
        }
        if let publicationStates {
            guard !publicationStates.isEmpty,
                  publicationStates.count <= 3,
                  Set(publicationStates).count == publicationStates.count,
                  publicationStates.allSatisfy({ ["draft", "published", "archived"].contains($0) })
            else {
                throw HostClientError.invalidIdentifier("collection publication states")
            }
        }
        var query = text.map { [URLQueryItem(name: "text", value: $0)] } ?? []
        if let publicationStates {
            query.append(
                URLQueryItem(
                    name: "publication_states",
                    value: publicationStates.joined(separator: ",")
                )
            )
        }
        return try await requestJSON(
            KnowledgeCollectionPage.self,
            method: "GET",
            path: ["v1", "knowledge-collections"],
            query: query
        )
    }

    public func getKnowledgeCollection(id: String) async throws -> KnowledgeCollectionSummary {
        guard Self.isTypedIdentifier(id, prefix: "collection") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            KnowledgeCollectionSummary.self,
            method: "GET",
            path: ["v1", "knowledge-collections", id]
        )
    }

    public func createKnowledgeCollection(
        _ draft: KnowledgeCollectionDraft
    ) async throws -> KnowledgeCollectionSummary {
        try Self.validateKnowledgeCollection(
            name: draft.name,
            nodeIDs: draft.nodeIDs,
            entryNodeIDs: draft.entryNodeIDs
        )
        return try await sendJSON(
            KnowledgeCollectionSummary.self,
            path: ["v1", "knowledge-collections"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func reviseKnowledgeCollection(
        id: String,
        _ draft: KnowledgeCollectionRevisionDraft
    ) async throws -> KnowledgeCollectionSummary {
        guard Self.isTypedIdentifier(id, prefix: "collection"), draft.expectedRevision >= 1 else {
            throw HostClientError.invalidIdentifier(id)
        }
        if let name = draft.name, name.isEmpty || name.count > 256 {
            throw HostClientError.invalidConfiguration(
                "A Knowledge Collection name must contain 1 through 256 characters."
            )
        }
        if let nodeIDs = draft.nodeIDs {
            guard !nodeIDs.isEmpty, Set(nodeIDs).count == nodeIDs.count else {
                throw HostClientError.invalidConfiguration(
                    "A Knowledge Collection requires unique member nodes."
                )
            }
        }
        if let entryNodeIDs = draft.entryNodeIDs {
            guard !entryNodeIDs.isEmpty, Set(entryNodeIDs).count == entryNodeIDs.count else {
                throw HostClientError.invalidConfiguration(
                    "A Knowledge Collection requires unique entry nodes."
                )
            }
        }
        return try await sendJSON(
            KnowledgeCollectionSummary.self,
            path: ["v1", "knowledge-collections", id, "revisions"],
            body: draft,
            expectedStatus: 200
        )
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

    public func getTuningSourceSuggestions(
        patchID: String
    ) async throws -> TuningSourceSuggestionResult {
        guard Self.isTypedIdentifier(patchID, prefix: "patch") else {
            throw HostClientError.invalidIdentifier(patchID)
        }
        return try await requestJSON(
            TuningSourceSuggestionResult.self,
            method: "GET",
            path: ["v1", "tuning-patches", patchID, "source-suggestions"]
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

    public func createReviewIssueFromDifference(
        comparisonID: String,
        _ request: CreateReviewIssueFromDifferenceRequest
    ) async throws -> ReviewIssueSummary {
        guard Self.isTypedIdentifier(comparisonID, prefix: "comparison") else {
            throw HostClientError.invalidIdentifier(comparisonID)
        }
        guard Self.isTypedIdentifier(request.differenceID, prefix: "difference") else {
            throw HostClientError.invalidIdentifier(request.differenceID)
        }
        return try await sendJSON(
            ReviewIssueSummary.self,
            path: ["v1", "design-comparisons", comparisonID, "issues"],
            body: request,
            expectedStatus: 201
        )
    }

    public func recaptureAndVerifyReviewIssue(
        id: String,
        _ request: RecaptureReviewIssueRequest
    ) async throws -> RecaptureReviewIssueResult {
        guard Self.isTypedIdentifier(id, prefix: "issue") else {
            throw HostClientError.invalidIdentifier(id)
        }
        guard request.expectedRevision >= 1 else {
            throw HostClientError.invalidConfiguration(
                "The expected Review Issue revision must be at least 1."
            )
        }
        return try await sendJSON(
            RecaptureReviewIssueResult.self,
            path: ["v1", "review-issues", id, "recapture-verifications"],
            body: request,
            expectedStatus: 201
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

    public func getScreenState(
        id: String,
        applicationVersion: String,
        buildID: String
    ) async throws -> ScreenStateDetail {
        guard Self.isTypedIdentifier(id, prefix: "screenstate"),
              Self.isTypedIdentifier(buildID, prefix: "build"),
              !applicationVersion.isEmpty,
              applicationVersion.count <= 128
        else {
            throw HostClientError.invalidIdentifier("\(id)/\(applicationVersion)/\(buildID)")
        }
        return try await requestJSON(
            ScreenStateDetail.self,
            method: "GET",
            path: ["v1", "screen-states", id],
            query: [
                URLQueryItem(name: "build_id", value: buildID),
                URLQueryItem(name: "application_version", value: applicationVersion),
            ]
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

    public func mergeScreenStates(_ command: MergeScreenStatesCommand) async throws -> IdentityCurationResult {
        try Self.validateGraphIdentity(projectID: command.projectID, applicationID: command.applicationID)
        guard (2...64).contains(command.stateIDs.count),
              command.stateIDs.allSatisfy({ Self.isTypedIdentifier($0, prefix: "screenstate") })
        else {
            throw HostClientError.invalidIdentifier(command.stateIDs.joined(separator: ","))
        }
        if let intoStateID = command.intoStateID {
            guard Self.isTypedIdentifier(intoStateID, prefix: "screenstate"),
                  command.stateIDs.contains(intoStateID)
            else {
                throw HostClientError.invalidIdentifier(intoStateID)
            }
        }
        try Self.validateGraphRevision(command.expectedGraphRevision)
        try Self.validateJustification(command.justification)
        return try await sendJSON(
            IdentityCurationResult.self,
            path: ["v1", "screen-graph", "state-merges"],
            body: command,
            expectedStatus: 201
        )
    }

    public func splitScreenState(_ command: SplitScreenStateCommand) async throws -> IdentityCurationResult {
        try Self.validateGraphIdentity(projectID: command.projectID, applicationID: command.applicationID)
        guard Self.isTypedIdentifier(command.stateID, prefix: "screenstate") else {
            throw HostClientError.invalidIdentifier(command.stateID)
        }
        guard (1...256).contains(command.observationIDs.count),
              command.observationIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 })
        else {
            throw HostClientError.invalidConfiguration(
                "A split names between 1 and 256 observation IDs of up to 128 bytes each."
            )
        }
        if let title = command.title {
            guard !title.isEmpty, title.utf8.count <= 512 else {
                throw HostClientError.invalidConfiguration(
                    "The split title must contain 1 through 512 bytes."
                )
            }
        }
        try Self.validateGraphRevision(command.expectedGraphRevision)
        try Self.validateJustification(command.justification)
        return try await sendJSON(
            IdentityCurationResult.self,
            path: ["v1", "screen-graph", "state-splits"],
            body: command,
            expectedStatus: 201
        )
    }

    public func annotateScreenState(
        _ command: AnnotateScreenStateCommand
    ) async throws -> ScreenStateAnnotationResult {
        try Self.validateGraphIdentity(projectID: command.projectID, applicationID: command.applicationID)
        guard Self.isTypedIdentifier(command.stateID, prefix: "screenstate") else {
            throw HostClientError.invalidIdentifier(command.stateID)
        }
        guard command.labels != nil || command.summary != nil else {
            throw HostClientError.invalidConfiguration(
                "An annotation sets labels, a summary, or both."
            )
        }
        if let labels = command.labels {
            // An empty array is the canonical "clear the labels" value; a
            // present label must be a unique 1-through-128-character string.
            guard Set(labels).count == labels.count,
                  labels.allSatisfy({ !$0.isEmpty && $0.count <= 128 })
            else {
                throw HostClientError.invalidConfiguration(
                    "Annotation labels must be unique strings of 1 through 128 characters."
                )
            }
        }
        if let summary = command.summary {
            // The empty string is the canonical "clear the summary" value.
            guard summary.count <= 280 else {
                throw HostClientError.invalidConfiguration(
                    "The annotation summary must contain at most 280 characters."
                )
            }
        }
        try Self.validateGraphRevision(command.expectedGraphRevision)
        return try await sendJSON(
            ScreenStateAnnotationResult.self,
            path: ["v1", "screen-graph", "state-annotations"],
            body: command,
            expectedStatus: 200
        )
    }

    public func listDesignReferences() async throws -> DesignReferencePage {
        try await requestJSON(
            DesignReferencePage.self,
            method: "GET",
            path: ["v1", "design-references"]
        )
    }

    public func getDesignReference(id: String) async throws -> DesignReferenceDetail {
        guard Self.isTypedIdentifier(id, prefix: "designref") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            DesignReferenceDetail.self,
            method: "GET",
            path: ["v1", "design-references", id]
        )
    }

    public func listDesignComparisons(
        designReferenceID: String?,
        targetSnapshotID: String?
    ) async throws -> DesignComparisonPage {
        var query: [URLQueryItem] = []
        if let designReferenceID {
            guard Self.isTypedIdentifier(designReferenceID, prefix: "designref") else {
                throw HostClientError.invalidIdentifier(designReferenceID)
            }
            query.append(URLQueryItem(name: "design_reference_id", value: designReferenceID))
        }
        if let targetSnapshotID {
            guard (try? SnapshotID(validating: targetSnapshotID)) != nil else {
                throw HostClientError.invalidIdentifier(targetSnapshotID)
            }
            query.append(URLQueryItem(name: "target_snapshot_id", value: targetSnapshotID))
        }
        return try await requestJSON(
            DesignComparisonPage.self,
            method: "GET",
            path: ["v1", "design-comparisons"],
            query: query
        )
    }

    public func runDesignComparison(
        _ command: DesignComparisonCommand
    ) async throws -> DesignComparisonDetail {
        guard Self.isTypedIdentifier(command.designReferenceID, prefix: "designref") else {
            throw HostClientError.invalidIdentifier(command.designReferenceID)
        }
        guard (try? SnapshotID(validating: command.targetSnapshotID)) != nil else {
            throw HostClientError.invalidIdentifier(command.targetSnapshotID)
        }
        return try await sendJSON(
            DesignComparisonDetail.self,
            path: ["v1", "design-comparisons"],
            body: command,
            expectedStatus: 201
        )
    }

    public func runExploration(_ command: ExplorationRunCommand) async throws -> ExplorationOperationRef {
        guard (1...500).contains(command.maximumActions) else {
            throw HostClientError.invalidConfiguration(
                "The exploration action budget must be between 1 and 500 actions."
            )
        }
        if let maximumDepth = command.maximumDepth {
            guard (1...32).contains(maximumDepth) else {
                throw HostClientError.invalidConfiguration(
                    "The exploration depth limit must be between 1 and 32."
                )
            }
        }
        if let settleMilliseconds = command.settleMilliseconds {
            guard (0...60_000).contains(settleMilliseconds) else {
                throw HostClientError.invalidConfiguration(
                    "The exploration settle time must be between 0 and 60000 milliseconds."
                )
            }
        }
        if let excluded = command.excludedStableIDs {
            guard excluded.count <= 128,
                  excluded.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 })
            else {
                throw HostClientError.invalidConfiguration(
                    "Excluded stable IDs must be at most 128 non-empty strings of up to 256 bytes."
                )
            }
        }
        if let actorID = command.actorID {
            guard !actorID.isEmpty, actorID.utf8.count <= 256 else {
                throw HostClientError.invalidConfiguration(
                    "The exploration actor ID must be a non-empty string of up to 256 bytes."
                )
            }
        }
        return try await sendJSON(
            ExplorationOperationRef.self,
            path: ["v1", "exploration", "operations"],
            body: command,
            expectedStatus: 201
        )
    }

    public func getExplorationOperation(id: String) async throws -> ExplorationOperationRecord {
        guard Self.isTypedIdentifier(id, prefix: "operation") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            ExplorationOperationRecord.self,
            method: "GET",
            path: ["v1", "exploration", "operations", id]
        )
    }

    public func cancelExploration(id: String) async throws -> ExplorationOperationRef {
        guard Self.isTypedIdentifier(id, prefix: "operation") else {
            throw HostClientError.invalidIdentifier(id)
        }
        // The cancel route accepts no request body.
        let response = try await request(
            method: "POST",
            path: ["v1", "exploration", "operations", id, "cancel"]
        )
        try requireStatus(response, expected: [200])
        try requireJSONSize(response.body)
        do {
            return try JSONDecoder().decode(ExplorationOperationRef.self, from: response.body)
        } catch {
            throw HostClientError.decoding(String(describing: error))
        }
    }

    public func validateSnapshot(
        _ draft: ValidateSnapshotDraft
    ) async throws -> ValidationOutcomeSummary {
        guard (try? SnapshotID(validating: draft.snapshotID)) != nil else {
            throw HostClientError.invalidIdentifier(draft.snapshotID)
        }
        try Self.validateValidationCategories(draft.categories)
        return try await sendJSON(
            ValidationOutcomeSummary.self,
            path: ["v1", "validation", "snapshot-runs"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func validateScreenGraph(
        _ draft: ValidateScreenGraphDraft
    ) async throws -> ValidationOutcomeSummary {
        try Self.validateGraphIdentity(
            projectID: draft.projectID,
            applicationID: draft.applicationID
        )
        return try await sendJSON(
            ValidationOutcomeSummary.self,
            path: ["v1", "validation", "graph-runs"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func getValidationRun(id: String) async throws -> ValidationRunSummary {
        guard Self.isTypedIdentifier(id, prefix: "validationrun") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            ValidationRunSummary.self,
            method: "GET",
            path: ["v1", "validation", "runs", id]
        )
    }

    public func listValidationFindings(runID: String?) async throws -> ValidationFindingPage {
        if let runID, !Self.isTypedIdentifier(runID, prefix: "validationrun") {
            throw HostClientError.invalidIdentifier(runID)
        }
        return try await requestJSON(
            ValidationFindingPage.self,
            method: "GET",
            path: ["v1", "validation", "findings"],
            query: runID.map { [URLQueryItem(name: "validation_run_id", value: $0)] } ?? []
        )
    }

    public func suppressValidationFinding(
        id: String,
        _ draft: SuppressValidationFindingDraft
    ) async throws -> ValidationFindingSummary {
        guard Self.isTypedIdentifier(id, prefix: "finding"),
              draft.expectedFindingRevision >= 1,
              ["false_positive", "accepted_risk", "known_issue", "environment_variance", "other"]
                .contains(draft.reasonCode),
              !draft.justification.isEmpty,
              draft.justification.count <= 2_048
        else {
            throw HostClientError.invalidConfiguration(
                "A Finding suppression requires a canonical Finding, reason, current revision, and bounded justification."
            )
        }
        return try await sendJSON(
            ValidationFindingSummary.self,
            path: ["v1", "validation", "findings", id, "suppress"],
            body: draft,
            expectedStatus: 200
        )
    }

    public func compareBuilds(_ draft: BuildDiffCommandDraft) async throws -> BuildDiffSummary {
        try Self.validateGraphIdentity(
            projectID: draft.projectID,
            applicationID: draft.applicationID
        )
        guard Self.isTypedIdentifier(draft.leftBuildID, prefix: "build"),
              Self.isTypedIdentifier(draft.rightBuildID, prefix: "build"),
              draft.leftBuildID != draft.rightBuildID
        else {
            throw HostClientError.invalidConfiguration(
                "A Build Diff requires two distinct canonical Build IDs."
            )
        }
        return try await sendJSON(
            BuildDiffSummary.self,
            path: ["v1", "validation", "build-diffs"],
            body: draft,
            expectedStatus: 201
        )
    }

    public func getBuildDiff(id: String) async throws -> BuildDiffSummary {
        guard Self.isTypedIdentifier(id, prefix: "builddiff") else {
            throw HostClientError.invalidIdentifier(id)
        }
        return try await requestJSON(
            BuildDiffSummary.self,
            method: "GET",
            path: ["v1", "validation", "build-diffs", id]
        )
    }

    public func getSyncStatus(
        remote: HubSyncRemote,
        refNames: [String]?
    ) async throws -> HubSyncStatus {
        try Self.validateHubRemote(remote)
        if let refNames { try Self.validateSyncRefNames(refNames) }
        return try await sendJSON(
            HubSyncStatus.self,
            path: ["v1", "sync", "status"],
            body: HubSyncStatusRequest(remote: remote, refNames: refNames),
            expectedStatus: 200
        )
    }

    public func fetchWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor
    ) async throws -> HubSyncFetchOutcome {
        try Self.validateHubRemote(remote)
        try Self.validateSyncRefNames(refNames)
        try Self.validateSyncActor(actor)
        return try await sendJSON(
            HubSyncFetchOutcome.self,
            path: ["v1", "sync", "fetch"],
            body: HubSyncTransferRequest(
                remote: remote,
                refNames: refNames,
                createdBy: actor,
                message: nil
            ),
            expectedStatus: 200
        )
    }

    public func pushWorkspace(
        remote: HubSyncRemote,
        refNames: [String],
        actor: HubSyncActor,
        message: String?
    ) async throws -> HubSyncPushOutcome {
        try Self.validateHubRemote(remote)
        try Self.validateSyncRefNames(refNames)
        try Self.validateSyncActor(actor)
        if let message, message.isEmpty || message.utf8.count > 1_024 {
            throw HostClientError.invalidConfiguration(
                "A Hub push message must contain 1 through 1024 UTF-8 bytes."
            )
        }
        return try await sendJSON(
            HubSyncPushOutcome.self,
            path: ["v1", "sync", "push"],
            body: HubSyncTransferRequest(
                remote: remote,
                refNames: refNames,
                createdBy: actor,
                message: message
            ),
            expectedStatus: 200
        )
    }

    public func getSyncActivity(
        remote: HubSyncRemote,
        afterSequence: UInt64?,
        limit: Int?
    ) async throws -> HubSyncActivityPage {
        try Self.validateHubRemote(remote)
        if let limit, !(1...500).contains(limit) {
            throw HostClientError.invalidConfiguration(
                "A Hub activity page limit must be between 1 and 500."
            )
        }
        return try await sendJSON(
            HubSyncActivityPage.self,
            path: ["v1", "sync", "activity"],
            body: HubSyncActivityRequest(
                remote: remote,
                afterSequence: afterSequence,
                limit: limit
            ),
            expectedStatus: 200
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

    private static func validateHubRemote(_ remote: HubSyncRemote) throws {
        guard isTypedIdentifier(remote.projectID, prefix: "project"),
              remote.bearerToken.range(
                  of: "^[A-Za-z0-9_-]{43}$",
                  options: .regularExpression
              ) != nil,
              let url = URL(string: remote.baseURL),
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty,
              (url.scheme == "https" && url.host != nil
                  || url.scheme == "http" && ["127.0.0.1", "::1", "localhost"].contains(url.host))
        else {
            throw HostClientError.invalidConfiguration(
                "The Hub requires an HTTPS origin (or loopback HTTP), a canonical Project ID, and its 43-character bearer token."
            )
        }
    }

    private static func validateSyncRefNames(_ refNames: [String]) throws {
        let pattern = "^(users|teams|builds|baselines|releases)/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$"
        guard !refNames.isEmpty,
              refNames.count <= 64,
              Set(refNames).count == refNames.count,
              refNames.allSatisfy({ $0.range(of: pattern, options: .regularExpression) != nil })
        else {
            throw HostClientError.invalidConfiguration(
                "Hub refs must be 1 through 64 unique canonical ref names."
            )
        }
    }

    private static func validateSyncActor(_ actor: HubSyncActor) throws {
        guard ["human", "agent", "service"].contains(actor.kind),
              actor.id.range(
            of: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$",
            options: .regularExpression
        ) != nil else {
            throw HostClientError.invalidConfiguration("The Hub actor identity is invalid.")
        }
    }

    /// Validates the Screen Graph identity pair every curation write names.
    private static func validateGraphIdentity(projectID: String, applicationID: String) throws {
        guard projectID.range(of: "^project_[0-9a-f-]{36}$", options: .regularExpression) != nil,
              applicationID.range(
                  of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$",
                  options: .regularExpression
              ) != nil
        else {
            throw HostClientError.invalidIdentifier("\(projectID)/\(applicationID)")
        }
    }

    private static func validateGraphRevision(_ revision: UInt64) throws {
        guard revision >= 1 else {
            throw HostClientError.invalidConfiguration(
                "The expected Screen Graph revision must be at least 1."
            )
        }
    }

    private static func validateJustification(_ justification: String?) throws {
        if let justification {
            guard !justification.isEmpty, justification.count <= 1_024 else {
                throw HostClientError.invalidConfiguration(
                    "The curation justification must contain 1 through 1024 characters."
                )
            }
        }
    }

    private static func validateKnowledgeCollection(
        name: String,
        nodeIDs: [String],
        entryNodeIDs: [String]
    ) throws {
        guard !name.isEmpty,
              name.count <= 256,
              !nodeIDs.isEmpty,
              Set(nodeIDs).count == nodeIDs.count,
              !entryNodeIDs.isEmpty,
              Set(entryNodeIDs).count == entryNodeIDs.count,
              Set(entryNodeIDs).isSubset(of: Set(nodeIDs))
        else {
            throw HostClientError.invalidConfiguration(
                "A Knowledge Collection needs a name, unique member nodes, and entry nodes contained in that membership."
            )
        }
    }

    private static func validateValidationCategories(_ categories: [String]?) throws {
        guard let categories else { return }
        let allowed = Set(["structural", "visual", "behavioral", "accessibility"])
        guard !categories.isEmpty,
              Set(categories).count == categories.count,
              Set(categories).isSubset(of: allowed)
        else {
            throw HostClientError.invalidConfiguration(
                "Validation categories must be a unique subset of the core rule categories."
            )
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
