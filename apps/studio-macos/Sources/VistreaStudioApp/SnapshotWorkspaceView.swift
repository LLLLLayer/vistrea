import AppKit
import SceneKit
import SwiftUI
import VistreaStudioCore
import VistreaStudioHostRuntime

/// The primary navigation sections. The Canvas is the landing surface for
/// the selected Application + Version scope; the flat Snapshot list is the
/// secondary Evidence library, not the primary sidebar.
enum WorkspaceSection: String, CaseIterable, Identifiable {
    case canvas = "Canvas"
    case evidence = "Evidence"
    case documents = "Documents"
    case wiki = "Wiki"
    case quality = "Quality"
    case hub = "Hub"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .canvas: "point.3.connected.trianglepath.dotted"
        case .evidence: "camera.on.rectangle"
        case .documents: "doc.text.magnifyingglass"
        case .wiki: "book"
        case .quality: "checkmark.shield"
        case .hub: "arrow.triangle.2.circlepath.circle"
        }
    }
}

struct SnapshotWorkspaceView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @ObservedObject var projectDocuments: StudioProjectDocuments
    let workspaceName: String?
    let onManageWorkspaces: (() -> Void)?
    @State private var section: WorkspaceSection = .canvas

    init(
        model: SnapshotWorkspaceModel,
        projectDocuments: StudioProjectDocuments,
        workspaceName: String? = nil,
        onManageWorkspaces: (() -> Void)? = nil
    ) {
        self.model = model
        self.projectDocuments = projectDocuments
        self.workspaceName = workspaceName
        self.onManageWorkspaces = onManageWorkspaces
    }

    var body: some View {
        VStack(spacing: 0) {
            ContextBar(
                model: model,
                workspaceName: workspaceName,
                onManageWorkspaces: onManageWorkspaces
            )
            Divider()
            if let operationError = model.operationError {
                OperationErrorBanner(message: operationError) {
                    model.dismissOperationError()
                }
                Divider()
            }
            content
            Divider()
            EventTimelineStrip(model: model)
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
            ProgressView("Loading the Workspace…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            HSplitView {
                NavigationColumn(section: $section)
                    .frame(
                        minWidth: StudioLayoutMetrics.navigationMinWidth,
                        idealWidth: StudioLayoutMetrics.navigationIdealWidth,
                        maxWidth: StudioLayoutMetrics.navigationMaxWidth
                    )
                if section == .documents {
                    ProjectDocumentsPane(documents: projectDocuments)
                } else if section == .quality {
                    QualityWorkspaceView(model: model)
                } else if section == .hub {
                    HubPane(model: model)
                } else {
                    EmptyWorkspaceView(isCapturing: model.isCapturing) {
                        Task { await model.capture() }
                    }
                }
            }
        case let .failure(message):
            FailureView(message: message, isBusy: model.isRefreshing || model.isCapturing) {
                Task { await model.refresh() }
            }
        case .content:
            HSplitView {
                NavigationColumn(section: $section)
                    .frame(
                        minWidth: StudioLayoutMetrics.navigationMinWidth,
                        idealWidth: StudioLayoutMetrics.navigationIdealWidth,
                        maxWidth: StudioLayoutMetrics.navigationMaxWidth
                    )
                switch section {
                case .canvas:
                    CanvasSection(model: model)
                case .evidence:
                    EvidenceSection(model: model)
                case .documents:
                    ProjectDocumentsPane(documents: projectDocuments)
                case .wiki:
                    WikiPane(model: model)
                case .quality:
                    QualityWorkspaceView(model: model)
                case .hub:
                    HubPane(model: model)
                }
            }
        }
    }
}

