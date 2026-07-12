package dev.vistrea.demo.contract

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

@Serializable
data class ScenarioManifest(
    val schema_version: Int,
    val suite_id: String,
    val protocol_version: JsonObject,
    val required_platforms: List<String>,
    val platforms: JsonObject,
    val profiles: List<LaunchProfile>,
    val scenarios: List<ScenarioManifestEntry>,
    val vertical_loops: JsonArray,
    val extensions: JsonObject,
)

@Serializable
data class LaunchProfile(
    val profile_id: String,
    val base_profile: String? = null,
    val description: String,
    val determinism: JsonObject,
)

@Serializable
data class ScenarioManifestEntry(
    val scenario_id: String,
    val file: String,
    val required: Boolean,
    val coverage: List<String>,
)

@Serializable
data class ScenarioFixture(
    val schema_version: Int,
    val scenario_id: String,
    val title: String,
    val purpose: String,
    val required: Boolean,
    val coverage: List<String>,
    val platform_support: JsonObject,
    val profiles: List<String>,
    val reset: ScenarioReset,
    val stable_nodes: List<StableNode>,
    val states: List<ScenarioState>,
    val steps: List<ScenarioStep>,
    val expected_artifacts: JsonArray,
    val expectations: JsonObject,
    val extensions: JsonObject,
)

@Serializable
data class ScenarioReset(
    val entry_state_id: String,
    val seed: Int,
    val external_services: Boolean,
)

@Serializable
data class StableNode(
    val node_id: String,
    val role: String,
)

@Serializable
data class ScenarioState(
    val state_id: String,
    val kind: String,
    val required_node_ids: List<String>,
    val dynamic_fields: JsonArray,
)

@Serializable
data class ScenarioStep(
    val step_id: String,
    val action: ScenarioAction,
    val from_state_id: String,
    val to_state_id: String,
    val profiles: List<String> = emptyList(),
)

@Serializable
data class ScenarioAction(
    val kind: String,
    val target_node_id: String? = null,
    val input_alias: String? = null,
    val duration_ms: Int? = null,
)

data class ScenarioSuite(
    val manifest: ScenarioManifest,
    val fixturesById: Map<String, ScenarioFixture>,
) {
    fun fixture(scenarioId: String): ScenarioFixture =
        requireNotNull(fixturesById[scenarioId]) { "Unknown Scenario ID: $scenarioId" }
}

data class StableNodeIdentity(
    val contentDescription: String,
    val tag: String,
) {
    companion object {
        fun from(nodeId: String): StableNodeIdentity {
            require(nodeId.startsWith("demo.")) { "Shared stable node IDs must use demo.*." }
            return StableNodeIdentity(contentDescription = nodeId, tag = nodeId)
        }
    }
}
