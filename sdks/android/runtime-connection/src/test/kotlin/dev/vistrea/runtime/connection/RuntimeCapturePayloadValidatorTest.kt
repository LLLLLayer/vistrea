package dev.vistrea.runtime.connection

import dev.vistrea.protocol.v1.ColorSpace
import dev.vistrea.protocol.v1.Compression
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.JsonSafeUInt
import dev.vistrea.protocol.v1.NonEmptyRect
import dev.vistrea.protocol.v1.ObjectHash
import dev.vistrea.protocol.v1.ObjectRef
import dev.vistrea.protocol.v1.RuntimeSnapshotJson
import dev.vistrea.protocol.v1.ScreenshotEvidence
import dev.vistrea.protocol.v1.SystemChrome
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RuntimeCapturePayloadValidatorTest {
    @Test
    fun acceptsExactAssociatedBytesAndReturnsAnIsolatedTransportCopy() {
        val fixture = payload(OBJECT_BYTES)
        val validated = RuntimeCapturePayloadValidator.validate(fixture, LIMITS)
        assertEquals(fixture.snapshot, validated.snapshot)
        assertEquals(fixture.objects.single().reference, validated.objects.single().reference)
        assertContentEquals(OBJECT_BYTES, validated.objects.single().bytes)

        val providerCopy = fixture.objects.single().bytes
        providerCopy[0] = 0
        assertContentEquals(OBJECT_BYTES, validated.objects.single().bytes)
    }

    @Test
    fun rejectsMissingUnassociatedCorruptAndOverLimitObjects() {
        val valid = payload(OBJECT_BYTES)
        assertProtocolViolation(
            RuntimeSnapshotCapturePayload(valid.snapshot, objects = emptyList()),
            LIMITS,
        )
        assertProtocolViolation(
            RuntimeSnapshotCapturePayload(
                valid.snapshot.copy(screenshot = null),
                objects = valid.objects,
            ),
            LIMITS,
        )
        assertProtocolViolation(payload("Corrupt".toByteArray(Charsets.UTF_8)), LIMITS)
        assertProtocolViolation(
            valid,
            LIMITS.copy(maximumObjectBytes = OBJECT_BYTES.size.toLong() - 1),
        )
    }

    private fun payload(bytes: ByteArray): RuntimeSnapshotCapturePayload {
        val original = RuntimeSnapshotJson.decode(FIXTURE_PATH.toFile().readText(Charsets.UTF_8))
        val reference = ObjectRef(
            hash = ObjectHash(OBJECT_HASH),
            mediaType = "image/png",
            byteSize = JsonSafeUInt(OBJECT_BYTES.size.toLong()),
            compression = Compression.NONE,
            logicalName = "validator.png",
            extensions = Extensions.empty(),
        )
        val screenshot = ScreenshotEvidence(
            objectRef = reference,
            captureStartedAt = original.capturedAt,
            captureFinishedAt = original.capturedAt,
            treeSkewMs = 0.0,
            coverage = NonEmptyRect(
                x = 0.0,
                y = 0.0,
                width = original.display.logicalSize.width,
                height = original.display.logicalSize.height,
            ),
            pixelSize = original.display.pixelSize,
            systemChrome = SystemChrome.EXCLUDED,
            colorSpace = ColorSpace.SRGB,
            extensions = Extensions.empty(),
        )
        return RuntimeSnapshotCapturePayload(
            snapshot = original.copy(screenshot = screenshot),
            objects = listOf(RuntimeObjectPayload(reference, bytes)),
        )
    }

    private fun assertProtocolViolation(
        payload: RuntimeSnapshotCapturePayload,
        limits: RuntimeSessionLimits,
    ) {
        val error = assertFailsWith<RuntimeConnectionException> {
            RuntimeCapturePayloadValidator.validate(payload, limits)
        }
        assertEquals(RuntimeConnectionErrorCode.PROTOCOL_VIOLATION, error.code)
    }

    private companion object {
        val OBJECT_BYTES = "Vistrea".toByteArray(Charsets.UTF_8)
        const val OBJECT_HASH =
            "sha256:b0cd09405ae15f1cfb3f4b291002921832c81e26ed7f308c56b5c1eb5a791de5"
        val LIMITS = RuntimeSessionLimits(
            maximumLineBytes = 4 * 1_024 * 1_024,
            maximumObjectBytes = 64 * 1_024 * 1_024L,
            maximumChunkBytes = 64 * 1_024,
        )
        val FIXTURE_PATH: Path = Path.of(
            System.getProperty("vistrea.repository.root"),
            "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json",
        )
    }
}
