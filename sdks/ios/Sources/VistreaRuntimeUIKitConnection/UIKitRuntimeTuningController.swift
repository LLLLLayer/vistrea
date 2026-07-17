#if canImport(UIKit)
import UIKit
import VistreaRuntimeConnection
import VistreaRuntimeModels

/// Resolves stable identifiers to live views and previews allowlisted visual
/// properties without invoking application business methods.
///
/// The controller mutates exactly the allowlisted property on the main actor
/// and never invokes application business methods.
public final class UIKitRuntimeTuningController: RuntimeTuningApplying {
    public typealias WindowProvider = @MainActor @Sendable () -> [UIWindow]

    private let windowProvider: WindowProvider

    public init(windowProvider: @escaping WindowProvider) {
        self.windowProvider = windowProvider
    }

    public let supportedTuningProperties: Set<String> = [
        "content_insets",
        "spacing",
        "font",
        "foreground_color",
        "background_color",
        "alpha",
        "corner_radius",
    ]

    public func currentAlpha(stableID: String) async -> Double? {
        await MainActor.run {
            findView(stableID: stableID).map { Double($0.alpha) }
        }
    }

    public func setAlpha(stableID: String, value: Double) async {
        await MainActor.run {
            findView(stableID: stableID)?.alpha = CGFloat(value)
        }
    }

    public func currentTuningValue(stableID: String, property: String) async -> JSONValue? {
        await MainActor.run {
            guard let view = findView(stableID: stableID) else { return nil }
            switch property {
            case "alpha":
                return Self.numberValue(Double(view.alpha), unit: "ratio")
            case "corner_radius":
                return Self.numberValue(Double(view.layer.cornerRadius), unit: "logical_point")
            case "spacing":
                guard let stack = view as? UIStackView else { return nil }
                return Self.numberValue(Double(stack.spacing), unit: "logical_point")
            case "content_insets":
                let margins = view.layoutMargins
                return .object([
                    "kind": .string("insets"),
                    "value": .object([
                        "top": .number(Double(margins.top)),
                        "leading": .number(Double(margins.left)),
                        "bottom": .number(Double(margins.bottom)),
                        "trailing": .number(Double(margins.right)),
                    ]),
                    "extensions": .object([:]),
                ])
            case "foreground_color":
                guard let color = Self.foregroundColor(of: view) else { return nil }
                return Self.colorValue(color)
            case "background_color":
                guard let color = view.backgroundColor else { return nil }
                return Self.colorValue(color)
            case "font":
                guard let font = Self.font(of: view) else { return nil }
                return Self.fontValue(font)
            default:
                return nil
            }
        }
    }

    public func setTuningValue(
        stableID: String,
        property: String,
        value: JSONValue
    ) async -> Bool {
        await MainActor.run {
            guard let view = findView(stableID: stableID) else { return false }
            switch property {
            case "alpha":
                guard let number = Self.number(from: value), (0...1).contains(number) else {
                    return false
                }
                view.alpha = CGFloat(number)
            case "corner_radius":
                guard let number = Self.number(from: value), number >= 0 else { return false }
                view.layer.cornerRadius = CGFloat(number)
            case "spacing":
                guard let stack = view as? UIStackView,
                      let number = Self.number(from: value), number >= 0 else { return false }
                stack.spacing = CGFloat(number)
            case "content_insets":
                guard let insets = Self.insets(from: value) else { return false }
                view.layoutMargins = insets
            case "foreground_color":
                guard let color = Self.color(from: value) else { return false }
                guard Self.setForegroundColor(color, on: view) else { return false }
            case "background_color":
                guard let color = Self.color(from: value) else { return false }
                view.backgroundColor = color
            case "font":
                guard let font = Self.font(from: value) else { return false }
                guard Self.setFont(font, on: view) else { return false }
            default:
                return false
            }
            return true
        }
    }

    @MainActor
    private func findView(stableID: String) -> UIView? {
        for window in windowProvider() {
            if let match = findView(stableID: stableID, in: window) {
                return match
            }
        }
        return nil
    }

    @MainActor
    private func findView(stableID: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == stableID {
            return view
        }
        for subview in view.subviews {
            if let match = findView(stableID: stableID, in: subview) {
                return match
            }
        }
        return nil
    }

    private static func numberValue(_ value: Double, unit: String) -> JSONValue {
        .object([
            "kind": .string("number"),
            "value": .number(value),
            "unit": .string(unit),
            "extensions": .object([:]),
        ])
    }

    private static func number(from value: JSONValue) -> Double? {
        guard case let .object(object) = value else { return nil }
        switch object["value"] {
        case let .number(number): return number
        case let .integer(integer): return Double(integer)
        default: return nil
        }
    }

