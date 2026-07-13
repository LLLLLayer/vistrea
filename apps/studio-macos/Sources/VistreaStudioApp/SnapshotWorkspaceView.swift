import AppKit
import SceneKit
import SwiftUI
import VistreaStudioCore

struct SnapshotWorkspaceView: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            ConnectionBar(model: model)
            Divider()
            if let operationError = model.operationError {
                OperationErrorBanner(message: operationError) {
                    model.dismissOperationError()
                }
                Divider()
            }
            content
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            guard model.contentPhase == .idle else { return }
            await model.refresh()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.contentPhase {
        case .idle, .loading:
            ProgressView("Loading Runtime Snapshots…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            EmptyWorkspaceView(isCapturing: model.isCapturing) {
                Task { await model.capture() }
            }
        case let .failure(message):
            FailureView(message: message, isBusy: model.isRefreshing || model.isCapturing) {
                Task { await model.refresh() }
            }
        case .content:
            HSplitView {
                VSplitView {
                    SnapshotListPane(model: model)
                        .frame(minHeight: 200)
                    EventTimelinePane(model: model)
                        .frame(minHeight: 140)
                }
                .frame(minWidth: 220, idealWidth: 250, maxWidth: 320)
                VSplitView {
                    TabView {
                        ScreenshotPane(model: model)
                            .tabItem { Label("Screenshot", systemImage: "photo") }
                        CanvasPane(model: model)
                            .tabItem { Label("Canvas", systemImage: "point.3.connected.trianglepath.dotted") }
                        DesignReviewPane(model: model)
                            .tabItem { Label("Design Review", systemImage: "square.on.square.dashed") }
                        LayerInspector3DPane(model: model)
                            .tabItem { Label("3D Layers", systemImage: "square.3.layers.3d") }
                        WikiPane(model: model)
                            .tabItem { Label("Wiki", systemImage: "book") }
                    }
                    .frame(minHeight: 280)
                    ViewTreePane(model: model)
                        .frame(minHeight: 220)
                }
                VSplitView {
                    NodeDetailsPane(model: model)
                        .frame(minHeight: 260)
                    ReviewIssuesPane(model: model)
                        .frame(minHeight: 140)
                }
                .frame(minWidth: 250, idealWidth: 300, maxWidth: 380)
            }
        }
    }
}

private struct CanvasPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var isExploreFormPresented = false
    @State private var isMergeSheetPresented = false

    private static let columnWidth: CGFloat = 230
    private static let rowHeight: CGFloat = 116
    private static let cardSize = CGSize(width: 200, height: 92)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Screen State Canvas", systemImage: "point.3.connected.trianglepath.dotted") {
                if model.mergeSelectionStateIDs.count >= 2 {
                    Button("Merge…", systemImage: "arrow.triangle.merge") {
                        isMergeSheetPresented = true
                    }
                    .disabled(model.isMergingStates)
                }
                Button("Explore", systemImage: "figure.walk") {
                    isExploreFormPresented = true
                }
                .disabled(model.isExploring)
                .popover(isPresented: $isExploreFormPresented, arrowEdge: .bottom) {
                    ExplorationFormView(model: model, isPresented: $isExploreFormPresented)
                }
            }
            Divider()
            ExplorationStatusView(model: model)
            CurationStatusView(model: model)
            content
        }
        .sheet(isPresented: $isMergeSheetPresented) {
            MergeStatesSheet(model: model)
        }
        .onDisappear {
            // The Host-side run continues; only the poll loop stops with
            // the pane.
            model.stopExplorationPolling()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.canvasPhase {
        case .idle, .loading:
            ProgressView("Loading the Screen Graph…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No Screen States have been observed yet. Record state observations to build the Canvas.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            HStack(spacing: 0) {
                ScrollView([.horizontal, .vertical]) {
                    canvasContent
                        .padding(24)
                }
                if model.selectedCanvasStateID != nil {
                    Divider()
                    CanvasStateDetailPanel(model: model)
                        .frame(width: 280)
                }
            }
        }
    }

    private var canvasContent: some View {
        let positions = model.canvasStates
        let graph = model.canvasGraph
        let entryIDs = Set(graph?.entryStateIDs ?? [])
        let selectedID = model.selectedCanvasStateID
        let linkedSelected = !model.relatedWikiNodes.isEmpty
        let centers = Dictionary(uniqueKeysWithValues: positions.map { positioned in
            (
                positioned.id,
                CGPoint(
                    x: CGFloat(positioned.column) * Self.columnWidth + Self.cardSize.width / 2,
                    y: CGFloat(positioned.row) * Self.rowHeight + Self.cardSize.height / 2
                )
            )
        })
        let width = (positions.map(\.column).max() ?? 0) + 1
        let height = (positions.map(\.row).max() ?? 0) + 1
        return ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                for transition in graph?.transitions ?? [] {
                    guard let source = centers[transition.sourceStateID],
                          let target = centers[transition.targetStateID]
                    else {
                        continue
                    }
                    var path = Path()
                    path.move(to: source)
                    path.addLine(to: target)
                    context.stroke(path, with: .color(.secondary.opacity(0.6)), lineWidth: 1.5)
                }
            }
            ForEach(positions) { positioned in
                let isActive = positioned.state.isActive
                let isMergeSelected = model.mergeSelectionStateIDs.contains(positioned.id)
                VStack(alignment: .leading, spacing: 4) {
                    Text(positioned.state.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Text(positioned.state.kind)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        if !isActive {
                            Text(positioned.state.status)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if entryIDs.contains(positioned.id) {
                            Text("entry")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.blue)
                        }
                        if isMergeSelected {
                            Label("merge", systemImage: "checkmark.circle.fill")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.orange)
                        }
                        if positioned.id == selectedID, linkedSelected {
                            Label("linked", systemImage: "book")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.purple)
                        }
                    }
                }
                .padding(10)
                .frame(width: Self.cardSize.width, height: Self.cardSize.height, alignment: .topLeading)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(nsColor: .controlBackgroundColor))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(
                            isMergeSelected
                                ? Color.orange
                                : positioned.id == selectedID
                                    ? Color.accentColor
                                    : entryIDs.contains(positioned.id)
                                        ? Color.blue
                                        : Color.secondary.opacity(0.4),
                            lineWidth: isMergeSelected || positioned.id == selectedID
                                || entryIDs.contains(positioned.id) ? 2 : 1
                        )
                )
                .opacity(isActive ? 1 : 0.4)
                .offset(
                    x: CGFloat(positioned.column) * Self.columnWidth,
                    y: CGFloat(positioned.row) * Self.rowHeight
                )
                .highPriorityGesture(
                    TapGesture().modifiers(.command).onEnded {
                        // Cmd-click toggles the merge selection; only active
                        // states are selectable.
                        model.toggleMergeSelection(stateID: positioned.id)
                    }
                )
                .onTapGesture {
                    Task { await model.selectCanvasState(id: positioned.id) }
                }
                .help(
                    isActive
                        ? "Click for details; Cmd-click to select for merging."
                        : "This state was \(positioned.state.status) by identity curation."
                )
                .accessibilityLabel(
                    "Screen state \(positioned.state.title), \(positioned.state.status)"
                )
            }
        }
        .frame(
            width: CGFloat(width) * Self.columnWidth,
            height: CGFloat(height) * Self.rowHeight,
            alignment: .topLeading
        )
    }
}

