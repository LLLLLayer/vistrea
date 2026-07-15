import Foundation

@MainActor
public extension SnapshotWorkspaceModel {
    /// Build scopes available for a meaningful comparison with the selected
    /// project/application context. Cross-project comparisons are never
    /// silently attempted.
    var qualityBuildScopes: [WorkspaceScope] {
        guard let selectedScope else { return [] }
        return availableScopes.filter {
            $0.projectID == selectedScope.projectID
                && $0.applicationID == selectedScope.applicationID
        }
    }

    /// Clears ephemeral results when the Workspace context changes. Persisted
    /// Validation Runs and Build Diffs remain Host truth; Studio must not
    /// present the previous scope's last result as if it belonged to the new
    /// Application + Version selection.
    internal func resetQualityWorkspace() {
        validationGeneration += 1
        buildDiffGeneration += 1
        validationPhase = .idle
        lastValidationRun = nil
        validationFindings = []
        validationError = nil
        isValidating = false
        suppressingFindingIDs = []
        buildDiffPhase = .idle
        lastBuildDiff = nil
        buildDiffError = nil
        isComparingBuilds = false
    }

    func validateSelectedSnapshot(categories: [String]? = nil) async {
        guard let snapshotID = selectedSnapshotID else {
            validationError = "Select a Snapshot before running Snapshot validation."
            validationPhase = .failure(validationError ?? "Snapshot validation is unavailable.")
            return
        }
        await runValidation {
            try await client.validateSnapshot(
                ValidateSnapshotDraft(snapshotID: snapshotID, categories: categories)
            )
        }
    }

    func validateSelectedScreenGraph() async {
        guard let scope = selectedScope else {
            validationError = "Choose an Application + Version scope before validating the Screen Graph."
            validationPhase = .failure(validationError ?? "Screen Graph validation is unavailable.")
            return
        }
        await runValidation {
            try await client.validateScreenGraph(
                ValidateScreenGraphDraft(
                    projectID: scope.projectID,
                    applicationID: scope.applicationID
                )
            )
        }
    }

    func suppressValidationFinding(
        id: String,
        reasonCode: String,
        justification: String
    ) async -> Bool {
        guard !suppressingFindingIDs.contains(id),
              let finding = validationFindings.first(where: { $0.id == id })
        else { return false }
        let generation = validationGeneration
        let normalized = justification.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= 2_048 else {
            validationError = "A suppression needs a justification of 1 through 2048 characters."
            return false
        }
        suppressingFindingIDs.insert(id)
        validationError = nil
        defer {
            if generation == validationGeneration { suppressingFindingIDs.remove(id) }
        }
        do {
            let updated = try await client.suppressValidationFinding(
                id: id,
                SuppressValidationFindingDraft(
                    expectedFindingRevision: finding.revision,
                    reasonCode: reasonCode,
                    justification: normalized
                )
            )
            guard generation == validationGeneration else { return false }
            if let index = validationFindings.firstIndex(where: { $0.id == id }) {
                validationFindings[index] = updated
            }
            if let run = lastValidationRun {
                let refreshedRun = try await client.getValidationRun(id: run.id)
                guard generation == validationGeneration else { return false }
                lastValidationRun = refreshedRun
            }
            validationPhase = .content
            return true
        } catch let error as HostClientError {
            guard generation == validationGeneration else { return false }
            if case let .server(statusCode, _, code, _, _) = error,
               statusCode == 409 || code == "conflict" {
                await reloadValidationFindings(generation: generation)
                guard generation == validationGeneration else { return false }
                validationError =
                    "The Finding changed elsewhere. Studio reloaded the current validation result."
            } else {
                validationError = Self.message(for: error)
            }
            return false
        } catch {
            guard generation == validationGeneration else { return false }
            validationError = Self.message(for: error)
            return false
        }
    }

    func compareBuilds(leftBuildID: String, rightBuildID: String) async {
        guard !isComparingBuilds else { return }
        guard let scope = selectedScope,
              leftBuildID != rightBuildID,
              qualityBuildScopes.contains(where: { $0.buildID == leftBuildID }),
              qualityBuildScopes.contains(where: { $0.buildID == rightBuildID })
        else {
            buildDiffError = "Choose two different observed builds from the selected application."
            buildDiffPhase = .failure(buildDiffError ?? "Build Diff is unavailable.")
            return
        }
        buildDiffGeneration += 1
        let generation = buildDiffGeneration
        isComparingBuilds = true
        buildDiffError = nil
        buildDiffPhase = .loading
        defer {
            if generation == buildDiffGeneration { isComparingBuilds = false }
        }
        do {
            let diff = try await client.compareBuilds(
                BuildDiffCommandDraft(
                    projectID: scope.projectID,
                    applicationID: scope.applicationID,
                    leftBuildID: leftBuildID,
                    rightBuildID: rightBuildID
                )
            )
            guard generation == buildDiffGeneration else { return }
            lastBuildDiff = diff
            buildDiffPhase = diff.entries.isEmpty ? .empty : .content
        } catch {
            guard generation == buildDiffGeneration else { return }
            lastBuildDiff = nil
            buildDiffError = Self.message(for: error)
            buildDiffPhase = .failure(buildDiffError ?? "Build Diff failed.")
        }
    }

    private func runValidation(
        operation: () async throws -> ValidationOutcomeSummary
    ) async {
        guard !isValidating else { return }
        validationGeneration += 1
        let generation = validationGeneration
        isValidating = true
        validationError = nil
        validationPhase = .loading
        defer {
            if generation == validationGeneration { isValidating = false }
        }
        do {
            let outcome = try await operation()
            guard generation == validationGeneration else { return }
            lastValidationRun = outcome.run
            validationFindings = outcome.findings
            validationPhase = outcome.findings.isEmpty ? .empty : .content
        } catch {
            guard generation == validationGeneration else { return }
            lastValidationRun = nil
            validationFindings = []
            validationError = Self.message(for: error)
            validationPhase = .failure(validationError ?? "Validation failed.")
        }
    }

    private func reloadValidationFindings(generation: Int) async {
        guard let run = lastValidationRun else { return }
        do {
            async let refreshedRun = client.getValidationRun(id: run.id)
            async let refreshedFindings = client.listValidationFindings(runID: run.id)
            let (run, page) = try await (refreshedRun, refreshedFindings)
            guard generation == validationGeneration else { return }
            lastValidationRun = run
            validationFindings = page.items
            validationPhase = validationFindings.isEmpty ? .empty : .content
        } catch {
            guard generation == validationGeneration else { return }
            validationError = Self.message(for: error)
        }
    }
}
