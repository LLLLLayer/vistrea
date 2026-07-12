// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "VistreaIOSSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "VistreaRuntimeModels",
            targets: ["VistreaRuntimeModels"]
        ),
        .library(
            name: "VistreaRuntimeUIKit",
            targets: ["VistreaRuntimeUIKit"]
        ),
        .library(
            name: "VistreaRuntimeConnection",
            targets: ["VistreaRuntimeConnection"]
        ),
        .library(
            name: "VistreaRuntimeUIKitConnection",
            targets: ["VistreaRuntimeUIKitConnection"]
        ),
        .library(
            name: "VistreaRuntimeSwiftUI",
            targets: ["VistreaRuntimeSwiftUI"]
        ),
        .executable(
            name: "VistreaRuntimeInteropFixtureClient",
            targets: ["VistreaRuntimeInteropFixtureClient"]
        ),
    ],
    targets: [
        .target(name: "VistreaRuntimeModels"),
        .target(
            name: "VistreaRuntimeConnection",
            dependencies: ["VistreaRuntimeModels"]
        ),
        .target(
            name: "VistreaRuntimeUIKit",
            dependencies: ["VistreaRuntimeModels"]
        ),
        .target(name: "VistreaRuntimeSwiftUI"),
        .target(
            name: "VistreaRuntimeUIKitConnection",
            dependencies: [
                "VistreaRuntimeConnection",
                "VistreaRuntimeUIKit",
            ]
        ),
        .testTarget(
            name: "VistreaRuntimeModelsTests",
            dependencies: ["VistreaRuntimeModels"]
        ),
        .testTarget(
            name: "VistreaRuntimeSwiftUITests",
            dependencies: ["VistreaRuntimeSwiftUI"]
        ),
        .testTarget(
            name: "VistreaRuntimeConnectionTests",
            dependencies: [
                "VistreaRuntimeConnection",
                "VistreaRuntimeModels",
            ]
        ),
        .executableTarget(
            name: "VistreaRuntimeInteropFixtureClient",
            dependencies: [
                "VistreaRuntimeConnection",
                "VistreaRuntimeModels",
            ],
            path: "Tests/InteropFixtureClient"
        ),
    ]
)
