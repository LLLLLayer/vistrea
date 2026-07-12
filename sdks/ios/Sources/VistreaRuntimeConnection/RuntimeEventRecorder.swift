import Foundation
import VistreaRuntimeModels

/// The recorder epoch as negotiated with the Host during one handshake.
public struct RuntimeEventEpochState: Equatable, Sendable {
    public let eventEpochID: String
    public let oldestRetainedSequence: UInt64
    public let nextSequence: UInt64

    public init(eventEpochID: String, oldestRetainedSequence: UInt64, nextSequence: UInt64) {
        self.eventEpochID = eventEpochID
        self.oldestRetainedSequence = oldestRetainedSequence
        self.nextSequence = nextSequence
    }
}

/// What an observing caller reports; identity and ordering stay recorder-owned.
public struct RuntimeEventDraft: Sendable {
    public let kind: RuntimeEventKind
    public let nodeID: NodeID?
    public let stableID: StableID?
    public let snapshotID: SnapshotID?
    public let durationMilliseconds: Double?
    public let payload: [String: JSONValue]?

    public init(
        kind: RuntimeEventKind,
        nodeID: NodeID? = nil,
        stableID: StableID? = nil,
        snapshotID: SnapshotID? = nil,
        durationMilliseconds: Double? = nil,
        payload: [String: JSONValue]? = nil
    ) {
        self.kind = kind
        self.nodeID = nodeID
        self.stableID = stableID
        self.snapshotID = snapshotID
        self.durationMilliseconds = durationMilliseconds
        self.payload = payload
    }
}

/// Bounded in-process event retention for one application epoch.
///
/// The recorder owns the epoch identifier, monotonic sequences, and canonical
/// event construction. Overflowed or acknowledged events are released; a
/// subscription range that touches released sequences reports them explicitly
/// as dropped instead of silently skipping them.
public actor RuntimeEventRecorder {
    public static let defaultMaximumRetainedEvents = 512

    private let epochID: EventEpochID
    private let maximumRetainedEvents: Int
    private var nextSequenceValue: UInt64 = 1
    private var firstAvailableSequence: UInt64 = 1
    private var retained: [RuntimeEvent] = []
    private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    public init(maximumRetainedEvents: Int = RuntimeEventRecorder.defaultMaximumRetainedEvents) throws {
        guard (1...100_000).contains(maximumRetainedEvents) else {
            throw RuntimeConnectionError.invalidConfiguration
        }
        epochID = try EventEpochID(
            validating: RuntimeIdentifierFactory.make(prefix: "epoch")
        )
        self.maximumRetainedEvents = maximumRetainedEvents
    }

    public var epoch: RuntimeEventEpochState {
        RuntimeEventEpochState(
            eventEpochID: epochID.rawValue,
            oldestRetainedSequence: firstAvailableSequence,
            nextSequence: nextSequenceValue
        )
    }

    @discardableResult
    public func record(_ draft: RuntimeEventDraft, at date: Date = Date()) throws -> RuntimeEvent {
        let event = try RuntimeEvent(
            eventID: EventID(validating: RuntimeIdentifierFactory.make(prefix: "event")),
            protocolVersion: ProtocolVersion(minor: 0),
            eventEpochID: epochID,
            sequence: JSONSafeUInt(validating: nextSequenceValue),
            time: EventTime(wallTime: Timestamp(validating: Self.canonicalTimestamp(date))),
            kind: draft.kind,
            nodeID: draft.nodeID,
            stableID: draft.stableID,
            snapshotID: draft.snapshotID,
            durationMilliseconds: draft.durationMilliseconds,
            payload: draft.payload
        )
        nextSequenceValue += 1
        retained.append(event)
        if retained.count > maximumRetainedEvents {
            retained.removeFirst(retained.count - maximumRetainedEvents)
        }
        firstAvailableSequence = retained.first?.sequence.rawValue ?? nextSequenceValue
        for waiter in waiters.values {
            waiter.resume(returning: false)
        }
        waiters.removeAll()
        return event
    }

    /// Releases retained events the Host acknowledged as durable.
    public func releaseThrough(sequence: UInt64) {
        retained.removeAll { $0.sequence.rawValue <= sequence }
        firstAvailableSequence = max(
            firstAvailableSequence,
            min(sequence + 1, nextSequenceValue)
        )
    }

    /// Suspends until at least one event after `sequence` exists or the task is cancelled.
    public func waitForEvents(after sequence: UInt64) async {
        while nextSequenceValue <= sequence + 1 {
            let waiterID = UUID()
            let cancelled = await withTaskCancellationHandler {
                await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                    if Task.isCancelled {
                        continuation.resume(returning: true)
                        return
                    }
                    waiters[waiterID] = continuation
                }
            } onCancel: {
                Task { await self.cancelWaiter(waiterID) }
            }
            if cancelled {
                return
            }
        }
    }

    private func cancelWaiter(_ waiterID: UUID) {
        waiters.removeValue(forKey: waiterID)?.resume(returning: true)
    }

    /// The next contiguous batch after `cursor`, or nil when fully drained.
    ///
    /// Filtered kinds stay inside the advanced range as gaps; sequences that
    /// were already released count as dropped evidence.
    public func batchAfter(
        cursor: UInt64,
        kinds: Set<RuntimeEventKind>,
        limit: Int
    ) throws -> RuntimeEventBatch? {
        guard cursor + 1 < nextSequenceValue else {
            return nil
        }
        let firstSequence = cursor + 1
        var dropped: UInt64 = 0
        if firstSequence < firstAvailableSequence {
            dropped = firstAvailableSequence - firstSequence
        }
        var events: [RuntimeEvent] = []
        var lastSequence = max(firstSequence, firstAvailableSequence) - 1
        for event in retained where event.sequence.rawValue > cursor {
            if events.count == limit {
                break
            }
            lastSequence = event.sequence.rawValue
            if kinds.contains(event.kind) {
                events.append(event)
            }
        }
        if events.count < limit {
            // Every remaining retained sequence was examined; the cursor may
            // advance to the newest recorded event even when all were filtered.
            lastSequence = nextSequenceValue - 1
        }
        guard lastSequence >= firstSequence else {
            return nil
        }
        return try RuntimeEventBatch(
            protocolVersion: ProtocolVersion(minor: 0),
            eventEpochID: epochID,
            firstSequence: JSONSafeUInt(validating: firstSequence),
            lastSequence: JSONSafeUInt(validating: lastSequence),
            events: events,
            droppedEventCount: JSONSafeUInt(validating: dropped)
        )
    }

    private static func canonicalTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
