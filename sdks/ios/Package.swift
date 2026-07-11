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
    ],
    targets: [
        .target(name: "VistreaRuntimeModels"),
        .target(
            name: "VistreaRuntimeUIKit",
            dependencies: ["VistreaRuntimeModels"]
        ),
        .testTarget(
            name: "VistreaRuntimeModelsTests",
            dependencies: ["VistreaRuntimeModels"]
        ),
    ]
)
