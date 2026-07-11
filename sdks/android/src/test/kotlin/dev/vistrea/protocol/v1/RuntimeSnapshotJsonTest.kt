package dev.vistrea.protocol.v1

import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class RuntimeSnapshotJsonTest {
    private val repositoryRoot: Path =
        Paths.get(assertNotNull(System.getProperty("vistrea.repository.root")))

    @Test
    fun canonicalSnapshotsDecodeAndReencodeWithoutChangingJsonValues() {
        val fixtures =
            listOf(
                "protocol/fixtures/v1/runtime-snapshot/valid/minimal.json",
                "protocol/fixtures/v1/runtime-snapshot/valid/android-view.json",
                "protocol/fixtures/v1/compatibility/higher-minor-snapshot.json",
            )

        fixtures.forEach { fixture ->
            val source = readFixture(fixture)
            val decoded = RuntimeSnapshotJson.decode(source)
            val encoded = RuntimeSnapshotJson.encode(decoded)

            assertEquals(decoded, RuntimeSnapshotJson.decode(encoded), fixture)
            assertJsonEquivalent(
                RuntimeSnapshotJson.format.parseToJsonElement(source),
                RuntimeSnapshotJson.format.parseToJsonElement(encoded),
                fixture,
            )
        }
    }

    @Test
    fun androidViewFixtureExposesTypedPlatformTreeAndNodeIdentifiers() {
        val snapshot =
            RuntimeSnapshotJson.decode(
                readFixture("protocol/fixtures/v1/runtime-snapshot/valid/android-view.json"),
            )

        assertEquals(Platform.ANDROID, snapshot.runtimeContext.platform)
        assertEquals(
            "snapshot_019f0000-0000-7000-8000-000000000003",
            snapshot.snapshotId.value,
        )

        val tree = snapshot.trees.single()
        assertEquals(UiTreeKind.VIEW, tree.kind)
        assertEquals("tree_019f0000-0000-7000-8000-000000000003", tree.treeId.value)

        val nodes = assertNotNull(tree.payload.inlineNodes)
        assertEquals(
            JsonPrimitive("open_catalog"),
            nodes.last().extensions["android.view.resource_id"],
        )
        assertEquals(NodeAction.TAP, nodes.last().actions.single())
    }

    @Test
    fun higherMinorAndArbitraryNamespacedExtensionJsonArePreservedLosslessly() {
        val source =
            RuntimeSnapshotJson.format
                .parseToJsonElement(
                    readFixture("protocol/fixtures/v1/compatibility/higher-minor-snapshot.json"),
                ).jsonObject
        val arbitraryValue =
            RuntimeSnapshotJson.format.parseToJsonElement(
                """
                {
                  "null_value": null,
                  "boolean_value": true,
                  "number_value": 9007199254740991,
                  "decimal_value": 1.25,
                  "string_value": "preserve me",
                  "array_value": [1, "two", false, null],
                  "object_value": {"nested": ["value"]}
                }
                """.trimIndent(),
            )
        val extended =
            JsonObject(
                source +
                    (
                        "extensions" to
                            JsonObject(
                                source.getValue("extensions").jsonObject +
                                    ("com.example.arbitrary_payload" to arbitraryValue),
                            )
                    ),
            )

        val decoded = RuntimeSnapshotJson.decode(extended.toString())
        assertEquals(1L, decoded.protocolVersion.minor)
        assertEquals(arbitraryValue, decoded.extensions["com.example.arbitrary_payload"])

        val encodedExtensions =
            RuntimeSnapshotJson.format
                .parseToJsonElement(RuntimeSnapshotJson.encode(decoded))
                .jsonObject
                .getValue("extensions")
                .jsonObject
        assertEquals(arbitraryValue, encodedExtensions["com.example.arbitrary_payload"])
    }

    @Test
    fun namespacedCapabilityExtensionFixtureDecodesAndReencodes() {
        val source =
            readFixture("protocol/fixtures/v1/compatibility/namespaced-extension.json")
        val capabilities =
            RuntimeSnapshotJson.format.decodeFromString<CapabilitySet>(source)
        val encoded = RuntimeSnapshotJson.format.encodeToString(capabilities)

        assertEquals(
            JsonPrimitive("demo"),
            capabilities.extensions["com.example.future_capability"]
                ?.jsonObject
                ?.get("configuration"),
        )
        assertJsonEquivalent(
            RuntimeSnapshotJson.format.parseToJsonElement(source),
            RuntimeSnapshotJson.format.parseToJsonElement(encoded),
            "namespaced-extension.json",
        )
    }

    @Test
    fun unknownTopLevelCoreFieldIsRejected() {
        val error =
            assertFailsWith<SerializationException> {
                RuntimeSnapshotJson.decode(
                    readFixture(
                        "protocol/fixtures/v1/runtime-snapshot/invalid/unknown-core-field.json",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unexpected"))
    }

    @Test
    fun unknownNestedCoreFieldIsRejected() {
        val source =
            RuntimeSnapshotJson.format
                .parseToJsonElement(
                    readFixture("protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"),
                ).jsonObject
        val trees = source.getValue("trees") as JsonArray
        val tree = trees.single().jsonObject
        val payload = tree.getValue("payload").jsonObject
        val nodes = payload.getValue("inline_nodes") as JsonArray
        val node = nodes.single().jsonObject
        val invalidNode = JsonObject(node + ("future_core_field" to JsonPrimitive(true)))
        val invalidPayload = JsonObject(payload + ("inline_nodes" to JsonArray(listOf(invalidNode))))
        val invalidTree = JsonObject(tree + ("payload" to invalidPayload))
        val invalidSnapshot = JsonObject(source + ("trees" to JsonArray(listOf(invalidTree))))

        val error =
            assertFailsWith<SerializationException> {
                RuntimeSnapshotJson.decode(invalidSnapshot.toString())
            }

        assertTrue(error.message.orEmpty().contains("future_core_field"))
    }

    @Test
    fun unnamespacedExtensionKeyIsRejected() {
        val source =
            RuntimeSnapshotJson.format
                .parseToJsonElement(
                    readFixture("protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"),
                ).jsonObject
        val invalidSnapshot =
            JsonObject(
                source +
                    (
                        "extensions" to
                            JsonObject(mapOf("invalid" to JsonPrimitive(true)))
                    ),
            )

        val error =
            assertFailsWith<SerializationException> {
                RuntimeSnapshotJson.decode(invalidSnapshot.toString())
            }

        assertTrue(error.message.orEmpty().contains("not namespaced"))
    }

    @Test
    fun syntacticallyCanonicalButInvalidTimestampIsRejected() {
        val source =
            RuntimeSnapshotJson.format
                .parseToJsonElement(
                    readFixture("protocol/fixtures/v1/runtime-snapshot/valid/minimal.json"),
                ).jsonObject
        val capturedAt = source.getValue("captured_at").jsonObject
        val invalidCapturedAt =
            JsonObject(capturedAt + ("wall_time" to JsonPrimitive("2026-99-99T00:00:00Z")))
        val invalidSnapshot = JsonObject(source + ("captured_at" to invalidCapturedAt))

        assertFailsWith<IllegalArgumentException> {
            RuntimeSnapshotJson.decode(invalidSnapshot.toString())
        }
    }

    private fun readFixture(relativePath: String): String =
        Files.readString(repositoryRoot.resolve(relativePath))

    private fun assertJsonEquivalent(
        expected: JsonElement,
        actual: JsonElement,
        path: String,
    ) {
        when {
            expected is JsonObject && actual is JsonObject -> {
                assertEquals(expected.keys, actual.keys, "$path object keys")
                expected.forEach { (key, value) ->
                    assertJsonEquivalent(value, actual.getValue(key), "$path.$key")
                }
            }

            expected is JsonArray && actual is JsonArray -> {
                assertEquals(expected.size, actual.size, "$path array size")
                expected.indices.forEach { index ->
                    assertJsonEquivalent(expected[index], actual[index], "$path[$index]")
                }
            }

            expected is JsonNull && actual is JsonNull -> Unit

            expected is JsonPrimitive && actual is JsonPrimitive -> {
                val expectedNumber =
                    if (expected.isString) null else expected.content.toBigDecimalOrNull()
                val actualNumber =
                    if (actual.isString) null else actual.content.toBigDecimalOrNull()
                if (expectedNumber != null && actualNumber != null) {
                    assertTrue(
                        expectedNumber.compareTo(actualNumber) == 0,
                        "$path expected $expectedNumber but was $actualNumber",
                    )
                } else {
                    assertEquals(expected, actual, path)
                }
            }

            else -> assertEquals(expected, actual, path)
        }
    }

    private fun String.toBigDecimalOrNull(): BigDecimal? =
        try {
            BigDecimal(this)
        } catch (_: NumberFormatException) {
            null
        }
}
