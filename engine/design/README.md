# Design Review and Tuning Engine

Maps design baselines to Runtime Snapshots and UI Nodes, compares visual properties, manages Review Issue lifecycles, and creates, applies, reverts, stores, and exports `TuningPatch` objects.

- Enable tuning only in Debug/Internal builds.
- Allow only explicit visual properties.
- Display source truth and preview values separately.
- Record target node, original value, preview value, design evidence, and environment.
- Keep every patch reversible and reviewable.
- Never call arbitrary business methods or represent a preview as a source-code change.

## Pixel comparison

`RunDesignComparison` with `include_pixel: true` also compares the mean pixel
color of every mapped design region (decoded from the design asset PNG)
against the captured screenshot region, emitting `color` differences with
canonical `color_rgba` values and the sampled-pixel counts under
`extensions["vistrea.pixel"]`. The decoder supports eight-bit greyscale, RGB,
and RGBA non-interlaced PNGs; anything else degrades the comparison to
`partial` quality with the reason recorded instead of guessing about visual
truth.