/// The small Explore form: a bounded action budget, the settle time, and
/// the stable IDs the walk must never tap.
private struct ExplorationFormView: View {
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
        .frame(width: 360)
    }
}

/// The live exploration status line: progress while the Operation runs, the
/// report summary once it succeeded, and the verbatim error otherwise.
private struct ExplorationStatusView: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        if model.isExploring || model.explorationReport != nil || model.explorationError != nil {
            VStack(alignment: .leading, spacing: 4) {
                if model.isExploring {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
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

/// The Canvas identity-curation status line: the changed-elsewhere conflict
/// note after a rejected merge or split, and the verbatim write error.
private struct CurationStatusView: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        if model.graphConflictNote != nil || model.curationError != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let note = model.graphConflictNote {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
                if let error = model.curationError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
                HStack {
                    Spacer()
                    Button("Dismiss") {
                        model.dismissCurationError()
                    }
                    .font(.caption)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .accessibilityLabel("Identity curation status")
            Divider()
        }
    }
}

/// The Merge sheet: the survivor picker over the Cmd-click selection,
/// defaulting to the first selected state, plus an optional justification.
private struct MergeStatesSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var survivorID = ""
    @State private var justification = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Merge Screen States")
                .font(.headline)
            Text("The selected states are one product screen. Observations move to the surviving state; the others become merged tombstones.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Survivor", selection: $survivorID) {
                ForEach(model.mergeSelectionStateIDs, id: \.self) { stateID in
                    Text(title(for: stateID)).tag(stateID)
                }
            }
            TextField("Justification (optional)", text: $justification)
                .textFieldStyle(.roundedBorder)
            if let note = model.graphConflictNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let error = model.curationError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Merge") {
                    Task {
                        let merged = await model.mergeSelectedStates(
                            into: survivorID.isEmpty ? nil : survivorID,
                            justification: justification.isEmpty ? nil : justification
                        )
                        if merged {
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isMergingStates || model.mergeSelectionStateIDs.count < 2)
            }
        }
        .padding(16)
        .frame(minWidth: 440)
        .onAppear {
            survivorID = model.mergeSelectionStateIDs.first ?? ""
        }
    }

    private func title(for stateID: String) -> String {
        model.canvasGraph?.states.first(where: { $0.id == stateID })?.title ?? stateID
    }
}

/// The Split sheet: the state's observation checkboxes. At least one
/// observation must move and at least one must stay behind.
private struct SplitStateSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var selectedObservationIDs: Set<String> = []
    @State private var title = ""
    @State private var justification = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Split Screen State")
                .font(.headline)
            Text("Move wrongly deduplicated observations into a new state. At least one observation must stay behind.")
                .font(.caption)
                .foregroundStyle(.secondary)
            let observationIDs = model.selectedCanvasStateObservationIDs
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(observationIDs, id: \.self) { observationID in
                        Toggle(isOn: binding(for: observationID)) {
                            Text(observationID)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .toggleStyle(.checkbox)
                    }
                }
            }
            .frame(maxHeight: 160)
            TextField("New state title (optional)", text: $title)
                .textFieldStyle(.roundedBorder)
            TextField("Justification (optional)", text: $justification)
                .textFieldStyle(.roundedBorder)
            if let note = model.graphConflictNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let error = model.curationError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Split") {
                    let moved = observationIDs.filter(selectedObservationIDs.contains)
                    Task {
                        let split = await model.splitSelectedState(
                            observationIDs: moved,
                            title: title.isEmpty ? nil : title,
                            justification: justification.isEmpty ? nil : justification
                        )
                        if split {
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isSplittingState
                        || selectedObservationIDs.isEmpty
                        || selectedObservationIDs.count >= observationIDs.count
                )
            }
        }
        .padding(16)
        .frame(minWidth: 440)
    }

    private func binding(for observationID: String) -> Binding<Bool> {
        Binding(
            get: { selectedObservationIDs.contains(observationID) },
            set: { isSelected in
                if isSelected {
                    selectedObservationIDs.insert(observationID)
                } else {
                    selectedObservationIDs.remove(observationID)
                }
            }
        )
    }
}

