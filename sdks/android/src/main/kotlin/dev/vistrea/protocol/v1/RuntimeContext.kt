package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private val ADAPTER_NAME_PATTERN = Regex("^[a-z][a-z0-9._-]*$")
private val SOURCE_SHA_PATTERN = Regex("^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
private const val MAX_TEXT_SCALE = 10.0

@Serializable
enum class Platform {
    @SerialName("ios")
    IOS,

    @SerialName("android")
    ANDROID,
}

@Serializable
enum class DeviceKind {
    @SerialName("simulator")
    SIMULATOR,

    @SerialName("emulator")
    EMULATOR,

    @SerialName("real_device")
    REAL_DEVICE,
}

@Serializable
enum class Theme {
    @SerialName("light")
    LIGHT,

    @SerialName("dark")
    DARK,

    @SerialName("system")
    SYSTEM,

    @SerialName("custom")
    CUSTOM,
}

@Serializable
data class DeviceDescriptor(
    @SerialName("device_id")
    val deviceId: DeviceId? = null,
    val kind: DeviceKind,
    val model: String,
    @SerialName("os_version")
    val osVersion: String,
    val extensions: Extensions,
)

@Serializable
data class RuntimeContext(
    @SerialName("project_id")
    val projectId: ProjectId,
    @SerialName("application_id")
    val applicationId: String,
    @SerialName("build_id")
    val buildId: BuildId,
    @SerialName("application_version")
    val applicationVersion: String,
    @SerialName("source_git_sha")
    val sourceGitSha: String? = null,
    val platform: Platform,
    val device: DeviceDescriptor,
    @SerialName("environment_id")
    val environmentId: String,
    @SerialName("account_profile_id")
    val accountProfileId: String? = null,
    @SerialName("feature_context_refs")
    val featureContextRefs: List<String>? = null,
    val locale: String,
    val theme: Theme,
    @SerialName("text_scale")
    val textScale: Double,
    @SerialName("sdk_version")
    val sdkVersion: String,
    @SerialName("adapter_versions")
    val adapterVersions: Map<String, String>,
    val extensions: Extensions,
) {
    init {
        require(sourceGitSha == null || SOURCE_SHA_PATTERN.matches(sourceGitSha)) {
            "Invalid source Git SHA"
        }
        require(textScale.isFinite() && textScale > 0 && textScale <= MAX_TEXT_SCALE) {
            "Text scale must be finite and in the protocol range"
        }
        require(adapterVersions.isNotEmpty()) { "At least one adapter version is required" }
        require(adapterVersions.keys.all(ADAPTER_NAME_PATTERN::matches)) {
            "Invalid adapter version key"
        }
        require(featureContextRefs == null || featureContextRefs.distinct().size == featureContextRefs.size) {
            "Feature context references must be unique"
        }
    }
}
