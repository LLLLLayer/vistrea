import Foundation

public enum RedactedTextField: String, Codable, Equatable, Hashable, Sendable {
    case text
    case value
    case placeholder
    case contentDescription = "content_description"
}

public struct TextContent: Codable, Equatable, Sendable {
    public let text: String?
    public let value: String?
    public let placeholder: String?
    public let contentDescription: String?
    public let redactedFields: [RedactedTextField]?

    public init(
        text: String? = nil,
        value: String? = nil,
        placeholder: String? = nil,
        contentDescription: String? = nil,
        redactedFields: [RedactedTextField]? = nil
    ) throws {
        guard text.map({ $0.unicodeScalars.count <= 65_536 }) ?? true,
              value.map({ $0.unicodeScalars.count <= 65_536 }) ?? true,
              placeholder.map({ $0.unicodeScalars.count <= 4_096 }) ?? true,
              contentDescription.map({ $0.unicodeScalars.count <= 65_536 }) ?? true
        else {
            throw ProtocolModelError.invalidValue("Text content exceeds the canonical field limit.")
        }
        if let redactedFields, Set(redactedFields).count != redactedFields.count {
            throw ProtocolModelError.invalidValue("Redacted text fields must be unique.")
        }
        self.text = text
        self.value = value
        self.placeholder = placeholder
        self.contentDescription = contentDescription
        self.redactedFields = redactedFields
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case text
        case value
        case placeholder
        case contentDescription = "content_description"
        case redactedFields = "redacted_fields"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let text = try container.decodeIfPresent(String.self, forKey: .text)
        let value = try container.decodeIfPresent(String.self, forKey: .value)
        let placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        let contentDescription = try container.decodeIfPresent(String.self, forKey: .contentDescription)
        let redactedFields = try container.decodeIfPresent([RedactedTextField].self, forKey: .redactedFields)
        do {
            try self.init(
                text: text,
                value: value,
                placeholder: placeholder,
                contentDescription: contentDescription,
                redactedFields: redactedFields
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .text,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct NodeState: Codable, Equatable, Sendable {
    public let visible: Bool?
    public let enabled: Bool?
    public let selected: Bool?
    public let focused: Bool?
    public let checked: Bool?
    public let expanded: Bool?

    public init(
        visible: Bool? = nil,
        enabled: Bool? = nil,
        selected: Bool? = nil,
        focused: Bool? = nil,
        checked: Bool? = nil,
        expanded: Bool? = nil
    ) {
        self.visible = visible
        self.enabled = enabled
        self.selected = selected
        self.focused = focused
        self.checked = checked
        self.expanded = expanded
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case visible
        case enabled
        case selected
        case focused
        case checked
        case expanded
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        visible = try container.decodeIfPresent(Bool.self, forKey: .visible)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
        selected = try container.decodeIfPresent(Bool.self, forKey: .selected)
        focused = try container.decodeIfPresent(Bool.self, forKey: .focused)
        checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
        expanded = try container.decodeIfPresent(Bool.self, forKey: .expanded)
    }
}

public enum ColorSpace: String, Codable, Equatable, Sendable {
    case sRGB = "srgb"
    case displayP3 = "display_p3"
    case unknown
}

public struct Color: Codable, Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double
    public let colorSpace: ColorSpace

    public init(red: Double, green: Double, blue: Double, alpha: Double, colorSpace: ColorSpace) throws {
        let components = [red, green, blue, alpha]
        guard components.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
            throw ProtocolModelError.invalidValue("Color components must be finite values from 0 through 1.")
        }
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
        self.colorSpace = colorSpace
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case red
        case green
        case blue
        case alpha
        case colorSpace = "color_space"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let red = try container.decode(Double.self, forKey: .red)
        let green = try container.decode(Double.self, forKey: .green)
        let blue = try container.decode(Double.self, forKey: .blue)
        let alpha = try container.decode(Double.self, forKey: .alpha)
        let colorSpace = try container.decode(ColorSpace.self, forKey: .colorSpace)
        do {
            try self.init(red: red, green: green, blue: blue, alpha: alpha, colorSpace: colorSpace)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .red,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct Font: Codable, Equatable, Sendable {
    public let family: String
    public let postscriptName: String?
    public let size: Double
    public let weight: Double

    public init(family: String, postscriptName: String? = nil, size: Double, weight: Double) throws {
        guard !family.isEmpty, family.unicodeScalars.count <= 256 else {
            throw ProtocolModelError.invalidValue("Font family must contain 1 through 256 UTF-8 bytes.")
        }
        if let postscriptName, postscriptName.isEmpty || postscriptName.unicodeScalars.count > 256 {
            throw ProtocolModelError.invalidValue("PostScript name must contain 1 through 256 UTF-8 bytes.")
        }
        guard size.isFinite, size > 0, weight.isFinite, (-1...1).contains(weight) else {
            throw ProtocolModelError.invalidValue("Font size and weight are outside the canonical range.")
        }
        self.family = family
        self.postscriptName = postscriptName
        self.size = size
        self.weight = weight
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case family
        case postscriptName = "postscript_name"
        case size
        case weight
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let family = try container.decode(String.self, forKey: .family)
        let postscriptName = try container.decodeIfPresent(String.self, forKey: .postscriptName)
        let size = try container.decode(Double.self, forKey: .size)
        let weight = try container.decode(Double.self, forKey: .weight)
        do {
            try self.init(family: family, postscriptName: postscriptName, size: size, weight: weight)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .family,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct VisualProperties: Codable, Equatable, Sendable {
    public let alpha: Double?
    public let foregroundColor: Color?
    public let backgroundColor: Color?
    public let font: Font?
    public let cornerRadius: Double?
    public let borderWidth: Double?
    public let borderColor: Color?

    public init(
        alpha: Double? = nil,
        foregroundColor: Color? = nil,
        backgroundColor: Color? = nil,
        font: Font? = nil,
        cornerRadius: Double? = nil,
        borderWidth: Double? = nil,
        borderColor: Color? = nil
    ) throws {
        if let alpha, !alpha.isFinite || !(0...1).contains(alpha) {
            throw ProtocolModelError.invalidValue("Visual alpha must be a finite value from 0 through 1.")
        }
        if let cornerRadius, !cornerRadius.isFinite || cornerRadius < 0 {
            throw ProtocolModelError.invalidValue("Corner radius must be finite and non-negative.")
        }
        if let borderWidth, !borderWidth.isFinite || borderWidth < 0 {
            throw ProtocolModelError.invalidValue("Border width must be finite and non-negative.")
        }
        self.alpha = alpha
        self.foregroundColor = foregroundColor
        self.backgroundColor = backgroundColor
        self.font = font
        self.cornerRadius = cornerRadius
        self.borderWidth = borderWidth
        self.borderColor = borderColor
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case alpha
        case foregroundColor = "foreground_color"
        case backgroundColor = "background_color"
        case font
        case cornerRadius = "corner_radius"
        case borderWidth = "border_width"
        case borderColor = "border_color"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let alpha = try container.decodeIfPresent(Double.self, forKey: .alpha)
        let foregroundColor = try container.decodeIfPresent(Color.self, forKey: .foregroundColor)
        let backgroundColor = try container.decodeIfPresent(Color.self, forKey: .backgroundColor)
        let font = try container.decodeIfPresent(Font.self, forKey: .font)
        let cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        let borderWidth = try container.decodeIfPresent(Double.self, forKey: .borderWidth)
        let borderColor = try container.decodeIfPresent(Color.self, forKey: .borderColor)
        do {
            try self.init(
                alpha: alpha,
                foregroundColor: foregroundColor,
                backgroundColor: backgroundColor,
                font: font,
                cornerRadius: cornerRadius,
                borderWidth: borderWidth,
                borderColor: borderColor
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .alpha,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public struct AccessibilityProperties: Codable, Equatable, Sendable {
    public let label: String?
    public let value: String?
    public let role: String?
    public let hidden: Bool?
    public let focusOrder: JSONSafeUInt?

    public init(
        label: String? = nil,
        value: String? = nil,
        role: String? = nil,
        hidden: Bool? = nil,
        focusOrder: JSONSafeUInt? = nil
    ) throws {
        guard label.map({ $0.unicodeScalars.count <= 65_536 }) ?? true,
              value.map({ $0.unicodeScalars.count <= 65_536 }) ?? true
        else {
            throw ProtocolModelError.invalidValue("Accessibility text exceeds the canonical field limit.")
        }
        if let role, role.isEmpty || role.unicodeScalars.count > 128 {
            throw ProtocolModelError.invalidValue("Accessibility role must contain 1 through 128 UTF-8 bytes.")
        }
        self.label = label
        self.value = value
        self.role = role
        self.hidden = hidden
        self.focusOrder = focusOrder
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case label
        case value
        case role
        case hidden
        case focusOrder = "focus_order"
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let label = try container.decodeIfPresent(String.self, forKey: .label)
        let value = try container.decodeIfPresent(String.self, forKey: .value)
        let role = try container.decodeIfPresent(String.self, forKey: .role)
        let hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden)
        let focusOrder = try container.decodeIfPresent(JSONSafeUInt.self, forKey: .focusOrder)
        do {
            try self.init(label: label, value: value, role: role, hidden: hidden, focusOrder: focusOrder)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .role,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public enum RelatedNodeRelation: String, Codable, Equatable, Sendable {
    case semanticFor = "semantic_for"
    case viewFor = "view_for"
    case layerFor = "layer_for"
    case sourceFor = "source_for"
}

public struct RelatedNodeReference: Codable, Equatable, Sendable {
    public let treeID: TreeID
    public let nodeID: NodeID
    public let relation: RelatedNodeRelation

    public init(treeID: TreeID, nodeID: NodeID, relation: RelatedNodeRelation) {
        self.treeID = treeID
        self.nodeID = nodeID
        self.relation = relation
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case treeID = "tree_id"
        case nodeID = "node_id"
        case relation
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        treeID = try container.decode(TreeID.self, forKey: .treeID)
        nodeID = try container.decode(NodeID.self, forKey: .nodeID)
        relation = try container.decode(RelatedNodeRelation.self, forKey: .relation)
    }
}

public struct SourceContext: Codable, Equatable, Sendable {
    public let route: String?
    public let controller: String?
    public let module: String?
    public let component: String?

    public init(
        route: String? = nil,
        controller: String? = nil,
        module: String? = nil,
        component: String? = nil
    ) throws {
        let values = [route, controller, module, component].compactMap { $0 }
        guard values.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 512 }) else {
            throw ProtocolModelError.invalidValue("Source context values must contain 1 through 512 UTF-8 bytes.")
        }
        self.route = route
        self.controller = controller
        self.module = module
        self.component = component
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case route
        case controller
        case module
        case component
    }

    public init(from decoder: Decoder) throws {
        try decoder.rejectUnknownKeys(CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let route = try container.decodeIfPresent(String.self, forKey: .route)
        let controller = try container.decodeIfPresent(String.self, forKey: .controller)
        let module = try container.decodeIfPresent(String.self, forKey: .module)
        let component = try container.decodeIfPresent(String.self, forKey: .component)
        do {
            try self.init(route: route, controller: controller, module: module, component: component)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .route,
                in: container,
                debugDescription: String(describing: error)
            )
        }
    }
}

public enum UiAction: String, Codable, Equatable, Hashable, Sendable {
    case tap
    case longPress = "long_press"
    case typeText = "type_text"
    case clearText = "clear_text"
    case swipe
    case scroll
}
