import AppKit
import SwiftUI
import VistreaStudioHostRuntime

struct ProjectDocumentsPane: View {
    @ObservedObject var documents: StudioProjectDocuments
    @State private var searchText = ""
    @State private var selection: String?
    @State private var showsSource = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            if !documents.warnings.isEmpty || documents.operationError != nil {
                Divider()
                messages
            }
        }
        .task {
            guard documents.phase == .idle else { return }
            await documents.refresh()
        }
        .onChange(of: documents.selectedDocumentID) { _, newValue in
            selection = newValue
        }
        .onChange(of: selection) { _, newValue in
            guard let newValue, newValue != documents.selectedDocumentID else { return }
            Task { await documents.selectDocument(id: newValue) }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Project Documents", systemImage: "doc.text.magnifyingglass")
                .font(.headline)
            if let projectRootURL = documents.projectRootURL {
                Text(projectRootURL.lastPathComponent)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(projectRootURL.path)
            }
            Spacer()
            if documents.projectRootURL != nil {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await documents.refresh() }
                }
                .disabled(documents.phase == .loading)
                if documents.usesProjectConfiguration,
                   let configurationURL = documents.configurationURL {
                    Button("Open Config", systemImage: "slider.horizontal.3") {
                        NSWorkspace.shared.open(configurationURL)
                    }
                    .help("Edit vistrea.project.json in the project repository.")
                } else {
                    Button("Create Config", systemImage: "doc.badge.plus") {
                        Task { await documents.createStarterConfiguration() }
                    }
                    .help("Create a starter vistrea.project.json without overwriting existing files.")
                }
                Button("Reveal", systemImage: "folder") {
                    if let projectRootURL = documents.projectRootURL {
                        NSWorkspace.shared.activateFileViewerSelecting([projectRootURL])
                    }
                }
                Button("Disconnect") {
                    documents.clearProjectRoot()
                }
            }
            Button(
                documents.projectRootURL == nil ? "Choose Project…" : "Change Project…",
                systemImage: "folder.badge.gearshape"
            ) {
                chooseProject()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder
    private var content: some View {
        switch documents.phase {
        case .idle, .loading:
            ProgressView("Loading project documents…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unconfigured:
            ContentUnavailableView {
                Label("No Project Folder", systemImage: "folder.badge.questionmark")
            } description: {
                Text(
                    "Choose the source project associated with this Workspace. " +
                    "Studio reads README.md and docs/ by default, or the sources declared in vistrea.project.json."
                )
            } actions: {
                Button("Choose Project…") { chooseProject() }
                    .buttonStyle(.borderedProminent)
            }
        case .empty:
            ContentUnavailableView(
                "No Markdown Documents",
                systemImage: "doc.text",
                description: Text(
                    documents.usesProjectConfiguration
                        ? "The configured sources contain no readable .md or .markdown files."
                        : "Add README.md, a docs directory, or create vistrea.project.json to choose other sources."
                )
            )
        case let .failure(message):
            ContentUnavailableView {
                Label("Documents Unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Choose Another Project…") { chooseProject() }
            }
        case .content:
            HSplitView {
                documentList
                    .frame(minWidth: 240, idealWidth: 300, maxWidth: 420)
                documentPreview
                    .frame(minWidth: 440)
            }
        }
    }

    private var documentList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter documents…", text: $searchText)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            Divider()
            List(filteredDocuments, selection: $selection) { document in
                VStack(alignment: .leading, spacing: 3) {
                    Text(document.title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(document.relativePath)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(document.sourceName)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 3)
                .tag(document.id)
                .accessibilityLabel("\(document.title), \(document.relativePath)")
            }
            .listStyle(.sidebar)
        }
    }

    @ViewBuilder
    private var documentPreview: some View {
        if let detail = documents.selectedDocument {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(detail.summary.title)
                            .font(.headline)
                        Text(detail.summary.relativePath)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Toggle("Source", isOn: $showsSource)
                        .toggleStyle(.button)
                        .help("Switch between rendered Markdown and its source text.")
                }
                .padding(.horizontal)
                .padding(.vertical, 9)
                .background(Color(nsColor: .controlBackgroundColor))
                Divider()
                ScrollView {
                    if showsSource {
                        Text(detail.markdown)
                            .font(.system(.body, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .textSelection(.enabled)
                            .padding(20)
                    } else {
                        Text(renderedMarkdown(detail.markdown))
                            .frame(maxWidth: 820, alignment: .topLeading)
                            .textSelection(.enabled)
                            .padding(24)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
                .background(Color(nsColor: .textBackgroundColor))
            }
        } else if documents.operationError == nil {
            ContentUnavailableView(
                "Choose a Document",
                systemImage: "doc.text",
                description: Text("Select any configured Markdown document to preview it.")
            )
        }
    }

    private var messages: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let error = documents.operationError {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    Spacer()
                    Button("Dismiss") { documents.dismissOperationError() }
                }
            }
            ForEach(documents.warnings, id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
            if documents.projectRootURL != nil, !documents.usesProjectConfiguration {
                Text(
                    "Automatic sources are active. Create vistrea.project.json to share the document roots with the project."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var filteredDocuments: [StudioProjectDocumentSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return documents.documents }
        return documents.documents.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.relativePath.localizedCaseInsensitiveContains(query)
                || $0.sourceName.localizedCaseInsensitiveContains(query)
        }
    }

    private func renderedMarkdown(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
        )) ?? AttributedString(source)
    }

    private func chooseProject() {
        let panel = NSOpenPanel()
        panel.title = "Choose Project Folder"
        panel.message = "Choose the source project whose Markdown should appear in this Workspace."
        panel.prompt = "Choose"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = documents.projectRootURL
        guard panel.runModal() == .OK, let projectURL = panel.url else { return }
        Task { await documents.configureProjectRoot(projectURL) }
    }
}
