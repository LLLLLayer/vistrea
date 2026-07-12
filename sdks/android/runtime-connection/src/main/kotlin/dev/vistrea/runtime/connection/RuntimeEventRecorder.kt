package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.EventEpochId
import dev.vistrea.protocol.v1.EventId
import dev.vistrea.protocol.v1.EventTime
import dev.vistrea.protocol.v1.JsonSafeUInt
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.ProtocolVersion
import dev.vistrea.protocol.v1.RuntimeEvent
import dev.vistrea.protocol.v1.RuntimeEventBatch
import dev.vistrea.protocol.v1.RuntimeEventKind
import dev.vistrea.protocol.v1.RuntimeIdentifierFactory
import dev.vistrea.protocol.v1.SnapshotId
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.protocol.v1.Timestamp
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

private const val DEFAULT_MAXIMUM_RETAINED_EVENTS = 512
private const val MAXIMUM_CONFIGURABLE_RETAINED_EVENTS = 100_000
private val CANONICAL_TIMESTAMP =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** The recorder epoch as negotiated with the Host during one handshake. */
data class RuntimeEventEpochState(
    val eventEpochId: String,
    val oldestRetainedSequence: Long,
    val nextSequence: Long,
)

/** What an observing caller reports; identity and ordering stay recorder-owned. */
data class RuntimeEventDraft(
    val kind: RuntimeEventKind,
    val nodeId: NodeId? = null,
    val stableId: StableId? = null,
    val snapshotId: SnapshotId? = null,
    val durationMs: Double? = null,
    val payload: JsonObject? = null,
)

/**
 * Bounded in-process event retention for one application epoch.
 *
 * The recorder owns the epoch identifier, monotonic sequences, and canonical
 * event construction. Overflowed or acknowledged events are released; a
 * subscription range that touches released sequences reports them explicitly
 * as dropped instead of silently skipping them.
 */
class RuntimeEventRecorder(
    private val maximumRetainedEvents: Int = DEFAULT_MAXIMUM_RETAINED_EVENTS,
) {
    init {
        require(maximumRetainedEvents in 1..MAXIMUM_CONFIGURABLE_RETAINED_EVENTS) {
            "maximumRetainedEvents must be between 1 and $MAXIMUM_CONFIGURABLE_RETAINED_EVENTS"
        }
    }

    private val epochId = EventEpochId(RuntimeIdentifierFactory.make("epoch"))
    private val lock = Mutex()
    private var nextSequenceValue = 1L
    private var firstAvailableSequence = 1L
    private val retained = ArrayDeque<RuntimeEvent>()
    private var newEventsSignal = CompletableDeferred<Unit>()

    suspend fun epoch(): RuntimeEventEpochState = lock.withLock {
        RuntimeEventEpochState(
            eventEpochId = epochId.value,
            oldestRetainedSequence = firstAvailableSequence,
            nextSequence = nextSequenceValue,
        )
    }

    suspend fun record(
        draft: RuntimeEventDraft,
        time: Instant = Instant.now(),
    ): RuntimeEvent {
        val signal: CompletableDeferred<Unit>
        val event: RuntimeEvent
        lock.withLock {
            event = RuntimeEvent(
                eventId = EventId(RuntimeIdentifierFactory.make("event")),
                protocolVersion = ProtocolVersion(major = 1, minor = 0),
                eventEpochId = epochId,
                sequence = JsonSafeUInt(nextSequenceValue),
                time = EventTime(wallTime = Timestamp(CANONICAL_TIMESTAMP.format(time))),
                kind = draft.kind,
                nodeId = draft.nodeId,
                stableId = draft.stableId,
                snapshotId = draft.snapshotId,
                durationMs = draft.durationMs,
                payload = draft.payload,
            )
            nextSequenceValue += 1
            retained.addLast(event)
            while (retained.size > maximumRetainedEvents) {
                retained.removeFirst()
            }
            firstAvailableSequence = retained.firstOrNull()?.sequence?.value ?: nextSequenceValue
            signal = newEventsSignal
            newEventsSignal = CompletableDeferred()
        }
        signal.complete(Unit)
        return event
    }

    /** Releases retained events the Host acknowledged as durable. */
    suspend fun releaseThrough(sequence: Long) {
        lock.withLock {
            while (retained.isNotEmpty() && retained.first().sequence.value <= sequence) {
                retained.removeFirst()
            }
            firstAvailableSequence = maxOf(
                firstAvailableSequence,
                minOf(sequence + 1, nextSequenceValue),
            )
        }
    }

    /** Suspends until at least one event after [sequence] exists. */
    suspend fun waitForEvents(after: Long) {
        while (true) {
            val signal = lock.withLock {
                if (nextSequenceValue > after + 1) {
                    return
                }
                newEventsSignal
            }
            signal.await()
        }
    }

    /**
     * The next contiguous batch after [cursor], or null when fully drained.
     *
     * Filtered kinds stay inside the advanced range as gaps; sequences that
     * were already released count as dropped evidence.
     */
    suspend fun batchAfter(
        cursor: Long,
        kinds: Set<RuntimeEventKind>,
        limit: Int,
    ): RuntimeEventBatch? = lock.withLock {
        if (cursor + 1 >= nextSequenceValue) {
            return null
        }
        val firstSequence = cursor + 1
        val dropped = if (firstSequence < firstAvailableSequence) {
            firstAvailableSequence - firstSequence
        } else {
            0L
        }
        val events = mutableListOf<RuntimeEvent>()
        var lastSequence = maxOf(firstSequence, firstAvailableSequence) - 1
        for (event in retained) {
            if (event.sequence.value <= cursor) {
                continue
            }
            if (events.size == limit) {
                break
            }
            lastSequence = event.sequence.value
            if (event.kind in kinds) {
                events.add(event)
            }
        }
        if (events.size < limit) {
            // Every remaining retained sequence was examined; the cursor may
            // advance to the newest recorded event even when all were filtered.
            lastSequence = nextSequenceValue - 1
        }
        if (lastSequence < firstSequence) {
            return null
        }
        RuntimeEventBatch(
            protocolVersion = ProtocolVersion(major = 1, minor = 0),
            eventEpochId = epochId,
            firstSequence = JsonSafeUInt(firstSequence),
            lastSequence = JsonSafeUInt(lastSequence),
            events = events,
            droppedEventCount = JsonSafeUInt(dropped),
        )
    }
}
