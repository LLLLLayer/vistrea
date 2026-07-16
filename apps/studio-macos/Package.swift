// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "VistreaStudio",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "VistreaStudio", targets: ["VistreaStudioApp"]),
        .executable(
            name: "VistreaStudioAcceptanceProbe",
            targets: ["VistreaStudioAcceptanceProbe"]
        ),
        .library(name: "VistreaStudioCore", targets: ["VistreaStudioCore"]),
        .library(name: "VistreaStudioHostRuntime", targets: ["VistreaStudioHostRuntime"]),
    ],
    dependencies: [
        .package(name: "VistreaIOSSDK", path: "../../sdks/ios"),
        .package(
            url: "https://github.com/sparkle-project/Sparkle",
            exact: "2.9.4"
        ),
    ],
    targets: [
        .target(
            name: "VistreaStudioCore",
            dependencies: [
                .product(name: "VistreaRuntimeModels", package: "VistreaIOSSDK"),
            ]
        ),
        .target(
            name: "VistreaStudioHostRuntime",
            dependencies: ["VistreaStudioCore"]
        ),
        .executableTarget(
            name: "VistreaStudioApp",
            dependencies: [
                "VistreaStudioCore",
                "VistreaStudioHostRuntime",
                .product(name: "Sparkle", package: "Sparkle"),
            ]
        ),
        .executableTarget(
            name: "VistreaStudioAcceptanceProbe",
            dependencies: ["VistreaStudioCore"]
        ),
        .testTarget(
            name: "VistreaStudioCoreTests",
            dependencies: [
                "VistreaStudioCore",
                "VistreaStudioHostRuntime",
                .product(name: "VistreaRuntimeModels", package: "VistreaIOSSDK"),
            ]
        ),
        .testTarget(
            name: "VistreaStudioAppTests",
            dependencies: [
                "VistreaStudioApp",
                "VistreaStudioCore",
                "VistreaStudioHostRuntime",
                .product(name: "VistreaRuntimeModels", package: "VistreaIOSSDK"),
            ]
        ),
    ]
)
