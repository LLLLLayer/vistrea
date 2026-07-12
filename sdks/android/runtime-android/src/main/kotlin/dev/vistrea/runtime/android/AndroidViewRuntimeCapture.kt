package dev.vistrea.runtime.android

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.graphics.Rect as AndroidRect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Looper
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.DisplayMetrics
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.AbsListView
import android.widget.Button
import android.widget.Checkable
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import dev.vistrea.protocol.v1.AccessibilityProperties
import dev.vistrea.protocol.v1.BuildId
import dev.vistrea.protocol.v1.CapabilitySet
import dev.vistrea.protocol.v1.CaptureLimitation
import dev.vistrea.protocol.v1.CaptureLimitationSeverity
import dev.vistrea.protocol.v1.Color
import dev.vistrea.protocol.v1.ColorSpace
import dev.vistrea.protocol.v1.Compression
import dev.vistrea.protocol.v1.DeviceDescriptor
import dev.vistrea.protocol.v1.DeviceId
import dev.vistrea.protocol.v1.DeviceKind
import dev.vistrea.protocol.v1.DisplayGeometry
import dev.vistrea.protocol.v1.EventTime
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.Font
import dev.vistrea.protocol.v1.Insets
import dev.vistrea.protocol.v1.JsonSafePositiveInteger
import dev.vistrea.protocol.v1.JsonSafeUInt
import dev.vistrea.protocol.v1.NodeAction
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.NodeState
import dev.vistrea.protocol.v1.NonEmptyRect
import dev.vistrea.protocol.v1.ObjectHash
import dev.vistrea.protocol.v1.ObjectRef
import dev.vistrea.protocol.v1.Orientation
import dev.vistrea.protocol.v1.PixelSize
import dev.vistrea.protocol.v1.Platform
import dev.vistrea.protocol.v1.ProjectId
import dev.vistrea.protocol.v1.ProtocolVersion
import dev.vistrea.protocol.v1.Rect
import dev.vistrea.protocol.v1.RedactedContentField
import dev.vistrea.protocol.v1.RuntimeContext
import dev.vistrea.protocol.v1.RuntimeSnapshot
import dev.vistrea.protocol.v1.ScreenshotEvidence
import dev.vistrea.protocol.v1.Size
import dev.vistrea.protocol.v1.SnapshotId
import dev.vistrea.protocol.v1.SourceContext
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.protocol.v1.SystemChrome
import dev.vistrea.protocol.v1.TextContent
import dev.vistrea.protocol.v1.Theme
import dev.vistrea.protocol.v1.Timestamp
import dev.vistrea.protocol.v1.TreeId
import dev.vistrea.protocol.v1.UiNode
import dev.vistrea.protocol.v1.UiTree
import dev.vistrea.protocol.v1.UiTreeKind
import dev.vistrea.protocol.v1.UiTreePayload
import dev.vistrea.protocol.v1.VisualProperties
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.ArrayDeque
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive

private const val ADAPTER_NAME = "view"
private const val DEFAULT_MAXIMUM_NODE_COUNT = 25_000
private const val DEFAULT_MAXIMUM_SCREENSHOT_PIXELS = 20_000_000L
private const val COLOR_COMPONENT_MAXIMUM = 255.0
private const val FONT_NORMAL_WEIGHT = 400.0
private const val FONT_WEIGHT_SPAN = 500.0
private const val UUID_BYTE_COUNT = 16
private const val UUID_TIMESTAMP_BYTE_COUNT = 6

data class AndroidViewRuntimeCaptureConfiguration(
    val projectId: ProjectId,
    val buildId: BuildId,
    val deviceId: DeviceId? = null,
    val environmentId: String = "local",
    val accountProfileId: String? = null,
    val featureContextRefs: List<String>? = null,
    val sourceGitSha: String? = null,
    val applicationVersionOverride: String? = null,
    val sdkVersion: String,
    val adapterVersion: String,
    val maximumNodeCount: Int = DEFAULT_MAXIMUM_NODE_COUNT,
    val maximumScreenshotPixels: Long = DEFAULT_MAXIMUM_SCREENSHOT_PIXELS,
) {
    init {
        require(maximumNodeCount > 0) { "maximumNodeCount must be positive." }
        require(maximumScreenshotPixels > 0) { "maximumScreenshotPixels must be positive." }
    }
}

