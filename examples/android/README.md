# Android Examples

`VistreaDemoApp/` is the canonical native Android View/ViewGroup executable fixture. Its Gradle build copies the shared Scenario manifest and fixtures from `../scenarios/` into generated assets, so Android does not maintain a second contract corpus.

The application can launch every required Scenario ID through its chooser or deterministic intent extras. See [`VistreaDemoApp/README.md`](VistreaDemoApp/README.md) for build and launch commands.
