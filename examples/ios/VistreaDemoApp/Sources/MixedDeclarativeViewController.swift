import SwiftUI
import UIKit

/// The deterministic toggle behind `demo.mixed.status`. Tapping the action
/// only rewrites the status text — the SwiftUI structure never changes.
@MainActor
final class MixedDeclarativeModel: ObservableObject {
    static let readyText = "Status: ready"
    static let engagedText = "Status: engaged"

    @Published private(set) var statusText = MixedDeclarativeModel.readyText

    func toggle() {
        statusText = statusText == Self.readyText ? Self.engagedText : Self.readyText
    }
}

/// The SwiftUI content of `demo.mixed.declarative`. All four contracted
/// stable nodes are SwiftUI views carrying `.accessibilityIdentifier`; the
/// SDK observes them through accessibility elements, which requires an active
/// accessibility runtime — a limitation the shared fixture records.
struct MixedDeclarativeScreen: View {
    @ObservedObject var model: MixedDeclarativeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Declarative storefront")
                .font(.largeTitle)
                .accessibilityIdentifier("demo.mixed.header")
            VStack(alignment: .leading, spacing: 8) {
                Text(StoreCatalog.featuredItem.name)
                    .font(.headline)
                Text(StoreCatalog.featuredItem.price)
                    .foregroundStyle(.secondary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("demo.mixed.featured_card")
            Button("Toggle status") {
                model.toggle()
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("demo.mixed.action")
            Text(model.statusText)
                .font(.body)
                .accessibilityIdentifier("demo.mixed.status")
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `demo.mixed.declarative`: the scenario container stays UIKit (so the
/// shared Inspector chrome and capture entry point are unchanged) while the
/// screen content renders through SwiftUI inside a hosted controller.
final class MixedDeclarativeViewController: ScenarioScreenViewController {
    let model = MixedDeclarativeModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Declarative"
        view.accessibilityIdentifier = "demo.state.mixed.root"

        let hosting = UIHostingController(rootView: MixedDeclarativeScreen(model: model))
        hosting.view.backgroundColor = .clear
        addChild(hosting)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        hosting.didMove(toParent: self)
    }
}
