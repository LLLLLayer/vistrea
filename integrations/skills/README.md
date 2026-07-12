# Agent Skills

Task-oriented workflows for Codex and compatible Coding Agents. A Skill tells an Agent when and how to compose Vistrea CLI, MCP, or local APIs. It never implements Design, Exploration, Knowledge, or Validation Engine logic.

Implemented Skills:

- `vistrea-inspect-runtime`: check Runtime readiness, capture canonical UI
  evidence, and inspect or retrieve the same persisted Snapshot through CLI or
  MCP

Planned Skills:

- `vistrea-explore-ui`: explore a bounded application area and update the Deep Wiki
- `vistrea-review-design`: open a Screen State and create issues against a design baseline
- `vistrea-tune-ui`: apply reversible visual changes, produce a Tuning Patch, and re-verify
- `vistrea-verify-change`: validate affected paths and compare build versions

Create additional real packages only after callable interfaces and workflows exist:

```text
integrations/skills/
└── vistrea-review-design/
    ├── SKILL.md
    ├── agents/
    │   └── openai.yaml
    ├── scripts/       # only for deterministic reusable helpers
    └── references/    # only for on-demand protocol or workflow context
```

Do not create placeholder Skills containing commands that the repository does not implement.
