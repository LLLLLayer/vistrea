import AppKit
import CoreGraphics
import XCTest

/// Pixel-based snapshot verification for the Studio's deterministic SwiftUI surfaces.
///
/// Baselines are intentionally partitioned by the rendering characteristics that make
/// AppKit screenshots incompatible: macOS major version, CPU architecture, and backing
/// scale. Set `VISTREA_RECORD_STUDIO_SNAPSHOTS=1` to record the current environment's
/// bucket. A missing baseline otherwise skips the test with an actionable message; CI
/// can set `VISTREA_REQUIRE_STUDIO_SNAPSHOTS=1` to fail closed and retain the actual
/// image for review instead.
@MainActor
struct StudioGoldenSnapshotHarness {
    struct Tolerance: Sendable {
        let maximumChannelDelta: UInt8
        let maximumDifferentPixelRatio: Double

        static let studioDefault = Tolerance(
            maximumChannelDelta: 3,
            maximumDifferentPixelRatio: 0.0005
        )
    }

    struct Environment: Equatable, Sendable {
        let macOSMajorVersion: Int
        let architecture: String
        let backingScale: Int

        var bucketName: String {
            "macos-\(macOSMajorVersion)-\(architecture)-\(backingScale)x"
        }

        static func current(for bitmap: NSBitmapImageRep, logicalSize: CGSize) -> Environment {
            let horizontalScale = logicalSize.width > 0
                ? CGFloat(bitmap.pixelsWide) / logicalSize.width
                : 1
            let verticalScale = logicalSize.height > 0
                ? CGFloat(bitmap.pixelsHigh) / logicalSize.height
                : 1
            let scale = max(horizontalScale, verticalScale)
            return Environment(
                macOSMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                architecture: currentArchitecture,
                backingScale: max(1, Int(scale.rounded()))
            )
        }

        private static var currentArchitecture: String {
            #if arch(arm64)
            return "arm64"
            #elseif arch(x86_64)
            return "x86_64"
            #else
            return "unknown"
            #endif
        }
    }

    private struct PixelImage {
        let width: Int
        let height: Int
        let rgba: [UInt8]
    }

    private struct Difference {
        let differentPixelCount: Int
        let totalPixelCount: Int
        let maximumObservedChannelDelta: UInt8
        let image: PixelImage

        var differentPixelRatio: Double {
            guard totalPixelCount > 0 else { return 0 }
            return Double(differentPixelCount) / Double(totalPixelCount)
        }
    }

    let testCase: XCTestCase
    let snapshotsDirectory: URL
    let differencesDirectory: URL
    let tolerance: Tolerance
    let environment: [String: String]

    init(
        testCase: XCTestCase,
        snapshotsDirectory: URL,
        differencesDirectory: URL? = nil,
        tolerance: Tolerance = .studioDefault,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.testCase = testCase
        self.snapshotsDirectory = snapshotsDirectory
        if let differencesDirectory {
            self.differencesDirectory = differencesDirectory
        } else if let artifactsPath = environment[
            "VISTREA_STUDIO_SNAPSHOT_ARTIFACTS_DIR"
        ], !artifactsPath.isEmpty {
            self.differencesDirectory = URL(
                fileURLWithPath: artifactsPath,
                isDirectory: true
            )
        } else {
            self.differencesDirectory = FileManager.default.temporaryDirectory
                .appending(path: "VistreaStudioSnapshotDiffs", directoryHint: .isDirectory)
        }
        self.tolerance = tolerance
        self.environment = environment
    }

    func assertMatches(
        _ bitmap: NSBitmapImageRep,
        named name: String,
        logicalSize: CGSize,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let safeName = try validatedSnapshotName(name)
        let currentEnvironment = Environment.current(for: bitmap, logicalSize: logicalSize)
        let bucketDirectory = snapshotsDirectory
            .appending(path: currentEnvironment.bucketName, directoryHint: .isDirectory)
        let baselineURL = bucketDirectory.appending(path: "\(safeName).png")
        let actualPNG = try pngData(for: bitmap)

        guard !(isRecording && requiresBaselines) else {
            throw NSError(
                domain: "StudioGoldenSnapshotHarness",
                code: 5,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Snapshot recording and required-baseline verification are mutually exclusive."
                ]
            )
        }

        if isRecording {
            try FileManager.default.createDirectory(
                at: bucketDirectory,
                withIntermediateDirectories: true
            )
            try actualPNG.write(to: baselineURL, options: .atomic)
            attach(actualPNG, name: "RECORDED-\(currentEnvironment.bucketName)-\(safeName)")
            return
        }

