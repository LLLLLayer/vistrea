# Studio Golden Snapshots

Studio presentation snapshots are pixel-compared inside rendering-environment buckets:

```text
macos-<major>-<architecture>-<backing-scale>x/<snapshot-name>.png
```

Record only on a deliberate reference machine:

```bash
VISTREA_RECORD_STUDIO_SNAPSHOTS=1 \
  swift test --package-path apps/studio-macos --filter StudioPresentationTests
```

Run the same command without the environment variable to compare against the current
bucket. A missing bucket is reported as skipped, not accepted as a passing comparison.
Pixel mismatches attach the baseline, actual image, and highlighted diff to the XCTest
result and also write them under the system temporary directory at
`VistreaStudioSnapshotDiffs/<bucket>/<snapshot-name>/`.

Pull-request CI sets `VISTREA_REQUIRE_STUDIO_SNAPSHOTS=1`. In that mode a missing
bucket fails closed and writes every actual image beneath
`VISTREA_STUDIO_SNAPSHOT_ARTIFACTS_DIR`. Review those images on the runner that owns
the bucket, then commit them under this directory; never make the recording mode a
passing regression gate.

Do not copy a baseline between buckets. Each committed bucket must be captured and
reviewed on the environment named by its directory.
