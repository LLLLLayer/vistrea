# Tools

Development-time schema generation, fixture maintenance, protocol validation, repository checks, and release helpers. Product runtime behavior must not depend on temporary scripts.

`protocol/` contains the strict JSON Schema and semantic fixture validator used by `pnpm protocol:validate`.

`ci/` contains checksum-verified bootstrap tools used only by GitHub Actions.
The iOS Demo job installs the exact XcodeGen release declared there before it
regenerates and verifies the checked-in project.

`release/` assembles the SwiftPM Studio executable into a Universal macOS app,
prepares architecture-matched pinned Node.js and production Host runtimes,
proves the embedded Host can open and release a temporary Workspace before and
after local ad-hoc signing, signs all nested Host and Sparkle code, and produces
local ZIP/DMG artifacts and checksums. The packager has no formal-distribution
credential inputs, publication workflow, or update-feed generator. The tooling
composes product runtime modules but does not own product logic.
