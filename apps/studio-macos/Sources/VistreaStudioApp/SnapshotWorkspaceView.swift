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

    private static let columnWidth: CGFloat = 230
    private static let rowHeight: CGFloat = 116
    private static let cardSize = CGSize(width: 200, height: 92)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Screen State Canvas", systemImage: "point.3.connected.trianglepath.dotted")
            Divider()
            content
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
            ScrollView([.horizontal, .vertical]) {
                canvasContent
                    .padding(24)
            }
        }
    }

    private var canvasContent: some View {
        let positions = model.canvasStates
        let graph = model.canvasGraph
        let entryIDs = Set(graph?.entryStateIDs ?? [])
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
                VStack(alignment: .leading, spacing: 4) {
                    Text(positioned.state.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Text(positioned.state.kind)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if entryIDs.contains(positioned.id) {
                        Text("entry")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.blue)
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
                            entryIDs.contains(positioned.id) ? Color.blue : Color.secondary.opacity(0.4),
                            lineWidth: entryIDs.contains(positioned.id) ? 2 : 1
                        )
                )
                .offset(
                    x: CGFloat(positioned.column) * Self.columnWidth,
                    y: CGFloat(positioned.row) * Self.rowHeight
                )
                .accessibilityLabel("Screen state \(positioned.state.title)")
            }
        }
        .frame(
            width: CGFloat(width) * Self.columnWidth,
            height: CGFloat(height) * Self.rowHeight,
            alignment: .topLeading
        )
    }
}

private struct LayerInspector3DPane: View {
    @ObservedObject var model: SnapshotWorkspaceModel

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
                    scene: LayerSceneBuilder.scene(for: model.layerBoxes),
                    options: [.allowsCameraControl, .autoenablesDefaultLighting]
                )
                .accessibilityLabel("3D layer inspector with \(model.layerBoxes.count) layers")
            }
        }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PaneHeader(title: "Deep Wiki", systemImage: "book")
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
    }

    @ViewBuilder
    private var content: some View {
        switch model.wikiPhase {
        case .idle, .loading:
            ProgressView("Loading the Deep Wiki…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            Text("No knowledge matches. Create Wiki nodes through the CLI, MCP, or an agent.")
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
                .padding(.vertical, 2)
                .accessibilityLabel("Wiki node \(node.title), \(node.status)")
            }
            .listStyle(.sidebar)
        }
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
            List(model.reviewIssues) { issue in
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
                .accessibilityLabel("Review issue \(issue.title), state \(issue.state)")
            }
            .listStyle(.sidebar)
        }
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
