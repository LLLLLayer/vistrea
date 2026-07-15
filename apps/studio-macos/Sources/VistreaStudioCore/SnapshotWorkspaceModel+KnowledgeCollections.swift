import Foundation

@MainActor
public extension SnapshotWorkspaceModel {
    /// Loads the mutable Collection projections. Published content remains
    /// immutable in its Commit; this list represents the current Workspace
    /// editing surface.
    func loadKnowledgeCollections(text: String?) async {
        knowledgeCollectionsGeneration += 1
        let generation = knowledgeCollectionsGeneration
        knowledgeCollectionsPhase = .loading
        do {
            let page = try await client.listKnowledgeCollections(
                text: text,
                publicationStates: nil
            )
            guard generation == knowledgeCollectionsGeneration else { return }
            knowledgeCollections = page.items
            knowledgeCollectionsPhase = page.items.isEmpty ? .empty : .content
            if let selectedKnowledgeCollectionID,
               let current = page.items.first(where: { $0.id == selectedKnowledgeCollectionID }) {
                selectedKnowledgeCollection = current
                knowledgeCollectionDetailPhase = .content
            } else if selectedKnowledgeCollectionID != nil {
                endKnowledgeCollectionSelection()
            }
        } catch {
            guard generation == knowledgeCollectionsGeneration else { return }
            knowledgeCollections = []
            knowledgeCollectionsPhase = .failure(Self.message(for: error))
        }
    }

    func selectKnowledgeCollection(id: String?) async {
        knowledgeCollectionDetailGeneration += 1
        let generation = knowledgeCollectionDetailGeneration
        selectedKnowledgeCollectionID = id
        selectedKnowledgeCollection = nil
        knowledgeCollectionError = nil
        knowledgeCollectionConflictNote = nil
        guard let id else {
            knowledgeCollectionDetailPhase = .idle
            return
        }
        knowledgeCollectionDetailPhase = .loading
        do {
            let collection = try await client.getKnowledgeCollection(id: id)
            guard generation == knowledgeCollectionDetailGeneration,
                  selectedKnowledgeCollectionID == id
            else { return }
            selectedKnowledgeCollection = collection
            knowledgeCollectionDetailPhase = .content
        } catch {
            guard generation == knowledgeCollectionDetailGeneration else { return }
            knowledgeCollectionDetailPhase = .failure(Self.message(for: error))
        }
    }

    /// Begins an edit from the exact list revision the operator selected.
    /// Saving uses this revision as the optimistic-concurrency precondition;
    /// Studio must not fetch a newer revision at submit time and silently
    /// absorb a concurrent change into the local edit.
    func beginKnowledgeCollectionEdit(_ collection: KnowledgeCollectionSummary) {
        knowledgeCollectionDetailGeneration += 1
        selectedKnowledgeCollectionID = collection.id
        selectedKnowledgeCollection = collection
        knowledgeCollectionDetailPhase = .content
        knowledgeCollectionError = nil
        knowledgeCollectionConflictNote = nil
    }

    func createKnowledgeCollection(
        name: String,
        summary: String?,
        nodeIDs: [String],
        entryNodeIDs: [String]
    ) async -> Bool {
        guard !isSavingKnowledgeCollection else { return false }
        guard let normalized = normalizedCollectionInput(
            name: name,
            summary: summary,
            nodeIDs: nodeIDs,
            entryNodeIDs: entryNodeIDs
        ) else { return false }
        isSavingKnowledgeCollection = true
        knowledgeCollectionError = nil
        defer { isSavingKnowledgeCollection = false }
        do {
            let created = try await client.createKnowledgeCollection(
                KnowledgeCollectionDraft(
                    name: normalized.name,
                    summary: normalized.summary,
                    nodeIDs: normalized.nodeIDs,
                    entryNodeIDs: normalized.entryNodeIDs
                )
            )
            knowledgeCollections.removeAll(where: { $0.id == created.id })
            knowledgeCollections.append(created)
            sortKnowledgeCollections()
            knowledgeCollectionsPhase = .content
            selectedKnowledgeCollectionID = created.id
            selectedKnowledgeCollection = created
            knowledgeCollectionDetailPhase = .content
            return true
        } catch {
            knowledgeCollectionError = Self.message(for: error)
            return false
        }
    }

