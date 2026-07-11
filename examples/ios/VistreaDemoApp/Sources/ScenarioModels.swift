import Foundation

struct ScenarioManifest: Decodable, Sendable {
    let suiteID: String
    let scenarios: [ScenarioManifestEntry]

    private enum CodingKeys: String, CodingKey {
        case suiteID = "suite_id"
        case scenarios
    }
}
struct ScenarioManifestEntry: Decodable, Sendable {
    let scenarioID: String
    let file: String
    let required: Bool

    private enum CodingKeys: String, CodingKey {
        case scenarioID = "scenario_id"
        case file
        case required
    }
}

struct ScenarioDefinition: Decodable, Sendable {
    let scenarioID: String
    let title: String
    let purpose: String
    let profiles: [String]
    let reset: ScenarioReset
    let stableNodes: [ScenarioStableNode]
    let states: [ScenarioState]
    let steps: [ScenarioStep]

    var entryStateID: String {
        reset.entryStateID
    }

    func state(id: String) -> ScenarioState? {
        states.first { $0.stateID == id }
    }

    func stableNode(id: String) -> ScenarioStableNode? {
        stableNodes.first { $0.nodeID == id }
    }

    func steps(from stateID: String, profile: String) -> [ScenarioStep] {
        steps.filter {
            $0.fromStateID == stateID && ($0.profiles?.contains(profile) ?? true)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case scenarioID = "scenario_id"
        case title
        case purpose
        case profiles
        case reset
        case stableNodes = "stable_nodes"
        case states
        case steps
    }
}

struct ScenarioReset: Decodable, Sendable {
    let entryStateID: String
    let seed: Int

    private enum CodingKeys: String, CodingKey {
        case entryStateID = "entry_state_id"
        case seed
    }
}

struct ScenarioStableNode: Decodable, Sendable {
    let nodeID: String
    let role: String

    private enum CodingKeys: String, CodingKey {
        case nodeID = "node_id"
        case role
    }
}

struct ScenarioState: Decodable, Sendable {
    let stateID: String
    let kind: String
    let requiredNodeIDs: [String]

    private enum CodingKeys: String, CodingKey {
        case stateID = "state_id"
        case kind
        case requiredNodeIDs = "required_node_ids"
    }
}

struct ScenarioStep: Decodable, Sendable {
    let stepID: String
    let action: ScenarioAction
    let fromStateID: String
    let toStateID: String
    let profiles: [String]?

    private enum CodingKeys: String, CodingKey {
        case stepID = "step_id"
        case action
        case fromStateID = "from_state_id"
        case toStateID = "to_state_id"
        case profiles
    }
}

struct ScenarioAction: Decodable, Sendable {
    let kind: String
    let targetNodeID: String?
    let inputAlias: String?
    let durationMilliseconds: Int?

    private enum CodingKeys: String, CodingKey {
        case kind
        case targetNodeID = "target_node_id"
        case inputAlias = "input_alias"
        case durationMilliseconds = "duration_ms"
    }
}
