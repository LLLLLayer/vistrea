package dev.vistrea.runtime.android

import dev.vistrea.protocol.v1.Compression
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.JsonSafeUInt
import dev.vistrea.protocol.v1.ObjectHash
import dev.vistrea.protocol.v1.ObjectRef
import kotlin.test.Test
import kotlin.test.assertContentEquals

class CapturedAndroidRuntimeObjectTest {
    @Test
    fun objectBytesAreDefensivelyCopiedAtBothBoundaries() {
        val source = byteArrayOf(1, 2, 3)
        val captured = CapturedAndroidRuntimeObject(
            reference = ObjectRef(
                hash = ObjectHash(
                    "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                ),
                mediaType = "application/octet-stream",
                byteSize = JsonSafeUInt(source.size.toLong()),
                compression = Compression.NONE,
                extensions = Extensions.empty(),
            ),
            bytes = source,
        )

        source[0] = 9
        val firstRead = captured.bytes
        firstRead[1] = 9

        assertContentEquals(byteArrayOf(1, 2, 3), captured.bytes)
    }
}
