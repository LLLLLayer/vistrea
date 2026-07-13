package dev.vistrea.demo.ui

import android.app.Activity
import android.widget.FrameLayout
import dev.vistrea.demo.contract.ScenarioFixture

internal data class ScenarioRuntimeContext(
    val activity: Activity,
    val container: FrameLayout,
    val fixture: ScenarioFixture,
    val profileId: String,
)

internal object ScenarioContentFactory {
    private val builders: Map<String, (ScenarioRuntimeContext) -> ScenarioController> = mapOf(
        "demo.navigation.basic" to { runtime ->
            with(runtime) { NavigationScenarioController(activity, container, fixture) }
        },
        "demo.form.validation" to { runtime ->
            with(runtime) { single(container) { InteractiveScenarioViews.form(activity, fixture) } }
        },
        "demo.transient.success" to { runtime ->
            with(runtime) {
                single(container) { InteractiveScenarioViews.transientSuccess(activity, fixture) }
            }
        },
        "demo.loading.outcomes" to { runtime -> LoadingScenarioController(runtime) },
        "demo.modal.dialog" to { runtime ->
            with(runtime) { single(container) { InteractiveScenarioViews.modal(activity, fixture) } }
        },
        "demo.layout.occlusion" to { runtime ->
            with(runtime) { single(container) { StaticScenarioViews.layoutOcclusion(activity, fixture) } }
        },
        "demo.accessibility.defects" to { runtime ->
            with(runtime) {
                single(container) { StaticScenarioViews.accessibility(activity, fixture, profileId) }
            }
        },
        "demo.design.tuning" to { runtime ->
            with(runtime) {
                single(container) { StaticScenarioViews.designTuning(activity, fixture, profileId) }
            }
        },
        "demo.dynamic.normalization" to { runtime ->
            with(runtime) {
                single(container) { StaticScenarioViews.dynamicContent(activity, fixture, profileId) }
            }
        },
        "demo.safety.dangerous" to { runtime ->
            with(runtime) { single(container) { StaticScenarioViews.safety(activity, fixture) } }
        },
        "demo.version.new-feature" to { runtime ->
            with(runtime) {
                single(container) { VersionScenarioViews.newFeature(activity, fixture, profileId) }
            }
        },
        "demo.version.regression" to { runtime ->
            with(runtime) {
                single(container) { VersionScenarioViews.regression(activity, fixture, profileId) }
            }
        },
        "demo.store.navigation" to { runtime ->
            with(runtime) { StoreNavigationScenarioController(activity, container, fixture) }
        },
        "demo.store.search" to { runtime ->
            with(runtime) { single(container) { StoreScenarioViews.search(activity, fixture) } }
        },
        "demo.store.sheet" to { runtime ->
            with(runtime) { single(container) { StoreScenarioViews.sheet(activity, fixture) } }
        },
        "demo.store.cart-states" to { runtime -> CartStatesScenarioController(runtime) },
        "demo.mixed.declarative" to { runtime ->
            with(runtime) {
                single(container) { MixedDeclarativeScenarioViews.declarative(activity, fixture) }
            }
        },
    )

    fun create(runtime: ScenarioRuntimeContext): ScenarioController {
        require(runtime.profileId in runtime.fixture.profiles) {
            "Profile ${runtime.profileId} is not supported by ${runtime.fixture.scenario_id}."
        }
        val builder = requireNotNull(builders[runtime.fixture.scenario_id]) {
            "Scenario ${runtime.fixture.scenario_id} has no Android UI implementation."
        }
        return builder(runtime)
    }

    fun supportedScenarioIds(): Set<String> = builders.keys.toSet()

    private fun single(
        container: FrameLayout,
        content: () -> android.view.View,
    ): ScenarioController = SingleViewScenarioController(container, content)
}
