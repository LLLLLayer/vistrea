import CryptoKit
import Foundation
import VistreaRuntimeModels
import XCTest
@testable import VistreaRuntimeConnection

final class RuntimeConnectionTests: XCTestCase {
    private let token = Data("vistrea-loopback-integration-token-0001".utf8)

    func testAuthenticationProofsMatchNodeVectors() throws {
        let key = SymmetricKey(data: token)
        let version = RuntimeConnectionProtocolVersion(major: 1, minor: 0)
        let clientProof = RuntimeConnectionAuthentication.clientProof(
            key: key,
            connectionAttemptID: "attempt-123",
            hostNonce: "host_nonce_abcdefghijklmnop",
            clientNonce: "client_nonce_abcdefghijklmnop",
            runtimeInstanceID: "runtime.test.instance",
            buildConfiguration: .debug,
            supportedVersions: [version],
            capabilities: ["runtime.snapshot"]
        )
        XCTAssertEqual(
            clientProof,
            "8590378d93c37807fee6914492d54c11a5efa1057272e28ebb9b077a8d9d3a5b"
        )

        let hostProof = RuntimeConnectionAuthentication.hostProof(
            key: key,
            connectionAttemptID: "attempt-123",
            connectionID: "connection-456",
            hostNonce: "host_nonce_abcdefghijklmnop",
            clientNonce: "client_nonce_abcdefghijklmnop",
            runtimeInstanceID: "runtime.test.instance",
            selectedVersion: version,
            enabledCapabilities: ["runtime.snapshot"]
        )
        XCTAssertEqual(
            hostProof,
            "6ef286c1b06e88438d7e9eb97a56a0a30cabb9c47470999b7500d9c003607508"
        )
        XCTAssertTrue(
            RuntimeConnectionAuthentication.verifyHostProof(
                hostProof,
                key: key,
                connectionAttemptID: "attempt-123",
                connectionID: "connection-456",
                hostNonce: "host_nonce_abcdefghijklmnop",
                clientNonce: "client_nonce_abcdefghijklmnop",
                runtimeInstanceID: "runtime.test.instance",
                selectedVersion: version,
                enabledCapabilities: ["runtime.snapshot"]
            )
        )
        XCTAssertFalse(
            RuntimeConnectionAuthentication.verifyHostProof(
                String(repeating: "0", count: 64),
                key: key,
                connectionAttemptID: "attempt-123",
                connectionID: "connection-456",
                hostNonce: "host_nonce_abcdefghijklmnop",
                clientNonce: "client_nonce_abcdefghijklmnop",
                runtimeInstanceID: "runtime.test.instance",
                selectedVersion: version,
                enabledCapabilities: ["runtime.snapshot"]
            )
        )
    }

    func testConfigurationRejectsReleaseNonLoopbackAndWeakTokens() throws {
        XCTAssertThrowsError(try LoopbackRuntimeEndpoint(host: "0.0.0.0", port: 9_999))
        let endpoint = try LoopbackRuntimeEndpoint(port: 9_999)
        XCTAssertThrowsError(
            try LoopbackRuntimeClientConfiguration(
                endpoint: endpoint,
                authorizationToken: token,
                buildConfiguration: .release
            )
        ) { error in
            XCTAssertEqual(error as? RuntimeConnectionError, .ineligibleBuild)
        }
        XCTAssertThrowsError(
            try LoopbackRuntimeClientConfiguration(
                endpoint: endpoint,
                authorizationToken: Data("too-short".utf8),
                buildConfiguration: .debug
            )
        )
        XCTAssertThrowsError(
            try LoopbackRuntimeClientConfiguration(
                endpoint: endpoint,
                authorizationToken: token,
                runtimeInstanceID: "runtime instance with spaces",
                buildConfiguration: .internal
            )
        )
    }

    func testCompileTimeBuildEligibilityCannotBeSpoofedByRuntimeInput() {
#if DEBUG
        XCTAssertTrue(RuntimeConnectionBuildEligibility.allows(.debug))
        XCTAssertTrue(RuntimeConnectionBuildEligibility.allows(.internal))
#elseif VISTREA_INTERNAL_RUNTIME
        XCTAssertFalse(RuntimeConnectionBuildEligibility.allows(.debug))
        XCTAssertTrue(RuntimeConnectionBuildEligibility.allows(.internal))
#else
        XCTAssertFalse(RuntimeConnectionBuildEligibility.allows(.debug))
        XCTAssertFalse(RuntimeConnectionBuildEligibility.allows(.internal))
#endif
        XCTAssertFalse(RuntimeConnectionBuildEligibility.allows(.release))
    }