        guard FileManager.default.fileExists(atPath: baselineURL.path) else {
            if requiresBaselines {
                let candidateURL = try writeMissingBaselineArtifact(
                    name: safeName,
                    environment: currentEnvironment,
                    actualPNG: actualPNG
                )
                attach(actualPNG, name: "ACTUAL-MISSING-BASELINE-\(safeName)")
                XCTFail(
                    "Missing required Studio golden \(baselineURL.path). "
                        + "Candidate image: \(candidateURL.path)",
                    file: file,
                    line: line
                )
                return
            }
            throw XCTSkip(
                "Missing Studio golden \(baselineURL.path). "
                    + "Record this rendering bucket with VISTREA_RECORD_STUDIO_SNAPSHOTS=1."
            )
        }

        let baselineData = try Data(contentsOf: baselineURL)
        // Deterministic renders normally take this fast path. Decode and normalize only
        // when PNG container bytes differ, so genuine pixel comparisons remain available
        // without making every unchanged presentation test expensive.
        if actualPNG == baselineData {
            return
        }
        let baseline = try XCTUnwrap(
            NSBitmapImageRep(data: baselineData),
            "The golden baseline is not a readable PNG: \(baselineURL.path)",
            file: file,
            line: line
        )
        let actualPixels = try normalizedPixels(for: bitmap)
        let baselinePixels = try normalizedPixels(for: baseline)

        guard actualPixels.width == baselinePixels.width,
              actualPixels.height == baselinePixels.height
        else {
            let artifactDirectory = try writeArtifacts(
                name: safeName,
                environment: currentEnvironment,
                actualPNG: actualPNG,
                baselinePNG: baselineData,
                differencePNG: nil
            )
            attach(baselineData, name: "BASELINE-\(safeName)")
            attach(actualPNG, name: "ACTUAL-\(safeName)")
            XCTFail(
                "Studio golden dimensions changed from "
                    + "\(baselinePixels.width)x\(baselinePixels.height) to "
                    + "\(actualPixels.width)x\(actualPixels.height). "
                    + "Artifacts: \(artifactDirectory.path)",
                file: file,
                line: line
            )
            return
        }

        let difference = compare(actual: actualPixels, baseline: baselinePixels)
        guard difference.differentPixelRatio > tolerance.maximumDifferentPixelRatio else {
            return
        }

