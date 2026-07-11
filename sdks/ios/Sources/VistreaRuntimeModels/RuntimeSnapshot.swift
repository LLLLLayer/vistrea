import Foundation

public enum SystemChromeCapture: String, Codable, Equatable, Sendable {
    case included
    case excluded
    case partial
    case unknown
}

public struct ScreenshotEvidence: Codable, Equatable, Sendable {
    public let object: ObjectReference
    public let captureStartedAt: EventTime
    public let captureFinishedAt: EventTime
    public let treeSkewMilliseconds: Double
    public let coverage: NonEmptyRect
    public let pixelSize: PixelSize
    public let systemChrome: SystemChromeCapture
    public let colorSpace: ColorSpace?
    public let extensions: Extensions

    public init(
        object: ObjectReference,
        captureStartedAt: EventTime,
        captureFinishedAt: EventTime,
        treeSkewMilliseconds: Double,
        coverage: NonEmptyRect,
        pixelSize: PixelSize,
        systemChrome: SystemChromeCapture,
        colorSpace: ColorSpace? = nil,
        extensions: Extensions = .empty
    ) throws {
        guard treeSkewMilliseconds.isFinite, treeSkewMilliseconds >= 0 else {
            throw ProtocolModelError.invalidValue("Screenshot tree skew must be finite and non-negative.")
        }
        self.object = object
        self.captureStartedAt = captureStartedAt
        self.captureFinishedAt = captureFinishedAt
        self.treeSkewMilliseconds = treeSkewMilliseconds
        self.coverage = coverage
        self.pixelSize = pixelSize
        self.systemChrome = systemChrome
        self.colorSpace = colorSpace
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case object
        case captureStartedAt = "capture_started_at"
        case captureFinishedAt = "capture_finished_at"
        case treeSkewMilliseconds = "tree_skew_ms"
        case coverage
        case pixelSize = "pixel_size"
        case systemChrome = "system_chrome"
        case colorSpace = "color_space"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let object = try container.decode(ObjectReference.self, forKey: .object)
        let captureStartedAt = try container.decode(EventTime.self, forKey: .captureStartedAt)
        let captureFinishedAt = try container.decode(EventTime.self, forKey: .captureFinishedAt)
        let treeSkewMilliseconds = try container.decode(Double.self, forKey: .treeSkewMilliseconds)
        let coverage = try container.decode(NonEmptyRect.self, forKey: .coverage)
        let pixelSize = try container.decode(PixelSize.self, forKey: .pixelSize)
        let systemChrome = try container.decode(SystemChromeCapture.self, forKey: .systemChrome)
        let colorSpace = try container.decodeIfPresent(ColorSpace.self, forKey: .colorSpace)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                object: object,
                captureStartedAt: captureStartedAt,
                captureFinishedAt: captureFinishedAt,
                treeSkewMilliseconds: treeSkewMilliseconds,
                coverage: coverage,
                pixelSize: pixelSize,
                systemChrome: systemChrome,
                colorSpace: colorSpace,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .treeSkewMilliseconds,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct EventWindow: Codable, Equatable, Sendable {
    public let eventEpochID: EventEpochID
    public let firstSequence: JSONSafeUInt?
    public let lastSequence: JSONSafeUInt?
    public let droppedEventCount: JSONSafeUInt?

    public init(
        eventEpochID: EventEpochID,
        firstSequence: JSONSafeUInt? = nil,
        lastSequence: JSONSafeUInt? = nil,
        droppedEventCount: JSONSafeUInt? = nil
    ) {
        self.eventEpochID = eventEpochID
        self.firstSequence = firstSequence
        self.lastSequence = lastSequence
        self.droppedEventCount = droppedEventCount
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case eventEpochID = "event_epoch_id"
        case firstSequence = "first_sequence"
        case lastSequence = "last_sequence"
        case droppedEventCount = "dropped_event_count"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventEpochID = try container.decode(EventEpochID.self, forKey: .eventEpochID)
        firstSequence = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .firstSequence)
        lastSequence = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .lastSequence)
        droppedEventCount = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .droppedEventCount)
    }
}

