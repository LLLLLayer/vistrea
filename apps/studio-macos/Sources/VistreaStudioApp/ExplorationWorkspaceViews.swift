import SwiftUI
import VistreaStudioCore

/// The small Explore form: a bounded action budget, the settle time, and
/// the stable IDs the walk must never tap.
struct ExplorationFormView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Binding var isPresented: Bool
    @State private var maximumActions = 20
    @State private var settleMilliseconds = 1_500
    @State private var excludedStableIDs =
        "android.debug.inspector.open,vistrea.inspector.capture,BackButton"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Explore the running application")
                .font(.headline)
            Stepper(
                "Maximum actions: \(maximumActions)",
                value: $maximumActions,
                in: 1...500
            )
            Stepper(
                "Settle milliseconds: \(settleMilliseconds)",
                value: $settleMilliseconds,
                in: 0...60_000,
                step: 250
            )
            Text("Excluded stable IDs (comma-separated)")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Excluded stable IDs", text: $excludedStableIDs)
                .textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Start exploration") {
                    let excluded = excludedStableIDs
                        .split(separator: ",")
                        .map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }
                    isPresented = false
                    Task {
                        await model.startExploration(
                            maximumActions: maximumActions,
                            settleMilliseconds: settleMilliseconds,
                            excludedStableIDs: excluded
                        )
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isExploring)
            }
        }
        .padding(14)
        .frame(width: StudioLayoutMetrics.explorationFormWidth)
    }
}

/// The live exploration status line: progress while the Operation runs, the
/// report summary once it succeeded, and the verbatim error otherwise.
struct ExplorationStatusView: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        if model.isExploring
            || model.isExplorationRunAddressable
            || model.explorationReport != nil
            || model.explorationError != nil
        {
            VStack(alignment: .leading, spacing: 4) {
                // Cancel stays reachable for every Operation the Host has not
                // settled yet — including a run this Studio stopped polling —
                // so a started exploration can never become unstoppable.
                if model.isExploring || model.isExplorationRunAddressable {
                    HStack(spacing: 8) {
                        if model.isExploring {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(progressLine)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer()
                        Button("Cancel") {
                            Task { await model.cancelExploration() }
                        }
                        .disabled(model.isCancellingExploration)
                    }
                }
                if let report = model.explorationReport {
                    Text(
                        "Exploration succeeded: \(report.discoveredStateIDs.count) states discovered · \(report.actionCount) actions · stopped by \(report.stoppedReason)"
                    )
                    .font(.caption)
                    .foregroundStyle(.green)
                    .textSelection(.enabled)
                }
                if let error = model.explorationError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .accessibilityLabel("Exploration status")
            Divider()
        }
    }

    private var progressLine: String {
        var parts: [String] = []
        if let state = model.explorationState {
            parts.append(state)
        }
        if let progress = model.explorationProgress {
            if let phase = progress.phase {
                parts.append(phase)
            }
            if let completed = progress.completedUnits, let total = progress.totalUnits {
                parts.append("\(completed)/\(total) \(progress.unit ?? "units")")
            }
        }
        if let message = model.explorationLastEventMessage {
            parts.append(message)
        }
        return parts.isEmpty ? "Starting exploration…" : parts.joined(separator: " · ")
    }
}
