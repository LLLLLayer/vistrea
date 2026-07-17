import SwiftUI
import VistreaStudioCore
import VistreaStudioHostRuntime

struct WorkspaceManagerView: View {
    let recentWorkspaces: [StudioRecentWorkspace]
    let currentWorkspaceURL: URL?
    let selectedWorkspaceURL: URL?
    let availability: (URL) -> StudioWorkspaceAvailability
    let maintenanceModel: WorkspaceMaintenanceViewModel
    let allowsMaintenance: Bool
    let canRetryOpen: Bool
    let onSelect: (URL) -> Void
    let onNewWorkspace: () -> Void
    let onOpenWorkspace: () -> Void
    let onOpenToManage: (URL) -> Void
    let onReveal: (URL) -> Void
    let onRemoveRecent: (URL) -> Void
    let onClose: () -> Void
    let onOfflineMaintenance: (WorkspaceOfflineMaintenanceAction) -> Void
    let onRetryOpen: () -> Void

    var body: some View {
        HSplitView {
            managerSidebar
                .frame(minWidth: 270, idealWidth: 310, maxWidth: 360)
            managerDetail
                .frame(minWidth: 580, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceManager)
    }

    private var managerSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Workspaces")
                            .font(.title2.weight(.semibold))
                        Text("Local projects and maintenance")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(currentWorkspaceURL == nil ? "Back" : "Done", action: onClose)
                        .disabled(maintenanceModel.isBusy)
                        .accessibilityIdentifier(StudioAccessibilityID.workspaceManagerClose)
                }

                HStack(spacing: 8) {
                    Button(action: onNewWorkspace) {
                        Label("New", systemImage: "plus")
                    }
                    Button(action: onOpenWorkspace) {
                        Label("Open", systemImage: "folder")
                    }
                }
                .disabled(maintenanceModel.isBusy)
            }
            .padding(18)

            Divider()

            if recentWorkspaces.isEmpty {
                ContentUnavailableView(
                    "No Workspaces",
                    systemImage: "folder",
                    description: Text("Create a Workspace or open one from disk.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 5) {
                        ForEach(recentWorkspaces) { workspace in
                            managerRow(workspace)
                        }
                    }
                    .padding(10)
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceManagerList)
    }

    private func managerRow(_ workspace: StudioRecentWorkspace) -> some View {
        let status = availability(workspace.url)
        let selected = normalizedPath(workspace.url) == selectedWorkspaceURL.map(normalizedPath)
        let current = normalizedPath(workspace.url) == currentWorkspaceURL.map(normalizedPath)

        return Button {
            onSelect(workspace.url)
        } label: {
            HStack(spacing: 11) {
                Image(systemName: status == .available ? "folder.fill" : "folder.badge.questionmark")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(status == .available ? Color.accentColor : Color.secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(workspace.displayName)
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                        if current {
                            Text("Current")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tint)
                        }
                    }
                    Text(workspace.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if status != .available {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                selected ? Color.accentColor.opacity(0.12) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8)
            )
        }
        .buttonStyle(.plain)
        .disabled(maintenanceModel.isBusy)
        .accessibilityIdentifier(StudioAccessibilityID.workspaceManagerRow(workspace.path))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityValue(
            current ? "Current Workspace" : selected ? "Selected Workspace" : statusTitle(status)
        )
        .contextMenu {
            Button("Open to Manage") {
                onOpenToManage(workspace.url)
            }
            .disabled(status != .available || current || maintenanceModel.isBusy)
            Button("Reveal in Finder") {
                onReveal(workspace.url)
            }
            .disabled(status == .missing)
            Divider()
            Button("Remove from Recent", role: .destructive) {
                onRemoveRecent(workspace.url)
            }
            .disabled(current || maintenanceModel.isBusy)
        }
    }

    @ViewBuilder
    private var managerDetail: some View {
        if let selectedWorkspaceURL {
            let status = availability(selectedWorkspaceURL)
            if allowsMaintenance, status == .available {
                WorkspaceMaintenanceView(
                    model: maintenanceModel,
                    workspaceURL: selectedWorkspaceURL,
                    canRetryOpen: canRetryOpen,
                    onReveal: { onReveal(selectedWorkspaceURL) },
                    onOfflineMaintenance: onOfflineMaintenance,
                    onRetryOpen: onRetryOpen
                )
            } else {
                workspaceSummary(selectedWorkspaceURL, status: status)
            }
        } else {
            ContentUnavailableView(
                "Select a Workspace",
                systemImage: "sidebar.left",
                description: Text("Choose a recent Workspace to inspect or manage it.")
            )
            .studioAccessibilityContainer(StudioAccessibilityID.workspaceManagerDetail)
        }
    }

    private func workspaceSummary(
        _ workspaceURL: URL,
        status: StudioWorkspaceAvailability
    ) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 42))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 5) {
                    Text(displayName(workspaceURL))
                        .font(.largeTitle.weight(.semibold))
                    Text(workspaceURL.path)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer()
            }

            GroupBox("Workspace Status") {
                HStack {
                    Label(statusTitle(status), systemImage: statusIcon(status))
                        .foregroundStyle(status == .available ? Color.primary : Color.orange)
                    Spacer()
                    Button("Reveal in Finder") {
                        onReveal(workspaceURL)
                    }
                    .disabled(status == .missing)
                }
                .padding(8)
            }

            if status == .available {
                Text("Open this Workspace before changing recovery points or running offline maintenance. The current Workspace stays available until the switch succeeds.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open to Manage") {
                    onOpenToManage(workspaceURL)
                }
                .buttonStyle(.borderedProminent)
                .disabled(maintenanceModel.isBusy)
            } else {
                Text(status == .missing
                    ? "The recorded location is missing. Locate the Workspace with Open Workspace, or remove this entry from Recent."
                    : "This folder is not a recognizable Vistrea Workspace. Its contents have not been modified.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(34)
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceManagerDetail)
    }

    private func normalizedPath(_ url: URL) -> String {
        url.standardizedFileURL.path
    }

    private func displayName(_ url: URL) -> String {
        StudioRecentWorkspace(path: url.path, lastOpenedAt: Date()).displayName
    }

    private func statusTitle(_ status: StudioWorkspaceAvailability) -> String {
        switch status {
        case .available: "Available"
        case .missing: "Location Missing"
        case .unrecognized: "Not a Vistrea Workspace"
        }
    }

    private func statusIcon(_ status: StudioWorkspaceAvailability) -> String {
        switch status {
        case .available: "checkmark.circle.fill"
        case .missing: "questionmark.folder"
        case .unrecognized: "exclamationmark.triangle.fill"
        }
    }
}

