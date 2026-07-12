import AppKit
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
                SnapshotListPane(model: model)
                    .frame(minWidth: 220, idealWidth: 250, maxWidth: 320)
                VSplitView {
                    ScreenshotPane(model: model)
                        .frame(minHeight: 280)
                    ViewTreePane(model: model)
                        .frame(minHeight: 220)
                }
                NodeDetailsPane(model: model)
                    .frame(minWidth: 250, idealWidth: 300, maxWidth: 380)
            }
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
        case "text", "label": "textformat"
        case "image": "photo"
        case "text_field": "character.cursor.ibeam"
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
