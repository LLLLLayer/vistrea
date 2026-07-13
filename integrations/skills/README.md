# Agent Skills

Task-oriented workflows for Codex and compatible Coding Agents. A Skill tells an Agent when and how to compose the Vistrea CLI or local APIs. It never implements Design, Exploration, Knowledge, or Validation Engine logic.

Implemented Skills:

- `vistrea-inspect-runtime`: check Runtime readiness, capture canonical UI
  evidence, and inspect or retrieve the same persisted Snapshot through the
  CLI
- `vistrea-review-design`: register a design baseline, map regions to live
  nodes, run comparisons, and manage the Review Issue lifecycle to verified
  fixes
- `vistrea-tune-ui`: apply and revert allowlisted visual previews on the live
  Runtime with TTL and exact applied/rejected partitions
- `vistrea-verify-change`: run the core validators and the CI gate, triage or
  suppress findings, and diff observed coverage between builds
- `vistrea-explore-ui`: drive bounded deterministic exploration through the
  Host's exploration Operations and read the resulting Screen Graph

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