        let differencePNG = try pngData(for: difference.image)
        let artifactDirectory = try writeArtifacts(
            name: safeName,
            environment: currentEnvironment,
            actualPNG: actualPNG,
            baselinePNG: baselineData,
            differencePNG: differencePNG
        )
        attach(baselineData, name: "BASELINE-\(safeName)")
        attach(actualPNG, name: "ACTUAL-\(safeName)")
        attach(differencePNG, name: "DIFF-\(safeName)")
        XCTFail(
            String(
                format: "Studio golden %@ differs in %.4f%% of pixels (%d/%d; maximum channel delta %d). Artifacts: %@",
                safeName,
                difference.differentPixelRatio * 100,
                difference.differentPixelCount,
                difference.totalPixelCount,
                Int(difference.maximumObservedChannelDelta),
                artifactDirectory.path
            ),
            file: file,
            line: line
        )
    }

    private var isRecording: Bool {
        let value = environment["VISTREA_RECORD_STUDIO_SNAPSHOTS"]?.lowercased()
        return value == "1" || value == "true" || value == "yes"
    }

    private var requiresBaselines: Bool {
        let value = environment["VISTREA_REQUIRE_STUDIO_SNAPSHOTS"]?.lowercased()
        return value == "1" || value == "true" || value == "yes"
    }

    private func validatedSnapshotName(_ name: String) throws -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard !name.isEmpty,
              name.unicodeScalars.allSatisfy(allowed.contains)
        else {
            throw NSError(
                domain: "StudioGoldenSnapshotHarness",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid snapshot name: \(name)"]
            )
        }
        return name
    }

    private func pngData(for bitmap: NSBitmapImageRep) throws -> Data {
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    private func pngData(for pixels: PixelImage) throws -> Data {
        let bitmap = try XCTUnwrap(
            NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: pixels.width,
                pixelsHigh: pixels.height,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: pixels.width * 4,
                bitsPerPixel: 32
            )
        )
        guard let destination = bitmap.bitmapData else {
            throw NSError(
                domain: "StudioGoldenSnapshotHarness",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unable to allocate diff bitmap storage"]
            )
        }
        pixels.rgba.withUnsafeBytes { source in
            guard let sourceAddress = source.baseAddress else { return }
            destination.update(from: sourceAddress.assumingMemoryBound(to: UInt8.self), count: pixels.rgba.count)
        }
        return try pngData(for: bitmap)
    }

    private func normalizedPixels(for bitmap: NSBitmapImageRep) throws -> PixelImage {
        let width = bitmap.pixelsWide
        let height = bitmap.pixelsHigh
        guard width > 0, height > 0, let image = bitmap.cgImage else {
            throw NSError(
                domain: "StudioGoldenSnapshotHarness",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Unable to normalize an empty bitmap"]
            )
        }

        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let didRender = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let address = bytes.baseAddress,
                  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                      data: address,
                      width: width,
                      height: height,
                      bitsPerComponent: 8,
                      bytesPerRow: width * 4,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  )
            else {
                return false
            }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard didRender else {
            throw NSError(
                domain: "StudioGoldenSnapshotHarness",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Unable to create an sRGB comparison buffer"]
            )
        }
        return PixelImage(width: width, height: height, rgba: rgba)
    }

    private func compare(actual: PixelImage, baseline: PixelImage) -> Difference {
        let pixelCount = actual.width * actual.height
        var differentPixelCount = 0
        var maximumObservedChannelDelta: UInt8 = 0
        var differenceBytes = [UInt8](repeating: 0, count: actual.rgba.count)

        for pixelIndex in 0..<pixelCount {
            let byteIndex = pixelIndex * 4
            var pixelMaximumDelta: UInt8 = 0
            for channel in 0..<4 {
                let actualValue = actual.rgba[byteIndex + channel]
                let baselineValue = baseline.rgba[byteIndex + channel]
                let delta = actualValue >= baselineValue
                    ? actualValue - baselineValue
                    : baselineValue - actualValue
                pixelMaximumDelta = max(pixelMaximumDelta, delta)
                maximumObservedChannelDelta = max(maximumObservedChannelDelta, delta)
            }

            if pixelMaximumDelta > tolerance.maximumChannelDelta {
                differentPixelCount += 1
                differenceBytes[byteIndex] = 255
                differenceBytes[byteIndex + 1] = UInt8(
                    min(180, UInt16(pixelMaximumDelta) * 2)
                )
                differenceBytes[byteIndex + 2] = 0
                differenceBytes[byteIndex + 3] = 255
            } else {
                let luminance = UInt8(
                    (UInt16(actual.rgba[byteIndex])
                        + UInt16(actual.rgba[byteIndex + 1])
                        + UInt16(actual.rgba[byteIndex + 2])) / 3
                )
                let subdued = UInt8(32 + UInt16(luminance) / 5)
                differenceBytes[byteIndex] = subdued
                differenceBytes[byteIndex + 1] = subdued
                differenceBytes[byteIndex + 2] = subdued
                differenceBytes[byteIndex + 3] = 255
            }
        }

        return Difference(
            differentPixelCount: differentPixelCount,
            totalPixelCount: pixelCount,
            maximumObservedChannelDelta: maximumObservedChannelDelta,
            image: PixelImage(
                width: actual.width,
                height: actual.height,
                rgba: differenceBytes
            )
        )
    }

    private func writeArtifacts(
        name: String,
        environment: Environment,
        actualPNG: Data,
        baselinePNG: Data,
        differencePNG: Data?
    ) throws -> URL {
        let directory = differencesDirectory
            .appending(path: environment.bucketName, directoryHint: .isDirectory)
            .appending(path: name, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try actualPNG.write(to: directory.appending(path: "actual.png"), options: .atomic)
        try baselinePNG.write(to: directory.appending(path: "baseline.png"), options: .atomic)
        if let differencePNG {
            try differencePNG.write(to: directory.appending(path: "diff.png"), options: .atomic)
        }
        return directory
    }

    private func writeMissingBaselineArtifact(
        name: String,
        environment: Environment,
        actualPNG: Data
    ) throws -> URL {
        let directory = differencesDirectory
            .appending(path: "candidates", directoryHint: .isDirectory)
            .appending(path: environment.bucketName, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let candidateURL = directory.appending(path: "\(name).png")
        try actualPNG.write(
            to: candidateURL,
            options: .atomic
        )
        return candidateURL
    }

    private func attach(_ png: Data, name: String) {
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        testCase.add(attachment)
    }
}
