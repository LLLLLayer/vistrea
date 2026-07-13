@file:Suppress("DEPRECATION")

package dev.vistrea.runtime.android

import android.graphics.Color
import android.test.InstrumentationTestCase
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import dev.vistrea.protocol.v1.BuildId
import dev.vistrea.protocol.v1.ObjectHash
import dev.vistrea.protocol.v1.ProjectId
import dev.vistrea.protocol.v1.RedactedContentField
import dev.vistrea.protocol.v1.RuntimeSnapshotJson
import dev.vistrea.runtime.connection.RuntimeCaptureReason
import dev.vistrea.runtime.connection.RuntimeCaptureRequest
import dev.vistrea.runtime.connection.RuntimeCaptureScreenshotMode
import dev.vistrea.runtime.connection.RuntimeConnectionErrorCode
import dev.vistrea.runtime.connection.RuntimeConnectionException
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking

class AndroidViewRuntimeCaptureInstrumentedTest : InstrumentationTestCase() {
    fun testCapturesCanonicalTreeAndPngObject() {
        lateinit var captured: AndroidViewRuntimeCaptureResult
        instrumentation.runOnMainSync {
            val root = fixtureRoot()
            captured = adapter().capture(
                rootView = root,
                scenarioId = "demo.navigation.basic",
                includeScreenshot = true,
            )
        }

        val snapshot = captured.snapshot
        assertEquals("demo.navigation.basic", snapshot.extensions["vistrea.scenario_id"]?.toString()?.trim('"'))
        assertEquals(1, snapshot.trees.size)
        val nodes = requireNotNull(snapshot.trees.single().payload.inlineNodes)
        assertEquals(2, nodes.size)
        val button = snapshot.trees.single().payload.inlineNodes
            ?.single { it.stableId?.value == BUTTON_ID }
        assertNotNull(button)
        assertTrue(button?.actions?.contains(dev.vistrea.protocol.v1.NodeAction.TAP) == true)
        val root = snapshot.trees.single().payload.inlineNodes
            ?.single { it.stableId?.value == ROOT_ID }
        assertEquals(root?.nodeId, button?.parentId)
        assertEquals(listOf(button?.nodeId), root?.childIds)

        val objectValue = captured.objects.single()
        assertEquals("image/png", objectValue.reference.mediaType)
        val objectBytes = objectValue.bytes
        assertEquals(objectBytes.size.toLong(), objectValue.reference.byteSize.value)
        assertTrue(objectBytes.size > PNG_SIGNATURE.size)
        assertTrue(objectBytes.copyOf(PNG_SIGNATURE.size).contentEquals(PNG_SIGNATURE))
        val digest = MessageDigest.getInstance("SHA-256").digest(objectBytes)
        val expectedHash = "sha256:" + digest.joinToString("") { "%02x".format(it.toInt() and BYTE_MASK) }
        assertEquals(ObjectHash(expectedHash), objectValue.reference.hash)
        objectBytes[0] = 0
        assertTrue(objectValue.bytes.copyOf(PNG_SIGNATURE.size).contentEquals(PNG_SIGNATURE))
        val screenshot = requireNotNull(snapshot.screenshot)
        assertEquals(objectValue.reference, screenshot.objectRef)
        assertEquals(
            screenshot.pixelSize.width.value.toDouble(),
            screenshot.coverage.width * snapshot.display.pixelScaleX,
            PIXEL_EPSILON,
        )
        assertEquals(
            screenshot.pixelSize.height.value.toDouble(),
            screenshot.coverage.height * snapshot.display.pixelScaleY,
            PIXEL_EPSILON,
        )
        assertEquals(snapshot, RuntimeSnapshotJson.decode(RuntimeSnapshotJson.encode(snapshot)))
    }

    fun testPasswordTextIsRedacted() {
        lateinit var captured: AndroidViewRuntimeCaptureResult
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val root = FrameLayout(context).apply {
                tag = ROOT_ID
                setBackgroundColor(Color.WHITE)
            }
            val password = EditText(context).apply {
                tag = PASSWORD_ID
                contentDescription = PASSWORD_ID
                setText("secret-value")
                hint = "Password"
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            root.addView(password, FrameLayout.LayoutParams(MATCH_PARENT, CONTROL_HEIGHT_PX))
            layoutRoot(root)
            captured = adapter().capture(root, includeScreenshot = false)
        }

        val passwordNode = captured.snapshot.trees.single().payload.inlineNodes
            ?.single { it.stableId?.value == PASSWORD_ID }
        assertNull(passwordNode?.content?.text)
        assertNull(passwordNode?.content?.value)
        assertNull(passwordNode?.accessibility?.value)
        assertEquals(
            listOf(RedactedContentField.TEXT, RedactedContentField.VALUE),
            passwordNode?.content?.redactedFields,
        )
    }

