# Design Review and Tuning Engine

Maps design baselines to Runtime Snapshots and UI Nodes, compares visual properties, manages Review Issue lifecycles, and creates, applies, reverts, stores, and exports `TuningPatch` objects.

- Enable tuning only in Debug/Internal builds.
- Allow only explicit visual properties.
- Display source truth and preview values separately.
- Record target node, original value, preview value, design evidence, and environment.
- Keep every patch reversible and reviewable.
- Never call arbitrary business methods or represent a preview as a source-code change.

## Pixel comparison

`RunDesignComparison` with `include_pixel: true` compares every mapped region
pixel by pixel in normalized region coordinates. It records sampled pixels,
changed-pixel ratio, mean channel delta, and maximum channel delta under
`extensions["vistrea.pixel"]`; localized regressions remain visible even when
the two regions have identical mean colors. The decoder supports eight-bit
greyscale, RGB, and RGBA non-interlaced PNGs. Anything else degrades the
comparison to `partial` quality with the reason recorded instead of guessing.

`PromoteVisualBaseline` turns a captured screenshot into an immutable,
content-addressed `approved_build` Design Reference. A Design Difference can
be promoted directly into a Review Issue without copying target or value
fields. `RecaptureAndVerifyIssue` accepts only a different real build, captures
fresh screenshot/tree truth, reruns the comparison, and resolves only a
complete passing result.

## Tuning and source handoff

The current cross-platform allowlist is `alpha`, `foreground_color`,
`background_color`, `font`, `spacing`, `content_insets`, and `corner_radius`.
Native adapters read the live original, apply only supported view/property
combinations, and restore captured originals on explicit revert, partial
failure, TTL expiry, disconnect, or termination. `GenerateTuningSourceSuggestions`
converts a patch into strict source-oriented instructions using captured
component/controller/module context. It never edits source or fabricates a
file path when the Snapshot lacks source provenance.