/// The selected Screen State's persisted details plus its Deep Wiki links.
private struct CanvasStateDetailPanel: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var linkFilter = ""
    @State private var isSplitSheetPresented = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Screen State")
                        .font(.headline)
                    Spacer()
                    Button("Close", systemImage: "xmark.circle") {
                        Task { await model.selectCanvasState(id: nil) }
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                }
                switch model.canvasStatePhase {
                case .idle:
                    EmptyView()
                case .loading:
                    ProgressView("Loading the Screen State…")
                        .controlSize(.small)
                case let .failure(message):
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                case .content:
                    if let detail = model.canvasStateDetail {
                        stateFields(for: detail)
                        Divider()
                        observationSection(for: detail)
                        linkedNodes
                        Divider()
                        linkControls
                    }
                }
            }
            .padding(12)
        }
        .sheet(isPresented: $isSplitSheetPresented) {
            SplitStateSheet(model: model)
        }
    }

    /// The state's recorded observations, with the Split entry once at
    /// least two observations make a strict-subset split possible.
    @ViewBuilder
    private func observationSection(for detail: ScreenStateDetail) -> some View {
        let observationIDs = model.selectedCanvasStateObservationIDs
        Text("Observations (\(observationIDs.count))")
            .font(.caption.weight(.semibold))
        if observationIDs.count >= 2, detail.status == "active" {
            Button("Split…", systemImage: "arrow.triangle.branch") {
                isSplitSheetPresented = true
            }
            .font(.caption)
            .disabled(model.isSplittingState)
        } else {
            Text("A state with a single observation cannot be split.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        Divider()
    }

    private func stateFields(for detail: ScreenStateDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Title", value: detail.title)
            LabeledContent("Kind", value: detail.kind)
            LabeledContent("Status", value: detail.status)
            LabeledContent("First seen", value: detail.firstSeen)
            LabeledContent("Last seen", value: detail.lastSeen)
            LabeledContent("Snapshot") {
                Text(detail.canonicalSnapshotID)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
        .font(.caption)
    }

    @ViewBuilder
    private var linkedNodes: some View {
        Text("Linked wiki nodes")
            .font(.caption.weight(.semibold))
        if model.relatedWikiNodes.isEmpty {
            Text("No wiki node links this state yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            ForEach(model.relatedWikiNodes) { node in
                Label("\(node.title) · \(node.kind)", systemImage: "book")
                    .font(.caption)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var linkControls: some View {
        Text("Link to wiki node")
            .font(.caption.weight(.semibold))
        TextField("Filter wiki nodes…", text: $linkFilter)
            .textFieldStyle(.roundedBorder)
        let candidates = model.wikiNodes.filter { node in
            linkFilter.isEmpty || node.title.lowercased().contains(linkFilter.lowercased())
        }
        if candidates.isEmpty {
            Text("No wiki node matches. Create one in the Wiki tab first.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            ForEach(candidates.prefix(6)) { node in
                HStack {
                    Text(node.title)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Button("Link") {
                        Task { await model.linkSelectedCanvasState(toWikiNode: node.id) }
                    }
                    .font(.caption)
                    .disabled(model.isLinkingWikiNode)
                }
            }
        }
        if let error = model.canvasLinkError {
            Text(error)
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        }
    }
}

/// The design comparison workbench: pick a persisted design reference, run a
/// comparison against the selected Snapshot, and inspect the differences
/// over the screenshot with the design asset overlaid.
private struct DesignReviewPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var includePixel = false
    @State private var overlayOpacity = 0.5
    @State private var isReviewMode = false

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Design Review", systemImage: "square.on.square.dashed") {
                Toggle("Include pixel comparison", isOn: $includePixel)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .disabled(model.isComparingDesign)
                Button("Compare", systemImage: "sparkles.rectangle.stack") {
                    Task { await model.runDesignComparison(includePixel: includePixel) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isComparingDesign
                        || model.selectedDesignReferenceID == nil
                        || model.selectedSnapshotID == nil
                )
            }
            Divider()
            HSplitView {
                DesignReferenceColumn(model: model)
                    .frame(minWidth: 210, idealWidth: 240, maxWidth: 320)
                overlayColumn
                DesignDifferenceColumn(model: model, isReviewMode: $isReviewMode)
                    .frame(minWidth: 230, idealWidth: 270, maxWidth: 360)
            }
        }
        .task {
            guard model.designReferencesPhase == .idle else { return }
            await model.loadDesignReferences()
        }
    }

    private var overlayColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            ComparisonCaptionsView(model: model)
            ComparisonOverlayView(model: model, overlayOpacity: overlayOpacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack(spacing: 8) {
                Text("Design overlay")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Slider(value: $overlayOpacity, in: 0...1) {
                    Text("Design overlay opacity")
                }
                .controlSize(.small)
                Text(overlayOpacity.formatted(.number.precision(.fractionLength(2))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }
}

/// The persisted design references plus the past comparisons for the
/// selected reference and Snapshot.
private struct DesignReferenceColumn: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            referenceList
            Divider()
            comparisonHistory
                .frame(height: 150)
        }
    }

    @ViewBuilder
    private var referenceList: some View {
        switch model.designReferencesPhase {
        case .idle, .loading:
            ProgressView("Loading design references…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No design references have been added yet. Add one through the Host design routes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            List(model.designReferences, selection: referenceSelection) { reference in
                VStack(alignment: .leading, spacing: 3) {
                    Text(reference.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Text(reference.kind)
                        .font(.caption)
                        .foregroundStyle(.blue)
                    Text(
                        "\(reference.canvasSize.width.formatted()) × \(reference.canvasSize.height.formatted()) pt · \(reference.pixelSize.width) × \(reference.pixelSize.height) px"
                    )
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 2)
                .tag(reference.id)
                .accessibilityLabel("Design reference \(reference.name)")
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private var comparisonHistory: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Past comparisons")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            switch model.designComparisonsPhase {
            case .idle:
                Text("Select a design reference to list its comparisons.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .padding(.horizontal, 10)
            case .empty:
                Text("No comparison has been run for this reference and Snapshot yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
            case let .failure(message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 10)
            case .content:
                List(model.designComparisons, selection: comparisonSelection) { comparison in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(comparison.completedAt)
                            .font(.caption)
                        Text("\(comparison.quality) · \(comparison.differences.count) difference\(comparison.differences.count == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .tag(comparison.id)
                    .accessibilityLabel(
                        "Comparison at \(comparison.completedAt), \(comparison.quality)"
                    )
                }
                .listStyle(.sidebar)
            }
            Spacer(minLength: 0)
        }
    }

    private var referenceSelection: Binding<String?> {
        Binding(
            get: { model.selectedDesignReferenceID },
            set: { id in
                guard id != model.selectedDesignReferenceID else { return }
                Task { await model.selectDesignReference(id: id) }
            }
        )
    }

    private var comparisonSelection: Binding<String?> {
        Binding(
            get: { model.designComparison?.id },
            set: { id in
                guard let id else { return }
                model.selectDesignComparison(id: id)
            }
        )
    }
}

/// The honest captions above the overlay: partial quality, the canonical
/// `vistrea.pixel` verdict, asset-load degradation, and write errors.
private struct ComparisonCaptionsView: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        let captions = captionLines
        if model.isComparingDesign || !captions.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                if model.isComparingDesign {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Running the design comparison…")
                            .font(.caption)
                    }
                }
                ForEach(captions, id: \.text) { caption in
                    Text(caption.text)
                        .font(.caption)
                        .foregroundStyle(caption.isError ? Color.red : Color.orange)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .accessibilityLabel("Design comparison status")
            Divider()
        }
    }

    private struct Caption: Hashable {
        let text: String
        let isError: Bool
    }

    private var captionLines: [Caption] {
        var lines: [Caption] = []
        if let error = model.designComparisonError {
            lines.append(Caption(text: error, isError: true))
        }
        if let comparison = model.designComparison {
            if comparison.quality == "partial" {
                lines.append(
                    Caption(
                        text: "This comparison is partial: not every design region could be measured on the target Snapshot.",
                        isError: false
                    )
                )
            }
            if let pixel = comparison.pixel {
                if pixel.status == "compared" {
                    lines.append(Caption(text: "Pixel comparison included.", isError: false))
                } else {
                    let reason = pixel.reason.map { ": \($0)" } ?? "."
                    lines.append(
                        Caption(text: "Pixel comparison \(pixel.status)\(reason)", isError: false)
                    )
                }
            }
            if let snapshotID = model.selectedSnapshotID, comparison.targetSnapshotID != snapshotID {
                lines.append(
                    Caption(
                        text: "This comparison targets Snapshot \(comparison.targetSnapshotID), not the selected one; the overlay is hidden.",
                        isError: false
                    )
                )
            }
        }
        if case let .unavailable(message) = model.designAssetPhase {
            lines.append(
                Caption(text: "The design asset could not be loaded: \(message)", isError: false)
            )
        }
        return lines
    }
}

/// The screenshot with the design asset overlaid at adjustable opacity and
/// the difference regions drawn over the affected areas.
private struct ComparisonOverlayView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let overlayOpacity: Double

    var body: some View {
        if model.selectedSnapshot == nil {
            honestPlaceholder("Select a Runtime Snapshot to compare against a design reference.")
        } else if model.selectedSnapshot?.screenshot == nil {
            honestPlaceholder(
                "The selected Snapshot carries no screenshot Object. Differences are listed on the right without a visual overlay."
            )
        } else if let data = model.screenshotData, let image = NSImage(data: data) {
            GeometryReader { proxy in
                let fitted = Self.fittedRect(image: image.size, container: proxy.size)
                ZStack(alignment: .topLeading) {
                    Image(nsImage: image)
                        .resizable()
                        .frame(width: fitted.width, height: fitted.height)
                        .offset(x: fitted.minX, y: fitted.minY)
                        .accessibilityLabel("Captured application screenshot")
                    if let assetData = model.designAssetData, let design = NSImage(data: assetData) {
                        // The design asset scales to the screenshot size so
                        // both images share one coordinate space.
                        Image(nsImage: design)
                            .resizable()
                            .frame(width: fitted.width, height: fitted.height)
                            .offset(x: fitted.minX, y: fitted.minY)
                            .opacity(overlayOpacity)
                            .allowsHitTesting(false)
                            .accessibilityLabel("Design reference overlay")
                    }
                    ForEach(model.differenceRegions) { region in
                        regionOverlay(for: region, in: fitted)
                    }
                }
            }
            .padding(8)
        } else {
            honestPlaceholder(screenshotStateText)
        }
    }

    @ViewBuilder
    private func regionOverlay(for region: DifferenceRegion, in fitted: CGRect) -> some View {
        let isSelected = region.id == model.selectedDifferenceID
        let color = Self.severityColor(region.severity)
        Rectangle()
            .fill(isSelected ? color.opacity(0.18) : Color.clear)
            .overlay(
                Rectangle()
                    .strokeBorder(color, lineWidth: isSelected ? 3 : 1.5)
            )
            .frame(
                width: max(fitted.width * region.unitRect.width, 4),
                height: max(fitted.height * region.unitRect.height, 4)
            )
            .offset(
                x: fitted.minX + fitted.width * region.unitRect.x,
                y: fitted.minY + fitted.height * region.unitRect.y
            )
            .onTapGesture {
                model.selectDifference(id: region.id)
            }
            .accessibilityLabel("Difference region \(region.category), \(region.severity)")
        if isSelected, let expected = region.expectedUnitRect {
            Rectangle()
                .strokeBorder(color, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
                .frame(
                    width: max(fitted.width * expected.width, 4),
                    height: max(fitted.height * expected.height, 4)
                )
                .offset(
                    x: fitted.minX + fitted.width * expected.x,
                    y: fitted.minY + fitted.height * expected.y
                )
                .allowsHitTesting(false)
                .accessibilityLabel("Expected design position")
        }
    }

    private var screenshotStateText: String {
        switch model.screenshotPhase {
        case .loading:
            return "Loading the screenshot Object…"
        case let .unavailable(message):
            return "The screenshot Object could not be loaded: \(message)"
        case .available:
            return "The screenshot Object bytes are not a supported image."
        case .none:
            return "The screenshot Object has not been loaded."
        }
    }

    private func honestPlaceholder(_ message: String) -> some View {
        Text(message)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Aspect-fits the image into the container, centered.
    static func fittedRect(image: CGSize, container: CGSize) -> CGRect {
        guard image.width > 0, image.height > 0, container.width > 0, container.height > 0 else {
            return .zero
        }
        let scale = min(container.width / image.width, container.height / image.height)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGRect(
            x: (container.width - size.width) / 2,
            y: (container.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }

    static func severityColor(_ severity: String) -> Color {
        switch severity {
        case "critical": .red
        case "major": .orange
        case "minor": .yellow
        default: .blue
        }
    }
}

/// The difference list: category, severity, delta, and the expected-versus-
/// actual summary. Selection highlights the region; review mode steps
/// through the differences one at a time.
private struct DesignDifferenceColumn: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Binding var isReviewMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Differences")
                    .font(.caption.weight(.semibold))
                Spacer()
                Toggle("Review mode", isOn: $isReviewMode)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .onChange(of: isReviewMode) {
                        if isReviewMode, model.selectedDifferenceID == nil {
                            model.advanceDifferenceSelection(by: 1)
                        }
                    }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            if isReviewMode {
                HStack(spacing: 8) {
                    Button("Previous", systemImage: "chevron.left") {
                        model.advanceDifferenceSelection(by: -1)
                    }
                    Button("Next", systemImage: "chevron.right") {
                        model.advanceDifferenceSelection(by: 1)
                    }
                    Spacer()
                    if let position = reviewPosition {
                        Text(position)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                .controlSize(.small)
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
                .disabled(model.designComparison?.differences.isEmpty != false)
            }
            Divider()
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        if let comparison = model.designComparison {
            if comparison.differences.isEmpty {
                Text("No differences were found.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(comparison.differences, selection: differenceSelection) { difference in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(difference.category)
                                .font(.subheadline.weight(.semibold))
                            Text(difference.severity)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(
                                    ComparisonOverlayView.severityColor(difference.severity)
                                )
                            if let delta = difference.delta {
                                Text("Δ \(delta.formatted(.number.precision(.fractionLength(0...3))))")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text("expected \(difference.expected.summaryText)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Text("actual \(difference.actual.summaryText)")
                            .font(.caption)
                            .lineLimit(2)
                        if let stableID = difference.runtimeTarget?.stableID {
                            Text(stableID)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.vertical, 2)
                    .tag(difference.id)
                    .accessibilityLabel(
                        "Difference \(difference.category), \(difference.severity)"
                    )
                }
                .listStyle(.sidebar)
            }
        } else {
            Text("Run a comparison to list the differences between the design reference and the captured Snapshot.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var reviewPosition: String? {
        guard let comparison = model.designComparison,
              let selected = model.selectedDifferenceID,
              let index = comparison.differences.firstIndex(where: { $0.id == selected })
        else {
            return nil
        }
        return "\(index + 1)/\(comparison.differences.count)"
    }

    private var differenceSelection: Binding<String?> {
        Binding(
            get: { model.selectedDifferenceID },
            set: { model.selectDifference(id: $0) }
        )
    }
}

private struct LayerInspector3DPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var sceneCache = LayerSceneCache()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "3D Layer Inspector", systemImage: "square.3.layers.3d")
            Divider()
            if model.layerBoxes.isEmpty {
                Text("Select a Runtime Snapshot to explode its layers in 3D.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                SceneView(
                    scene: sceneCache.scene(for: model.layerBoxes),
                    options: [.allowsCameraControl, .autoenablesDefaultLighting]
                )
                .accessibilityLabel("3D layer inspector with \(model.layerBoxes.count) layers")
            }
        }
    }
}

/// Memoizes the built scene by its layer boxes so unrelated published changes
/// do not rebuild it and reset the user's orbiting camera. The cache is only
/// touched from main-actor `body` evaluations.
private final class LayerSceneCache {
    private var boxes: [LayerBox3D] = []
    private var cached: SCNScene?

    @MainActor
    func scene(for boxes: [LayerBox3D]) -> SCNScene {
        if let cached, boxes == self.boxes {
            return cached
        }
        let built = LayerSceneBuilder.scene(for: boxes)
        self.boxes = boxes
        cached = built
        return built
    }
}

enum LayerSceneBuilder {
    private static let scale: CGFloat = 0.01
    private static let layerSpacing: CGFloat = 0.16

    static func scene(for boxes: [LayerBox3D]) -> SCNScene {
        let scene = SCNScene()
        scene.background.contents = NSColor.windowBackgroundColor
        let bounds = boxes.reduce(CGRect.zero) { partial, box in
            partial.union(CGRect(x: box.x, y: box.y, width: box.width, height: box.height))
        }
        for box in boxes {
            let plane = SCNBox(
                width: CGFloat(box.width) * scale,
                height: CGFloat(box.height) * scale,
                length: 0.01,
                chamferRadius: 0
            )
            let material = SCNMaterial()
            material.diffuse.contents = box.isInteractive
                ? NSColor.systemOrange.withAlphaComponent(0.55)
                : NSColor.systemBlue.withAlphaComponent(0.35)
            material.isDoubleSided = true
            plane.materials = [material]
            let node = SCNNode(geometry: plane)
            node.name = box.nodeID
            node.position = SCNVector3(
                (CGFloat(box.x + box.width / 2) - bounds.midX) * scale,
                (bounds.midY - CGFloat(box.y + box.height / 2)) * scale,
                CGFloat(box.depth) * layerSpacing
            )
            scene.rootNode.addChildNode(node)
        }
        let camera = SCNCamera()
        camera.zFar = 100
        let cameraNode = SCNNode()
        cameraNode.camera = camera
        let extent = max(bounds.width, bounds.height) * scale
        cameraNode.position = SCNVector3(extent * 0.7, extent * 0.35, extent * 1.4)
        cameraNode.look(at: SCNVector3(0, 0, 0))
        scene.rootNode.addChildNode(cameraNode)
        return scene
    }
}

private struct WikiPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var searchText = ""
    @State private var isCreating = false
    @State private var editingNode: WikiNodeSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Deep Wiki", systemImage: "book") {
                Button("New node", systemImage: "plus") {
                    isCreating = true
                }
                .disabled(model.isSavingWikiNode)
            }
            Divider()
            HStack(spacing: 8) {
                TextField("Search knowledge…", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        Task { await model.loadWiki(text: searchText.isEmpty ? nil : searchText) }
                    }
                Button("Search") {
                    Task { await model.loadWiki(text: searchText.isEmpty ? nil : searchText) }
                }
            }
            .padding(8)
            Divider()
            content
        }
        .sheet(isPresented: $isCreating) {
            WikiNodeCreateSheet(model: model)
        }
        .sheet(item: $editingNode) { node in
            WikiNodeEditSheet(model: model, nodeID: node.id)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.wikiPhase {
        case .idle, .loading:
            ProgressView("Loading the Deep Wiki…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No knowledge matches. Create the first Wiki node with the New node button.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            List(model.wikiNodes) { node in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(node.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            Text(node.kind)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.blue)
                            Text(node.status)
                                .font(.caption)
                                .foregroundStyle(node.status == "published" ? Color.green : Color.secondary)
                            ForEach(node.labels.prefix(3), id: \.self) { label in
                                Text(label)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        if let summary = node.summary {
                            Text(summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    Button("Edit") {
                        editingNode = node
                    }
                    .font(.caption)
                }
                .padding(.vertical, 2)
                .accessibilityLabel("Wiki node \(node.title), \(node.status)")
            }
            .listStyle(.sidebar)
        }
    }
}

/// The New node sheet: kind, title, summary, and Markdown content.
private struct WikiNodeCreateSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "note"
    @State private var title = ""
    @State private var summary = ""
    @State private var markdown = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("New Wiki node")
                .font(.headline)
            Picker("Kind", selection: $kind) {
                ForEach(WikiVocabulary.nodeKinds, id: \.self) { kind in
                    Text(kind).tag(kind)
                }
            }
            TextField("Title", text: $title)
                .textFieldStyle(.roundedBorder)
            TextField("Summary (optional)", text: $summary)
                .textFieldStyle(.roundedBorder)
            Text("Markdown")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $markdown)
                .font(.body.monospaced())
                .frame(minHeight: 160)
                .border(Color.secondary.opacity(0.4))
            if let error = model.wikiWriteError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Create") {
                    Task {
                        let created = await model.createWikiNode(
                            kind: kind,
                            title: title,
                            summary: summary.isEmpty ? nil : summary,
                            markdown: markdown
                        )
                        if created {
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isSavingWikiNode || title.isEmpty || markdown.isEmpty)
            }
        }
        .padding(16)
        .frame(minWidth: 460)
    }
}

/// The Edit sheet: loads the full node, revises it guarded by its revision,
/// and offers only legal status transitions.
private struct WikiNodeEditSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let nodeID: String
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var summary = ""
    @State private var markdown = ""
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Edit Wiki node")
                .font(.headline)
            switch model.wikiEditPhase {
            case .idle, .loading:
                ProgressView("Loading the Wiki node…")
                    .frame(maxWidth: .infinity, minHeight: 160)
            case let .failure(message):
                Text(message)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 160)
            case .content:
                if let node = model.wikiEditingNode {
                    editor(for: node)
                }
            }
            HStack {
                Spacer()
                Button("Close") {
                    model.endWikiEdit()
                    dismiss()
                }
                if let node = model.wikiEditingNode {
                    Button("Save") {
                        Task {
                            let saved = await model.saveWikiEdit(
                                title: title == node.title ? nil : title,
                                summary: summary.isEmpty ? nil : summary,
                                markdown: markdown == (node.markdown ?? "") ? nil : markdown,
                                toStatus: status == node.status ? nil : status
                            )
                            if saved {
                                model.endWikiEdit()
                                dismiss()
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isSavingWikiNode || title.isEmpty)
                }
            }
        }
        .padding(16)
        .frame(minWidth: 460)
        .task {
            await model.beginWikiEdit(nodeID: nodeID)
        }
        .onChange(of: model.wikiEditingNode) {
            syncFields()
        }
    }

    private func editor(for node: WikiNodeDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(node.kind) · revision \(node.revision)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let note = model.wikiConflictNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            TextField("Title", text: $title)
                .textFieldStyle(.roundedBorder)
            TextField("Summary (optional)", text: $summary)
                .textFieldStyle(.roundedBorder)
            Text("Markdown")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $markdown)
                .font(.body.monospaced())
                .frame(minHeight: 160)
                .border(Color.secondary.opacity(0.4))
            Picker("Status", selection: $status) {
                Text(node.status).tag(node.status)
                ForEach(WikiVocabulary.legalStatusTargets(from: node.status), id: \.self) { target in
                    Text(target).tag(target)
                }
            }
            if let error = model.wikiWriteError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    private func syncFields() {
        guard let node = model.wikiEditingNode else { return }
        title = node.title
        summary = node.summary ?? ""
        markdown = node.markdown ?? ""
        status = node.status
    }
}

