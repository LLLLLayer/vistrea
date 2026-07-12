import Foundation

public enum EventIDKind: TypedIDKind { public static let prefix = "event" }
public typealias EventID = TypedID<EventIDKind>

public enum RuntimeEventKind: String, Codable, CaseIterable, Sendable {
    case nodeAppeared = "node_appeared"
    case nodeDisappeared = "node_disappeared"
    case layoutChanged = "layout_changed"
    case stateChanged = "state_changed"
    case transientPresented = "transient_presented"
    case transientDismissed = "transient_dismissed"
    case screenChanged = "screen_changed"
}

/// One canonical transient or structural runtime UI event.
public struct RuntimeEvent: Codable, Equatable, Sendable {
    public let eventID: EventID
    public let protocolVersion: ProtocolVersion
    public let eventEpochID: EventEpochID
    public let sequence: JSONSafeUInt
    public let time: EventTime
    public let kind: RuntimeEventKind
    public let nodeID: NodeID?
    public let stableID: StableID?
    public let snapshotID: SnapshotID?
    public let durationMilliseconds: Double?
    public let payload: [String: JSONValue]?
    public let extensions: Extensions

    public init(
        eventID: EventID,
        protocolVersion: ProtocolVersion,
        eventEpochID: EventEpochID,
        sequence: JSONSafeUInt,
        time: EventTime,
        kind: RuntimeEventKind,
        nodeID: NodeID? = nil,
        stableID: StableID? = nil,
        snapshotID: SnapshotID? = nil,
        durationMilliseconds: Double? = nil,
        payload: [String: JSONValue]? = nil,
        extensions: Extensions = .empty
    ) throws {
        if let durationMilliseconds {
            guard durationMilliseconds >= 0, durationMilliseconds.isFinite else {
                throw ProtocolModelError.invalidValue("Event durations must be finite and non-negative.")
            }
        }
        self.eventID = eventID
        self.protocolVersion = protocolVersion
        self.eventEpochID = eventEpochID
        self.sequence = sequence
        self.time = time
        self.kind = kind
        self.nodeID = nodeID
        self.stableID = stableID
        self.snapshotID = snapshotID
        self.durationMilliseconds = durationMilliseconds
        self.payload = payload
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case eventID = "event_id"
        case protocolVersion = "protocol_version"
        case eventEpochID = "event_epoch_id"
        case sequence
        case time
        case kind
        case nodeID = "node_id"
        case stableID = "stable_id"
        case snapshotID = "snapshot_id"
        case durationMilliseconds = "duration_ms"
        case payload
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let durationMilliseconds = try container.decodeIfPresent(
            Double.self,
            forKey: .durationMilliseconds
        )
        do {
            try self.init(
                eventID: try container.decode(EventID.self, forKey: .eventID),
                protocolVersion: try container.decode(ProtocolVersion.self, forKey: .protocolVersion),
                eventEpochID: try container.decode(EventEpochID.self, forKey: .eventEpochID),
                sequence: try container.decode(JSONSafeUInt.self, forKey: .sequence),
                time: try container.decode(EventTime.self, forKey: .time),
                kind: try container.decode(RuntimeEventKind.self, forKey: .kind),
                nodeID: try container.decodeIfPresent(NodeID.self, forKey: .nodeID),
                stableID: try container.decodeIfPresent(StableID.self, forKey: .stableID),
                snapshotID: try container.decodeIfPresent(SnapshotID.self, forKey: .snapshotID),
                durationMilliseconds: durationMilliseconds,
                payload: try container.decodeIfPresent([String: JSONValue].self, forKey: .payload),
                extensions: try container.decode(Extensions.self, forKey: .extensions)
            )
        } catch let error as ProtocolModelError {
            throw DecodingError.dataCorruptedError(
                forKey: .durationMilliseconds,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(eventID, forKey: .eventID)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(eventEpochID, forKey: .eventEpochID)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(time, forKey: .time)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(nodeID, forKey: .nodeID)
        try container.encodeIfPresent(stableID, forKey: .stableID)
        try container.encodeIfPresent(snapshotID, forKey: .snapshotID)
        try container.encodeIfPresent(durationMilliseconds, forKey: .durationMilliseconds)
        try container.encodeIfPresent(payload, forKey: .payload)
        try container.encode(extensions, forKey: .extensions)
    }
}

/// One contiguous, strictly ordered cursor range of retained runtime events.
public struct RuntimeEventBatch: Codable, Equatable, Sendable {
    public let protocolVersion: ProtocolVersion
    public let eventEpochID: EventEpochID
    public let firstSequence: JSONSafeUInt
    public let lastSequence: JSONSafeUInt
    public let events: [RuntimeEvent]
    public let droppedEventCount: JSONSafeUInt
    public let extensions: Extensions

    public init(
        protocolVersion: ProtocolVersion,
        eventEpochID: EventEpochID,
        firstSequence: JSONSafeUInt,
        lastSequence: JSONSafeUInt,
        events: [RuntimeEvent],
        droppedEventCount: JSONSafeUInt,
        extensions: Extensions = .empty
    ) throws {
        guard firstSequence.rawValue <= lastSequence.rawValue else {
            throw ProtocolModelError.invalidValue("Event batch sequence range is reversed.")
        }
        var previous: UInt64?
        for event in events {
            guard event.eventEpochID == eventEpochID else {
                throw ProtocolModelError.invalidValue("Event batch epochs must be uniform.")
            }
            let sequence = event.sequence.rawValue
            guard sequence >= firstSequence.rawValue, sequence <= lastSequence.rawValue else {
                throw ProtocolModelError.invalidValue("Event sequences must stay inside the batch range.")
            }
            if let previous {
                guard sequence > previous else {
                    throw ProtocolModelError.invalidValue("Event sequences must strictly increase.")
                }
            }
            previous = sequence
        }
        self.protocolVersion = protocolVersion
        self.eventEpochID = eventEpochID
        self.firstSequence = firstSequence
        self.lastSequence = lastSequence
        self.events = events
        self.droppedEventCount = droppedEventCount
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case protocolVersion = "protocol_version"
        case eventEpochID = "event_epoch_id"
        case firstSequence = "first_sequence"
        case lastSequence = "last_sequence"
        case events
        case droppedEventCount = "dropped_event_count"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                protocolVersion: try container.decode(ProtocolVersion.self, forKey: .protocolVersion),
                eventEpochID: try container.decode(EventEpochID.self, forKey: .eventEpochID),
                firstSequence: try container.decode(JSONSafeUInt.self, forKey: .firstSequence),
                lastSequence: try container.decode(JSONSafeUInt.self, forKey: .lastSequence),
                events: try container.decode([RuntimeEvent].self, forKey: .events),
                droppedEventCount: try container.decode(JSONSafeUInt.self, forKey: .droppedEventCount),
                extensions: try container.decode(Extensions.self, forKey: .extensions)
            )
        } catch let error as ProtocolModelError {
            throw DecodingError.dataCorruptedError(
                forKey: .events,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}
