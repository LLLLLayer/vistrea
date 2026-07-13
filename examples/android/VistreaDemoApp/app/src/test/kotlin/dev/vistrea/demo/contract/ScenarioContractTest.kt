package dev.vistrea.demo.contract

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import dev.vistrea.demo.ui.ScenarioContentFactory

class ScenarioContractTest {
    private val generatedRoot = File(requireNotNull(System.getProperty("vistrea.scenario.assets")))
    private val sourceRoot = File(requireNotNull(System.getProperty("vistrea.scenario.source")))
    private val suite = ScenarioContractRepository(fileSource(generatedRoot)).load()

    @Test
    fun allSeventeenRequiredScenarioIdsDecodeFromCopiedFixtures() {
        assertEquals(REQUIRED_SCENARIO_IDS, suite.fixturesById.keys)
        assertEquals(REQUIRED_SCENARIO_IDS, suite.manifest.scenarios.mapTo(linkedSetOf()) { it.scenario_id })
        assertTrue(suite.manifest.scenarios.all { it.required })
        assertTrue(suite.fixturesById.values.all { it.required })
        assertTrue(suite.fixturesById.values.none { it.reset.external_services })
        assertEquals(REQUIRED_SCENARIO_IDS, ScenarioContentFactory.supportedScenarioIds())
    }

    @Test
    fun generatedAssetsAreByteForByteCopiesOfTheSharedContract() {
        assertEquals(
            File(sourceRoot, "manifest.json").readBytes().toList(),
            File(generatedRoot, "scenarios/manifest.json").readBytes().toList(),
        )
        suite.manifest.scenarios.forEach { entry ->
            assertEquals(
                File(sourceRoot, entry.file).readBytes().toList(),
                File(generatedRoot, "scenarios/${entry.file}").readBytes().toList(),
            )
        }
    }

    @Test
    fun everySharedStableNodeMapsToContentDescriptionAndTag() {
        suite.fixturesById.values.forEach { fixture ->
            assertTrue(fixture.stable_nodes.isNotEmpty())
            fixture.stable_nodes.forEach { node ->
                val identity = StableNodeIdentity.from(node.node_id)
                assertEquals(node.node_id, identity.contentDescription)
                assertEquals(node.node_id, identity.tag)
            }
        }
    }

    @Test
    fun basicNavigationFixtureDefinesRealForwardAndBackPath() {
        val fixture = suite.fixture("demo.navigation.basic")
        assertEquals("demo.state.home", fixture.reset.entry_state_id)
        assertEquals(
            listOf(
                "demo.state.home" to "demo.state.home",
                "demo.state.home" to "demo.state.catalog",
                "demo.state.catalog" to "demo.state.detail",
                "demo.state.detail" to "demo.state.catalog",
                "demo.state.catalog" to "demo.state.home",
            ),
            fixture.steps.map { it.from_state_id to it.to_state_id },
        )
        assertEquals(listOf("launch", "tap", "tap", "back", "back"), fixture.steps.map { it.action.kind })
    }

    @Test
    fun storefrontNavigationFixtureDefinesTabStackAndScrollPaths() {
        val fixture = suite.fixture("demo.store.navigation")
        assertEquals("demo.state.store-shop", fixture.reset.entry_state_id)
        assertEquals(
            listOf(
                "demo.state.store-shop" to "demo.state.store-shop",
                "demo.state.store-shop" to "demo.state.store-detail",
                "demo.state.store-detail" to "demo.state.store-reviews",
                "demo.state.store-reviews" to "demo.state.store-detail",
                "demo.state.store-detail" to "demo.state.store-shop",
                "demo.state.store-shop" to "demo.state.store-shop",
                "demo.state.store-shop" to "demo.state.store-profile",
                "demo.state.store-profile" to "demo.state.store-shop",
            ),
            fixture.steps.map { it.from_state_id to it.to_state_id },
        )
        assertEquals(
            listOf("launch", "tap", "tap", "back", "back", "swipe", "tap", "tap"),
            fixture.steps.map { it.action.kind },
        )
    }

    @Test
    fun searchFixtureTypedAndClearedQueriesReturnToTheEntryState() {
        val fixture = suite.fixture("demo.store.search")
        assertEquals("demo.state.search", fixture.reset.entry_state_id)
        assertEquals(
            listOf("launch", "type_text", "clear_text", "type_text", "clear_text"),
            fixture.steps.map { it.action.kind },
        )
        assertEquals(
            setOf("QUERY_MATCHING", "QUERY_UNMATCHED"),
            fixture.steps.mapNotNull { it.action.input_alias }.toSet(),
        )
        fixture.steps.filter { it.action.kind == "clear_text" }.forEach { step ->
            assertEquals("demo.state.search", step.to_state_id)
        }
    }

    @Test
    fun launchArgumentsAcceptCanonicalAndEnvironmentStyleExtras() {
        val canonical = LaunchArguments.resolve(
            mapOf(
                LaunchArguments.SCENARIO_ID to "demo.navigation.basic",
                LaunchArguments.PROFILE_ID to "baseline",
            )::get,
        )
        assertEquals("demo.navigation.basic", canonical.scenarioId)
        assertEquals("baseline", canonical.profileId)

        val fallback = LaunchArguments.resolve(
            mapOf(
                LaunchArguments.ENV_SCENARIO_ID to "demo.version.new-feature",
                LaunchArguments.ENV_PROFILE_ID to "new-feature",
            )::get,
        )
        assertEquals("demo.version.new-feature", fallback.scenarioId)
        assertEquals("new-feature", fallback.profileId)
        assertFalse(fallback.scenarioId.isNullOrBlank())
        assertNotNull(suite.fixturesById[fallback.scenarioId])
    }

    private fun fileSource(root: File): ScenarioAssetSource = ScenarioAssetSource { relativePath ->
        File(root, relativePath).readText(Charsets.UTF_8)
    }

    private companion object {
        val REQUIRED_SCENARIO_IDS = linkedSetOf(
            "demo.navigation.basic",
            "demo.form.validation",
            "demo.transient.success",
            "demo.loading.outcomes",
            "demo.modal.dialog",
            "demo.layout.occlusion",
            "demo.accessibility.defects",
            "demo.design.tuning",
            "demo.dynamic.normalization",
            "demo.safety.dangerous",
            "demo.version.new-feature",
            "demo.version.regression",
            "demo.store.navigation",
            "demo.store.search",
            "demo.store.sheet",
            "demo.store.cart-states",
            "demo.mixed.declarative",
        )
    }
}