class CapturedAndroidRuntimeObject(
    val reference: ObjectRef,
    bytes: ByteArray,
) {
    private val encodedBytes = bytes.copyOf()

    /** Returns an isolated copy so callers cannot invalidate the captured ObjectRef hash. */
    val bytes: ByteArray
        get() = encodedBytes.copyOf()
}

data class AndroidViewRuntimeCaptureResult(
    val snapshot: RuntimeSnapshot,
    val objects: List<CapturedAndroidRuntimeObject>,
)

enum class AndroidRuntimeCaptureFailure {
    WRONG_THREAD,
    EMPTY_ROOT,
    ROOT_OUTSIDE_DISPLAY,
    NODE_LIMIT_EXCEEDED,
    SCREENSHOT_LIMIT_EXCEEDED,
    SCREENSHOT_ENCODING_FAILED,
}

class AndroidRuntimeCaptureException(
    val failure: AndroidRuntimeCaptureFailure,
    message: String,
) : IllegalStateException(message)

/**
 * Observes a real Android View/ViewGroup hierarchy on the main thread.
 *
 * The adapter never invokes application business methods or performs device
 * actions. It returns the canonical Runtime Snapshot plus encoded Object bytes;
 * transport and persistence remain separate responsibilities.
 */
class AndroidViewRuntimeCaptureAdapter(
    private val configuration: AndroidViewRuntimeCaptureConfiguration,
) {
    fun capture(
        rootView: View,
        scenarioId: String? = null,
        includeScreenshot: Boolean = true,
    ): AndroidViewRuntimeCaptureResult {
        validateCaptureRoot(rootView)
        val snapshotRawId = RuntimeIdentifierFactory.make("snapshot")
        val treeId = TreeId(
            RuntimeIdentifierFactory.deterministic("tree", "$snapshotRawId:view-tree"),
        )
        val treeMoment = CaptureMoment.now()
        val display = captureDisplay(rootView)
        val components = CaptureComponents(
            snapshotId = SnapshotId(snapshotRawId),
            treeId = treeId,
            treeMoment = treeMoment,
            display = display,
            hierarchy = captureHierarchy(rootView, snapshotRawId, display.density),
            screenshot = if (includeScreenshot) captureScreenshot(rootView) else null,
        )
        return assembleResult(rootView.context, scenarioId, components)
    }

    private fun validateCaptureRoot(rootView: View) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw AndroidRuntimeCaptureException(
                AndroidRuntimeCaptureFailure.WRONG_THREAD,
                "Android View capture must run on the main thread.",
            )
        }
        if (rootView.width <= 0 || rootView.height <= 0) {
            throw AndroidRuntimeCaptureException(
                AndroidRuntimeCaptureFailure.EMPTY_ROOT,
                "Android View capture requires a laid-out non-empty root.",
            )
        }
    }

    private fun assembleResult(
        context: Context,
        scenarioId: String?,
        components: CaptureComponents,
    ): AndroidViewRuntimeCaptureResult {
        val snapshotExtensions = scenarioId?.let {
            Extensions.of(mapOf("vistrea.scenario_id" to JsonPrimitive(it)))
        } ?: Extensions.empty()
        val tree = UiTree(
            treeId = components.treeId,
            kind = UiTreeKind.VIEW,
            rootNodeIds = listOf(components.hierarchy.rootNodeId),
            payload = UiTreePayload(inlineNodes = components.hierarchy.nodes),
            captureLimitations = emptyList(),
            extensions = Extensions.empty(),
        )
        val snapshot = RuntimeSnapshot(
            snapshotId = components.snapshotId,
            protocolVersion = ProtocolVersion(major = 1, minor = 0),
            capturedAt = components.treeMoment.eventTime(),
            runtimeContext = captureRuntimeContext(context, scenarioId),
            display = components.display.geometry,
            trees = listOf(tree),
            screenshot = components.screenshot?.let {
                screenshotEvidence(it, components.treeMoment, components.display.rootCoverage)
            },
            capabilities = CapabilitySet(
                names = listOf("runtime.snapshot"),
                extensions = Extensions.empty(),
            ),
            captureLimitations = components.display.limitations,
            extensions = snapshotExtensions,
        )
        return AndroidViewRuntimeCaptureResult(
            snapshot = snapshot,
            objects = components.screenshot?.let { listOf(it.objectValue) } ?: emptyList(),
        )
    }

    private fun screenshotEvidence(
        result: ScreenshotCapture,
        treeMoment: CaptureMoment,
        coverage: NonEmptyRect,
    ): ScreenshotEvidence {
        val midpointNanos = result.startedAt.monotonicNanos +
            (result.finishedAt.monotonicNanos - result.startedAt.monotonicNanos) / 2
        return ScreenshotEvidence(
            objectRef = result.objectValue.reference,
            captureStartedAt = result.startedAt.eventTime(),
            captureFinishedAt = result.finishedAt.eventTime(),
            treeSkewMs = kotlin.math.abs(treeMoment.monotonicNanos - midpointNanos) / 1_000_000.0,
            coverage = coverage,
            pixelSize = result.pixelSize,
            systemChrome = SystemChrome.EXCLUDED,
            colorSpace = ColorSpace.SRGB,
            extensions = Extensions.empty(),
        )
    }

    private fun captureRuntimeContext(context: Context, scenarioId: String?): RuntimeContext {
        val locale = context.resources.configuration.locales[0]?.toLanguageTag()
            ?.takeIf(String::isNotBlank)
            ?: Locale.getDefault().toLanguageTag()
        val nightMode = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        val applicationVersion = configuration.applicationVersionOverride
            ?: packageVersion(context)
        return RuntimeContext(
            projectId = configuration.projectId,
            applicationId = context.packageName,
            buildId = configuration.buildId,
            applicationVersion = applicationVersion,
            sourceGitSha = validGitSha(configuration.sourceGitSha),
            platform = Platform.ANDROID,
            device = DeviceDescriptor(
                deviceId = configuration.deviceId,
                kind = if (isEmulator()) DeviceKind.EMULATOR else DeviceKind.REAL_DEVICE,
                model = Build.MODEL.ifBlank { "Android device" },
                osVersion = Build.VERSION.RELEASE.ifBlank { Build.VERSION.SDK_INT.toString() },
                extensions = Extensions.empty(),
            ),
            environmentId = configuration.environmentId,
            accountProfileId = configuration.accountProfileId,
            featureContextRefs = configuration.featureContextRefs ?: scenarioId?.let(::listOf),
            locale = locale,
            theme = if (nightMode == Configuration.UI_MODE_NIGHT_YES) Theme.DARK else Theme.LIGHT,
            textScale = context.resources.configuration.fontScale.toDouble(),
            sdkVersion = configuration.sdkVersion,
            adapterVersions = mapOf(ADAPTER_NAME to configuration.adapterVersion),
            extensions = Extensions.empty(),
        )
    }

    @Suppress("DEPRECATION")
    private fun packageVersion(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull()?.takeIf(String::isNotBlank) ?: "0.0.0"

    private fun captureDisplay(rootView: View): DisplayCapture {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        rootView.display?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0 || metrics.density <= 0) {
            metrics.setTo(rootView.resources.displayMetrics)
        }
        val density = metrics.density.toDouble()
        val rotation = rootView.display?.rotation ?: Surface.ROTATION_0
        val rootFrame = frameInDisplay(rootView, density)
        val displayWidth = metrics.widthPixels / density
        val displayHeight = metrics.heightPixels / density
        val epsilon = 1.0 / density
        val startsOutside = rootFrame.x < -epsilon || rootFrame.y < -epsilon
        val endsOutside = rootFrame.x + rootFrame.width > displayWidth + epsilon ||
            rootFrame.y + rootFrame.height > displayHeight + epsilon
        if (startsOutside || endsOutside) {
            throw AndroidRuntimeCaptureException(
                AndroidRuntimeCaptureFailure.ROOT_OUTSIDE_DISPLAY,
                "The Android root View is outside the captured display coordinate space.",
            )
        }
        val (safeArea, limitations) = captureSafeArea(rootView, density)
        val geometry = DisplayGeometry(
            coordinateUnit = "logical_point",
            origin = "top_left",
            logicalSize = Size(displayWidth, displayHeight),
            pixelSize = PixelSize(
                JsonSafePositiveInteger(metrics.widthPixels.toLong()),
                JsonSafePositiveInteger(metrics.heightPixels.toLong()),
            ),
            pixelScaleX = density,
            pixelScaleY = density,
            orientation = orientation(rotation),
            safeArea = safeArea,
            geometryRevision = "android-${metrics.widthPixels}x${metrics.heightPixels}-${metrics.densityDpi}-$rotation",
            extensions = Extensions.of(
                mapOf("android.display.rotation" to JsonPrimitive(rotation)),
            ),
        )
        return DisplayCapture(
            geometry = geometry,
            density = density,
            rootCoverage = NonEmptyRect(
                rootFrame.x,
                rootFrame.y,
                rootFrame.width,
                rootFrame.height,
            ),
            limitations = limitations,
        )
    }

    private fun captureSafeArea(rootView: View, density: Double): Pair<Insets, List<CaptureLimitation>> {
        val windowInsets = rootView.rootWindowInsets
        if (windowInsets == null) {
            return Insets(0.0, 0.0, 0.0, 0.0) to listOf(
                CaptureLimitation(
                    code = "android.capture.insets-unavailable",
                    severity = CaptureLimitationSeverity.INFO,
                    message = "Window insets were unavailable for this View root.",
                    retryable = true,
                    extensions = Extensions.empty(),
                ),
            )
        }
        val insets = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val platformInsets = windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            RawInsets(
                platformInsets.left,
                platformInsets.top,
                platformInsets.right,
                platformInsets.bottom,
            )
        } else {
            @Suppress("DEPRECATION")
            RawInsets(
                left = windowInsets.systemWindowInsetLeft,
                top = windowInsets.systemWindowInsetTop,
                right = windowInsets.systemWindowInsetRight,
                bottom = windowInsets.systemWindowInsetBottom,
            )
        }
        return Insets(
            top = insets.top / density,
            left = insets.left / density,
            bottom = insets.bottom / density,
            right = insets.right / density,
        ) to emptyList()
    }

    private fun captureHierarchy(
        rootView: View,
        snapshotRawId: String,
        density: Double,
    ): HierarchyCapture {
        val orderedViews = mutableListOf<TraversalItem>()
        val stack = ArrayDeque<TraversalItem>()
        stack.addLast(TraversalItem(rootView, "0", null))
        while (stack.isNotEmpty()) {
            if (orderedViews.size >= configuration.maximumNodeCount) {
                throw AndroidRuntimeCaptureException(
                    AndroidRuntimeCaptureFailure.NODE_LIMIT_EXCEEDED,
                    "The Android View hierarchy exceeds maximumNodeCount.",
                )
            }
            val current = stack.removeLast()
            orderedViews += current
            val group = current.view as? ViewGroup ?: continue
            for (index in group.childCount - 1 downTo 0) {
                stack.addLast(
                    TraversalItem(group.getChildAt(index), "${current.path}.$index", current.path),
                )
            }
        }

        val idsByPath = LinkedHashMap<String, NodeId>()
        for (item in orderedViews) {
            val stableSeed = stableIdentifier(item.view)?.value ?: item.path
            idsByPath[item.path] = NodeId(
                RuntimeIdentifierFactory.deterministic(
                    "node",
                    "$snapshotRawId:$stableSeed:${item.path}",
                ),
            )
        }
        val nodes = orderedViews.map { item ->
            val nodeId = checkNotNull(idsByPath[item.path])
            val parentId = item.parentPath?.let(idsByPath::get)
            val childIds = (item.view as? ViewGroup)?.let { group ->
                (0 until group.childCount).mapNotNull { index ->
                    idsByPath["${item.path}.$index"]
                }
            } ?: emptyList()
            captureNode(
                NodeCaptureInput(
                    view = item.view,
                    nodeId = nodeId,
                    parentId = parentId,
                    childIds = childIds,
                    density = density,
                ),
            )
        }
        return HierarchyCapture(
            rootNodeId = checkNotNull(idsByPath["0"]),
            nodes = nodes,
        )
    }

    private fun captureNode(input: NodeCaptureInput): UiNode {
        val view = input.view
        val density = input.density
        val frame = frameInDisplay(view, density)
        val visiblePixels = AndroidRect()
        val hasVisibleRect = view.getGlobalVisibleRect(visiblePixels)
        val visibleRect = if (hasVisibleRect && visiblePixels.width() >= 0 && visiblePixels.height() >= 0) {
            protocolRect(visiblePixels, density)
        } else {
            null
        }
        val stableId = stableIdentifier(view)
        val role = role(view)
        return UiNode(
            nodeId = input.nodeId,
            stableId = stableId,
            parentId = input.parentId,
            childIds = input.childIds,
            nativeType = view.javaClass.name,
            role = role,
            frame = frame,
            visibleRect = visibleRect,
            hitRect = if (view.isClickable || view.isLongClickable || view.isFocusable) frame else null,
            bounds = Rect(0.0, 0.0, view.width / density, view.height / density),
            zIndex = view.z.toDouble(),
            clipped = visibleRect?.let { it != frame },
            content = content(view),
            state = NodeState(
                visible = view.visibility == View.VISIBLE && view.alpha > 0 && hasVisibleRect,
                enabled = view.isEnabled,
                selected = view.isSelected,
                focused = view.isFocused,
                checked = (view as? Checkable)?.isChecked,
            ),
            actions = actions(view),
            visual = visual(view, density),
            accessibility = AccessibilityProperties(
                label = view.contentDescription?.toString(),
                value = accessibilityValue(view),
                role = role,
                hidden = view.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO ||
                    view.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,
            ),
            sourceContext = SourceContext(component = view.javaClass.name),
            relatedNodes = emptyList(),
            captureLimitations = emptyList(),
            extensions = nodeExtensions(view),
        )
    }

    private fun captureScreenshot(rootView: View): ScreenshotCapture {
        val pixels = rootView.width.toLong() * rootView.height.toLong()
        if (pixels > configuration.maximumScreenshotPixels) {
            throw AndroidRuntimeCaptureException(
                AndroidRuntimeCaptureFailure.SCREENSHOT_LIMIT_EXCEEDED,
                "The Android View screenshot exceeds maximumScreenshotPixels.",
            )
        }
        val startedAt = CaptureMoment.now()
        val bitmap = Bitmap.createBitmap(rootView.width, rootView.height, Bitmap.Config.ARGB_8888)
        val bytes = try {
            rootView.draw(Canvas(bitmap))
            ByteArrayOutputStream().use { output ->
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, output)) {
                    throw AndroidRuntimeCaptureException(
                        AndroidRuntimeCaptureFailure.SCREENSHOT_ENCODING_FAILED,
                        "Android PNG encoding failed.",
                    )
                }
                output.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
        val finishedAt = CaptureMoment.now()
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and BYTE_MASK) }
        val reference = ObjectRef(
            hash = ObjectHash("sha256:$hash"),
            mediaType = "image/png",
            byteSize = JsonSafeUInt(bytes.size.toLong()),
            compression = Compression.NONE,
            logicalName = "runtime-snapshot.png",
            extensions = Extensions.empty(),
        )
        return ScreenshotCapture(
            objectValue = CapturedAndroidRuntimeObject(reference, bytes),
            pixelSize = PixelSize(
                JsonSafePositiveInteger(rootView.width.toLong()),
                JsonSafePositiveInteger(rootView.height.toLong()),
            ),
            startedAt = startedAt,
            finishedAt = finishedAt,
        )
    }

    private fun content(view: View): TextContent {
        val description = view.contentDescription?.toString()
        if (view is EditText) {
            val placeholder = view.hint?.toString()
            if (isPassword(view)) {
                return TextContent(
                    placeholder = placeholder,
                    contentDescription = description,
                    redactedFields = listOf(
                        RedactedContentField.TEXT,
                        RedactedContentField.VALUE,
                    ),
                )
            }
            val value = view.text?.toString()
            return TextContent(
                text = value,
                value = value,
                placeholder = placeholder,
                contentDescription = description,
            )
        }
        if (view is TextView) {
            return TextContent(
                text = view.text?.toString(),
                contentDescription = description,
            )
        }
        return TextContent(contentDescription = description)
    }

    private fun accessibilityValue(view: View): String? = when {
        view is EditText && isPassword(view) -> null
        view is TextView -> view.text?.toString()
        else -> null
    }

    private fun role(view: View): String = when (view) {
        is EditText -> "text-field"
        is Button -> "button"
        is ImageView -> "image"
        is ProgressBar -> "progress-indicator"
        is ScrollView, is AbsListView -> "scroll-view"
        is TextView -> "text"
        is ViewGroup -> "container"
        else -> "view"
    }

    private fun actions(view: View): List<NodeAction> {
        val actions = linkedSetOf<NodeAction>()
        if (view is EditText) {
            actions += NodeAction.TAP
            actions += NodeAction.TYPE_TEXT
            actions += NodeAction.CLEAR_TEXT
        }
        if (view is ScrollView || view is AbsListView) {
            actions += NodeAction.SWIPE
            actions += NodeAction.SCROLL
        }
        if (view.isClickable) {
            actions += NodeAction.TAP
        }
        if (view.isLongClickable) {
            actions += NodeAction.LONG_PRESS
        }
        return actions.toList()
    }

    private fun visual(view: View, density: Double): VisualProperties {
        val textView = view as? TextView
        val backgroundColor = (view.background as? ColorDrawable)?.color?.let(::protocolColor)
        val foregroundColor = textView?.currentTextColor?.let(::protocolColor)
        val font = textView?.takeIf { it.textSize > 0 }?.let {
            Font(
                family = "android-system",
                size = it.textSize.toDouble() / density,
                weight = fontWeight(it),
            )
        }
        return VisualProperties(
            alpha = view.alpha.toDouble(),
            foregroundColor = foregroundColor,
            backgroundColor = backgroundColor,
            font = font,
        )
    }

    private fun fontWeight(view: TextView): Double {
        val weight = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            view.typeface?.weight?.toDouble() ?: FONT_NORMAL_WEIGHT
        } else if (view.typeface?.isBold == true) {
            FONT_NORMAL_WEIGHT + FONT_WEIGHT_SPAN / 2
        } else {
            FONT_NORMAL_WEIGHT
        }
        return ((weight - FONT_NORMAL_WEIGHT) / FONT_WEIGHT_SPAN).coerceIn(-1.0, 1.0)
    }

    private fun protocolColor(value: Int): Color = Color(
        red = AndroidColor.red(value) / COLOR_COMPONENT_MAXIMUM,
        green = AndroidColor.green(value) / COLOR_COMPONENT_MAXIMUM,
        blue = AndroidColor.blue(value) / COLOR_COMPONENT_MAXIMUM,
        alpha = AndroidColor.alpha(value) / COLOR_COMPONENT_MAXIMUM,
        colorSpace = ColorSpace.SRGB,
    )

    private fun nodeExtensions(view: View): Extensions {
        if (view.id == View.NO_ID) {
            return Extensions.empty()
        }
        val resourceName = runCatching { view.resources.getResourceName(view.id) }.getOrNull()
            ?: return Extensions.empty()
        return Extensions.of(
            mapOf("android.view.resource_id" to JsonPrimitive(resourceName)),
        )
    }

    private fun stableIdentifier(view: View): StableId? {
        val candidates = buildList {
            (view.tag as? String)?.takeIf(String::isNotBlank)?.let(::add)
            view.transitionName?.takeIf(String::isNotBlank)?.let(::add)
            view.contentDescription?.toString()?.takeIf(String::isNotBlank)?.let(::add)
            if (view.id != View.NO_ID) {
                runCatching { view.resources.getResourceName(view.id) }.getOrNull()?.let(::add)
            }
        }
        return candidates.firstNotNullOfOrNull { candidate ->
            runCatching { StableId(candidate) }.getOrNull()
        }
    }

    private fun frameInDisplay(view: View, density: Double): Rect {
        val location = IntArray(2)
        view.getLocationOnScreen(location)
        return Rect(
            x = location[0] / density,
            y = location[1] / density,
            width = view.width / density,
            height = view.height / density,
        )
    }

    private fun protocolRect(rect: AndroidRect, density: Double): Rect = Rect(
        x = rect.left / density,
        y = rect.top / density,
        width = rect.width() / density,
        height = rect.height() / density,
    )

    private fun isPassword(view: EditText): Boolean {
        if (view.transformationMethod is PasswordTransformationMethod) {
            return true
        }
        val variation = view.inputType and InputType.TYPE_MASK_VARIATION
        return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
            variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    }

    private fun orientation(rotation: Int): Orientation = when (rotation) {
        Surface.ROTATION_90 -> Orientation.LANDSCAPE_LEFT
        Surface.ROTATION_180 -> Orientation.PORTRAIT_UPSIDE_DOWN
        Surface.ROTATION_270 -> Orientation.LANDSCAPE_RIGHT
        else -> Orientation.PORTRAIT
    }

    private fun validGitSha(value: String?): String? = value?.takeIf {
        GIT_SHA_PATTERN.matches(it)
    }

    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
            Build.MODEL.contains("emulator", ignoreCase = true) ||
            Build.MODEL.contains("Android SDK", ignoreCase = true) ||
            Build.HARDWARE.contains("ranchu", ignoreCase = true) ||
            Build.HARDWARE.contains("goldfish", ignoreCase = true)

    private companion object {
        const val PNG_QUALITY = 100
        const val BYTE_MASK = 0xff
        val GIT_SHA_PATTERN = Regex("^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
    }
}

