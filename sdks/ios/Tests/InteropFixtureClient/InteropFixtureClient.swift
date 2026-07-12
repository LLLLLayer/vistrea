import Darwin
import Foundation
import VistreaRuntimeConnection
import VistreaRuntimeModels

private actor FixtureCaptureProvider: RuntimeSnapshotCaptureProvider {
    private let payload: RuntimeSnapshotCapturePayload

    init(payload: RuntimeSnapshotCapturePayload) {
        self.payload = payload
    }

    func capture(_ request: RuntimeCaptureRequest) async throws -> RuntimeSnapshotCapturePayload {
        let requestedFields = Set(request.includePaths)
        let supportedFields: Set<String> = request.screenshot == .reference
            ? ["trees", "screenshot"]
            : ["trees"]
        guard request.includePaths.count == supportedFields.count,
              requestedFields == supportedFields
        else {
            throw RuntimeConnectionError.protocolViolation
        }
        if request.reason == .validation {
            try await Task.sleep(nanoseconds: 30_000_000_000)
        }
        try Task.checkCancellation()
        if request.reason == .review, let object = payload.objects.first {
            return RuntimeSnapshotCapturePayload(
                snapshot: payload.snapshot,
                objects: [
                    RuntimeObjectPayload(
                        reference: object.reference,
                        bytes: Data("Corrupt".utf8)
                    ),
                ]
            )
        }
        return payload
    }
}

private actor InteropTuningController: RuntimeTuningApplying {
    private var alphaByStableID: [String: Double] = ["demo.home.root": 1.0]

    func currentAlpha(stableID: String) async -> Double? {
        alphaByStableID[stableID]
    }

    func setAlpha(stableID: String, value: Double) async {
        alphaByStableID[stableID] = value
    }
}

@main
private struct InteropFixtureClient {
    static func main() async {
        do {
            let arguments = try parseArguments()
            let environment = ProcessInfo.processInfo.environment
            guard let token = environment["VISTREA_RUNTIME_TOKEN"],
                  let fixturePath = environment["VISTREA_RUNTIME_FIXTURE"]
            else {
                throw RuntimeConnectionError.invalidConfiguration
            }
            let payload = try loadPayload(fixturePath: fixturePath)
            let endpoint = try LoopbackRuntimeEndpoint(
                host: arguments.host,
                port: arguments.port
            )
            let configuration = try LoopbackRuntimeClientConfiguration(
                endpoint: endpoint,
                authorizationToken: Data(token.utf8),
                runtimeInstanceID: "runtime.swift.interop",
                buildConfiguration: .debug
            )
            var recorder: RuntimeEventRecorder?
            var scriptTask: Task<Void, Never>?
            if environment["VISTREA_RUNTIME_EVENTS"] == "scripted" {
                let scripted = try RuntimeEventRecorder()
                try await scripted.record(RuntimeEventDraft(
                    kind: .transientPresented,
                    stableID: StableID(validating: "demo.toast.success"),
                    durationMilliseconds: 2_000,
                    payload: ["text": .string("Saved successfully")]
                ))
                try await scripted.record(RuntimeEventDraft(
                    kind: .transientDismissed,
                    stableID: StableID(validating: "demo.toast.success")
                ))
                recorder = scripted
                scriptTask = Task {
                    // Keep a slow deterministic stream flowing so the Host can
                    // observe live batches after its subscription starts.
                    for _ in 0..<20 {
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        guard !Task.isCancelled else {
                            return
                        }
                        try? await scripted.record(RuntimeEventDraft(kind: .layoutChanged))
                    }
                }
            }
            let tuningController: InteropTuningController? =
                environment["VISTREA_RUNTIME_TUNING"] == "scripted"
                    ? InteropTuningController()
                    : nil
            let client = LoopbackRuntimeClient(
                configuration: configuration,
                captureProvider: FixtureCaptureProvider(payload: payload),
                eventRecorder: recorder,
                tuningController: tuningController
            )
            defer {
                scriptTask?.cancel()
            }
            try await client.runUntilClosed()
        } catch {
            // RuntimeConnectionError descriptions never carry authorization
            // material; keep the diagnostic on one line for log scraping.
            let reason = String(describing: error)
                .replacingOccurrences(of: "\n", with: " ")
            FileHandle.standardError.write(Data("Runtime interop client failed: \(reason)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }

    private static func parseArguments() throws -> (host: String, port: UInt16) {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 4,
              arguments[0] == "--host",
              arguments[2] == "--port",
              let port = UInt16(arguments[3])
        else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        return (arguments[1], port)
    }

    private static func loadPayload(fixturePath: String) throws -> RuntimeSnapshotCapturePayload {
        let fixtureData = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        guard var object = try JSONSerialization.jsonObject(with: fixtureData) as? [String: Any],
              let capturedAt = object["captured_at"],
              let display = object["display"] as? [String: Any],
              let pixelSize = display["pixel_size"]
        else {
            throw RuntimeConnectionError.protocolViolation
        }

        let bytes = Data("Vistrea".utf8)
        let reference: [String: Any] = [
            "hash": "sha256:b0cd09405ae15f1cfb3f4b291002921832c81e26ed7f308c56b5c1eb5a791de5",
            "media_type": "image/png",
            "byte_size": bytes.count,
            "compression": "none",
            "logical_name": "swift-interop.png",
            "extensions": [:],
        ]
        object["screenshot"] = [
            "object": reference,
            "capture_started_at": capturedAt,
            "capture_finished_at": capturedAt,
            "tree_skew_ms": 0,
            "coverage": ["x": 0, "y": 0, "width": 390, "height": 844],
            "pixel_size": pixelSize,
            "system_chrome": "excluded",
            "extensions": [:],
        ]
        let snapshotData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let snapshot = try RuntimeSnapshotCodec.decode(snapshotData)
        let objectReference = try JSONDecoder().decode(
            ObjectReference.self,
            from: JSONSerialization.data(withJSONObject: reference, options: [.sortedKeys])
        )
        return RuntimeSnapshotCapturePayload(
            snapshot: snapshot,
            objects: [RuntimeObjectPayload(reference: objectReference, bytes: bytes)]
        )
    }
}