    private static func colorValue(_ color: UIColor) -> JSONValue? {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
        return .object([
            "kind": .string("color_rgba"),
            "value": .object([
                "red": .number(Double(red)),
                "green": .number(Double(green)),
                "blue": .number(Double(blue)),
                "alpha": .number(Double(alpha)),
            ]),
            "color_space": .string("srgb"),
            "extensions": .object([:]),
        ])
    }

    private static func color(from value: JSONValue) -> UIColor? {
        guard case let .object(property) = value,
              case let .object(components)? = property["value"],
              let red = rawNumber(components["red"]),
              let green = rawNumber(components["green"]),
              let blue = rawNumber(components["blue"]),
              let alpha = rawNumber(components["alpha"]),
              [red, green, blue, alpha].allSatisfy({ (0...1).contains($0) })
        else { return nil }
        return UIColor(
            red: CGFloat(red),
            green: CGFloat(green),
            blue: CGFloat(blue),
            alpha: CGFloat(alpha)
        )
    }

    @MainActor
    private static func foregroundColor(of view: UIView) -> UIColor? {
        switch view {
        case let label as UILabel: label.textColor
        case let textView as UITextView: textView.textColor
        case let textField as UITextField: textField.textColor
        case let button as UIButton: button.titleColor(for: .normal)
        default: nil
        }
    }

    @MainActor
    private static func setForegroundColor(_ color: UIColor, on view: UIView) -> Bool {
        switch view {
        case let label as UILabel: label.textColor = color
        case let textView as UITextView: textView.textColor = color
        case let textField as UITextField: textField.textColor = color
        case let button as UIButton: button.setTitleColor(color, for: .normal)
        default: return false
        }
        return true
    }

    @MainActor
    private static func font(of view: UIView) -> UIFont? {
        switch view {
        case let label as UILabel: label.font
        case let textView as UITextView: textView.font
        case let textField as UITextField: textField.font
        case let button as UIButton: button.titleLabel?.font
        default: nil
        }
    }

    @MainActor
    private static func setFont(_ font: UIFont, on view: UIView) -> Bool {
        switch view {
        case let label as UILabel: label.font = font
        case let textView as UITextView: textView.font = font
        case let textField as UITextField: textField.font = font
        case let button as UIButton: button.titleLabel?.font = font
        default: return false
        }
        return true
    }

    private static func fontValue(_ font: UIFont) -> JSONValue {
        let descriptorTraits = font.fontDescriptor.object(forKey: .traits)
            as? [UIFontDescriptor.TraitKey: Any]
        let rawWeight = descriptorTraits?[.weight] as? NSNumber
        let normalized = max(-1, min(1, rawWeight?.doubleValue ?? 0))
        let protocolWeight = Int((normalized + 1) * 499.5 + 1)
        let italic = font.fontDescriptor.symbolicTraits.contains(.traitItalic)
        return .object([
            "kind": .string("font"),
            "value": .object([
                "family": .string(font.familyName),
                "size": .number(Double(font.pointSize)),
                "weight": .integer(Int64(protocolWeight)),
                "style": .string(italic ? "italic" : "normal"),
            ]),
            "extensions": .object([:]),
        ])
    }

    private static func font(from value: JSONValue) -> UIFont? {
        guard case let .object(property) = value,
              case let .object(font)? = property["value"],
              case let .string(family)? = font["family"],
              let size = rawNumber(font["size"]), size > 0,
              let weight = rawNumber(font["weight"]), (1...1000).contains(weight),
              case let .string(style)? = font["style"]
        else { return nil }
        let normalized = CGFloat((weight - 1) / 499.5 - 1)
        var traits: [UIFontDescriptor.TraitKey: Any] = [.weight: normalized]
        if style == "italic" {
            traits[.symbolic] = UIFontDescriptor.SymbolicTraits.traitItalic.rawValue
        }
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: family,
            .traits: traits,
        ])
        return UIFont(descriptor: descriptor, size: CGFloat(size))
    }

    private static func insets(from value: JSONValue) -> UIEdgeInsets? {
        guard case let .object(property) = value,
              case let .object(insets)? = property["value"],
              let top = rawNumber(insets["top"]),
              let leading = rawNumber(insets["leading"]),
              let bottom = rawNumber(insets["bottom"]),
              let trailing = rawNumber(insets["trailing"])
        else { return nil }
        return UIEdgeInsets(
            top: CGFloat(top),
            left: CGFloat(leading),
            bottom: CGFloat(bottom),
            right: CGFloat(trailing)
        )
    }

    private static func rawNumber(_ value: JSONValue?) -> Double? {
        switch value {
        case let .number(number): number
        case let .integer(integer): Double(integer)
        default: nil
        }
    }
}
#endif