private data class TraversalItem(
    val view: View,
    val path: String,
    val parentPath: String?,
)

private data class NodeCaptureInput(
    val view: View,
    val nodeId: NodeId,
    val parentId: NodeId?,
    val childIds: List<NodeId>,
    val density: Double,
)

private data class HierarchyCapture(
    val rootNodeId: NodeId,
    val nodes: List<UiNode>,
)

private data class DisplayCapture(
    val geometry: DisplayGeometry,
    val density: Double,
    val rootCoverage: NonEmptyRect,
    val limitations: List<CaptureLimitation>,
)

private data class ScreenshotCapture(
    val objectValue: CapturedAndroidRuntimeObject,
    val pixelSize: PixelSize,
    val startedAt: CaptureMoment,
    val finishedAt: CaptureMoment,
)

private data class CaptureComponents(
    val snapshotId: SnapshotId,
    val treeId: TreeId,
    val treeMoment: CaptureMoment,
    val display: DisplayCapture,
    val hierarchy: HierarchyCapture,
    val screenshot: ScreenshotCapture?,
)

private data class CaptureMoment(
    val wallTime: Instant,
    val monotonicNanos: Long,
) {
    fun eventTime(): EventTime = EventTime(
        wallTime = Timestamp(wallTime.toString()),
    )

    companion object {
        fun now(): CaptureMoment = CaptureMoment(Instant.now(), System.nanoTime())
    }
}

