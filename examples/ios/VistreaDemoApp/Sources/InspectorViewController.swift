import UIKit
import VistreaRuntimeUIKit

final class InspectorViewController: UIViewController, UITableViewDataSource {
    private let result: UIKitRuntimeCaptureResult
    private let nodes: [(depth: Int, title: String, detail: String)]
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)

    init(result: UIKitRuntimeCaptureResult) {
        self.result = result
        nodes = Self.flatten(result: result)
        super.init(nibName: nil, bundle: nil)
        title = "Runtime Inspector"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.dataSource = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "node")
        tableView.accessibilityIdentifier = "vistrea.inspector.node-list"
        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    func numberOfSections(in tableView: UITableView) -> Int {
        2
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? 3 : nodes.count
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 0 ? "Capture" : "View tree (\(nodes.count) nodes)"
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "node", for: indexPath)
        var content = cell.defaultContentConfiguration()
        if indexPath.section == 0 {
            switch indexPath.row {
            case 0:
                content.text = "Snapshot"
                content.secondaryText = result.snapshot.snapshotID.rawValue
            case 1:
                content.text = "Screenshot object"
                content.secondaryText = result.objects.first?.reference.hash ?? "Not captured"
            default:
                content.text = "Application"
                content.secondaryText = result.snapshot.runtimeContext.applicationID
            }
        } else {
            let node = nodes[indexPath.row]
            content.text = String(repeating: "  ", count: node.depth) + node.title
            content.secondaryText = node.detail
        }
        content.secondaryTextProperties.color = .secondaryLabel
        content.secondaryTextProperties.numberOfLines = 2
        cell.contentConfiguration = content
        cell.selectionStyle = .none
        return cell
    }

    private static func flatten(
        result: UIKitRuntimeCaptureResult
    ) -> [(depth: Int, title: String, detail: String)] {
        guard let tree = result.snapshot.trees.first,
              let nodes = tree.payload.inlineNodes
        else {
            return []
        }
        let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.nodeID, $0) })
        var flattened: [(Int, String, String)] = []
        var stack = tree.rootNodeIDs.reversed().map { ($0, 0) }
        while let (nodeID, depth) = stack.popLast(), let node = byID[nodeID] {
            flattened.append((
                depth,
                node.stableID?.rawValue ?? node.role,
                "\(node.nativeType) • \(node.nodeID.rawValue)"
            ))
            for childID in node.childIDs.reversed() {
                stack.append((childID, depth + 1))
            }
        }
        return flattened
    }
}
