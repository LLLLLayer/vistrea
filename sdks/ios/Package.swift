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
    ],
    targets: [
        .target(name: "VistreaRuntimeModels"),
        .testTarget(
            name: "VistreaRuntimeModelsTests",
            dependencies: ["VistreaRuntimeModels"]
        ),
    ]
)