private struct WorkspaceMaintenanceView: View {
    @ObservedObject var model: WorkspaceMaintenanceViewModel

    let workspaceURL: URL
    let canRetryOpen: Bool
    let onReveal: () -> Void
    let onOfflineMaintenance: (WorkspaceOfflineMaintenanceAction) -> Void
    let onRetryOpen: () -> Void

    @State private var restoreConfirmation: WorkspaceRecoveryPoint?
    @State private var releaseConfirmation: RetentionRelease?
    @State private var advancedConfirmation: AdvancedRecovery?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                statusBanner
                recoveryPointsSection
                garbageCollectionSection
                advancedRecoverySection
            }
            .padding(30)
            .frame(maxWidth: 1_050, alignment: .leading)
        }
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceManagerDetail)
        .alert(
            "Restore Workspace?",
            isPresented: Binding(
                get: { restoreConfirmation != nil },
                set: { if !$0 { restoreConfirmation = nil } }
            ),
            presenting: restoreConfirmation
        ) { point in
            Button("Cancel", role: .cancel) {}
            Button("Restore and Reopen", role: .destructive) {
                onOfflineMaintenance(.restore(recoveryPointID: point.recoveryPointID))
                restoreConfirmation = nil
            }
            .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceRestoreConfirmation)
        } message: { point in
            Text("The local Host will stop, metadata will be restored from “\(point.reason)”, and the Workspace will reopen. Current metadata is preserved as recovery evidence.")
        }
        .alert(
            "Release Retention Policy?",
            isPresented: Binding(
                get: { releaseConfirmation != nil },
                set: { if !$0 { releaseConfirmation = nil } }
            ),
            presenting: releaseConfirmation
        ) { release in
            Button("Cancel", role: .cancel) {}
            Button("Release", role: .destructive) {
                Task {
                    await model.releaseRecoveryPoint(
                        recoveryPointID: release.recoveryPointID,
                        retentionPolicyID: release.policyID
                    )
                }
                releaseConfirmation = nil
            }
        } message: { release in
            Text("Releasing “\(release.policyID)” allows this backup to become eligible for a later garbage-collection plan. It is not deleted immediately.")
        }
        .alert(
            "Run Advanced Recovery?",
            isPresented: Binding(
                get: { advancedConfirmation != nil },
                set: { if !$0 { advancedConfirmation = nil } }
            ),
            presenting: advancedConfirmation
        ) { recovery in
            Button("Cancel", role: .cancel) {}
            Button("Stop Host and Recover") {
                switch recovery {
                case .interruptedRestore:
                    onOfflineMaintenance(.recoverInterruptedRestore)
                case .staleLock:
                    onOfflineMaintenance(.recoverStaleLock)
                }
                advancedConfirmation = nil
            }
        } message: { recovery in
            Text(recovery.explanation)
        }
        .task {
            if model.hasOnlineClient && model.recoveryPoints.isEmpty && !model.isBusy {
                await model.loadRecoveryPoints()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            Image(systemName: "externaldrive.fill.badge.checkmark")
                .font(.system(size: 38))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 5) {
                Text("Workspace Maintenance")
                    .font(.largeTitle.weight(.semibold))
                Text(workspaceURL.path)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            Button("Reveal in Finder", action: onReveal)
                .disabled(model.isBusy)
        }
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenance)
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let status = model.statusMessage {
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceProgress)
                Text(status)
                Spacer()
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceStatus)
        }
        if let result = model.resultMessage {
            Label(result, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceResult)
        }
        if let error = model.errorMessage {
            VStack(alignment: .leading, spacing: 9) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                if canRetryOpen {
                    Button("Retry Open", action: onRetryOpen)
                        .disabled(model.isBusy)
                        .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceRetryOpen)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceError)
        }
    }

    private var recoveryPointsSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                if model.hasOnlineClient {
                    HStack {
                        TextField("Reason for this recovery point", text: $model.recoveryPointReason)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier(
                                StudioAccessibilityID.workspaceMaintenanceRecoveryPointReason
                            )
                        Button("Create Recovery Point") {
                            Task { await model.createRecoveryPoint() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isBusy || model.recoveryPointReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceCreateRecoveryPoint)
                        Button {
                            Task { await model.loadRecoveryPoints() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .help("Reload recovery points")
                        .disabled(model.isBusy)
                    }

                    if model.recoveryPoints.isEmpty {
                        ContentUnavailableView(
                            "No Recovery Points",
                            systemImage: "clock.arrow.circlepath",
                            description: Text("Create a verified metadata backup before a risky local change.")
                        )
                        .frame(minHeight: 150)
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(model.recoveryPoints, id: \.recoveryPointID) { point in
                                recoveryPointRow(point)
                            }
                        }
                    }
                } else {
                    Label(
                        "The local Host is unavailable, so recovery-point metadata cannot be listed. Offline repair actions remain available below.",
                        systemImage: "bolt.horizontal.circle"
                    )
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(8)
        } label: {
            Label("Recovery Points", systemImage: "clock.arrow.circlepath")
                .font(.headline)
        }
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceRecoveryPoints)
    }

    private func recoveryPointRow(_ point: WorkspaceRecoveryPoint) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(point.reason)
                    .font(.body.weight(.semibold))
                Text(point.source == .manual ? "Manual" : "Before Migration")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(point.source == .manual ? Color.accentColor : .orange)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(
                        (point.source == .manual ? Color.accentColor : Color.orange).opacity(0.1),
                        in: Capsule()
                    )
                Spacer()
                Button("Restore…") {
                    restoreConfirmation = point
                }
                .disabled(model.isBusy)
                .accessibilityIdentifier(
                    StudioAccessibilityID.workspaceMaintenanceRestore(point.recoveryPointID)
                )
            }
            HStack(spacing: 16) {
                Label(point.createdAt.rawValue, systemImage: "calendar")
                Label(
                    ByteCountFormatter.string(
                        fromByteCount: Int64(clamping: point.backup.byteSize.rawValue),
                        countStyle: .file
                    ),
                    systemImage: "doc"
                )
                Text(shortHash(point.recoveryPointID))
                    .font(.caption.monospaced())
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if point.activeRetentionPolicyIDs.isEmpty {
                Text("No active retention policy")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                HStack(spacing: 8) {
                    Text("Retained by")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(point.activeRetentionPolicyIDs, id: \.self) { policyID in
                        Button(policyID) {
                            releaseConfirmation = RetentionRelease(
                                recoveryPointID: point.recoveryPointID,
                                policyID: policyID
                            )
                        }
                        .buttonStyle(.borderless)
                        .font(.caption.monospaced())
                        .help("Release this retention policy")
                        .disabled(model.isBusy)
                    }
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(nsColor: .separatorColor).opacity(0.65))
        }
        .studioAccessibilityContainer(
            StudioAccessibilityID.workspaceMaintenanceRecoveryPoint(point.recoveryPointID)
        )
    }

    private var garbageCollectionSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                Text("Analyze first. Vistrea deletes only objects that are old enough, unreachable from live metadata and Commit roots, and protected by no active retention policy.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Stepper(
                        "Minimum age: \(model.garbageMinimumAgeDays) day\(model.garbageMinimumAgeDays == 1 ? "" : "s")",
                        value: $model.garbageMinimumAgeDays,
                        in: 0...365
                    )
                    Spacer()
                    Button("Analyze Storage") {
                        onOfflineMaintenance(
                            .analyzeGarbage(minimumAgeSeconds: model.garbageMinimumAgeSeconds)
                        )
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier(
                        StudioAccessibilityID.workspaceMaintenanceGarbageAnalyze
                    )
                }

                if let preview = model.garbagePreview {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 24) {
                            metric("Scanned", value: preview.scannedObjects)
                            metric("Candidates", value: preview.candidateObjects)
                            metric("Candidate size", value: formattedBytes(preview.candidateBytes))
                            metric("Stale records", value: preview.staleCatalogEntries)
                        }
                        Text("Plan \(shortHash(preview.planDigest))")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)

                        if preview.candidateObjects > 0 || preview.staleCatalogEntries > 0 {
                            Divider()
                            Text("Type DELETE to apply this exact plan. Any Workspace change that alters the plan makes the operation fail safely.")
                                .font(.callout)
                                .foregroundStyle(.orange)
                            HStack {
                                TextField("DELETE", text: $model.garbageConfirmation)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: 220)
                                    .accessibilityIdentifier(
                                        StudioAccessibilityID
                                            .workspaceMaintenanceGarbageConfirmationField
                                    )
                                Button("Delete Planned Objects", role: .destructive) {
                                    onOfflineMaintenance(
                                        .applyGarbage(
                                            minimumAgeSeconds: preview.minimumAgeSeconds,
                                            planDigest: preview.planDigest
                                        )
                                    )
                                }
                                .disabled(model.isBusy || !model.canApplyGarbagePreview)
                                .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceGarbageApply)
                            }
                            .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceGarbageConfirmation)
                        } else {
                            Label("Nothing is eligible for deletion.", systemImage: "checkmark.circle")
                                .foregroundStyle(.green)
                        }
                    }
                    .padding(12)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                    .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceGarbagePreview)
                }
            }
            .padding(8)
        } label: {
            Label("Storage Cleanup", systemImage: "trash.slash")
                .font(.headline)
        }
        .studioAccessibilityContainer(StudioAccessibilityID.workspaceMaintenanceGarbage)
    }

    private var advancedRecoverySection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 13) {
                Text("Use these only when a prior restore was interrupted or Studio reports a stale Host lock. A live owner is never broken automatically.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Recover Interrupted Restore…") {
                        advancedConfirmation = .interruptedRestore
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceRecoverInterruptedRestore)
                    Button("Recover Stale Host Lock…") {
                        advancedConfirmation = .staleLock
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier(StudioAccessibilityID.workspaceMaintenanceRecoverStaleLock)
                }
            }
            .padding(8)
        } label: {
            Label("Advanced Recovery", systemImage: "wrench.and.screwdriver")
                .font(.headline)
        }
    }

    private func metric(_ title: String, value: UInt64) -> some View {
        metric(title, value: String(value))
    }

    private func metric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title3.monospacedDigit().weight(.semibold))
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func formattedBytes(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(clamping: bytes), countStyle: .file)
    }

    private func shortHash(_ hash: String) -> String {
        guard hash.count > 22 else { return hash }
        return "\(hash.prefix(15))…\(hash.suffix(6))"
    }
}

private struct RetentionRelease {
    let recoveryPointID: String
    let policyID: String
}

private enum AdvancedRecovery {
    case interruptedRestore
    case staleLock

    var explanation: String {
        switch self {
        case .interruptedRestore:
            "Vistrea will stop the local Host, inspect the durable restore journal, roll back preserved metadata files, and then try to reopen the Workspace."
        case .staleLock:
            "Vistrea will stop the local Host, verify that the recorded owner is dead, preserve lock evidence, and then try to reopen the Workspace. A live or malformed lock fails closed."
        }
    }
}
