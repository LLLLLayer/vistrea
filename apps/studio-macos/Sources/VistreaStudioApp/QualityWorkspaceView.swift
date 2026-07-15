import SwiftUI
import VistreaStudioCore

struct QualityWorkspaceView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var mode: QualityMode = .validation

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Quality", systemImage: "checkmark.shield")
                    .font(.headline)
                Spacer()
                Picker("Quality mode", selection: $mode) {
                    ForEach(QualityMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 280)
                .labelsHidden()
            }
            .padding(10)
            Divider()
            switch mode {
            case .validation:
                ValidationWorkspaceView(model: model)
            case .buildDiff:
                BuildDiffWorkspaceView(model: model)
            }
        }
    }

    private enum QualityMode: String, CaseIterable, Identifiable {
        case validation
        case buildDiff

        var id: String { rawValue }
        var label: String { self == .validation ? "Validation" : "Build Diff" }
    }
}

private struct ValidationWorkspaceView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var snapshotID = ""
    @State private var suppressingFinding: ValidationFindingSummary?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Picker("Snapshot", selection: $snapshotID) {
                    if model.scopedSnapshots.isEmpty {
                        Text("No Snapshot").tag("")
                    } else {
                        ForEach(model.scopedSnapshots) { snapshot in
                            Text("\(snapshot.device) · \(snapshot.capturedAt)")
                                .tag(snapshot.id)
                        }
                    }
                }
                .frame(maxWidth: 460)
                Button("Validate Snapshot") {
                    Task {
                        if !snapshotID.isEmpty { await model.selectSnapshot(id: snapshotID) }
                        await model.validateSelectedSnapshot()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(snapshotID.isEmpty || model.isValidating)
                Button("Validate Screen Graph") {
                    Task { await model.validateSelectedScreenGraph() }
                }
                .disabled(model.selectedScope == nil || model.isValidating)
                Spacer()
            }
            .padding(10)
            Divider()
            validationContent
        }
        .onAppear { synchronizeSnapshotSelection() }
        .onChange(of: model.selectedSnapshotID) { synchronizeSnapshotSelection() }
        .sheet(item: $suppressingFinding) { finding in
            FindingSuppressionSheet(model: model, finding: finding)
        }
    }

    @ViewBuilder
    private var validationContent: some View {
        switch model.validationPhase {
        case .idle:
            ContentUnavailableView(
                "Run Local Validation",
                systemImage: "checkmark.shield",
                description: Text(
                    "Validate one persisted Snapshot or the selected Screen Graph using ruleset.vistrea.core."
                )
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading:
            ProgressView("Running validation…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.green)
                Text("No findings")
                    .font(.title3.weight(.semibold))
                if let run = model.lastValidationRun {
                    Text("\(run.target.kind) · \(run.state) · revision \(run.revision)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            ContentUnavailableView(
                "Validation Failed",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            VStack(spacing: 0) {
                if let run = model.lastValidationRun {
                    ValidationSummaryStrip(run: run)
                    Divider()
                }
                List(model.validationFindings) { finding in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: severityIcon(finding.severity))
                            .foregroundStyle(severityColor(finding.severity))
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 7) {
                                Text(finding.ruleID)
                                    .font(.caption.monospaced().weight(.medium))
                                Text(finding.status)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(
                                        finding.status == "open" ? Color.orange : Color.secondary
                                    )
                            }
                            Text(finding.message)
                                .font(.subheadline)
                                .textSelection(.enabled)
                            Text("\(finding.category) · \(finding.subject.kind): \(finding.subject.id)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let expected = finding.expectedPresentation {
                                LabeledContent("Expected") {
                                    Text(expected)
                                        .font(.caption2.monospaced())
                                        .textSelection(.enabled)
                                }
                            }
                            if let actual = finding.actualPresentation {
                                LabeledContent("Actual") {
                                    Text(actual)
                                        .font(.caption2.monospaced())
                                        .textSelection(.enabled)
                                }
                            }
                        }
                        Spacer()
                        if finding.status == "open" {
                            Button("Suppress") { suppressingFinding = finding }
                                .disabled(model.suppressingFindingIDs.contains(finding.id))
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.inset)
                if let error = model.validationError {
                    Divider()
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func synchronizeSnapshotSelection() {
        if let selected = model.selectedSnapshotID,
           model.scopedSnapshots.contains(where: { $0.id == selected }) {
            snapshotID = selected
        } else {
            snapshotID = model.scopedSnapshots.first?.id ?? ""
        }
    }

    private func severityIcon(_ severity: String) -> String {
        switch severity {
        case "critical", "error": "xmark.octagon.fill"
        case "warning": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity {
        case "critical": .purple
        case "error": .red
        case "warning": .orange
        default: .blue
        }
    }
}

private struct ValidationSummaryStrip: View {
    let run: ValidationRunSummary

    var body: some View {
        HStack(spacing: 18) {
            metric("Total", run.findingCounts.total, .primary)
            metric("Open", run.findingCounts.open, .orange)
            metric("Suppressed", run.findingCounts.suppressed, .secondary)
            metric("Errors", run.findingCounts.bySeverity.error, .red)
            metric("Critical", run.findingCounts.bySeverity.critical, .purple)
            Spacer()
            Text("\(run.target.kind): \(run.target.id) · \(run.state)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(10)
    }

    private func metric(_ label: String, _ value: UInt64, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value.formatted())
                .font(.title3.weight(.semibold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct FindingSuppressionSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let finding: ValidationFindingSummary
    @Environment(\.dismiss) private var dismiss
    @State private var reasonCode = "known_issue"
    @State private var justification = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Suppress Finding")
                .font(.headline)
            Text(finding.ruleID)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text(finding.message)
                .textSelection(.enabled)
            Picker("Reason", selection: $reasonCode) {
                ForEach(Self.reasonCodes, id: \.self) { reason in
                    Text(reason.replacingOccurrences(of: "_", with: " ").capitalized)
                        .tag(reason)
                }
            }
            TextEditor(text: $justification)
                .font(.body)
                .frame(minHeight: 100)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(.separator))
            if let error = model.validationError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Suppress") {
                    Task {
                        if await model.suppressValidationFinding(
                            id: finding.id,
                            reasonCode: reasonCode,
                            justification: justification
                        ) {
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    justification.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.suppressingFindingIDs.contains(finding.id)
                )
            }
        }
        .padding(16)
        .frame(minWidth: 460)
    }

    private static let reasonCodes = [
        "false_positive",
        "accepted_risk",
        "known_issue",
        "environment_variance",
        "other",
    ]
}

private struct BuildDiffWorkspaceView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var leftBuildID = ""
    @State private var rightBuildID = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                buildPicker("From", selection: $leftBuildID)
                Image(systemName: "arrow.right")
                    .foregroundStyle(.secondary)
                buildPicker("To", selection: $rightBuildID)
                Button("Compare Builds") {
                    Task {
                        await model.compareBuilds(
                            leftBuildID: leftBuildID,
                            rightBuildID: rightBuildID
                        )
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    leftBuildID.isEmpty
                        || rightBuildID.isEmpty
                        || leftBuildID == rightBuildID
                        || model.isComparingBuilds
                )
                Spacer()
            }
            .padding(10)
            Divider()
            diffContent
        }
        .onAppear { synchronizeBuildSelection() }
        .onChange(of: model.selectedScope) { synchronizeBuildSelection() }
        .onChange(of: model.availableScopes) { synchronizeBuildSelection() }
    }

    private func buildPicker(_ title: String, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) {
            if model.qualityBuildScopes.isEmpty {
                Text("No observed build").tag("")
            } else {
                ForEach(model.qualityBuildScopes) { scope in
                    Text("\(scope.applicationVersion) · \(scope.buildID)")
                        .tag(scope.buildID)
                }
            }
        }
        .frame(maxWidth: 360)
    }

    @ViewBuilder
    private var diffContent: some View {
        if model.qualityBuildScopes.count < 2 {
            ContentUnavailableView(
                "Two Builds Required",
                systemImage: "square.split.2x1",
                description: Text(
                    "Capture or open two builds of the selected application to compare structural and coverage changes."
                )
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch model.buildDiffPhase {
            case .idle:
                ContentUnavailableView(
                    "Compare Builds",
                    systemImage: "arrow.left.arrow.right.square",
                    description: Text("Choose two observed builds from the same application.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loading:
                ProgressView("Comparing builds…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .empty:
                VStack(spacing: 10) {
                    Image(systemName: "equal.circle.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(.green)
                    Text("No build differences")
                        .font(.title3.weight(.semibold))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failure(message):
                ContentUnavailableView(
                    "Build Comparison Failed",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .content:
                if let diff = model.lastBuildDiff {
                    VStack(spacing: 0) {
                        BuildDiffSummaryStrip(diff: diff)
                        Divider()
                        List(diff.entries) { entry in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: diffIcon(entry.kind))
                                    .foregroundStyle(diffColor(entry.kind))
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 7) {
                                        Text(entry.kind.capitalized)
                                            .font(.caption.weight(.semibold))
                                        Text(entry.domains.joined(separator: " · "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(entry.summary)
                                        .font(.subheadline)
                                        .textSelection(.enabled)
                                    if let left = entry.leftSubject {
                                        Text("From · \(left.kind): \(left.id)")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    if let right = entry.rightSubject {
                                        Text("To · \(right.kind): \(right.id)")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .listStyle(.inset)
                    }
                }
            }
        }
    }

    private func synchronizeBuildSelection() {
        let scopes = model.qualityBuildScopes
        if !scopes.contains(where: { $0.buildID == leftBuildID }) {
            leftBuildID = scopes.dropFirst().first?.buildID ?? scopes.first?.buildID ?? ""
        }
        if !scopes.contains(where: { $0.buildID == rightBuildID }) || rightBuildID == leftBuildID {
            rightBuildID = scopes.first(where: { $0.buildID != leftBuildID })?.buildID ?? ""
        }
    }

    private func diffIcon(_ kind: String) -> String {
        switch kind {
        case "added": "plus.circle.fill"
        case "removed": "minus.circle.fill"
        case "regressed": "arrow.down.circle.fill"
        case "improved": "arrow.up.circle.fill"
        default: "pencil.circle.fill"
        }
    }

    private func diffColor(_ kind: String) -> Color {
        switch kind {
        case "added", "improved": .green
        case "removed", "regressed": .red
        default: .blue
        }
    }
}

private struct BuildDiffSummaryStrip: View {
    let diff: BuildDiffSummary

    var body: some View {
        HStack(spacing: 18) {
            metric("Total", diff.summary.total, .primary)
            metric("Added", diff.summary.added, .green)
            metric("Removed", diff.summary.removed, .red)
            metric("Changed", diff.summary.changed, .blue)
            metric("Regressed", diff.summary.regressed, .orange)
            metric("Improved", diff.summary.improved, .green)
            Spacer()
        }
        .padding(10)
    }

    private func metric(_ label: String, _ value: UInt64, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value.formatted())
                .font(.title3.weight(.semibold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
