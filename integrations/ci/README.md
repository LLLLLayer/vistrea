# CI Integration

The headless CI gate over the same authenticated Host Local API client as the CLI. It never imports Data, SQLite, Object Store, or Workspace path implementations.

## Run

```bash
pnpm build:host
export VISTREA_HOST_URL=http://127.0.0.1:43123
# Provision VISTREA_HOST_TOKEN through the pipeline's protected environment.
node .build/typescript/integrations/ci/main.js \
  [--snapshot <snapshot_id>] \
  [--project <project_id> --application <application_id>] \
  [--left-build <build_id> --right-build <build_id>] \ [--baseline-tag <tag>]
  [--fail-on info|warning|error|critical]
```

The gate validates the newest (or one named) Snapshot with the core rule set, optionally validates the Screen Graph and diffs two builds, and emits exactly one machine-readable JSON report on stdout.

Exit codes: `0` gate passed, `1` open findings at or above `--fail-on` (default `error`), `2` usage error, `3` the Host was unavailable or an operation failed.

Target-environment orchestration (booting devices and capturing inside the pipeline) remains a later slice; the gate judges evidence a pipeline has already captured through the Host.

With `--baseline-tag`, removed coverage that the frozen baseline graph version also exhibited classifies as `regressed`, the report lists the regressions under `build_regressions`, and any regression fails the gate (exit `1`) regardless of the severity threshold — intentional removals stay `removed` and pass.

The `--fail-on` threshold applies to validation findings only. Build-diff coverage differences never fail the gate on their own — a removal without a baseline is an intentional change — which is exactly why `--baseline-tag` exists: it is the only way a coverage loss can fail the pipeline. `--left-build`/`--right-build` require `--project` and `--application`.