    fun testOverLongTextTruncatesAndRecordsTheLimitation() {
        lateinit var captured: AndroidViewRuntimeCaptureResult
        val emoji = "😀"
        val overLimit = emoji.repeat(CaptureContentLimits.TEXT_CODE_POINT_LIMIT + 32)
        val overLimitHint = "h".repeat(CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT + 32)
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val root = FrameLayout(context).apply { tag = ROOT_ID }
            val console = EditText(context).apply {
                tag = CONSOLE_ID
                contentDescription = overLimit
                setText(overLimit)
                hint = overLimitHint
            }
            root.addView(console, FrameLayout.LayoutParams(MATCH_PARENT, CONTROL_HEIGHT_PX))
            layoutRoot(root)
            captured = adapter().capture(root, includeScreenshot = false)
        }

        val snapshot = captured.snapshot
        val tree = snapshot.trees.single()
        val console = requireNotNull(tree.payload.inlineNodes).single { it.stableId?.value == CONSOLE_ID }
        val text = requireNotNull(console.content.text)
        // Truncation cuts on a code-point boundary, so the last emoji survives
        // whole instead of leaving a lone surrogate that no consumer can read.
        assertEquals(
            CaptureContentLimits.TEXT_CODE_POINT_LIMIT,
            text.codePointCount(0, text.length),
        )
        assertTrue(text.endsWith(emoji))
        assertEquals(text, console.content.value)
        assertEquals(text, console.accessibility?.value)
        assertEquals(
            CaptureContentLimits.PLACEHOLDER_CODE_POINT_LIMIT,
            requireNotNull(console.content.placeholder).length,
        )

