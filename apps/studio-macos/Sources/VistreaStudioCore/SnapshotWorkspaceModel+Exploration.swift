import Foundation

// Exploration is intentionally separated from the general Workspace model:
// it owns a long-running Host Operation lifecycle and can evolve without
// forcing every Canvas, Wiki, and design-review change through one file.
extension SnapshotWorkspaceModel {
    private static let terminalExplorationStates: Set<String> = [
        "succeeded",
        "failed",
        "cancelled",
    ]

    /// True while an exploration Operation this Studio started is still
    /// addressable on the Host: Cancel must stay reachable even when the poll
    /// loop is no longer running (a superseded start, a torn-down model), so
    /// the run can never be orphaned.
    public var isExplorationRunAddressable: Bool {
        guard explorationOperationID != nil else {
            return false
        }
        guard let state = explorationState else {
            return true
        }
        return !Self.terminalExplorationStates.contains(state)
    }

    /// Starts one background exploration Operation and polls it to a
    /// terminal state. The poll loop is bound to the Operation, not to the
    /// Canvas pane: switching tabs never stops it. A Host without a
    /// configured automation provider rejects the run with HTTP 501 code
    /// `unsupported`; the message is shown inline and the controls stay
    /// usable.
    public func startExploration(
        maximumActions: Int,
        maximumDepth: Int? = nil,
        settleMilliseconds: Int? = nil,
        excludedStableIDs: [String] = []
    ) async {
        guard !isExploring else {
            return
        }
        explorationGeneration += 1
        let generation = explorationGeneration
        isExploring = true
        explorationError = nil
        explorationReport = nil
        explorationProgress = nil
        explorationLastEventMessage = nil
        let command = ExplorationRunCommand(
            maximumActions: maximumActions,
            maximumDepth: maximumDepth,
            settleMilliseconds: settleMilliseconds,
            excludedStableIDs: excludedStableIDs.isEmpty ? nil : excludedStableIDs
        )
        let reference: ExplorationOperationRef
        do {
            reference = try await client.runExploration(command)
            guard generation == explorationGeneration else {
                return
            }
        } catch {
            guard generation == explorationGeneration else {
                return
            }
            explorationError = Self.explorationMessage(for: error)
            isExploring = false
            // The previous Operation identity survives a rejected start: a
            // Host that rejects the run because one is already active must
            // leave that run cancellable, not orphaned.
            return
        }
        // Only an accepted run replaces the previous Operation identity.
        explorationOperationID = reference.operationID
        explorationState = reference.state
        await pollExploration(operationID: reference.operationID, generation: generation)
    }

    /// Requests cancellation of the addressable exploration. The Operation
    /// stays running until the walk observes the request; the poll loop then
    /// shows the terminal `cancelled` state.
    public func cancelExploration() async {
        guard !isCancellingExploration,
              isExplorationRunAddressable,
              let operationID = explorationOperationID
        else {
            return
        }
        isCancellingExploration = true
        defer { isCancellingExploration = false }
        do {
            let ref = try await client.cancelExploration(id: operationID)
            if explorationOperationID == operationID {
                explorationState = ref.state
            }
        } catch {
            if explorationOperationID == operationID {
                explorationError = Self.explorationMessage(for: error)
            }
        }
    }

    /// Tears down the exploration poll loop without cancelling the Host-side
    /// run, when the model itself is discarded or a newer request supersedes
    /// it. The Canvas pane must never call this: a tab switch keeps the run
    /// polling. The Operation identity survives so Cancel stays reachable.
    public func stopExplorationPolling() {
        explorationGeneration += 1
        isExploring = false
    }

    /// Polls the exploration Operation once per interval until it reaches a
    /// terminal state, the generation guard supersedes the loop, or the
    /// enclosing Task is cancelled.
    private func pollExploration(operationID: String, generation: Int) async {
        while generation == explorationGeneration {
            if Task.isCancelled {
                return
            }
            do {
                try await explorationPollSleep()
            } catch {
                // The only failure a sleep reports is cancellation: stop the
                // loop instead of spinning through it.
                return
            }
            guard !Task.isCancelled, generation == explorationGeneration else {
                return
            }
            let record: ExplorationOperationRecord
            do {
                record = try await client.getExplorationOperation(id: operationID)
            } catch {
                guard generation == explorationGeneration else {
                    return
                }
                explorationError = Self.explorationMessage(for: error)
                isExploring = false
                return
            }
            guard generation == explorationGeneration else {
                return
            }
            explorationState = record.operation.state
            let previousCompletedUnits = explorationProgress?.completedUnits
            explorationProgress = record.latestProgress
            explorationLastEventMessage = record.latestEventMessage
            switch record.operation.state {
            case "succeeded":
                explorationReport = record.report
                isExploring = false
                await refreshCanvasAfterExploration()
                return
            case "failed", "cancelled":
                explorationError = Self.terminalExplorationMessage(for: record.operation)
                isExploring = false
                return
            default:
                // The walk records observations as it goes, so the Canvas
                // grows while the device is still walking: every executed
                // action may have discovered a state, and waiting for the
                // run to settle would hide exactly the live picture an
                // operator watches an exploration for.
                if record.latestProgress?.completedUnits != previousCompletedUnits {
                    await refreshCanvasAfterExploration()
                }
            }
        }
    }
}