private object RuntimeIdentifierFactory {
    private val random = SecureRandom()

    fun make(prefix: String, time: Instant = Instant.now()): String {
        val bytes = ByteArray(UUID_BYTE_COUNT)
        val milliseconds = time.toEpochMilli().coerceAtLeast(0)
        for (index in 0 until UUID_TIMESTAMP_BYTE_COUNT) {
            bytes[UUID_TIMESTAMP_BYTE_COUNT - 1 - index] =
                ((milliseconds shr (index * Byte.SIZE_BITS)) and BYTE_MASK.toLong()).toByte()
        }
        random.nextBytes(bytes, UUID_TIMESTAMP_BYTE_COUNT, UUID_BYTE_COUNT)
        setVersionAndVariant(bytes)
        return "${prefix}_${format(bytes)}"
    }

    fun deterministic(prefix: String, seed: String): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest(seed.toByteArray(Charsets.UTF_8))
            .copyOf(UUID_BYTE_COUNT)
        setVersionAndVariant(bytes)
        return "${prefix}_${format(bytes)}"
    }

    private fun SecureRandom.nextBytes(bytes: ByteArray, fromIndex: Int, toIndex: Int) {
        val suffix = ByteArray(toIndex - fromIndex)
        nextBytes(suffix)
        suffix.copyInto(bytes, destinationOffset = fromIndex)
    }

    private fun setVersionAndVariant(bytes: ByteArray) {
        bytes[UUID_VERSION_BYTE_INDEX] =
            ((bytes[UUID_VERSION_BYTE_INDEX].toInt() and VERSION_MASK) or VERSION_SEVEN).toByte()
        bytes[UUID_VARIANT_BYTE_INDEX] =
            ((bytes[UUID_VARIANT_BYTE_INDEX].toInt() and VARIANT_MASK) or VARIANT_RFC_4122).toByte()
    }

    private fun format(bytes: ByteArray): String {
        val hex = bytes.joinToString(separator = "") { byte ->
            "%02x".format(byte.toInt() and BYTE_MASK)
        }
        return listOf(
            hex.substring(UUID_GROUP_ONE_START, UUID_GROUP_ONE_END),
            hex.substring(UUID_GROUP_ONE_END, UUID_GROUP_TWO_END),
            hex.substring(UUID_GROUP_TWO_END, UUID_GROUP_THREE_END),
            hex.substring(UUID_GROUP_THREE_END, UUID_GROUP_FOUR_END),
            hex.substring(UUID_GROUP_FOUR_END, UUID_HEX_LENGTH),
        ).joinToString("-")
    }

    private const val VERSION_MASK = 0x0f
    private const val VERSION_SEVEN = 0x70
    private const val VARIANT_MASK = 0x3f
    private const val VARIANT_RFC_4122 = 0x80
    private const val BYTE_MASK = 0xff
    private const val UUID_VERSION_BYTE_INDEX = 6
    private const val UUID_VARIANT_BYTE_INDEX = 8
    private const val UUID_GROUP_ONE_START = 0
    private const val UUID_GROUP_ONE_END = 8
    private const val UUID_GROUP_TWO_END = 12
    private const val UUID_GROUP_THREE_END = 16
    private const val UUID_GROUP_FOUR_END = 20
    private const val UUID_HEX_LENGTH = 32
}

private data class RawInsets(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
)
