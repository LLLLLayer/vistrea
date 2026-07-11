package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class SystemChrome {
    @SerialName("included")
    INCLUDED,

    @SerialName("excluded")
    EXCLUDED,

    @SerialName("partial")
    PARTIAL,

    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
data class ScreenshotEvidence(
    @SerialName("object")
    val objectRef: ObjectRef,
    @SerialName("capture_started_at")
    val captureStartedAt: EventTime,
    @SerialName("capture_finished_at")
    val captureFinishedAt: EventTime,
    @SerialName("tree_skew_ms")
    val treeSkewMs: Double,
    val coverage: NonEmptyRect,
    @SerialName("pixel_size")
    val pixelSize: PixelSize,
    @SerialName("system_chrome")
    val systemChrome: SystemChrome,
    @SerialName("color_space")
    val colorSpace: ColorSpace? = null,
    val extensions: Extensions,
) {
    init {
        require(treeSkewMs.isFinite() && treeSkewMs >= 0) {
            "Screenshot tree skew must be finite and non-negative"
        }
    }
}

@Serializable
data class EventWindow(
    @SerialName("event_epoch_id")
    val eventEpochId: EventEpochId,
    @SerialName("first_sequence")
    val firstSequence: JsonSafeUInt? = null,
    @SerialName("last_sequence")
    val lastSequence: JsonSafeUInt? = null,
    @SerialName("dropped_event_count")
    val droppedEventCount: JsonSafeUInt? = null,
) {
    init {
        require(firstSequence == null || lastSequence == null || firstSequence.value <= lastSequence.value) {
            "Event window sequence range is reversed"
        }
    }
}

@Serializable
data class RuntimeSnapshot(
    @SerialName("snapshot_id")
    val snapshotId: SnapshotId,
    @SerialName("protocol_version")
    val protocolVersion: ProtocolVersion,
    @SerialName("captured_at")
    val capturedAt: EventTime,
    @SerialName("runtime_context")
    val runtimeContext: RuntimeContext,
    val display: DisplayGeometry,
    val trees: List<UiTree>,
    @SerialName("screenshot")
    val screenshot: ScreenshotEvidence? = null,
    @SerialName("event_window")
    val eventWindow: EventWindow? = null,
    val capabilities: CapabilitySet,
    @SerialName("capture_limitations")
    val captureLimitations: List<CaptureLimitation>,
    val extensions: Extensions,
) {
    init {
        require(trees.isNotEmpty()) { "A RuntimeSnapshot requires at least one UI tree" }
        require(trees.map(UiTree::treeId).distinct().size == trees.size) {
            "Tree IDs must be unique within a RuntimeSnapshot"
        }
    }
}
