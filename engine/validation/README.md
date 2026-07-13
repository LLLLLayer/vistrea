# Validation Engine

Executes the built-in `ruleset.vistrea.core` validators over persisted Snapshots and the materialized Screen Graph, through `data/api` only.

`ValidationEngine` implements the first verified rule set. The rules complement, never repeat, protocol semantic checks — a Snapshot is already structurally coherent when persisted, so validators judge product quality:

- structural: `structural.duplicate-stable-id` (one stable identifier resolving to several nodes breaks identity, automation, and tuning) and `structural.interactive-without-stable-id`;
- accessibility: `accessibility.minimum-touch-target` (44x44pt) and `accessibility.missing-label` on interactive nodes;
- visual: `visual.offscreen-interactive` (interactive nodes entirely outside the display) and `visual.zero-size-visible`;
- behavioral: `behavioral.unreachable-state` and `behavioral.dead-end-state` over observed Screen Graph transitions from the entry states.

Every run persists with exact finding counts enforced by the repository, states move `running -> succeeded`, and open findings suppress with a justified reason, optimistic concurrency, and synchronized run counts.



## Configuration

Callers may disable named core rules (`disabled_rules`) and raise or lower the
minimum touch-target threshold (`minimum_touch_target_points`, default 44).
Unknown rule identifiers fail closed as `invalid_argument`, and every
non-default configuration persists into the run's
`extensions["vistrea.configuration"]` so a lenient run can never masquerade as
a default one.

## Baseline-classified build regressions

`CompareBuilds` with a `baseline_tag` loads the frozen graph version created
by `tagGraphVersion` and classifies every removed coverage entry: removals
the baseline also exhibited become `regressed` (error severity, both
subjects, the baseline counterpart under `tag:<name>`), while removals
absent from the baseline stay plain `removed` — an intentional change.
States match by identity (layout digest including merge aliases) and
transitions by their dedup key, so curation and re-materialization do not
break classification.