    func testBoundedJSONLinesAcceptsSplitCRLFAndRejectsMalformedInput() throws {
        var decoder = BoundedJSONLineDecoder(maximumLineBytes: 64)
        XCTAssertTrue(try decoder.append(Data("{\"type\":\"pi".utf8)).isEmpty)
        let lines = try decoder.append(Data("ng\"}\r\n{\"type\":\"pong\"}\n".utf8))
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(String(decoding: lines[0], as: UTF8.self), "{\"type\":\"ping\"}")
        XCTAssertNoThrow(try decoder.validateCompleteStream())

        var oversized = BoundedJSONLineDecoder(maximumLineBytes: 8)
        XCTAssertThrowsError(try oversized.append(Data("{\"type\":\"oversized\"}".utf8))) {
            XCTAssertEqual($0 as? BoundedJSONLineError, .lineTooLarge)
        }

        var malformed = BoundedJSONLineDecoder(maximumLineBytes: 64)
        XCTAssertThrowsError(try malformed.append(Data([0xc3, 0x28, 0x0a]))) {
            XCTAssertEqual($0 as? BoundedJSONLineError, .malformedUTF8)
        }

        var empty = BoundedJSONLineDecoder(maximumLineBytes: 64)
        XCTAssertThrowsError(try empty.append(Data([0x0a]))) {
            XCTAssertEqual($0 as? BoundedJSONLineError, .invalidEnvelope)
        }
    }

    func testBoundedJSONLinesRejectsDecodedDuplicateKeysInEveryObjectScope() throws {
        let duplicates = [
            "{\"type\":\"ping\",\"type\":\"pong\"}\n",
            "{\"type\":\"ping\",\"\\u0074ype\":\"pong\"}\n",
            "{\"outer\":{\"value\":1,\"value\":2}}\n",
            "{\"😀\":1,\"\\ud83d\\ude00\":2}\n",
        ]
        for source in duplicates {
            var decoder = BoundedJSONLineDecoder(maximumLineBytes: 1_024)
            XCTAssertThrowsError(try decoder.append(Data(source.utf8)), source) {
                XCTAssertEqual($0 as? BoundedJSONLineError, .duplicateKey)
            }
        }

        var distinctScalars = BoundedJSONLineDecoder(maximumLineBytes: 1_024)
        XCTAssertNoThrow(
            try distinctScalars.append(Data("{\"é\":1,\"e\\u0301\":2}\n".utf8))
        )
        var ordinaryValues = BoundedJSONLineDecoder(maximumLineBytes: 1_024)
        XCTAssertNoThrow(
            try ordinaryValues.append(
                Data("{\"values\":[true,false,null,-1.25e+2]}\n".utf8)
            )
        )
    }

    func testNegotiatedLineLimitRevalidatesAlreadyBufferedReadyMessages() throws {
        let oversizedReadyMessage = "{\"type\":\"ping\",\"padding\":\""
            + String(repeating: "x", count: 1_100)
            + "\"}\n"
        var decoder = BoundedJSONLineDecoder(maximumLineBytes: 4 * 1_024 * 1_024)
        try decoder.enqueue(Data("{\"type\":\"host_welcome\"}\n".utf8))
        try decoder.enqueue(Data(oversizedReadyMessage.utf8))
        XCTAssertNotNil(try decoder.nextLine())
        XCTAssertThrowsError(try decoder.updateMaximumLineBytes(1_024)) {
            XCTAssertEqual($0 as? BoundedJSONLineError, .lineTooLarge)
        }
    }

    func testRuntimeObjectPayloadDefensivelyCopiesProviderBytes() throws {
        let original = Data("Vistrea".utf8)
        let reference = try ObjectReference(
            hash: "sha256:b0cd09405ae15f1cfb3f4b291002921832c81e26ed7f308c56b5c1eb5a791de5",
            mediaType: "text/plain",
            byteSize: JSONSafeUInt(validating: UInt64(original.count)),
            compression: .none
        )
        var providerBuffer = original
        let payload = RuntimeObjectPayload(reference: reference, bytes: providerBuffer)
        providerBuffer[providerBuffer.startIndex] = 0
        var consumerBuffer = payload.bytes
        consumerBuffer[consumerBuffer.startIndex] = 1

        XCTAssertEqual(payload.bytes, original)
    }

    func testPublicErrorsNeverIncludeAuthorizationMaterial() {
        let secret = String(decoding: token, as: UTF8.self)
        let errors: [RuntimeConnectionError] = [
            .invalidConfiguration,
            .ineligibleBuild,
            .unavailable,
            .authenticationFailed,
            .negotiationFailed,
            .protocolViolation,
            .resourceExhausted,
            .timeout,
            .cancelled,
            .remoteError(code: "remote_error"),
        ]
        XCTAssertTrue(errors.allSatisfy { !$0.description.contains(secret) })
    }
}

