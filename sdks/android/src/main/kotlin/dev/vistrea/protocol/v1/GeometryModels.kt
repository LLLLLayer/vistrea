package dev.vistrea.protocol.v1

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private fun requireFinite(value: Double, name: String) {
    require(value.isFinite()) { "$name must be finite" }
}

@Serializable
data class Size(
    val width: Double,
    val height: Double,
) {
    init {
        requireFinite(width, "width")
        requireFinite(height, "height")
        require(width >= 0 && height >= 0) { "Size dimensions must be non-negative" }
    }
}

@Serializable
data class PixelSize(
    val width: JsonSafePositiveInteger,
    val height: JsonSafePositiveInteger,
)

@Serializable
data class Rect(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
) {
    init {
        requireFinite(x, "x")
        requireFinite(y, "y")
        requireFinite(width, "width")
        requireFinite(height, "height")
        require(width >= 0 && height >= 0) { "Rectangle dimensions must be non-negative" }
    }
}

@Serializable
data class NonEmptyRect(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
) {
    init {
        requireFinite(x, "x")
        requireFinite(y, "y")
        requireFinite(width, "width")
        requireFinite(height, "height")
        require(width > 0 && height > 0) { "Rectangle dimensions must be positive" }
    }
}

@Serializable
data class Insets(
    val top: Double,
    val left: Double,
    val bottom: Double,
    val right: Double,
) {
    init {
        listOf(top, left, bottom, right).forEach { requireFinite(it, "inset") }
        require(listOf(top, left, bottom, right).all { it >= 0 }) {
            "Insets must be non-negative"
        }
    }
}

@Serializable
enum class Orientation {
    @SerialName("portrait")
    PORTRAIT,

    @SerialName("portrait_upside_down")
    PORTRAIT_UPSIDE_DOWN,

    @SerialName("landscape_left")
    LANDSCAPE_LEFT,

    @SerialName("landscape_right")
    LANDSCAPE_RIGHT,
}

@Serializable
data class DisplayGeometry(
    @SerialName("coordinate_unit")
    val coordinateUnit: String,
    val origin: String,
    @SerialName("logical_size")
    val logicalSize: Size,
    @SerialName("pixel_size")
    val pixelSize: PixelSize,
    @SerialName("pixel_scale_x")
    val pixelScaleX: Double,
    @SerialName("pixel_scale_y")
    val pixelScaleY: Double,
    val orientation: Orientation,
    @SerialName("safe_area")
    val safeArea: Insets,
    @SerialName("geometry_revision")
    val geometryRevision: String,
    val extensions: Extensions,
) {
    init {
        require(coordinateUnit == "logical_point") { "Unsupported coordinate unit" }
        require(origin == "top_left") { "Unsupported coordinate origin" }
        requireFinite(pixelScaleX, "pixel_scale_x")
        requireFinite(pixelScaleY, "pixel_scale_y")
        require(pixelScaleX > 0 && pixelScaleY > 0) { "Pixel scales must be positive" }
    }
}