/// Cross-team collaboration remains an optional local-Host workflow. The
/// secret field is session-only; only the origin, project, and ref names use
/// UserDefaults so reopening Studio never writes a Hub credential to disk.
private struct HubPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @AppStorage("vistrea.hub.base-url") private var baseURL = ""
    @AppStorage("vistrea.hub.project-id") private var projectID = ""
    @AppStorage("vistrea.hub.ref-names") private var refNames = "teams/design/main"
    @State private var bearerToken = ""
    @State private var pushMessage = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if model.hubSyncStatus == nil {
                connectionForm
            } else {
                connectedContent
            }
        }
        .task(id: model.hubSyncStatus?.remote.projectID) {
            guard model.hubSyncStatus != nil else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    return
                }
                await model.loadMoreHubActivity()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Team Hub", systemImage: "person.2.fill")
                .font(.headline)
            if let identity = model.hubSyncStatus?.identity {
                Text(identity.principalID)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                roleBadge(identity.role)
            }
            Spacer()
            if model.hubSyncStatus != nil {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task {
                        await model.refreshHubStatus()
                        await model.loadMoreHubActivity()
                    }
                }
                .disabled(model.isHubTransferring)
                Button("Disconnect") {
                    model.disconnectHub()
                    bearerToken = ""
                }
                    .disabled(model.isHubTransferring)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var connectionForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Label("Connect this local Workspace to an optional Vistrea Hub.", systemImage: "network")
                    .font(.title3.weight(.semibold))
                Text("Studio sends the credential only to its authenticated loopback Host. The Host uses TLS for non-local Hub origins and never echoes the token.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Hub URL")
                        TextField("https://hub.example.com", text: $baseURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        Text("Project")
                        TextField("project_…", text: $projectID)
                            .textFieldStyle(.roundedBorder)
                            .font(.body.monospaced())
                    }
                    GridRow {
                        Text("Refs")
                        TextField("teams/design/main", text: $refNames)
                            .textFieldStyle(.roundedBorder)
                            .font(.body.monospaced())
                    }
                    GridRow {
                        Text("Token")
                        SecureField("Current Hub bearer token", text: $bearerToken)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                Text("Separate multiple refs with commas. The token is kept only for this Studio session.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = model.hubSyncError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
                HStack {
                    Spacer()
                    Button("Connect", systemImage: "link") {
                        Task {
                            await model.connectHub(
                                baseURL: baseURL,
                                projectID: projectID,
                                bearerToken: bearerToken,
                                refNames: parsedRefNames
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || projectID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || bearerToken.isEmpty
                            || parsedRefNames.isEmpty
                            || model.hubSyncPhase == .connecting
                    )
                }
            }
            .padding(28)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private var connectedContent: some View {
        HSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    remoteSection
                    projectsSection
                    refsSection
                    transferSection
                }
                .padding(20)
            }
            .frame(minWidth: 430, idealWidth: 560)
            activitySection
                .frame(minWidth: 330, idealWidth: 430)
        }
    }

    @ViewBuilder
    private var remoteSection: some View {
        if let status = model.hubSyncStatus {
            GroupBox("Connected remote") {
                VStack(alignment: .leading, spacing: 7) {
                    LabeledContent("Origin") {
                        Text(status.remote.baseURL).textSelection(.enabled)
                    }
                    LabeledContent("Project") {
                        Text(status.remote.projectID).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    LabeledContent("Credential") {
                        Text(status.identity.credentialScope.rawValue.capitalized)
                    }
                    if let organization = status.identity.organizationID,
                       let team = status.identity.teamID {
                        LabeledContent("Team") { Text("\(organization) / \(team)") }
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private var projectsSection: some View {
        if let projects = model.hubSyncStatus?.accessibleProjects, projects.count > 1 {
            GroupBox("Team projects") {
                VStack(spacing: 0) {
                    ForEach(projects) { project in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.projectID).font(.caption.monospaced())
                                if let team = project.teamID { Text(team).font(.caption2).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            roleBadge(project.role)
                            if project.projectID != model.hubSyncStatus?.remote.projectID {
                                Button("Select") {
                                    projectID = project.projectID
                                    Task {
                                        await model.connectHub(
                                            baseURL: baseURL,
                                            projectID: project.projectID,
                                            bearerToken: bearerToken,
                                            refNames: parsedRefNames
                                        )
                                    }
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .padding(.vertical, 7)
                        if project.id != projects.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private var refsSection: some View {
        GroupBox("Shared refs") {
            VStack(spacing: 0) {
                ForEach(model.hubSyncStatus?.refs ?? []) { ref in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: relationSymbol(ref.relation))
                            .foregroundStyle(relationColor(ref.relation))
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(ref.name).font(.body.monospaced())
                            Text(relationLabel(ref.relation))
                                .font(.caption)
                                .foregroundStyle(relationColor(ref.relation))
                            if ref.relation == .diverged {
                                Text("Local and Hub refs were preserved. Fetch or push will not force either side; merge and publish a new Commit explicitly.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    if ref.id != model.hubSyncStatus?.refs.last?.id { Divider() }
                }
            }
        }
    }

    private var transferSection: some View {
        GroupBox("Sync") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Button("Fetch", systemImage: "arrow.down.circle") {
                        Task { await model.fetchFromHub() }
                    }
                    .disabled(model.isHubTransferring || !canFetch)
                    Button("Push", systemImage: "arrow.up.circle") {
                        Task { await model.pushToHub(message: pushMessage) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isHubTransferring || !canPush)
                    if model.isHubTransferring { ProgressView().controlSize(.small) }
                }
                TextField("Optional push message", text: $pushMessage)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!canPush || model.isHubTransferring)
                if !canPush {
                    Text("Push requires a maintainer or admin capability; fetch remains available to viewers.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let transfer = model.lastHubTransfer {
                    Label(
                        "\(transfer.direction.rawValue.capitalized): \(transfer.importedCommitCount) commits, \(transfer.importedObjectCount) objects, \(transfer.advancedRefCount) refs advanced",
                        systemImage: transfer.conflicts.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(transfer.conflicts.isEmpty ? Color.green : Color.orange)
                    if !transfer.conflicts.isEmpty {
                        ForEach(transfer.conflicts) { conflict in
                            Text("Conflict: \(conflict.name)")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                }
                if let error = model.hubSyncError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var activitySection: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Activity", systemImage: "clock.arrow.circlepath")
                    .font(.headline)
                Spacer()
                if model.isHubActivityLoading { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Color(nsColor: .controlBackgroundColor))
            Divider()
            if model.hubSyncActivity.isEmpty {
                ContentUnavailableView(
                    "No collaboration activity",
                    systemImage: "person.2",
                    description: Text("New pack, ref, and permission changes will appear here automatically.")
                )
            } else {
                List(model.hubSyncActivity) { event in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Image(systemName: activitySymbol(event.kind))
                            Text(activityLabel(event.kind)).fontWeight(.medium)
                            Spacer()
                            Text("#\(event.sequence)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Text("\(event.actor.principalID) · \(event.actor.role.rawValue)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(event.resource)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(event.occurredAt)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.inset)
            }
            if let error = model.hubActivityError {
                Divider()
                Text(error).font(.caption).foregroundStyle(.red).padding(8)
            }
        }
    }

    private var parsedRefNames: [String] {
        refNames.split(separator: ",", omittingEmptySubsequences: false).map {
            String($0).trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
    }

    private var canFetch: Bool {
        model.hubSyncStatus?.identity.capabilities.contains("packs.export") == true
    }

    private var canPush: Bool {
        let capabilities = model.hubSyncStatus?.identity.capabilities ?? []
        return capabilities.contains("packs.import") && capabilities.contains("refs.update")
    }

    private func roleBadge(_ role: HubSyncRole) -> some View {
        Text(role.rawValue.capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Color.accentColor.opacity(0.14), in: Capsule())
    }

    private func relationLabel(_ relation: HubSyncRefRelation) -> String {
        switch relation {
        case .synced: "Synced"
        case .localOnly: "Local only"
        case .remoteOnly: "Hub only"
        case .localAhead: "Local ahead"
        case .remoteAhead: "Hub ahead"
        case .diverged: "Conflict — both refs preserved"
        case .unknown: "Different history — fetch to classify"
        }
    }

    private func relationSymbol(_ relation: HubSyncRefRelation) -> String {
        switch relation {
        case .synced: "checkmark.circle.fill"
        case .diverged: "exclamationmark.triangle.fill"
        case .unknown: "questionmark.circle"
        case .localOnly, .localAhead: "arrow.up.circle"
        case .remoteOnly, .remoteAhead: "arrow.down.circle"
        }
    }

    private func relationColor(_ relation: HubSyncRefRelation) -> Color {
        switch relation {
        case .synced: .green
        case .diverged: .red
        case .unknown: .orange
        case .localOnly, .remoteOnly, .localAhead, .remoteAhead: .accentColor
        }
    }

    private func activityLabel(_ kind: String) -> String {
        switch kind {
        case "RefUpdated": "Ref updated"
        case "HubPackImported": "Pack imported"
        case "HubPackExported": "Pack exported"
        case "PermissionChanged": "Permission changed"
        default: kind
        }
    }

    private func activitySymbol(_ kind: String) -> String {
        switch kind {
        case "RefUpdated": "arrow.triangle.branch"
        case "HubPackImported": "square.and.arrow.down"
        case "HubPackExported": "square.and.arrow.up"
        case "PermissionChanged": "person.badge.key.fill"
        default: "circle"
        }
    }
}

private struct NavigationColumn: View {
    @Binding var section: WorkspaceSection

    var body: some View {
        List(WorkspaceSection.allCases, selection: selectionBinding) { section in
            Label(section.rawValue, systemImage: section.systemImage)
                .tag(section)
                .accessibilityLabel("\(section.rawValue) section")
        }
        .listStyle(.sidebar)
    }

    private var selectionBinding: Binding<WorkspaceSection?> {
        Binding(
            get: { section },
            set: { newValue in
                if let newValue {
                    section = newValue
                }
            }
        )
    }
}

/// The landing surface for the selected scope: the Screen State Canvas, plus
/// the selected state's single-screen Inspector as the main right-hand
/// experience once a state is picked.
private struct CanvasSection: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        // The CanvasPane keeps one structural identity whether or not the
        // Inspector is open: its appear/disappear pair owns the Canvas
        // revision watch, and a branch switch would fire the old identity's
        // onDisappear against the new identity's freshly started watch.
        HSplitView {
            CanvasPane(model: model)
                .frame(
                    minWidth: StudioLayoutMetrics.canvasPaneMinWidth,
                    idealWidth: StudioLayoutMetrics.canvasPaneIdealWidth
                )
            if model.selectedCanvasStateID != nil {
                StateInspectorView(model: model)
                    .frame(minWidth: StudioLayoutMetrics.inspectorMinWidth)
            }
        }
    }
}

/// The single-screen Inspector for the selected Screen State. Every pane in
/// here — screenshot, 2D tree, node properties, 3D layers, and the design
/// workbench — is driven by the state's canonical observation Snapshot.
///
/// The Inspector is responsive: with enough width the evidence panes and the
/// state context column sit side by side; when the width it was actually
/// given drops below `StudioLayoutMetrics.inspectorSideBySideMinWidth`, the
/// context column collapses behind a header toggle and the Inspector shows
/// one surface at a time instead of clipping values at the window edge.
private struct StateInspectorView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var isCompactContextVisible = false

    var body: some View {
        GeometryReader { proxy in
            let arrangement = StudioLayoutMetrics.inspectorArrangement(forWidth: proxy.size.width)
            VStack(spacing: 0) {
                header(arrangement: arrangement)
                Divider()
                switch arrangement {
                case .sideBySide:
                    HSplitView {
                        InspectorPanes(model: model)
                            .frame(minWidth: StudioLayoutMetrics.inspectorPanesMinWidth)
                        StateContextColumn(model: model)
                            .frame(
                                minWidth: StudioLayoutMetrics.contextColumnMinWidth,
                                idealWidth: StudioLayoutMetrics.contextColumnIdealWidth,
                                maxWidth: StudioLayoutMetrics.contextColumnMaxWidth
                            )
                    }
                case .compact:
                    if isCompactContextVisible {
                        StateContextColumn(model: model)
                    } else {
                        InspectorPanes(model: model)
                    }
                }
            }
        }
    }

    private func header(arrangement: StudioLayoutMetrics.InspectorArrangement) -> some View {
        HStack(spacing: 8) {
            Label("Screen State Inspector", systemImage: "scope")
                .font(.headline)
            if let detail = model.canvasStateDetail {
                Text(detail.title)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            snapshotCaption
            if arrangement == .compact {
                Toggle("Context", isOn: $isCompactContextVisible)
                    .toggleStyle(.button)
                    .help("The window is too narrow to show the state context beside the evidence panes. Toggle between them.")
                    .accessibilityLabel("Show the Screen State context column")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder
    private var snapshotCaption: some View {
        if let detail = model.canvasStateDetail {
            Text("Canonical Snapshot \(detail.canonicalSnapshotID)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: StudioLayoutMetrics.headerCaptionMaxWidth)
                .help("The observation Snapshot driving every Inspector pane.")
        }
    }
}

/// The Snapshot-driven inspection panes: screenshot evidence, the 3D layers,
/// the design workbench, and the 2D view tree.
private struct InspectorPanes: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VSplitView {
            TabView {
                ScreenshotPane(model: model)
                    .tabItem { Label("Screenshot", systemImage: "photo") }
                LayerInspector3DPane(model: model)
                    .tabItem { Label("3D Layers", systemImage: "square.3.layers.3d") }
                if StudioFeaturePolicy.designReviewVisibleByDefault {
                    DesignReviewPane(model: model)
                        .tabItem { Label("Design Review", systemImage: "square.on.square.dashed") }
                }
            }
            .frame(minHeight: 280)
            ViewTreePane(model: model)
                .frame(minHeight: 180)
        }
    }
}

/// The demoted Snapshot library: a secondary evidence view over the raw
/// captures of the selected scope.
private struct EvidenceSection: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        HSplitView {
            SnapshotListPane(model: model)
                .frame(
                    minWidth: StudioLayoutMetrics.evidenceListMinWidth,
                    idealWidth: StudioLayoutMetrics.evidenceListIdealWidth,
                    maxWidth: StudioLayoutMetrics.evidenceListMaxWidth
                )
            InspectorPanes(model: model)
                .frame(minWidth: StudioLayoutMetrics.inspectorPanesMinWidth)
            VSplitView {
                NodeDetailsPane(model: model)
                    .frame(minHeight: 260)
                ReviewIssuesPane(model: model)
                    .frame(minHeight: 140)
            }
            .frame(
                minWidth: StudioLayoutMetrics.evidenceDetailMinWidth,
                idealWidth: StudioLayoutMetrics.evidenceDetailIdealWidth,
                maxWidth: StudioLayoutMetrics.evidenceDetailMaxWidth
            )
        }
    }
}

private struct CanvasPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var isExploreFormPresented = false
    @State private var isMergeSheetPresented = false

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
        // The exploration Operation belongs to the run, not to the visible
        // tab: switching tabs keeps the poll loop, the progress line, the
        // automatic Canvas refresh after a succeeded run, and Cancel alive.
        // The revision watch, by contrast, is a pure view concern — it only
        // needs to run while the Canvas is actually on screen.
        .onAppear { model.startCanvasWatch() }
        .onDisappear { model.stopCanvasWatch() }
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
            InteractiveScreenStateCanvas(model: model)
        }
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
                Button("Cancel") {
                    model.endMergeDecision()
                    dismiss()
                }
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
        .frame(minWidth: StudioLayoutMetrics.curationSheetMinWidth)
        .onAppear {
            // The decision starts here, against the graph revision on screen.
            model.beginMergeDecision()
            survivorID = model.mergeSelectionStateIDs.first ?? ""
        }
        .onChange(of: model.mergeSelectionStateIDs) {
            // A background reload can drop the survivor out of the selection;
            // the picker must never keep a state the merge cannot name.
            if !model.mergeSelectionStateIDs.contains(survivorID) {
                survivorID = model.mergeSelectionStateIDs.first ?? ""
            }
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
                Button("Cancel") {
                    model.endSplitDecision()
                    dismiss()
                }
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
        .frame(minWidth: StudioLayoutMetrics.curationSheetMinWidth)
        .onAppear {
            // The decision starts here, against the graph revision on screen.
            model.beginSplitDecision()
        }
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

/// A labeled context value that truncates in the middle instead of clipping
/// at the column edge, with the full value in the tooltip.
private struct ContextValueText: View {
    let value: String
    var monospaced = false

    init(_ value: String, monospaced: Bool = false) {
        self.value = value
        self.monospaced = monospaced
    }

    var body: some View {
        Text(value)
            .font(monospaced ? .caption.monospaced() : .caption)
            .multilineTextAlignment(.trailing)
            .lineLimit(1)
            .truncationMode(.middle)
            .help(value)
            .textSelection(.enabled)
    }
}

/// One small annotation label chip, shared by the Canvas cards and the
/// Inspector context column.
private struct AnnotationLabelChip: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.secondary.opacity(0.15)))
            .help(label)
    }
}

/// The single state context column of the Inspector: the Screen State's
/// persisted fields, its annotations, observations and curation actions,
/// knowledge links, the Runtime Context of the state's canonical Snapshot,
/// the selected node's properties and tuning entry, and the Review Issues —
/// as sections of one scrollable column, not stacked panels.
private struct StateContextColumn: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var linkFilter = ""
    @State private var isSplitSheetPresented = false
    @State private var isEditingAnnotations = false
    @State private var annotationLabelsText = ""
    @State private var annotationSummaryText = ""

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Screen State", systemImage: "scope") {
                Button("Close", systemImage: "xmark.circle") {
                    Task { await model.selectCanvasState(id: nil) }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .accessibilityLabel("Close the Screen State Inspector")
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    stateContent
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(isPresented: $isSplitSheetPresented) {
            SplitStateSheet(model: model)
        }
        .onChange(of: model.selectedCanvasStateID) {
            // A different state closes the open annotation editor: its
            // decision belonged to the previous state.
            if isEditingAnnotations {
                model.endAnnotationEdit()
                isEditingAnnotations = false
            }
        }
    }

    @ViewBuilder
    private var stateContent: some View {
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
                annotationSection(for: detail)
                Divider()
                observationSection(for: detail)
                linkedNodes
                Divider()
                linkControls
                Divider()
                runtimeContextSection
                nodeSection
                Divider()
                reviewIssuesSection
            }
        }
    }

    // MARK: Screen State fields

    private func stateFields(for detail: ScreenStateDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Title") { ContextValueText(detail.title) }
            LabeledContent("Kind") { ContextValueText(detail.kind) }
            LabeledContent("Status") { ContextValueText(detail.status) }
            LabeledContent("First seen") { ContextValueText(detail.firstSeen) }
            LabeledContent("Last seen") { ContextValueText(detail.lastSeen) }
            LabeledContent("Snapshot") {
                ContextValueText(detail.canonicalSnapshotID, monospaced: true)
            }
        }
        .font(.caption)
    }

    // MARK: Annotations

    /// The state's annotation labels and one-sentence summary, with the
    /// inline editor behind the Edit affordance. The edit begins against the
    /// graph revision on screen; a reload underneath it conflicts at Save.
    @ViewBuilder
    private func annotationSection(for detail: ScreenStateDetail) -> some View {
        Text("Annotations")
            .font(.caption.weight(.semibold))
        if isEditingAnnotations {
            annotationEditor
        } else {
            if detail.labels.isEmpty, detail.summary == nil {
                Text("No labels or summary describe this state yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !detail.labels.isEmpty {
                AnnotationLabelFlow(labels: detail.labels)
            }
            if let summary = detail.summary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Button("Edit annotations", systemImage: "tag") {
                annotationLabelsText = detail.labels.joined(separator: ", ")
                annotationSummaryText = detail.summary ?? ""
                // The edit decision starts here, against the graph revision
                // on screen — exactly like the Merge and Split sheets.
                model.beginAnnotationEdit()
                isEditingAnnotations = true
            }
            .font(.caption)
            .disabled(!detail.isActive)
            .help(
                detail.isActive
                    ? "Edit the state's labels and summary."
                    : "This state was \(detail.status) by identity curation. Only an active state can be annotated."
            )
        }
    }

    private var annotationEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Labels (comma-separated)")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Labels", text: $annotationLabelsText)
                .textFieldStyle(.roundedBorder)
            Text("Summary")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Summary", text: $annotationSummaryText, axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
            Text("\(trimmedSummary.count)/\(ScreenStateAnnotationForm.maximumSummaryLength)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(
                    trimmedSummary.count > ScreenStateAnnotationForm.maximumSummaryLength
                        ? Color.red
                        : Color.secondary
                )
                .accessibilityLabel("Summary length \(trimmedSummary.count) of \(ScreenStateAnnotationForm.maximumSummaryLength) characters")
            Text("Emptying a field clears it on the state.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
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
                Button("Cancel") {
                    model.endAnnotationEdit()
                    isEditingAnnotations = false
                }
                Button("Save") {
                    Task {
                        let saved = await model.annotateSelectedState(
                            labels: parsedLabels,
                            summary: trimmedSummary
                        )
                        if saved {
                            isEditingAnnotations = false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isAnnotatingState
                        || ScreenStateAnnotationForm.validationError(
                            labels: parsedLabels,
                            summary: trimmedSummary
                        ) != nil
                )
            }
        }
    }

    private var parsedLabels: [String] {
        ScreenStateAnnotationForm.parseLabels(annotationLabelsText)
    }

    private var trimmedSummary: String {
        annotationSummaryText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Observations and curation

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

    // MARK: Knowledge links

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
                    .help("\(node.title) · \(node.kind)")
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
                        .help(node.title)
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

    // MARK: Runtime Context of the canonical Snapshot

    @ViewBuilder
    private var runtimeContextSection: some View {
        if let snapshot = model.selectedSnapshot {
            Text("Runtime Context")
                .font(.caption.weight(.semibold))
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Snapshot") { ContextValueText(snapshot.id, monospaced: true) }
                if let scenarioID = snapshot.scenarioID {
                    LabeledContent("Scenario") { ContextValueText(scenarioID) }
                }
                LabeledContent("Application") { ContextValueText(snapshot.applicationID) }
                LabeledContent("Version") { ContextValueText(snapshot.applicationVersion) }
                LabeledContent("Platform") { ContextValueText(snapshot.platform.uppercased()) }
                LabeledContent("Device") { ContextValueText(snapshot.device) }
                LabeledContent("Environment") { ContextValueText(snapshot.environment) }
                LabeledContent("Build") { ContextValueText(snapshot.buildID, monospaced: true) }
                if let sourceGitSHA = snapshot.sourceGitSHA {
                    LabeledContent("Source Git SHA") {
                        ContextValueText(sourceGitSHA, monospaced: true)
                    }
                }
            }
            .font(.caption)
        }
    }

    // MARK: Selected node properties and tuning

    @ViewBuilder
    private var nodeSection: some View {
        if let node = model.selectedNode {
            Divider()
            Text("UI Node")
                .font(.caption.weight(.semibold))
            VStack(alignment: .leading, spacing: 4) {
                ForEach(node.fields) { field in
                    LabeledContent(field.label) { ContextValueText(field.value) }
                }
            }
            .font(.caption)
            if node.stableID != nil {
                Divider()
                Text("Tuning Preview (Debug Runtime)")
                    .font(.caption.weight(.semibold))
                TuningPreviewControls(model: model, node: node)
                Text("Active Previews")
                    .font(.caption.weight(.semibold))
                ActiveTuningList(model: model)
            }
        }
    }

    // MARK: Review Issues

    @ViewBuilder
    private var reviewIssuesSection: some View {
        Text("Review Issues")
            .font(.caption.weight(.semibold))
        switch model.issuesPhase {
        case .idle, .loading:
            ProgressView("Loading Review Issues…")
                .controlSize(.small)
        case .empty:
            Text("No Review Issues have been recorded yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case let .failure(message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        case .content:
            ForEach(model.reviewIssues) { issue in
                reviewIssueRow(for: issue)
            }
            if model.selectedIssueID != nil {
                Divider()
                ReviewIssueDetailPanel(model: model)
            }
        }
    }

    private func reviewIssueRow(for issue: ReviewIssueSummary) -> some View {
        Button {
            Task {
                await model.selectReviewIssue(
                    id: model.selectedIssueID == issue.id ? nil : issue.id
                )
            }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(issue.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(issue.state)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(issue.state == "resolved" ? Color.green : Color.orange)
                    Text(issue.severity)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(issue.category)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(
                        model.selectedIssueID == issue.id
                            ? Color.accentColor.opacity(0.12)
                            : Color.clear
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Review issue \(issue.title), state \(issue.state)")
    }
}

/// Annotation label chips laid out in wrapping rows sized to the column.
private struct AnnotationLabelFlow: View {
    let labels: [String]

    var body: some View {
        // An adaptive grid wraps chips across rows without a custom Layout;
        // each chip truncates inside its cell instead of widening the column.
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 56, maximum: 160), spacing: 4, alignment: .leading)],
            alignment: .leading,
            spacing: 4
        ) {
            ForEach(labels, id: \.self) { label in
                AnnotationLabelChip(label: label)
            }
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
                    .frame(
                        minWidth: StudioLayoutMetrics.designReferenceColumnMinWidth,
                        idealWidth: StudioLayoutMetrics.designReferenceColumnIdealWidth,
                        maxWidth: StudioLayoutMetrics.designReferenceColumnMaxWidth
                    )
                overlayColumn
                DesignDifferenceColumn(model: model, isReviewMode: $isReviewMode)
                    .frame(
                        minWidth: StudioLayoutMetrics.designDifferenceColumnMinWidth,
                        idealWidth: StudioLayoutMetrics.designDifferenceColumnIdealWidth,
                        maxWidth: StudioLayoutMetrics.designDifferenceColumnMaxWidth
                    )
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
        // An overlay that cannot be reconciled with the screenshot says so
        // instead of stretching the design asset behind the user's back.
        if model.designAssetData != nil,
           let caption = model.designOverlayPlacement?.reconciliationCaption
        {
            lines.append(Caption(text: caption, isError: false))
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
                    if let assetData = model.designAssetData,
                       let design = NSImage(data: assetData),
                       let placement = model.designOverlayPlacement
                    {
                        // The design canvas maps through the screenshot
                        // coverage, exactly like the difference rectangles, so
                        // both live in one coordinate frame even when the
                        // screenshot covers less than the whole canvas. The
                        // asset keeps its own aspect ratio; a canvas it cannot
                        // fill is captioned, never silently stretched.
                        Image(nsImage: design)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(
                                width: max(fitted.width * placement.unitRect.width, 1),
                                height: max(fitted.height * placement.unitRect.height, 1)
                            )
                            .offset(
                                x: fitted.minX + fitted.width * placement.unitRect.x,
                                y: fitted.minY + fitted.height * placement.unitRect.y
                            )
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
            Divider()
            issueAction
        }
    }

    private var issueAction: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button("Create Review Issue", systemImage: "exclamationmark.bubble") {
                Task { await model.promoteSelectedDifferenceToIssue() }
            }
            .controlSize(.small)
            .disabled(model.selectedDifferenceID == nil || model.isPromotingDifference)
            if model.isPromotingDifference {
                ProgressView("Creating Review Issue…")
                    .controlSize(.small)
                    .font(.caption)
            } else if let issue = model.lastPromotedIssue {
                Text("Created \(issue.title)")
                    .font(.caption)
                    .foregroundStyle(.green)
                    .lineLimit(2)
                    .accessibilityLabel("Review Issue created: \(issue.title)")
            } else if let error = model.differenceIssueError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            } else {
                Text("Select a Difference to preserve its target and evidence as an Issue.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
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
                Text("Select a Screen State or a Snapshot to explode its layers in 3D.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                sceneContent
            }
        }
    }

    @ViewBuilder
    private var sceneContent: some View {
        // The scene must be resolved before the caption so the caption can
        // report honestly whether this build textured real pixels.
        let scene = sceneCache.scene(
            for: model.layerBoxes,
            screenshot: model.selectedSnapshot?.screenshot,
            screenshotData: model.screenshotData,
            selectedNodeID: model.selectedNodeID
        )
        if !sceneCache.lastBuildUsedRealPixels {
            Text("No screenshot bytes are available for this Snapshot; layers are role-colored placeholders, not real pixels.")
                .font(.caption)
                .foregroundStyle(.orange)
                .padding(.horizontal)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
        }
        SceneView(
            scene: scene,
            options: [.allowsCameraControl, .autoenablesDefaultLighting]
        )
        .accessibilityLabel("3D layer inspector with \(model.layerBoxes.count) layers")
    }
}

/// Memoizes the built scene by its layer boxes and screenshot identity so
/// unrelated published changes do not rebuild it and reset the user's
/// orbiting camera. A changed node selection restyles the cached scene in
/// place instead of rebuilding it. The cache is only touched from main-actor
/// `body` evaluations.
private final class LayerSceneCache {
    private struct Key: Equatable {
        let boxes: [LayerBox3D]
        let screenshotHash: String?
        let hasScreenshotBytes: Bool
    }

    private var key: Key?
    private var cached: SCNScene?
    private var selectedNodeID: String?
    /// Whether the most recent build textured the layers with the actual
    /// screenshot pixels. False means the honest colored-placeholder fallback.
    private(set) var lastBuildUsedRealPixels = false

    @MainActor
    func scene(
        for boxes: [LayerBox3D],
        screenshot: ScreenshotPresentation?,
        screenshotData: Data?,
        selectedNodeID: String?
    ) -> SCNScene {
        let key = Key(
            boxes: boxes,
            screenshotHash: screenshot?.hash,
            hasScreenshotBytes: screenshotData != nil
        )
        if cached == nil || key != self.key {
            let build = LayerSceneBuilder.scene(
                for: boxes,
                screenshot: screenshot,
                screenshotData: screenshotData
            )
            cached = build.scene
            lastBuildUsedRealPixels = build.usedRealPixels
            self.key = key
            self.selectedNodeID = nil
        }
        guard let cached else {
            // Unreachable: the cache was just filled above.
            return SCNScene()
        }
        if selectedNodeID != self.selectedNodeID {
            LayerSceneBuilder.applySelection(selectedNodeID, in: cached)
            self.selectedNodeID = selectedNodeID
        }
        return cached
    }
}

enum LayerSceneBuilder {
    private static let scale: CGFloat = 0.01
    private static let layerSpacing: CGFloat = 0.16

    struct Build {
        let scene: SCNScene
        /// True when the layers were textured with the screenshot's pixels.
        let usedRealPixels: Bool
    }

    static func scene(
        for boxes: [LayerBox3D],
        screenshot: ScreenshotPresentation?,
        screenshotData: Data?
    ) -> Build {
        let scene = SCNScene()
        scene.background.contents = NSColor.windowBackgroundColor
        let raster = decodedRaster(screenshot: screenshot, screenshotData: screenshotData)
        let bounds = boxes.reduce(CGRect.zero) { partial, box in
            partial.union(CGRect(x: box.x, y: box.y, width: box.width, height: box.height))
        }
        var texturedAnyLayer = false
        for box in boxes {
            let plane = SCNBox(
                width: CGFloat(box.width) * scale,
                height: CGFloat(box.height) * scale,
                length: 0.01,
                chamferRadius: 0
            )
            let material = SCNMaterial()
            if let texture = texture(for: box, raster: raster, screenshot: screenshot) {
                // The layer shows the node's actual captured pixels. A
                // constant lighting model keeps the default scene lights
                // from tinting the evidence.
                material.diffuse.contents = texture
                material.lightingModel = .constant
                texturedAnyLayer = true
            } else if raster != nil {
                // Real pixels exist but this node's frame lies outside the
                // covered region: a neutral placeholder, never invented pixels.
                material.diffuse.contents = NSColor.systemGray.withAlphaComponent(0.3)
            } else {
                // No screenshot bytes at all (fixture mode ships none): the
                // honest role-colored placeholder boxes.
                material.diffuse.contents = box.isInteractive
                    ? NSColor.systemOrange.withAlphaComponent(0.55)
                    : NSColor.systemBlue.withAlphaComponent(0.35)
            }
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
        return Build(scene: scene, usedRealPixels: texturedAnyLayer)
    }

    /// Restyles the selection highlight in place so an orbiting camera
    /// survives a changed node selection. The highlight is a subtle emission
    /// tint; the layer content itself stays the evidence.
    static func applySelection(_ nodeID: String?, in scene: SCNScene) {
        scene.rootNode.enumerateChildNodes { node, _ in
            guard let material = node.geometry?.firstMaterial, node.name != nil else {
                return
            }
            let isSelected = nodeID != nil && node.name == nodeID
            material.emission.contents = isSelected
                ? NSColor.controlAccentColor.withAlphaComponent(0.45)
                : NSColor.black
        }
    }

    /// Decodes the screenshot bytes into a CGImage once per scene build.
    /// Returns nil when there are no bytes or they are not a supported image.
    private static func decodedRaster(
        screenshot: ScreenshotPresentation?,
        screenshotData: Data?
    ) -> CGImage? {
        guard screenshot != nil, let screenshotData, let image = NSImage(data: screenshotData) else {
            return nil
        }
        return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }

    /// Crops the node's region out of the screenshot raster: the logical
    /// frame maps through the screenshot coverage and pixel scale into a
    /// top-left-origin pixel rect, clamped to the raster, which is exactly
    /// the space `CGImage.cropping(to:)` consumes.
    private static func texture(
        for box: LayerBox3D,
        raster: CGImage?,
        screenshot: ScreenshotPresentation?
    ) -> CGImage? {
        guard let raster, let screenshot else {
            return nil
        }
        guard let crop = LayerTextureProjection.pixelCropRect(
            frame: RectPresentation(x: box.x, y: box.y, width: box.width, height: box.height),
            coverage: screenshot.coverage,
            pixelWidth: Double(raster.width),
            pixelHeight: Double(raster.height)
        ) else {
            return nil
        }
        return raster.cropping(
            to: CGRect(x: crop.x, y: crop.y, width: crop.width, height: crop.height)
        )
    }
}

private struct WikiPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var searchText = ""
    @State private var mode: WikiMode = .nodes
    @State private var isCreating = false
    @State private var editingNode: WikiNodeSummary?
    @State private var editingCollection: KnowledgeCollectionSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Deep Wiki", systemImage: "book") {
                Button(mode == .nodes ? "New node" : "New Collection", systemImage: "plus") {
                    isCreating = true
                }
                .disabled(model.isSavingWikiNode || model.isSavingKnowledgeCollection)
            }
            Divider()
            Picker("Knowledge view", selection: $mode) {
                ForEach(WikiMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 8)
            .padding(.top, 8)
            HStack(spacing: 8) {
                TextField(mode == .nodes ? "Search knowledge…" : "Search Collections…", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { runSearch() }
                Button("Search") {
                    runSearch()
                }
            }
            .padding(8)
            Divider()
            content
        }
        .sheet(isPresented: $isCreating) {
            if mode == .nodes {
                WikiNodeCreateSheet(model: model)
            } else {
                KnowledgeCollectionEditorSheet(model: model, collection: nil)
            }
        }
        .sheet(item: $editingNode) { node in
            WikiNodeEditSheet(model: model, nodeID: node.id)
        }
        .sheet(item: $editingCollection) { collection in
            KnowledgeCollectionEditorSheet(model: model, collection: collection)
        }
        .onChange(of: mode) {
            searchText = ""
            if mode == .collections {
                Task {
                    await model.loadWiki(text: nil)
                    await model.loadKnowledgeCollections(text: nil)
                }
            } else {
                Task { await model.loadWiki(text: nil) }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if mode == .nodes {
            nodeContent
        } else {
            collectionContent
        }
    }

    @ViewBuilder
    private var nodeContent: some View {
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

    @ViewBuilder
    private var collectionContent: some View {
        switch model.knowledgeCollectionsPhase {
        case .idle, .loading:
            ProgressView("Loading Knowledge Collections…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No Knowledge Collections",
                systemImage: "square.stack.3d.up",
                description: Text(
                    model.wikiNodes.isEmpty
                        ? "Create a Wiki node first, then group published knowledge into a Collection."
                        : "Create a Collection to define an entry point and a versionable knowledge bundle."
                )
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failure(message):
            Text(message)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .content:
            List(model.knowledgeCollections) { collection in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(collection.name)
                            .font(.subheadline.weight(.semibold))
                        HStack(spacing: 8) {
                            Text(collection.publication.state)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(
                                    collection.publication.state == "published"
                                        ? Color.green
                                        : Color.secondary
                                )
                            Text("\(collection.nodeIDs.count) nodes")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("revision \(collection.revision)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        if let summary = collection.summary, !summary.isEmpty {
                            Text(summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    Button("Edit") {
                        model.beginKnowledgeCollectionEdit(collection)
                        editingCollection = collection
                    }
                    .font(.caption)
                }
                .padding(.vertical, 3)
                .accessibilityLabel(
                    "Knowledge Collection \(collection.name), \(collection.publication.state), \(collection.nodeIDs.count) nodes"
                )
            }
            .listStyle(.sidebar)
        }
    }

    private func runSearch() {
        let text = searchText.isEmpty ? nil : searchText
        if mode == .nodes {
            Task { await model.loadWiki(text: text) }
        } else {
            Task { await model.loadKnowledgeCollections(text: text) }
        }
    }

    private enum WikiMode: String, CaseIterable, Identifiable {
        case nodes
        case collections

        var id: String { rawValue }
        var label: String { self == .nodes ? "Wiki Nodes" : "Collections" }
    }
}

/// Creates or revises one Knowledge Collection from the current Workspace's
/// Wiki nodes. Entry nodes are an explicit subset of members; Studio never
/// silently expands or imports source documents.
private struct KnowledgeCollectionEditorSheet: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let collection: KnowledgeCollectionSummary?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var summary = ""
    @State private var memberNodeIDs: Set<String> = []
    @State private var entryNodeIDs: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(collection == nil ? "New Knowledge Collection" : "Edit Knowledge Collection")
                .font(.headline)
            if let collection {
                Text("\(collection.publication.state) · revision \(collection.revision)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField("Collection name", text: $name)
                .textFieldStyle(.roundedBorder)
            TextField("Summary (optional)", text: $summary)
                .textFieldStyle(.roundedBorder)
            Text("Members and entry points")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            List(model.wikiNodes) { node in
                HStack(spacing: 10) {
                    Toggle(
                        isOn: Binding(
                            get: { memberNodeIDs.contains(node.id) },
                            set: { isMember in
                                if isMember {
                                    memberNodeIDs.insert(node.id)
                                } else {
                                    memberNodeIDs.remove(node.id)
                                    entryNodeIDs.remove(node.id)
                                }
                            }
                        )
                    ) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(node.title)
                            Text("\(node.kind) · \(node.status)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.checkbox)
                    Toggle(
                        "Entry",
                        isOn: Binding(
                            get: { entryNodeIDs.contains(node.id) },
                            set: { isEntry in
                                if isEntry {
                                    memberNodeIDs.insert(node.id)
                                    entryNodeIDs.insert(node.id)
                                } else {
                                    entryNodeIDs.remove(node.id)
                                }
                            }
                        )
                    )
                    .toggleStyle(.checkbox)
                    .disabled(!memberNodeIDs.contains(node.id))
                }
            }
            .frame(minHeight: 220)
            if let note = model.knowledgeCollectionConflictNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let error = model.knowledgeCollectionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            HStack {
                Text("\(memberNodeIDs.count) members · \(entryNodeIDs.count) entries")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { dismiss() }
                Button(collection == nil ? "Create" : "Save") {
                    Task {
                        let saved: Bool
                        if collection != nil {
                            saved = await model.updateSelectedKnowledgeCollection(
                                name: name,
                                summary: summary,
                                nodeIDs: Array(memberNodeIDs),
                                entryNodeIDs: Array(entryNodeIDs)
                            )
                        } else {
                            saved = await model.createKnowledgeCollection(
                                name: name,
                                summary: summary,
                                nodeIDs: Array(memberNodeIDs),
                                entryNodeIDs: Array(entryNodeIDs)
                            )
                        }
                        if saved { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isSavingKnowledgeCollection
                        || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || memberNodeIDs.isEmpty
                        || entryNodeIDs.isEmpty
                )
            }
        }
        .padding(16)
        .frame(minWidth: 620, minHeight: 520)
        .onAppear {
            if let collection {
                name = collection.name
                summary = collection.summary ?? ""
                memberNodeIDs = Set(collection.nodeIDs)
                entryNodeIDs = Set(collection.entryNodeIDs)
            }
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
        .frame(minWidth: StudioLayoutMetrics.wikiSheetMinWidth)
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
        .frame(minWidth: StudioLayoutMetrics.wikiSheetMinWidth)
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
                .disabled(model.isTransitioningIssue || model.isRecapturingIssue)
            HStack(spacing: 6) {
                ForEach(model.legalIssueTransitions, id: \.self) { target in
                    Button(target) {
                        let transitionReason = reason.isEmpty ? nil : reason
                        Task {
                            await model.transitionSelectedIssue(to: target, reason: transitionReason)
                        }
                    }
                    .font(.caption)
                    .disabled(model.isTransitioningIssue || model.isRecapturingIssue)
                }
            }
            if issue.state == "ready_for_verification" {
                Button("Recapture and Verify", systemImage: "camera.badge.ellipsis") {
                    Task { await model.recaptureAndVerifySelectedIssue() }
                }
                .controlSize(.small)
                .disabled(model.isTransitioningIssue || model.isRecapturingIssue)
            }
            if model.isRecapturingIssue {
                ProgressView("Capturing a later build and verifying…")
                    .controlSize(.small)
                    .font(.caption)
            } else if let result = model.lastIssueVerification,
                      result.issue.issueID == issue.issueID {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Verification \(result.verification.result.uppercased())")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            result.verification.result == "passed" ? Color.green : Color.orange
                        )
                    Text("Build \(result.verification.verifiedBuildID)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("The captured Snapshot is available in Evidence.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = model.issueTransitionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if let error = model.issueVerificationError {
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

/// The collapsible bottom timeline strip: persisted Runtime events with the
/// Host's event-pump state. Events are timeline evidence, not a standalone
/// sidebar destination.
private struct EventTimelineStrip: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if isExpanded {
                Divider()
                content
                    .frame(height: 190)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                isExpanded.toggle()
            } label: {
                Label("Timeline", systemImage: isExpanded ? "chevron.down" : "chevron.up")
                    .font(.headline)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isExpanded ? "Collapse the timeline" : "Expand the timeline")
            Text(summaryLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
            pumpStatus
        }
        .padding(.horizontal)
        .padding(.vertical, 7)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var summaryLine: String {
        EventTimelineStripPresentation.summary(
            phase: model.eventsPhase,
            eventCount: model.events.count,
            gapCount: model.reportedEventGaps.count
        )
    }

    /// The Host's Runtime event-pump status, reported by `GET /v1/status`.
    @ViewBuilder
    private var pumpStatus: some View {
        if case let .available(status) = model.connectionPhase, let pump = status.runtimeEvents {
            Text(pump.state.rawValue)
                .font(.caption)
                .foregroundStyle(pumpColor(pump.state))
                .help(pumpHelp(pump))
                .accessibilityLabel("Runtime event pump \(pump.state.rawValue)")
        }
    }

    private func pumpColor(_ state: RuntimeEventsPumpState) -> Color {
        switch state {
        case .running: .green
        case .failed: .red
        case .stopped: .orange
        case .idle, .unsupported: .secondary
        }
    }

    private func pumpHelp(_ status: RuntimeEventsStatus) -> String {
        var parts = ["Runtime event pump: \(status.state.rawValue)"]
        if let epoch = status.eventEpochID {
            parts.append("epoch \(epoch)")
        }
        if let sequence = status.persistedThroughSequence {
            parts.append("persisted through #\(sequence)")
        }
        if let code = status.errorCode {
            parts.append("error \(code)")
        }
        return parts.joined(separator: " · ")
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

/// The persistent context bar: the Application + Version scope picker that
/// drives everything below, the independent Host and Runtime status, and the
/// capture entry.
private struct ContextBar: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let workspaceName: String?
    let onManageWorkspaces: (() -> Void)?

    var body: some View {
        HStack(spacing: 14) {
            workspaceLabel
            Divider()
                .frame(height: 18)
            scopePicker
            Divider()
                .frame(height: 18)
            connectionLabel
            runtimeLabel
            Text("\(model.scopedSnapshots.count) Snapshot\(model.scopedSnapshots.count == 1 ? "" : "s")")
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
    private var workspaceLabel: some View {
        if let workspaceName, let onManageWorkspaces {
            Menu {
                Button("Manage Workspaces…", action: onManageWorkspaces)
            } label: {
                Label(workspaceName, systemImage: "folder.fill")
                    .font(.headline)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Manage local Workspaces")
            .accessibilityLabel("Current Workspace, \(workspaceName)")
        } else {
            Label("Vistrea Studio", systemImage: "rectangle.3.group")
                .font(.headline)
        }
    }

    @ViewBuilder
    private var scopePicker: some View {
        if model.availableScopes.isEmpty {
            Text("No application scope")
                .foregroundStyle(.secondary)
        } else {
            Picker("Application", selection: scopeBinding) {
                ForEach(model.availableScopes) { scope in
                    Text(scope.title).tag(Optional(scope))
                }
            }
            .labelsHidden()
            .frame(maxWidth: StudioLayoutMetrics.scopePickerMaxWidth)
            .help(scopeHelp)
            .accessibilityLabel("Application and version scope")
        }
    }

    private var scopeBinding: Binding<WorkspaceScope?> {
        Binding(
            get: { model.selectedScope },
            set: { scope in
                guard let scope, scope != model.selectedScope else { return }
                Task { await model.selectScope(scope) }
            }
        )
    }

    private var scopeHelp: String {
        guard let scope = model.selectedScope else {
            return "Application and version scope"
        }
        return "Project \(scope.projectID) · build \(scope.buildID)"
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

/// The Evidence library: the raw captures of the selected scope. Snapshots
/// here are subordinate evidence — the primary way into a screenshot or a
/// view tree is a Screen State on the Canvas.
private struct SnapshotListPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Snapshot Evidence", systemImage: "camera.on.rectangle")
            Divider()
            List(model.scopedSnapshots, selection: selection) { snapshot in
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
                        Section("Tuning Preview (Debug Runtime)") {
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

/// Reversible visual-property controls for one selected node. The Host and
/// Debug Runtime remain the security boundary; Studio only creates canonical
/// Tuning Patches and renders explicit applied/rejected outcomes.
private struct TuningPreviewControls: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let node: NodePresentation
    @State private var property: TunableProperty = .alpha
    @State private var alphaValue: Double = 1
    @State private var cornerRadiusValue: Double = 0
    @State private var foregroundColor = Color.primary
    @State private var backgroundColor = Color.clear
    @State private var fontFamily = "System"
    @State private var fontSize: Double = 17
    @State private var fontWeight: Double = 400
    @State private var spacingOriginal: Double = 0
    @State private var spacingValue: Double = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Property", selection: $property) {
                ForEach(TunableProperty.allCases) { value in
                    Text(value.label).tag(value)
                }
            }
            propertyEditor
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
            if let patch = model.lastTuningPatch {
                TuningSourceHandoffView(model: model, patch: patch)
            }
        }
        .onAppear { resetValues() }
        .onChange(of: node.id) {
            resetValues()
        }
    }

    @ViewBuilder
    private var propertyEditor: some View {
        switch property {
        case .alpha:
            LabeledContent(
                "Source alpha",
                value: (node.alpha ?? 1).formatted(.number.precision(.fractionLength(0...2)))
            )
            Slider(value: $alphaValue, in: 0...1)
            previewButton("Preview alpha") { await model.previewAlpha(alphaValue) }
        case .foregroundColor:
            colorEditor(
                label: "Foreground",
                source: node.foregroundColor,
                selection: $foregroundColor,
                property: "foreground_color"
            )
        case .backgroundColor:
            colorEditor(
                label: "Background",
                source: node.backgroundColor,
                selection: $backgroundColor,
                property: "background_color"
            )
        case .font:
            if let source = node.font {
                LabeledContent("Source font", value: source.summaryText)
                TextField("Family", text: $fontFamily)
                LabeledContent("Size", value: fontSize.formatted(.number.precision(.fractionLength(1))))
                Slider(value: $fontSize, in: 6...96, step: 0.5)
                LabeledContent("Weight", value: Int(fontWeight).description)
                Slider(value: $fontWeight, in: 100...900, step: 100)
                previewButton("Preview font") {
                    await model.previewTuning(
                        property: "font",
                        originalValue: .font(
                            family: source.family,
                            size: source.size,
                            weight: source.weight,
                            style: source.style
                        ),
                        previewValue: .font(
                            family: fontFamily,
                            size: fontSize,
                            weight: Int(fontWeight),
                            style: source.style
                        )
                    )
                }
            } else {
                unavailable("This node did not report a font.")
            }
        case .spacing:
            Text("Enter the observed source spacing. The Runtime re-reads it and rejects a mismatch.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                TextField("Source", value: $spacingOriginal, format: .number)
                TextField("Preview", value: $spacingValue, format: .number)
            }
            previewButton("Preview spacing") {
                await model.previewTuning(
                    property: "spacing",
                    originalValue: .number(value: spacingOriginal, unit: "logical_point"),
                    previewValue: .number(value: spacingValue, unit: "logical_point")
                )
            }
        case .cornerRadius:
            if let source = node.cornerRadius {
                LabeledContent(
                    "Source radius",
                    value: source.formatted(.number.precision(.fractionLength(0...2)))
                )
                Slider(value: $cornerRadiusValue, in: 0...64, step: 0.5)
                previewButton("Preview corner radius") {
                    await model.previewTuning(
                        property: "corner_radius",
                        originalValue: .number(value: source, unit: "logical_point"),
                        previewValue: .number(value: cornerRadiusValue, unit: "logical_point")
                    )
                }
            } else {
                unavailable("This node did not report a corner radius.")
            }
        }
    }

    @ViewBuilder
    private func colorEditor(
        label: String,
        source: ColorRGBAValueSummary?,
        selection: Binding<Color>,
        property: String
    ) -> some View {
        if let source {
            LabeledContent("Source \(label.lowercased())", value: source.summaryText)
            ColorPicker(label, selection: selection, supportsOpacity: true)
            previewButton("Preview \(label.lowercased())") {
                guard let preview = rgba(selection.wrappedValue) else { return }
                await model.previewTuning(
                    property: property,
                    originalValue: .color(
                        red: source.red,
                        green: source.green,
                        blue: source.blue,
                        alpha: source.alpha
                    ),
                    previewValue: .color(
                        red: preview.red,
                        green: preview.green,
                        blue: preview.blue,
                        alpha: preview.alpha
                    )
                )
            }
        } else {
            unavailable("This node did not report a \(label.lowercased()).")
        }
    }

    private func previewButton(
        _ title: String,
        operation: @escaping () async -> Void
    ) -> some View {
        HStack {
            Spacer()
            Button(title) { Task { await operation() } }
                .disabled(model.isApplyingTuning)
        }
    }

    private func unavailable(_ message: String) -> some View {
        Text(message).font(.caption).foregroundStyle(.secondary)
    }

    private func resetValues() {
        alphaValue = node.alpha ?? 1
        cornerRadiusValue = node.cornerRadius ?? 0
        if let color = node.foregroundColor {
            foregroundColor = Color(
                red: color.red,
                green: color.green,
                blue: color.blue,
                opacity: color.alpha
            )
        }
        if let color = node.backgroundColor {
            backgroundColor = Color(
                red: color.red,
                green: color.green,
                blue: color.blue,
                opacity: color.alpha
            )
        }
        if let font = node.font {
            fontFamily = font.family
            fontSize = font.size
            fontWeight = Double(font.weight)
        }
    }

    private func rgba(_ color: Color) -> ColorRGBAValueSummary? {
        guard let converted = NSColor(color).usingColorSpace(.sRGB) else { return nil }
        return ColorRGBAValueSummary(
            red: Double(converted.redComponent),
            green: Double(converted.greenComponent),
            blue: Double(converted.blueComponent),
            alpha: Double(converted.alphaComponent)
        )
    }

    private enum TunableProperty: String, CaseIterable, Identifiable {
        case alpha
        case foregroundColor
        case backgroundColor
        case font
        case spacing
        case cornerRadius

        var id: String { rawValue }

        var label: String {
            switch self {
            case .alpha: "Alpha"
            case .foregroundColor: "Foreground color"
            case .backgroundColor: "Background color"
            case .font: "Font"
            case .spacing: "Spacing"
            case .cornerRadius: "Corner radius"
            }
        }
    }
}

/// A Coding Agent handoff generated from the exact persisted Tuning Patch.
/// Missing source mapping remains visible and never turns into a fabricated
/// file path.
private struct TuningSourceHandoffView: View {
    @ObservedObject var model: SnapshotWorkspaceModel
    let patch: TuningPatchSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Label("Source Handoff", systemImage: "chevron.left.forwardslash.chevron.right")
                    .font(.caption.weight(.semibold))
                Spacer()
                Button("Prepare") {
                    Task { await model.loadTuningSourceSuggestions() }
                }
                .controlSize(.small)
                .disabled(isLoading)
            }
            Text(patch.title)
                .font(.caption)
                .lineLimit(2)
            Text("Patch \(patch.patchID)")
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)

            switch model.tuningSourceSuggestionsPhase {
            case .idle:
                Text("Prepare a source-oriented instruction set for a Coding Agent.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .loading:
                ProgressView("Preparing source handoff…")
                    .controlSize(.small)
            case .empty:
                Text("This patch produced no source suggestions.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case let .failure(message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            case .content:
                ForEach(model.tuningSourceSuggestions) { suggestion in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(suggestion.property.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.caption.weight(.medium))
                            Spacer()
                            Text(suggestion.status == "actionable" ? "Mapped" : "Needs source mapping")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(suggestion.status == "actionable" ? Color.green : Color.orange)
                        }
                        if let stableID = suggestion.stableID {
                            Text(stableID)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        if let sourceContext = suggestion.sourceContextPresentation {
                            LabeledContent("Source context") {
                                Text(sourceContext)
                                    .font(.caption2.monospaced())
                                    .textSelection(.enabled)
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                        LabeledContent("Source value") {
                            Text(suggestion.originalValuePresentation)
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Suggested value") {
                            Text(suggestion.suggestedValuePresentation)
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                        }
                        ForEach(Array(suggestion.codingAgentInstructions.enumerated()), id: \.offset) { _, instruction in
                            Text("• \(instruction)")
                                .font(.caption)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(7)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 7))
                }
            }
        }
    }

    private var isLoading: Bool {
        if case .loading = model.tuningSourceSuggestionsPhase { return true }
        return false
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