private struct ReviewIssuesPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Review Issues", systemImage: "checkmark.seal")
            Divider()
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.issuesPhase {
        case .idle, .loading:
            ProgressView("Loading Review Issues…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No Review Issues have been recorded yet.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            List(model.reviewIssues, selection: issueSelection) { issue in
                VStack(alignment: .leading, spacing: 3) {
                    Text(issue.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Text(issue.state)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(issue.state == "resolved" ? Color.green : Color.orange)
                        Text(issue.severity)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(issue.category)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Text(issue.updatedAt)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                .padding(.vertical, 2)
                .tag(issue.id)
                .accessibilityLabel("Review issue \(issue.title), state \(issue.state)")
            }
            .listStyle(.sidebar)
            Divider()
            ReviewIssueDetailPanel(model: model)
        }
    }

    private var issueSelection: Binding<String?> {
        Binding(
            get: { model.selectedIssueID },
            set: { id in
                guard id != model.selectedIssueID else { return }
                Task { await model.selectReviewIssue(id: id) }
            }
        )
    }
}

/// The selected issue's lifecycle detail with only legal transitions offered.
private struct ReviewIssueDetailPanel: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var reason = ""

    var body: some View {
        Group {
            switch model.issueDetailPhase {
            case .idle:
                Text("Select an issue to manage its lifecycle.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(8)
            case .loading:
                ProgressView("Loading issue…")
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .padding(8)
            case let .failure(message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(8)
            case .content:
                if let issue = model.selectedIssue {
                    detail(for: issue)
                }
            }
        }
    }

    private func detail(for issue: ReviewIssueSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(issue.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            Text("State \(issue.state) · revision \(issue.revision)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let note = model.issueConflictNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            TextField("Transition reason (optional)", text: $reason)
                .textFieldStyle(.roundedBorder)
                .disabled(model.isTransitioningIssue)
            HStack(spacing: 6) {
                ForEach(model.legalIssueTransitions, id: \.self) { target in
                    Button(target) {
                        let transitionReason = reason.isEmpty ? nil : reason
                        Task {
                            await model.transitionSelectedIssue(to: target, reason: transitionReason)
                        }
                    }
                    .font(.caption)
                    .disabled(model.isTransitioningIssue)
                }
            }
            if let error = model.issueTransitionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Issue lifecycle for \(issue.title), state \(issue.state)")
    }
}

private struct EventTimelinePane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Events", systemImage: "clock.arrow.circlepath")
            Divider()
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.eventsPhase {
        case .idle, .loading:
            ProgressView("Loading Runtime events…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No Runtime events have been persisted yet.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            List(model.events) { event in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(event.kind)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("#\(event.sequence)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    if let stableID = event.stableID {
                        Text(stableID)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let summary = event.summary {
                        Text(summary)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    Text(event.wallTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                .padding(.vertical, 2)
                .accessibilityLabel("Runtime event \(event.kind) sequence \(event.sequence)")
            }
            .listStyle(.sidebar)
        }
    }
}

private struct ConnectionBar: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        HStack(spacing: 14) {
            Label("Vistrea Studio", systemImage: "rectangle.3.group")
                .font(.headline)
            Divider()
                .frame(height: 18)
            connectionLabel
            runtimeLabel
            Text("\(model.snapshots.count) Snapshot\(model.snapshots.count == 1 ? "" : "s")")
                .foregroundStyle(.secondary)
            Spacer()
            Button("Refresh", systemImage: "arrow.clockwise") {
                Task { await model.refresh() }
            }
            .disabled(model.isRefreshing || model.isCapturing)
            Button("Capture", systemImage: "camera") {
                Task { await model.capture() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isRefreshing || model.isCapturing)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    @ViewBuilder
    private var connectionLabel: some View {
        switch model.connectionPhase {
        case .idle:
            Label("Host not checked", systemImage: "circle.dashed")
                .foregroundStyle(.secondary)
        case .checking:
            Label("Checking Host", systemImage: "ellipsis.circle")
                .foregroundStyle(.secondary)
        case let .available(status):
            Label(
                status.status == .ready ? "Host ready" : "Host degraded",
                systemImage: status.status == .ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
            )
            .foregroundStyle(status.status == .ready ? Color.green : Color.orange)
            .help(status.message ?? "Host status")
        case let .unavailable(message):
            Label("Host unavailable", systemImage: "xmark.circle.fill")
                .foregroundStyle(.red)
                .help(message)
        }
    }

    @ViewBuilder
    private var runtimeLabel: some View {
        switch model.connectionPhase {
        case let .available(status):
            Label(
                status.runtimeConnected ? "Runtime connected" : "Runtime disconnected",
                systemImage: status.runtimeConnected ? "iphone.and.arrow.forward" : "iphone.slash"
            )
            .foregroundStyle(status.runtimeConnected ? Color.primary : Color.secondary)
        default:
            Label("Runtime unknown", systemImage: "iphone.slash")
                .foregroundStyle(.secondary)
        }
    }
}

private struct SnapshotListPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Snapshots", systemImage: "camera.on.rectangle")
            Divider()
            List(model.snapshots, selection: selection) { snapshot in
                VStack(alignment: .leading, spacing: 4) {
                    Text(snapshot.applicationID)
                        .font(.headline)
                        .lineLimit(1)
                    Text("\(snapshot.device) · \(snapshot.platform.uppercased())")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(snapshot.capturedAt)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                .padding(.vertical, 3)
                .tag(snapshot.id)
                .accessibilityLabel("Snapshot from \(snapshot.applicationID) at \(snapshot.capturedAt)")
            }
            .listStyle(.sidebar)
            .disabled(model.isRefreshing || model.isCapturing)
        }
    }

    private var selection: Binding<String?> {
        Binding(
            get: { model.selectedSnapshotID },
            set: { id in
                guard let id, id != model.selectedSnapshotID else { return }
                Task { await model.selectSnapshot(id: id) }
            }
        )
    }
}

private struct ScreenshotPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Screenshot Evidence", systemImage: "photo") {
                if let screenshot = model.selectedSnapshot?.screenshot {
                    Text("\(screenshot.pixelWidth) × \(screenshot.pixelHeight)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Divider()
            Group {
                switch model.detailPhase {
                case .idle:
                    ContentUnavailableView("Select a Snapshot", systemImage: "camera.on.rectangle")
                case .loading:
                    ProgressView("Loading Snapshot…")
                case let .failure(message):
                    ContentUnavailableView(
                        "Snapshot unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                case .content:
                    screenshotContent
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var screenshotContent: some View {
        if let data = model.screenshotData, let image = NSImage(data: data) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .padding()
                .accessibilityLabel("Captured application screenshot")
        } else if let screenshot = model.selectedSnapshot?.screenshot {
            VStack(spacing: 12) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(screenshot.logicalName ?? "Screenshot Object")
                    .font(.headline)
                Text(screenshot.hash)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                screenshotStateDescription
            }
            .padding()
        } else {
            ContentUnavailableView(
                "No screenshot",
                systemImage: "photo",
                description: Text("This Runtime Snapshot contains structured UI evidence without a screenshot Object.")
            )
        }
    }

    @ViewBuilder
    private var screenshotStateDescription: some View {
        switch model.screenshotPhase {
        case .loading:
            ProgressView("Loading Object…")
                .controlSize(.small)
        case let .unavailable(message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(3)
        case .available:
            Text("The Object bytes are not a supported image.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .none:
            EmptyView()
        }
    }
}

private struct ViewTreePane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "View Tree", systemImage: "list.bullet.indent") {
                if let tree = model.selectedSnapshot?.tree {
                    Text(tree.kind.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Divider()
            treeContent
        }
    }

    @ViewBuilder
    private var treeContent: some View {
        if let tree = model.selectedSnapshot?.tree {
            if let object = tree.objectPayload {
                ContentUnavailableView(
                    "Tree stored as an Object",
                    systemImage: "doc.zipper",
                    description: Text("\(object.nodeCount) nodes · \(object.encoding)\n\(object.hash)")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if tree.roots.isEmpty {
                ContentUnavailableView("Empty View Tree", systemImage: "list.bullet.indent")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: nodeSelection) {
                    OutlineGroup(tree.roots, children: \.outlineChildren) { item in
                        TreeNodeRow(node: item.presentation)
                            .tag(item.id)
                    }
                }
                .listStyle(.plain)
            }
        } else {
            ProgressView("Loading View Tree…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var nodeSelection: Binding<String?> {
        Binding(
            get: { model.selectedNodeID },
            set: { model.selectNode(id: $0) }
        )
    }
}

private struct TreeNodeRow: View {
    let node: NodePresentation

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbolName)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(node.outlineTitle)
                    .lineLimit(1)
                Text("\(node.nativeType) · \(node.role)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityLabel("\(node.outlineTitle), \(node.role), \(node.nativeType)")
    }

    private var symbolName: String {
        switch node.role {
        case "button": "button.programmable"
        case "text": "textformat"
        case "image": "photo"
        case "text-field", "text-area": "character.cursor.ibeam"
        default: "square.on.square"
        }
    }
}

private struct NodeDetailsPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Selection", systemImage: "scope")
            Divider()
            if let snapshot = model.selectedSnapshot, let node = model.selectedNode {
                List {
                    Section("Runtime Context") {
                        LabeledContent("Snapshot", value: snapshot.id)
                        if let scenarioID = snapshot.scenarioID {
                            LabeledContent("Scenario", value: scenarioID)
                        }
                        LabeledContent("Application", value: snapshot.applicationID)
                        LabeledContent("Version", value: snapshot.applicationVersion)
                        LabeledContent("Platform", value: snapshot.platform.uppercased())
                        LabeledContent("Device", value: snapshot.device)
                        LabeledContent("Environment", value: snapshot.environment)
                        LabeledContent("Build", value: snapshot.buildID)
                        if let sourceGitSHA = snapshot.sourceGitSHA {
                            LabeledContent("Source Git SHA", value: sourceGitSHA)
                        }
                    }
                    Section("UI Node") {
                        ForEach(node.fields) { field in
                            LabeledContent(field.label) {
                                Text(field.value)
                                    .multilineTextAlignment(.trailing)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    if node.stableID != nil {
                        Section("Tuning Preview (Debug)") {
                            TuningPreviewControls(model: model, node: node)
                        }
                        Section("Active Previews") {
                            ActiveTuningList(model: model)
                        }
                    }
                }
                .listStyle(.inset)
            } else {
                ContentUnavailableView(
                    "No node selected",
                    systemImage: "scope",
                    description: Text("Select a node in the View Tree to inspect its canonical properties.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// The Debug-only alpha preview controls for one selected node.
private struct TuningPreviewControls: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let node: NodePresentation
    @State private var alphaValue: Double = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent(
                "Source alpha",
                value: (node.alpha ?? 1).formatted(.number.precision(.fractionLength(0...2)))
            )
            Slider(value: $alphaValue, in: 0...1) {
                Text("Alpha")
            }
            HStack {
                Text(alphaValue.formatted(.number.precision(.fractionLength(2))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Preview alpha") {
                    Task { await model.previewAlpha(alphaValue) }
                }
                .disabled(model.isApplyingTuning)
            }
            if model.isApplyingTuning {
                ProgressView("Applying preview…")
                    .controlSize(.small)
            }
            if let error = model.tuningError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if let outcome = model.lastTuningApplication {
                TuningOutcomeView(application: outcome)
            }
        }
        .onAppear { alphaValue = node.alpha ?? 1 }
        .onChange(of: node.id) {
            alphaValue = node.alpha ?? 1
        }
    }
}

/// The applied-versus-rejected outcome of the most recent tuning application.
private struct TuningOutcomeView: View {
    let application: TuningApplicationSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Preview \(application.status) · \(application.appliedChanges.count) applied · \(application.rejectedChanges.count) rejected")
                .font(.caption.weight(.medium))
                .foregroundStyle(application.rejectedChanges.isEmpty ? Color.green : Color.orange)
            ForEach(application.rejectedChanges) { change in
                Text("\(change.reasonCode): \(change.message)")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .accessibilityLabel(
            "Tuning preview \(application.status), \(application.appliedChanges.count) applied, \(application.rejectedChanges.count) rejected"
        )
    }
}

/// The active tuning previews with one Revert button each.
private struct ActiveTuningList: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        switch model.tuningPhase {
        case .idle, .loading:
            ProgressView("Loading active previews…")
                .controlSize(.small)
        case .empty:
            Text("No active tuning previews.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case let .failure(message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        case .content:
            ForEach(model.activeTuning) { application in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(application.tuningApplicationID)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text("\(application.status) · \(application.appliedChanges.count) applied · \(application.rejectedChanges.count) rejected")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Revert") {
                        Task { await model.revertTuning(id: application.id) }
                    }
                    .disabled(model.revertingTuningIDs.contains(application.id))
                }
                .accessibilityLabel("Active tuning preview, status \(application.status)")
            }
        }
    }
}

private struct PaneHeader<Trailing: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let trailing: () -> Trailing

    init(
        title: String,
        systemImage: String,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.title = title
        self.systemImage = systemImage
        self.trailing = trailing
    }

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
                .font(.headline)
            Spacer()
            trailing()
        }
        .padding(.horizontal)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

private extension PaneHeader where Trailing == EmptyView {
    init(title: String, systemImage: String) {
        self.init(title: title, systemImage: systemImage) { EmptyView() }
    }
}

private struct OperationErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Spacer()
            Button("Dismiss", action: dismiss)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

private struct EmptyWorkspaceView: View {
    let isCapturing: Bool
    let capture: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "No Runtime Snapshots",
                systemImage: "camera.on.rectangle",
                description: Text("Connect an authorized Debug Runtime and capture the first Snapshot.")
            )
            Button("Capture Snapshot", systemImage: "camera", action: capture)
                .buttonStyle(.borderedProminent)
                .disabled(isCapturing)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FailureView: View {
    let message: String
    let isBusy: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "Snapshots unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
            Button("Retry", systemImage: "arrow.clockwise", action: retry)
                .disabled(isBusy)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
