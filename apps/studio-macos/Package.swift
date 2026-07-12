// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "VistreaStudio",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "VistreaStudio", targets: ["VistreaStudioApp"]),
        .library(name: "VistreaStudioCore", targets: ["VistreaStudioCore"]),
    ],
    dependencies: [
        .package(name: "VistreaIOSSDK", path: "../../sdks/ios"),
    ],
    targets: [
        .target(
            name: "VistreaStudioCore",
            dependencies: [
                .product(name: "VistreaRuntimeModels", package: "VistreaIOSSDK"),
            ]
        ),
        .executableTarget(
            name: "VistreaStudioApp",
            dependencies: ["VistreaStudioCore"]
        ),
        .testTarget(
            name: "VistreaStudioCoreTests",
            dependencies: [
                "VistreaStudioCore",
                .product(name: "VistreaRuntimeModels", package: "VistreaIOSSDK"),
            ]
        ),
    ]
)
