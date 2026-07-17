#if DEBUG
import UIKit
import VistreaRuntimeConnection
import VistreaRuntimeModels
import VistreaRuntimeUIKit
import VistreaRuntimeUIKitConnection

@MainActor
final class DebugRuntimeConnectionController {
    /// The Debug-only event recorder shared with observing view controllers.
    private(set) static var sharedEventRecorder: RuntimeEventRecorder?

    private let client: LoopbackRuntimeClient
    private var runTask: Task<Void, Never>?

    init?(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        windowProvider: @escaping UIKitRuntimeSnapshotCaptureProvider.WindowProvider,
        scenarioIDProvider: @escaping UIKitRuntimeSnapshotCaptureProvider.ScenarioIDProvider
    ) {
        guard let host = environment["VISTREA_RUNTIME_HOST"],
              let portValue = environment["VISTREA_RUNTIME_PORT"],
              let port = UInt16(portValue),
              let token = environment["VISTREA_RUNTIME_TOKEN"],
              !token.isEmpty
        else {
            return nil
        }
        do {
            let adapter = UIKitRuntimeCaptureAdapter(
                configuration: UIKitRuntimeCaptureConfiguration(
                    projectID: try ProjectID(
                        validating: "project_019f0000-0000-7000-8000-000000000001"
                    ),
                    buildID: try BuildID(
                        validating: "build_019f0000-0000-7000-8000-000000000001"
                    ),
                    deviceID: try DeviceID(
                        validating: "device_019f0000-0000-7000-8000-000000000001"
                    ),
                    environmentID: "demo",
                    accountProfileID: "demo-user",
                    featureContextRefs: [
                        environment["VISTREA_SCENARIO_PROFILE"] ?? "baseline",
                    ],
                    sdkVersion: "0.1.0",
                    adapterVersion: "0.1.0"
                )
            )
            let captureProvider = UIKitRuntimeSnapshotCaptureProvider(
                adapter: adapter,
                windowProvider: windowProvider,
                scenarioIDProvider: scenarioIDProvider
            )
            let configuration: LoopbackRuntimeClientConfiguration
            if let certificateSHA256 = environment["VISTREA_RUNTIME_TLS_CERT_SHA256"] {
                configuration = try LoopbackRuntimeClientConfiguration(
                    endpoint: TlsRuntimeEndpoint(
                        host: host,
                        port: port,
                        pinnedCertificateSHA256Hex: certificateSHA256
                    ),
                    authorizationToken: Data(token.utf8),
                    buildConfiguration: .debug
                )
            } else {
                configuration = try LoopbackRuntimeClientConfiguration(
                    endpoint: LoopbackRuntimeEndpoint(host: host, port: port),
                    authorizationToken: Data(token.utf8),
                    buildConfiguration: .debug
                )
            }
            let eventRecorder = try RuntimeEventRecorder()
            Self.sharedEventRecorder = eventRecorder
            client = LoopbackRuntimeClient(
                configuration: configuration,
                captureProvider: captureProvider,
                eventRecorder: eventRecorder,
                tuningController: UIKitRuntimeTuningController(windowProvider: windowProvider)
            )
        } catch {
            return nil
        }
    }

    func start() {
        guard runTask == nil else {
            return
        }
        let client = client
        runTask = Task {
            do {
                try await client.runUntilClosed()
            } catch {
                // Runtime transport failures remain local and never reveal credentials.
            }
        }
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        let client = client
        Task {
            await client.close()
        }
    }
}
#endif
