# Documentation

## Product and repository

- `PROJECT_OVERVIEW.md`: product definition, boundaries, core concepts, and roadmap.
- `REPOSITORY_STRUCTURE.md`: repository tree, module ownership, and dependency rules.
- `DEVELOPMENT.md`: development workflow, multi-agent work lanes, handoffs, and integration order.
- `DEVELOPMENT_PROGRESS.md`: current phase, implementation truth, decisions, verification evidence, and next milestones.

## Architecture

- `architecture/DATA_LAYER.md`: local-first storage, Data API, versioning, and Hub synchronization.
- `architecture/`: additional cross-module architecture, security, performance, and deployment documents.
- `interfaces/`: common contracts, Runtime SDK connection, automation, Engine, Data, Agent, and Hub interfaces.
- `product/STUDIO_INTERACTIONS.md`: Studio information architecture and primary user workflows.
- `protocol/`: Runtime Snapshot semantics, compatibility rules, and executable Data model coverage.
- `decisions/`: Architecture Decision Records for replaceable engineering choices.
- `roadmap/`: milestones and acceptance criteria.

Product invariants belong in `PROJECT_OVERVIEW.md`. Replaceable choices such as schema format, transport, database, and implementation language belong in ADRs.