    func updateSelectedKnowledgeCollection(
        name: String,
        summary: String?,
        nodeIDs: [String],
        entryNodeIDs: [String]
    ) async -> Bool {
        guard !isSavingKnowledgeCollection,
              let current = selectedKnowledgeCollection
        else { return false }
        guard let normalized = normalizedCollectionInput(
            name: name,
            summary: summary,
            nodeIDs: nodeIDs,
            entryNodeIDs: entryNodeIDs
        ) else { return false }
        isSavingKnowledgeCollection = true
        knowledgeCollectionError = nil
        knowledgeCollectionConflictNote = nil
        defer { isSavingKnowledgeCollection = false }
        do {
            let updated = try await client.reviseKnowledgeCollection(
                id: current.id,
                KnowledgeCollectionRevisionDraft(
                    expectedRevision: current.revision,
                    name: normalized.name == current.name ? nil : normalized.name,
                    summary: normalized.summary == current.summary ? nil : (normalized.summary ?? ""),
                    nodeIDs: normalized.nodeIDs == current.nodeIDs ? nil : normalized.nodeIDs,
                    entryNodeIDs: normalized.entryNodeIDs == current.entryNodeIDs
                        ? nil
                        : normalized.entryNodeIDs
                )
            )
            replaceKnowledgeCollection(updated)
            return true
        } catch let error as HostClientError {
            if case let .server(statusCode, _, code, _, _) = error,
               statusCode == 409 || code == "conflict" {
                await reloadKnowledgeCollectionAfterConflict(id: current.id)
                knowledgeCollectionConflictNote =
                    "The Collection changed elsewhere. Studio reloaded the latest revision; review before saving again."
            } else {
                knowledgeCollectionError = Self.message(for: error)
            }
            return false
        } catch {
            knowledgeCollectionError = Self.message(for: error)
            return false
        }
    }

    func endKnowledgeCollectionSelection() {
        knowledgeCollectionDetailGeneration += 1
        selectedKnowledgeCollectionID = nil
        selectedKnowledgeCollection = nil
        knowledgeCollectionDetailPhase = .idle
        knowledgeCollectionError = nil
        knowledgeCollectionConflictNote = nil
    }

    private func normalizedCollectionInput(
        name: String,
        summary: String?,
        nodeIDs: [String],
        entryNodeIDs: [String]
    ) -> (name: String, summary: String?, nodeIDs: [String], entryNodeIDs: [String])? {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSummary = summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedNodeIDs = Array(Set(nodeIDs)).sorted()
        let normalizedEntryNodeIDs = Array(Set(entryNodeIDs)).sorted()
        guard !normalizedName.isEmpty,
              normalizedName.count <= 256,
              (normalizedSummary?.count ?? 0) <= 4_096,
              !normalizedNodeIDs.isEmpty,
              !normalizedEntryNodeIDs.isEmpty,
              Set(normalizedEntryNodeIDs).isSubset(of: Set(normalizedNodeIDs))
        else {
            knowledgeCollectionError =
                "Choose a name, at least one member, and at least one entry node contained in the membership."
            return nil
        }
        return (
            normalizedName,
            normalizedSummary.flatMap { $0.isEmpty ? nil : $0 },
            normalizedNodeIDs,
            normalizedEntryNodeIDs
        )
    }

    private func replaceKnowledgeCollection(_ collection: KnowledgeCollectionSummary) {
        knowledgeCollections.removeAll(where: { $0.id == collection.id })
        knowledgeCollections.append(collection)
        sortKnowledgeCollections()
        selectedKnowledgeCollectionID = collection.id
        selectedKnowledgeCollection = collection
        knowledgeCollectionDetailPhase = .content
        knowledgeCollectionsPhase = .content
    }

    private func sortKnowledgeCollections() {
        knowledgeCollections.sort { lhs, rhs in
            if lhs.name == rhs.name { return lhs.id < rhs.id }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    private func reloadKnowledgeCollectionAfterConflict(id: String) async {
        do {
            replaceKnowledgeCollection(try await client.getKnowledgeCollection(id: id))
        } catch {
            knowledgeCollectionError = Self.message(for: error)
        }
    }
}