        // The loss is reported per canonical field with the node scope, so the
        // Snapshot stays schema-valid instead of failing Host validation.
        val truncated = console.captureLimitations.filter {
            it.code == "android.capture.text-truncated"
        }
        assertEquals(
            listOf(
                "content.content_description",
                "content.placeholder",
                "content.text",
                "content.value",
                "accessibility.label",
                "accessibility.value",
            ),
            truncated.map { it.scope?.field },
        )
        assertTrue(truncated.all { it.scope?.treeId == tree.treeId && it.scope?.nodeId == console.nodeId })
        assertEquals(snapshot, RuntimeSnapshotJson.decode(RuntimeSnapshotJson.encode(snapshot)))
    }

    fun testInvalidStableIdentifierIsReportedInsteadOfSilentlyDropped() {
        lateinit var captured: AndroidViewRuntimeCaptureResult
        instrumentation.runOnMainSync {
            val context = instrumentation.targetContext
            val root = FrameLayout(context).apply { tag = ROOT_ID }
            // A blank-prefixed tag is not a canonical stable_id; the View has
            // no other identifier, so stable identity vanishes.
            val invalid = Button(context).apply {
                tag = " not a stable id"
                text = "Open"
            }
            root.addView(invalid, FrameLayout.LayoutParams(MATCH_PARENT, CONTROL_HEIGHT_PX))
            layoutRoot(root)
            captured = adapter().capture(root, includeScreenshot = false)
        }

        val nodes = requireNotNull(captured.snapshot.trees.single().payload.inlineNodes)
        val button = nodes.single { it.role == "button" }
        assertNull(button.stableId)
        val limitation = button.captureLimitations.single()
        assertEquals("android.capture.stable-id-invalid", limitation.code)
        assertEquals("stable_id", limitation.scope?.field)
        assertEquals(button.nodeId, limitation.scope?.nodeId)

        // A View with a valid identifier reports nothing.
        val root = nodes.single { it.stableId?.value == ROOT_ID }
        assertTrue(root.captureLimitations.isEmpty())
    }

    fun testNodeLimitAndMainThreadFailClosed() {
        lateinit var root: FrameLayout
        instrumentation.runOnMainSync {
            root = fixtureRoot()
        }
        val wrongThread = runCatching { adapter().capture(root) }.exceptionOrNull()
        assertTrue(wrongThread is AndroidRuntimeCaptureException)
        assertEquals(
            AndroidRuntimeCaptureFailure.WRONG_THREAD,
            (wrongThread as AndroidRuntimeCaptureException).failure,
        )

        var nodeLimit: Throwable? = null
        instrumentation.runOnMainSync {
            nodeLimit = runCatching {
                adapter(maximumNodeCount = 1).capture(root, includeScreenshot = false)
            }.exceptionOrNull()
        }
        assertTrue(nodeLimit is AndroidRuntimeCaptureException)
        assertEquals(
            AndroidRuntimeCaptureFailure.NODE_LIMIT_EXCEEDED,
            (nodeLimit as AndroidRuntimeCaptureException).failure,
        )
    }

    fun testRuntimeConnectionProviderBridgesToMainThreadCanonicalCapture() {
        lateinit var root: FrameLayout
        instrumentation.runOnMainSync {
            root = fixtureRoot()
        }
        val provider = AndroidViewRuntimeSnapshotCaptureProvider(
            adapter = adapter(),
            rootViewProvider = { root },
            scenarioIdProvider = { "demo.navigation.basic" },
        )
        val payload = runBlocking {
            provider.capture(
                RuntimeCaptureRequest(
                    includePaths = listOf("trees"),
                    screenshot = RuntimeCaptureScreenshotMode.NONE,
                    reason = RuntimeCaptureReason.MANUAL,
                ),
            )
        }

        assertTrue(payload.objects.isEmpty())
        assertNull(payload.snapshot.screenshot)
        assertEquals(
            "demo.navigation.basic",
            payload.snapshot.extensions["vistrea.scenario_id"]?.toString()?.trim('"'),
        )
        assertTrue(payload.snapshot.trees.single().payload.inlineNodes?.isNotEmpty() == true)
    }

    fun testRuntimeConnectionProviderRejectsUnsupportedOrUnsatisfiedFieldMasks() {
        lateinit var root: FrameLayout
        instrumentation.runOnMainSync {
            root = fixtureRoot()
        }
        val provider = AndroidViewRuntimeSnapshotCaptureProvider(
            adapter = adapter(),
            rootViewProvider = { root },
        )
        val unsupported = runBlocking {
            runCatching {
                provider.capture(
                    RuntimeCaptureRequest(
                        includePaths = listOf("trees", "unknown"),
                        screenshot = RuntimeCaptureScreenshotMode.NONE,
                        reason = RuntimeCaptureReason.MANUAL,
                    ),
                )
            }.exceptionOrNull()
        }
        val unsatisfied = runBlocking {
            runCatching {
                provider.capture(
                    RuntimeCaptureRequest(
                        includePaths = listOf("trees"),
                        screenshot = RuntimeCaptureScreenshotMode.REFERENCE,
                        reason = RuntimeCaptureReason.MANUAL,
                    ),
                )
            }.exceptionOrNull()
        }

        assertTrue(unsupported is RuntimeConnectionException)
        assertEquals(
            RuntimeConnectionErrorCode.PROTOCOL_VIOLATION,
            (unsupported as RuntimeConnectionException).code,
        )
        assertTrue(unsatisfied is RuntimeConnectionException)
        assertEquals(
            RuntimeConnectionErrorCode.PROTOCOL_VIOLATION,
            (unsatisfied as RuntimeConnectionException).code,
        )
    }

    private fun fixtureRoot(): FrameLayout {
        val context = instrumentation.targetContext
        val root = FrameLayout(context).apply {
            tag = ROOT_ID
            contentDescription = ROOT_ID
            setBackgroundColor(Color.WHITE)
        }
        val button = Button(context).apply {
            tag = BUTTON_ID
            contentDescription = BUTTON_ID
            text = "Open catalog"
            setOnClickListener { }
        }
        root.addView(button, FrameLayout.LayoutParams(MATCH_PARENT, CONTROL_HEIGHT_PX))
        layoutRoot(root)
        return root
    }

    private fun layoutRoot(root: View) {
        root.measure(
            View.MeasureSpec.makeMeasureSpec(ROOT_WIDTH_PX, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(ROOT_HEIGHT_PX, View.MeasureSpec.EXACTLY),
        )
        root.layout(0, 0, ROOT_WIDTH_PX, ROOT_HEIGHT_PX)
    }

    private fun adapter(maximumNodeCount: Int = DEFAULT_TEST_NODE_LIMIT) =
        AndroidViewRuntimeCaptureAdapter(
            AndroidViewRuntimeCaptureConfiguration(
                projectId = ProjectId("project_019f0000-0000-7000-8000-000000000001"),
                buildId = BuildId("build_019f0000-0000-7000-8000-000000000002"),
                sdkVersion = "0.1.0",
                adapterVersion = "0.1.0",
                applicationVersionOverride = "1.0.0",
                maximumNodeCount = maximumNodeCount,
            ),
        )

    private companion object {
        const val ROOT_ID = "demo.capture.root"
        const val BUTTON_ID = "demo.capture.button"
        const val PASSWORD_ID = "demo.capture.password"
        const val CONSOLE_ID = "demo.capture.console"
        const val ROOT_WIDTH_PX = 360
        const val ROOT_HEIGHT_PX = 640
        const val CONTROL_HEIGHT_PX = 96
        const val MATCH_PARENT = -1
        const val DEFAULT_TEST_NODE_LIMIT = 100
        const val BYTE_MASK = 0xff
        const val PIXEL_EPSILON = 0.000_001
        val PNG_SIGNATURE = byteArrayOf(
            0x89.toByte(),
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
        )
    }
}