public struct RuntimeSnapshot: Codable, Equatable, Sendable {
    public let snapshotID: SnapshotID
    public let protocolVersion: ProtocolVersion
    public let capturedAt: EventTime
    public let runtimeContext: RuntimeContext
    public let display: DisplayGeometry
    public let trees: [UiTree]
    public let screenshot: ScreenshotEvidence?
    public let eventWindow: EventWindow?
    public let capabilities: CapabilitySet
    public let captureLimitations: [CaptureLimitation]
    public let extensions: Extensions

    public init(
        snapshotID: SnapshotID,
        protocolVersion: ProtocolVersion,
        capturedAt: EventTime,
        runtimeContext: RuntimeContext,
        display: DisplayGeometry,
        trees: [UiTree],
        screenshot: ScreenshotEvidence? = nil,
        eventWindow: EventWindow? = nil,
        capabilities: CapabilitySet,
        captureLimitations: [CaptureLimitation],
        extensions: Extensions = .empty
    ) throws {
        guard !trees.isEmpty else {
            throw ProtocolModelError.invalidValue("A Runtime Snapshot must contain at least one UI tree.")
        }
        guard Set(trees.map(\.treeID)).count == trees.count else {
            throw ProtocolModelError.invalidValue("Runtime Snapshot tree IDs must be unique.")
        }
        self.snapshotID = snapshotID
        self.protocolVersion = protocolVersion
        self.capturedAt = capturedAt
        self.runtimeContext = runtimeContext
        self.display = display
        self.trees = trees
        self.screenshot = screenshot
        self.eventWindow = eventWindow
        self.capabilities = capabilities
        self.captureLimitations = captureLimitations
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case snapshotID = "snapshot_id"
        case protocolVersion = "protocol_version"
        case capturedAt = "captured_at"
        case runtimeContext = "runtime_context"
        case display
        case trees
        case screenshot
        case eventWindow = "event_window"
        case capabilities
        case captureLimitations = "capture_limitations"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let snapshotID = try container.decode(SnapshotID.self, forKey: .snapshotID)
        let protocolVersion = try container.decode(ProtocolVersion.self, forKey: .protocolVersion)
        let capturedAt = try container.decode(EventTime.self, forKey: .capturedAt)
        let runtimeContext = try container.decode(RuntimeContext.self, forKey: .runtimeContext)
        let display = try container.decode(DisplayGeometry.self, forKey: .display)
        let trees = try container.decode([UiTree].self, forKey: .trees)
        let screenshot = try container.decodeIfPresent(ScreenshotEvidence.self, forKey: .screenshot)
        let eventWindow = try container.decodeIfPresent(EventWindow.self, forKey: .eventWindow)
        let capabilities = try container.decode(CapabilitySet.self, forKey: .capabilities)
        let captureLimitations = try container.decode([CaptureLimitation].self, forKey: .captureLimitations)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                snapshotID: snapshotID,
                protocolVersion: protocolVersion,
                capturedAt: capturedAt,
                runtimeContext: runtimeContext,
                display: display,
                trees: trees,
                screenshot: screenshot,
                eventWindow: eventWindow,
                capabilities: capabilities,
                captureLimitations: captureLimitations,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .trees,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

/// Canonical JSON entry points shared by capture, transport, fixtures, and relays.
public enum RuntimeSnapshotCodec {
    public static func decode(_ data: Data) throws -> RuntimeSnapshot {
        try JSONDecoder().decode(RuntimeSnapshot.self, from: data)
    }

    public static func encode(_ snapshot: RuntimeSnapshot, prettyPrinted: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = prettyPrinted
            ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            : [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(snapshot)
    }
}