extension RuntimeConnectionTests {
    func testEventRecorderAssignsMonotonicSequencesAndBoundedRetention() async throws {
        let recorder = try RuntimeEventRecorder(maximumRetainedEvents: 3)
        let initial = await recorder.epoch
        XCTAssertTrue(initial.eventEpochID.hasPrefix("epoch_"))
        XCTAssertEqual(initial.oldestRetainedSequence, 1)
        XCTAssertEqual(initial.nextSequence, 1)

        for index in 1...5 {
            let event = try await recorder.record(
                RuntimeEventDraft(
                    kind: index % 2 == 0 ? .transientDismissed : .transientPresented,
                    stableID: try StableID(validating: "demo.toast.success")
                )
            )
            XCTAssertEqual(event.sequence.rawValue, UInt64(index))
            XCTAssertEqual(event.eventEpochID.rawValue, initial.eventEpochID)
        }
        let afterOverflow = await recorder.epoch
        XCTAssertEqual(afterOverflow.oldestRetainedSequence, 3)
        XCTAssertEqual(afterOverflow.nextSequence, 6)

        // A batch spanning released sequences reports them as dropped evidence.
        let overflowBatch = try await recorder.batchAfter(
            cursor: 0,
            kinds: Set(RuntimeEventKind.allCases),
            limit: 16
        )
        let batch = try XCTUnwrap(overflowBatch)
        XCTAssertEqual(batch.firstSequence.rawValue, 1)
        XCTAssertEqual(batch.lastSequence.rawValue, 5)
        XCTAssertEqual(batch.droppedEventCount.rawValue, 2)
        XCTAssertEqual(batch.events.map(\.sequence.rawValue), [3, 4, 5])
    }

    func testEventRecorderFiltersKindsAcknowledgesAndDrains() async throws {
        let recorder = try RuntimeEventRecorder()
        try await recorder.record(RuntimeEventDraft(kind: .transientPresented))
        try await recorder.record(RuntimeEventDraft(kind: .layoutChanged))
        try await recorder.record(RuntimeEventDraft(kind: .transientDismissed))

        let filteredBatch = try await recorder.batchAfter(
            cursor: 0,
            kinds: [.transientPresented, .transientDismissed],
            limit: 16
        )
        let filtered = try XCTUnwrap(filteredBatch)
        XCTAssertEqual(filtered.firstSequence.rawValue, 1)
        XCTAssertEqual(filtered.lastSequence.rawValue, 3)
        XCTAssertEqual(filtered.droppedEventCount.rawValue, 0)
        XCTAssertEqual(filtered.events.map(\.kind), [.transientPresented, .transientDismissed])

        let drained = try await recorder.batchAfter(
            cursor: filtered.lastSequence.rawValue,
            kinds: [.transientPresented],
            limit: 16
        )
        XCTAssertNil(drained)

        await recorder.releaseThrough(sequence: 3)
        let released = await recorder.epoch
        XCTAssertEqual(released.oldestRetainedSequence, 4)
        XCTAssertEqual(released.nextSequence, 4)
    }

    func testEventBatchEncodingMatchesCanonicalWireShape() throws {
        let epoch = try EventEpochID(validating: "epoch_019f0000-0000-7000-8000-000000000001")
        let event = try RuntimeEvent(
            eventID: EventID(validating: "event_019f0000-0000-7000-8000-000000000001"),
            protocolVersion: ProtocolVersion(minor: 0),
            eventEpochID: epoch,
            sequence: JSONSafeUInt(validating: 1),
            time: EventTime(wallTime: Timestamp(validating: "2026-07-12T00:00:01.100Z")),
            kind: .transientPresented,
            stableID: StableID(validating: "demo.toast.success"),
            durationMilliseconds: 2_000,
            payload: ["text": .string("Saved successfully")]
        )
        let batch = try RuntimeEventBatch(
            protocolVersion: ProtocolVersion(minor: 0),
            eventEpochID: epoch,
            firstSequence: JSONSafeUInt(validating: 1),
            lastSequence: JSONSafeUInt(validating: 1),
            events: [event],
            droppedEventCount: JSONSafeUInt(validating: 0)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoder.encode(batch)) as? [String: Any]
        )
        XCTAssertEqual(encoded["event_epoch_id"] as? String, epoch.rawValue)
        XCTAssertEqual(encoded["first_sequence"] as? Int, 1)
        XCTAssertEqual(encoded["dropped_event_count"] as? Int, 0)
        let events = try XCTUnwrap(encoded["events"] as? [[String: Any]])
        XCTAssertEqual(events[0]["kind"] as? String, "transient_presented")
        XCTAssertEqual(events[0]["duration_ms"] as? Double, 2_000)
        XCTAssertEqual((events[0]["payload"] as? [String: Any])?["text"] as? String, "Saved successfully")

        XCTAssertThrowsError(
            try RuntimeEventBatch(
                protocolVersion: ProtocolVersion(minor: 0),
                eventEpochID: epoch,
                firstSequence: JSONSafeUInt(validating: 2),
                lastSequence: JSONSafeUInt(validating: 2),
                events: [event],
                droppedEventCount: JSONSafeUInt(validating: 0)
            )
        )
    }
}
