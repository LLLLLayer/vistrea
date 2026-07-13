import UIKit

final class ScenarioListViewController: UITableViewController {
    private let catalog: ScenarioCatalog
    private weak var ownedNavigationController: UINavigationController?

    init(catalog: ScenarioCatalog, navigationController: UINavigationController) {
        self.catalog = catalog
        ownedNavigationController = navigationController
        super.init(style: .insetGrouped)
        title = "Vistrea Scenarios"
        navigationItem.largeTitleDisplayMode = .always
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "scenario")
        tableView.accessibilityIdentifier = "vistrea.scenario.list"
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        catalog.scenarios.count
    }

    override func tableView(
        _ tableView: UITableView,
        cellForRowAt indexPath: IndexPath
    ) -> UITableViewCell {
        let scenario = catalog.scenarios[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "scenario", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = scenario.title
        content.secondaryText = scenario.scenarioID
        content.secondaryTextProperties.color = .secondaryLabel
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = "vistrea.scenario.\(scenario.scenarioID)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let scenario = catalog.scenarios[indexPath.row]
        ownedNavigationController?.pushViewController(
            ScenarioEntryFactory.makeEntryViewController(
                scenario: scenario,
                profile: "baseline"
            ),
            animated: true
        )
    }
}
