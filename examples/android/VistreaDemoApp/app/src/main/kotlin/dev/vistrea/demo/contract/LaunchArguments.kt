package dev.vistrea.demo.contract

data class LaunchSelection(
    val scenarioId: String?,
    val profileId: String?,
)

object LaunchArguments {
    const val SCENARIO_ID = "vistrea.scenario_id"
    const val PROFILE_ID = "vistrea.profile_id"
    const val ENV_SCENARIO_ID = "VISTREA_SCENARIO_ID"
    const val ENV_PROFILE_ID = "VISTREA_PROFILE_ID"

    fun resolve(readValue: (String) -> String?): LaunchSelection = LaunchSelection(
        scenarioId = firstValue(readValue, SCENARIO_ID, ENV_SCENARIO_ID),
        profileId = firstValue(readValue, PROFILE_ID, ENV_PROFILE_ID),
    )

    private fun firstValue(
        readValue: (String) -> String?,
        primary: String,
        fallback: String,
    ): String? = readValue(primary)?.takeIf(String::isNotBlank)
        ?: readValue(fallback)?.takeIf(String::isNotBlank)
}
