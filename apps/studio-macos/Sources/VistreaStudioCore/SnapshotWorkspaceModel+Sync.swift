import Foundation

@MainActor
public extension SnapshotWorkspaceModel {
    func connectHub(
        baseURL: String,
        projectID: String,
        bearerToken: String,
        refNames: [String]
    ) async {
        guard !isHubTransferring else { return }
        hubSyncGeneration += 1
        let generation = hubSyncGeneration
        let remote = HubSyncRemote(
            baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            projectID: projectID.trimmingCharacters(in: .whitespacesAndNewlines),
            bearerToken: bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let normalizedRefs = refNames.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        hubSyncPhase = .connecting
        hubSyncError = nil
        hubActivityError = nil
        lastHubTransfer = nil
        do {
            let status = try await client.getSyncStatus(remote: remote, refNames: normalizedRefs)
            guard generation == hubSyncGeneration else { return }
            hubRemote = remote
            hubRefNames = normalizedRefs
            hubSyncStatus = status
            hubSyncPhase = .connected
            hubSyncActivity = []
            hubActivityCursor = 0
            await loadMoreHubActivity()
        } catch {
            guard generation == hubSyncGeneration else { return }
            hubRemote = nil
            hubSyncStatus = nil
            let message = Self.message(for: error)
            hubSyncError = message
            hubSyncPhase = .failure(message)
        }
    }

    func disconnectHub() {
        hubSyncGeneration += 1
        hubRemote = nil
        hubRefNames = []
        hubActivityCursor = 0
        hubSyncStatus = nil
        hubSyncActivity = []
        hubSyncError = nil
        hubActivityError = nil
        lastHubTransfer = nil
        isHubTransferring = false
        isHubActivityLoading = false
        hubSyncPhase = .idle
    }

    func refreshHubStatus() async {
        guard let remote = hubRemote, !isHubTransferring else { return }
        let generation = hubSyncGeneration
        hubSyncError = nil
        do {
            let status = try await client.getSyncStatus(remote: remote, refNames: hubRefNames)
            guard generation == hubSyncGeneration else { return }
            hubSyncStatus = status
            hubSyncPhase = .connected
        } catch {
            guard generation == hubSyncGeneration else { return }
            let message = Self.message(for: error)
            hubSyncError = message
            hubSyncPhase = .failure(message)
        }
    }

    func fetchFromHub() async {
        guard let remote = hubRemote, !isHubTransferring else { return }
        let generation = hubSyncGeneration
        isHubTransferring = true
        hubSyncError = nil
        defer { isHubTransferring = false }
        do {
            let outcome = try await client.fetchWorkspace(
                remote: remote,
                refNames: hubRefNames,
                actor: HubSyncActor()
            )
            guard generation == hubSyncGeneration else { return }
            hubSyncStatus = outcome.status
            lastHubTransfer = HubSyncTransferSummary(
                direction: .fetch,
                importedCommitCount: outcome.result.imported.importedCommitIDs.count,
                importedObjectCount: outcome.result.imported.importedObjectHashes.count,
                advancedRefCount: outcome.result.advancedRefs.count
                    + outcome.result.imported.createdRefs.count,
                conflicts: outcome.result.remainingConflicts
            )
            await refreshHubActivityFromStart()
            await refresh()
        } catch {
            guard generation == hubSyncGeneration else { return }
            hubSyncError = Self.message(for: error)
        }
    }

    func pushToHub(message: String?) async {
        guard let remote = hubRemote, !isHubTransferring else { return }
        let generation = hubSyncGeneration
        isHubTransferring = true
        hubSyncError = nil
        defer { isHubTransferring = false }
        do {
            let outcome = try await client.pushWorkspace(
                remote: remote,
                refNames: hubRefNames,
                actor: HubSyncActor(),
                message: message?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            )
            guard generation == hubSyncGeneration else { return }
            hubSyncStatus = outcome.status
            lastHubTransfer = HubSyncTransferSummary(
                direction: .push,
                importedCommitCount: outcome.result.imported.importedCommitIDs.count,
                importedObjectCount: outcome.result.imported.importedObjectHashes.count,
                advancedRefCount: outcome.result.advancedRefs.count + outcome.result.imported.createdRefs.count,
                conflicts: outcome.result.remainingConflicts
            )
            await refreshHubActivityFromStart()
        } catch {
            guard generation == hubSyncGeneration else { return }
            hubSyncError = Self.message(for: error)
        }
    }

    func refreshHubActivityFromStart() async {
        guard hubRemote != nil else { return }
        hubActivityCursor = 0
        hubSyncActivity = []
        await loadMoreHubActivity()
    }

    func loadMoreHubActivity() async {
        guard let remote = hubRemote, !isHubActivityLoading else { return }
        let generation = hubSyncGeneration
        isHubActivityLoading = true
        hubActivityError = nil
        defer { isHubActivityLoading = false }
        do {
            let page = try await client.getSyncActivity(
                remote: remote,
                afterSequence: hubActivityCursor,
                limit: 100
            )
            guard generation == hubSyncGeneration else { return }
            let known = Set(hubSyncActivity.map(\.eventID))
            hubSyncActivity.append(contentsOf: page.items.filter { !known.contains($0.eventID) })
            hubSyncActivity.sort { $0.sequence > $1.sequence }
            hubActivityCursor = UInt64(page.nextCursor) ?? hubActivityCursor
        } catch {
            guard generation == hubSyncGeneration else { return }
            hubActivityError = Self.message(for: error)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
