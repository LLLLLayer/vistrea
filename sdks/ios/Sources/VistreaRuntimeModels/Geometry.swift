import Foundation

public struct Size: Codable, Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) throws {
        guard width.isFinite, height.isFinite, width >= 0, height >= 0 else {
            throw ProtocolModelError.invalidValue("Size values must be finite and non-negative.")
        }
        self.width = width
        self.height = height
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case width
        case height
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let width = try container.decode(Double.self, forKey: .width)
        let height = try container.decode(Double.self, forKey: .height)
        do {
            try self.init(width: width, height: height)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .width,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct PixelSize: Codable, Equatable, Sendable {
    public let width: JSONSafePositiveUInt
    public let height: JSONSafePositiveUInt

    public init(width: JSONSafePositiveUInt, height: JSONSafePositiveUInt) {
        self.width = width
        self.height = height
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case width
        case height
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        width = try container.decode(JSONSafePositiveUInt.self, forKey: .width)
        height = try container.decode(JSONSafePositiveUInt.self, forKey: .height)
    }
}

public struct Rect: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) throws {
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width >= 0, height >= 0
        else {
            throw ProtocolModelError.invalidValue("Rect values must be finite and dimensions must be non-negative.")
        }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case x
        case y
        case width
        case height
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let x = try container.decode(Double.self, forKey: .x)
        let y = try container.decode(Double.self, forKey: .y)
        let width = try container.decode(Double.self, forKey: .width)
        let height = try container.decode(Double.self, forKey: .height)
        do {
            try self.init(x: x, y: y, width: width, height: height)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .width,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct NonEmptyRect: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) throws {
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width > 0, height > 0
        else {
            throw ProtocolModelError.invalidValue("Non-empty Rect values must be finite and dimensions must be positive.")
        }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case x
        case y
        case width
        case height
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let x = try container.decode(Double.self, forKey: .x)
        let y = try container.decode(Double.self, forKey: .y)
        let width = try container.decode(Double.self, forKey: .width)
        let height = try container.decode(Double.self, forKey: .height)
        do {
            try self.init(x: x, y: y, width: width, height: height)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .width,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct Insets: Codable, Equatable, Sendable {
    public let top: Double
    public let left: Double
    public let bottom: Double
    public let right: Double

    public init(top: Double, left: Double, bottom: Double, right: Double) throws {
        let values = [top, left, bottom, right]
        guard values.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            throw ProtocolModelError.invalidValue("Inset values must be finite and non-negative.")
        }
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case top
        case left
        case bottom
        case right
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let top = try container.decode(Double.self, forKey: .top)
        let left = try container.decode(Double.self, forKey: .left)
        let bottom = try container.decode(Double.self, forKey: .bottom)
        let right = try container.decode(Double.self, forKey: .right)
        do {
            try self.init(top: top, left: left, bottom: bottom, right: right)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .top,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public enum CoordinateUnit: String, Codable, Equatable, Sendable {
    case logicalPoint = "logical_point"
}

public enum CoordinateOrigin: String, Codable, Equatable, Sendable {
    case topLeft = "top_left"
}

public enum DisplayOrientation: String, Codable, Equatable, Sendable {
    case portrait
    case portraitUpsideDown = "portrait_upside_down"
    case landscapeLeft = "landscape_left"
    case landscapeRight = "landscape_right"
}

public struct DisplayGeometry: Codable, Equatable, Sendable {
    public let coordinateUnit: CoordinateUnit
    public let origin: CoordinateOrigin
    public let logicalSize: Size
    public let pixelSize: PixelSize
    public let pixelScaleX: Double
    public let pixelScaleY: Double
    public let orientation: DisplayOrientation
    public let safeArea: Insets
    public let geometryRevision: String
    public let extensions: Extensions

    public init(
        coordinateUnit: CoordinateUnit = .logicalPoint,
        origin: CoordinateOrigin = .topLeft,
        logicalSize: Size,
        pixelSize: PixelSize,
        pixelScaleX: Double,
        pixelScaleY: Double,
        orientation: DisplayOrientation,
        safeArea: Insets,
        geometryRevision: String,
        extensions: Extensions = .empty
    ) throws {
        guard pixelScaleX.isFinite, pixelScaleY.isFinite,
              pixelScaleX > 0, pixelScaleY > 0
        else {
            throw ProtocolModelError.invalidValue("Display pixel scales must be finite and positive.")
        }
        guard !geometryRevision.isEmpty, geometryRevision.unicodeScalars.count <= 128 else {
            throw ProtocolModelError.invalidValue("Geometry revision must contain 1 through 128 UTF-8 bytes.")
        }
        self.coordinateUnit = coordinateUnit
        self.origin = origin
        self.logicalSize = logicalSize
        self.pixelSize = pixelSize
        self.pixelScaleX = pixelScaleX
        self.pixelScaleY = pixelScaleY
        self.orientation = orientation
        self.safeArea = safeArea
        self.geometryRevision = geometryRevision
        self.extensions = extensions
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case coordinateUnit = "coordinate_unit"
        case origin
        case logicalSize = "logical_size"
        case pixelSize = "pixel_size"
        case pixelScaleX = "pixel_scale_x"
        case pixelScaleY = "pixel_scale_y"
        case orientation
        case safeArea = "safe_area"
        case geometryRevision = "geometry_revision"
        case extensions
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let coordinateUnit = try container.decode(CoordinateUnit.self, forKey: .coordinateUnit)
        let origin = try container.decode(CoordinateOrigin.self, forKey: .origin)
        let logicalSize = try container.decode(Size.self, forKey: .logicalSize)
        let pixelSize = try container.decode(PixelSize.self, forKey: .pixelSize)
        let pixelScaleX = try container.decode(Double.self, forKey: .pixelScaleX)
        let pixelScaleY = try container.decode(Double.self, forKey: .pixelScaleY)
        let orientation = try container.decode(DisplayOrientation.self, forKey: .orientation)
        let safeArea = try container.decode(Insets.self, forKey: .safeArea)
        let geometryRevision = try container.decode(String.self, forKey: .geometryRevision)
        let extensions = try container.decode(Extensions.self, forKey: .extensions)
        do {
            try self.init(
                coordinateUnit: coordinateUnit,
                origin: origin,
                logicalSize: logicalSize,
                pixelSize: pixelSize,
                pixelScaleX: pixelScaleX,
                pixelScaleY: pixelScaleY,
                orientation: orientation,
                safeArea: safeArea,
                geometryRevision: geometryRevision,
                extensions: extensions
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .pixelScaleX,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}
