package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
@JvmInline
value class EventId(val value: String) {
    init {
        require(
            Regex(
                "^event_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            ).matches(value),
        ) {
            "Expected an event UUIDv7 identifier"
        }
    }
}

@Serializable
enum class RuntimeEventKind {
    @SerialName("node_appeared")
    NODE_APPEARED,

    @SerialName("node_disappeared")
    NODE_DISAPPEARED,

    @SerialName("layout_changed")
    LAYOUT_CHANGED,

    @SerialName("state_changed")
    STATE_CHANGED,

    @SerialName("transient_presented")
    TRANSIENT_PRESENTED,

    @SerialName("transient_dismissed")
    TRANSIENT_DISMISSED,

    @SerialName("screen_changed")
    SCREEN_CHANGED,
}

/** One canonical transient or structural runtime UI event. */
@Serializable
data class RuntimeEvent(
    @SerialName("event_id")
    val eventId: EventId,
    @SerialName("protocol_version")
    val protocolVersion: ProtocolVersion,
    @SerialName("event_epoch_id")
    val eventEpochId: EventEpochId,
    val sequence: JsonSafeUInt,
    val time: EventTime,
    val kind: RuntimeEventKind,
    @SerialName("node_id")
    val nodeId: NodeId? = null,
    @SerialName("stable_id")
    val stableId: StableId? = null,
    @SerialName("snapshot_id")
    val snapshotId: SnapshotId? = null,
    @SerialName("duration_ms")
    val durationMs: Double? = null,
    val payload: JsonObject? = null,
    val extensions: Extensions = Extensions.empty(),
) {
    init {
        if (durationMs != null) {
            require(durationMs >= 0 && durationMs.isFinite()) {
                "Event durations must be finite and non-negative"
            }
        }
    }
}

/** One contiguous, strictly ordered cursor range of retained runtime events. */
@Serializable
data class RuntimeEventBatch(
    @SerialName("protocol_version")
    val protocolVersion: ProtocolVersion,
    @SerialName("event_epoch_id")
    val eventEpochId: EventEpochId,
    @SerialName("first_sequence")
    val firstSequence: JsonSafeUInt,
    @SerialName("last_sequence")
    val lastSequence: JsonSafeUInt,
    val events: List<RuntimeEvent>,
    @SerialName("dropped_event_count")
    val droppedEventCount: JsonSafeUInt,
    val extensions: Extensions = Extensions.empty(),
) {
    init {
        require(firstSequence.value <= lastSequence.value) {
            "Event batch sequence range is reversed"
        }
        var previous: Long? = null
        for (event in events) {
            require(event.eventEpochId == eventEpochId) {
                "Event batch epochs must be uniform"
            }
            val sequence = event.sequence.value
            require(sequence in firstSequence.value..lastSequence.value) {
                "Event sequences must stay inside the batch range"
            }
            val previousSequence = previous
            require(previousSequence == null || sequence > previousSequence) {
                "Event sequences must strictly increase"
            }
            previous = sequence
        }
    }
}
