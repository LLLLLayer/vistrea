package dev.vistrea.demo.contract

import android.content.res.AssetManager
import kotlinx.serialization.json.Json

fun interface ScenarioAssetSource {
    fun read(path: String): String
}

class AndroidScenarioAssetSource(
    private val assets: AssetManager,
) : ScenarioAssetSource {
    override fun read(path: String): String =
        assets.open(path).bufferedReader(Charsets.UTF_8).use { it.readText() }
}

class ScenarioContractRepository(
    private val source: ScenarioAssetSource,
) {
    private val json = Json {
        ignoreUnknownKeys = false
        explicitNulls = false
    }

    fun load(): ScenarioSuite {
        val manifest = json.decodeFromString<ScenarioManifest>(source.read(MANIFEST_PATH))
        val fixtures = manifest.scenarios.associate { entry ->
            validateRelativeFixturePath(entry.file)
            val fixture = json.decodeFromString<ScenarioFixture>(
                source.read("$SCENARIO_ASSET_ROOT/${entry.file}"),
            )
            validateFixture(manifest, entry, fixture)
            entry.scenario_id to fixture
        }
        require(fixtures.size == manifest.scenarios.size) { "Scenario IDs must be unique." }
        return ScenarioSuite(manifest = manifest, fixturesById = fixtures)
    }

    private fun validateFixture(
        manifest: ScenarioManifest,
        entry: ScenarioManifestEntry,
        fixture: ScenarioFixture,
    ) {
        require(entry.required && fixture.required) { "Demo fixtures must remain required." }
        require(entry.scenario_id == fixture.scenario_id) { "Manifest and fixture IDs differ." }
        require(entry.coverage == fixture.coverage) { "Manifest and fixture coverage differ." }
        require(!fixture.reset.external_services) { "Demo fixtures must remain fully local." }

        val knownProfiles = manifest.profiles.mapTo(mutableSetOf()) { it.profile_id }
        require(fixture.profiles.isNotEmpty() && fixture.profiles.all(knownProfiles::contains)) {
            "Fixture references an unknown launch profile."
        }
        val stableNodeIds = fixture.stable_nodes.map { it.node_id }
        require(stableNodeIds.size == stableNodeIds.toSet().size) {
            "Fixture stable node IDs must be unique."
        }
        stableNodeIds.forEach(StableNodeIdentity::from)

        val stateIds = fixture.states.mapTo(mutableSetOf()) { it.state_id }
        require(fixture.reset.entry_state_id in stateIds) { "Reset state is missing." }
        fixture.states.forEach { state ->
            require(state.required_node_ids.all(stableNodeIds::contains)) {
                "State ${state.state_id} references an unknown stable node."
            }
        }
        fixture.steps.forEach { step ->
            require(step.from_state_id in stateIds && step.to_state_id in stateIds) {
                "Step ${step.step_id} references an unknown state."
            }
            require(step.profiles.all(fixture.profiles::contains)) {
                "Step ${step.step_id} references an unsupported profile."
            }
            require(
                step.action.target_node_id == null || step.action.target_node_id in stableNodeIds,
            ) { "Step ${step.step_id} references an unknown target node." }
        }
    }

    private fun validateRelativeFixturePath(relativePath: String) {
        val segments = relativePath.split('/')
        require(relativePath.isNotBlank() && !relativePath.startsWith('/')) {
            "Fixture paths must be relative."
        }
        require(segments.none { it.isBlank() || it == "." || it == ".." }) {
            "Fixture paths must stay inside scenario assets."
        }
    }

    private companion object {
        const val SCENARIO_ASSET_ROOT = "scenarios"
        const val MANIFEST_PATH = "$SCENARIO_ASSET_ROOT/manifest.json"
    }
}
