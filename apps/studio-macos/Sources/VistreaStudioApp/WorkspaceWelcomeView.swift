import SwiftUI
import VistreaStudioHostRuntime

struct WorkspaceWelcomeView: View {
    let recentWorkspaces: [StudioRecentWorkspace]
    let currentWorkspaceURL: URL?
    let message: String?
    let availability: (URL) -> StudioWorkspaceAvailability
    let onNewWorkspace: () -> Void
    let onOpenWorkspace: () -> Void
    let onOpenRecent: (URL) -> Void
    let onManageRecent: (URL) -> Void
    let onReveal: (URL) -> Void
    let onRemoveRecent: (URL) -> Void
    let onClearRecent: () -> Void
    let onReturnToWorkspace: (() -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            welcomeColumn
                .frame(width: 380)
            Divider()
            recentColumn
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .studioAccessibilityContainer(StudioAccessibilityID.welcome)
    }

    private var welcomeColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 48)

            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 58, weight: .light))
                .foregroundStyle(.tint)
                .symbolRenderingMode(.hierarchical)
                .accessibilityHidden(true)

            Text("Vistrea Studio")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .padding(.top, 18)

            Text("Runtime UI knowledge, design review, and path exploration — organized in local-first Workspaces.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)

            VStack(spacing: 10) {
                WelcomeActionButton(
                    title: "New Workspace…",
                    subtitle: "Create an empty local Workspace",
                    systemImage: "plus.rectangle.on.folder",
                    accessibilityIdentifier: StudioAccessibilityID.welcomeNewWorkspace,
                    action: onNewWorkspace
                )
                WelcomeActionButton(
                    title: "Open Workspace…",
                    subtitle: "Choose an existing Vistrea Workspace",
                    systemImage: "folder",
                    accessibilityIdentifier: StudioAccessibilityID.welcomeOpenWorkspace,
                    action: onOpenWorkspace
                )
                if let onReturnToWorkspace, let currentWorkspaceURL {
                    WelcomeActionButton(
                        title: "Return to \(displayName(for: currentWorkspaceURL))",
                        subtitle: "Keep working in the current Workspace",
                        systemImage: "arrow.uturn.backward.circle",
                        accessibilityIdentifier: "studio.welcome.return-to-workspace",
                        action: onReturnToWorkspace
                    )
                }
            }
            .padding(.top, 30)

            Spacer()

            Label("Local data remains usable without Vistrea Hub.", systemImage: "internaldrive")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 42)
        .padding(.vertical, 34)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.45))
    }

    private var recentColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Recent Workspaces")
                        .font(.title2.weight(.semibold))
                    Text("Open a Workspace to restore its Canvas, evidence, Wiki, and review context.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if !recentWorkspaces.isEmpty {
                    Button("Clear Recent", action: onClearRecent)
                        .buttonStyle(.link)
                }
            }

            if let message {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(.orange.opacity(0.25))
                    }
                    .textSelection(.enabled)
            }

            if recentWorkspaces.isEmpty {
                ContentUnavailableView(
                    "No Recent Workspaces",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("Create a Workspace or open one from disk.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(recentWorkspaces) { recent in
                            RecentWorkspaceRow(
                                recent: recent,
                                status: availability(recent.url),
                                isCurrent: isCurrent(recent.url),
                                onOpen: { onOpenRecent(recent.url) },
                                onManage: { onManageRecent(recent.url) },
                                onReveal: { onReveal(recent.url) },
                                onRemove: { onRemoveRecent(recent.url) }
                            )
                        }
                    }
                    .padding(1)
                }
            }
        }
        .padding(34)
        .studioAccessibilityContainer(StudioAccessibilityID.welcomeRecentWorkspaces)
    }

    private func isCurrent(_ url: URL) -> Bool {
        guard let currentWorkspaceURL else { return false }
        return url.standardizedFileURL.path == currentWorkspaceURL.standardizedFileURL.path
    }

    private func displayName(for url: URL) -> String {
        let recent = StudioRecentWorkspace(path: url.path, lastOpenedAt: Date())
        return recent.displayName
    }
}

private struct WelcomeActionButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let accessibilityIdentifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(width: 24)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .contentShape(Rectangle())
            .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(nsColor: .separatorColor).opacity(0.7))
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}

private struct RecentWorkspaceRow: View {
    let recent: StudioRecentWorkspace
    let status: StudioWorkspaceAvailability
    let isCurrent: Bool
    let onOpen: () -> Void
    let onManage: () -> Void
    let onReveal: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onOpen) {
                rowContent
            }
            .buttonStyle(.plain)
            .disabled(status != .available)
            .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                Button("Manage…", action: onManage)
                    .disabled(status != .available)
                Button("Open", action: onOpen)
                    .disabled(status != .available)
                Button("Reveal in Finder", action: onReveal)
                    .disabled(status == .missing)
                Divider()
                Button("Remove from Recent", role: .destructive, action: onRemove)
                    .disabled(isCurrent)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 42, height: 42)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Workspace actions")
        }
        .background(
            isCurrent ? Color.accentColor.opacity(0.06) : Color(nsColor: .controlBackgroundColor),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    isCurrent ? Color.accentColor.opacity(0.35) :
                        Color(nsColor: .separatorColor).opacity(0.6)
                )
        }
        .contextMenu {
            Button("Manage…", action: onManage)
                .disabled(status != .available)
            Button("Open", action: onOpen)
                .disabled(status != .available)
            Button("Reveal in Finder", action: onReveal)
                .disabled(status == .missing)
            Divider()
            Button("Remove from Recent", role: .destructive, action: onRemove)
                .disabled(isCurrent)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(recent.displayName) Workspace")
        .accessibilityValue(statusDescription)
    }

    private var rowContent: some View {
        HStack(spacing: 14) {
            Image(systemName: status == .available ? "folder.fill" : "folder.badge.questionmark")
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(status == .available ? Color.accentColor : Color.secondary)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(recent.displayName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if isCurrent {
                        Text("Current")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tint)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(.tint.opacity(0.1), in: Capsule())
                    }
                    if status != .available {
                        Text(status == .missing ? "Missing" : "Not a Workspace")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                Text(recent.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(recent.lastOpenedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusDescription: String {
        if isCurrent { return "Current Workspace" }
        switch status {
        case .available: return "Available"
        case .missing: return "Location missing"
        case .unrecognized: return "Not a Vistrea Workspace"
        }
    }
}
