package dev.vistrea.runtime.android

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import dev.vistrea.protocol.v1.StableId
import dev.vistrea.runtime.connection.RuntimeTuningApplying
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull

/**
 * Resolves stable identifiers to live views and previews allowlisted visual
 * properties without invoking application business methods.
 *
 * The controller mutates exactly the allowlisted property on the main thread
 * and never invokes application business methods. Identifier resolution uses
 * the same candidate order as the capture adapter so tuning targets match the
 * observed `stable_id` values.
 */
class AndroidViewRuntimeTuningController(
    private val rootViewProvider: () -> View,
) : RuntimeTuningApplying {
    override val supportedTuningProperties: Set<String> = setOf(
        "content_insets",
        "spacing",
        "font",
        "foreground_color",
        "background_color",
        "alpha",
        "corner_radius",
    )

    override suspend fun currentAlpha(stableId: String): Double? =
        withContext(Dispatchers.Main.immediate) {
            findView(rootViewProvider(), stableId)?.alpha?.toDouble()
        }

    override suspend fun setAlpha(stableId: String, value: Double): Boolean =
        withContext(Dispatchers.Main.immediate) {
            val view = findView(rootViewProvider(), stableId)
            view?.alpha = value.toFloat()
            view != null
        }

    override suspend fun currentTuningValue(stableId: String, property: String): JsonElement? =
        withContext(Dispatchers.Main.immediate) {
            val view = findView(rootViewProvider(), stableId) ?: return@withContext null
            when (property) {
                "alpha" -> numberValue(view.alpha.toDouble(), "ratio")
                "corner_radius" -> (view.background as? GradientDrawable)?.let {
                    numberValue(it.cornerRadius.toDouble() / view.resources.displayMetrics.density, "logical_point")
                }
                "spacing" -> spacing(view)?.let { numberValue(it, "logical_point") }
                "content_insets" -> insetsValue(view)
                "foreground_color" -> (view as? TextView)?.currentTextColor?.let(::colorValue)
                "background_color" -> (view.background as? ColorDrawable)?.color?.let(::colorValue)
                "font" -> (view as? TextView)?.let(::fontValue)
                else -> null
            }
        }

    override suspend fun setTuningValue(
        stableId: String,
        property: String,
        value: JsonElement,
    ): Boolean = withContext(Dispatchers.Main.immediate) {
        val view = findView(rootViewProvider(), stableId) ?: return@withContext false
        when (property) {
            "alpha" -> {
                val number = propertyNumber(value)?.takeIf { it in 0.0..1.0 }
                    ?: return@withContext false
                view.alpha = number.toFloat()
            }
            "corner_radius" -> {
                val drawable = view.background as? GradientDrawable ?: return@withContext false
                val number = propertyNumber(value)?.takeIf { it >= 0 } ?: return@withContext false
                drawable.cornerRadius = (number * view.resources.displayMetrics.density).toFloat()
            }
            "spacing" -> {
                val number = propertyNumber(value)?.takeIf { it >= 0 } ?: return@withContext false
                if (!setSpacing(view, number)) return@withContext false
            }
            "content_insets" -> {
                val insets = insets(value) ?: return@withContext false
                val density = view.resources.displayMetrics.density
                view.setPadding(
                    (insets[0] * density).toInt(),
                    (insets[1] * density).toInt(),
                    (insets[2] * density).toInt(),
                    (insets[3] * density).toInt(),
                )
            }
            "foreground_color" -> {
                val text = view as? TextView ?: return@withContext false
                text.setTextColor(color(value) ?: return@withContext false)
            }
            "background_color" -> {
                val color = color(value) ?: return@withContext false
                when (val background = view.background) {
                    is ColorDrawable -> background.color = color
                    is GradientDrawable -> background.color = ColorStateList.valueOf(color)
                    else -> return@withContext false
                }
            }
            "font" -> {
                val text = view as? TextView ?: return@withContext false
                val font = font(value) ?: return@withContext false
                text.setTextSize(TypedValue.COMPLEX_UNIT_DIP, font.size.toFloat())
                text.typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    Typeface.create(Typeface.DEFAULT, font.weight, font.italic)
                } else {
                    Typeface.create(Typeface.DEFAULT, if (font.weight >= 600) Typeface.BOLD else Typeface.NORMAL)
                }
            }
            else -> return@withContext false
        }
        true
    }

    private fun findView(view: View, stableId: String): View? {
        if (stableIdentifier(view)?.value == stableId) {
            return view
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findView(view.getChildAt(index), stableId)?.let { return it }
            }
        }
        return null
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

    private data class FontValue(val size: Double, val weight: Int, val italic: Boolean)

    private fun numberValue(value: Double, unit: String): JsonObject = buildJsonObject {
        put("kind", JsonPrimitive("number"))
        put("value", JsonPrimitive(value))
        put("unit", JsonPrimitive(unit))
        put("extensions", JsonObject(emptyMap()))
    }

    private fun propertyNumber(value: JsonElement): Double? {
        val property = value as? JsonObject ?: return null
        return rawNumber(property["value"])
    }

    private fun insetsValue(view: View): JsonObject {
        val density = view.resources.displayMetrics.density.toDouble()
        return buildJsonObject {
            put("kind", JsonPrimitive("insets"))
            put("value", buildJsonObject {
                put("top", JsonPrimitive(view.paddingTop / density))
                put("leading", JsonPrimitive(view.paddingLeft / density))
                put("bottom", JsonPrimitive(view.paddingBottom / density))
                put("trailing", JsonPrimitive(view.paddingRight / density))
            })
            put("extensions", JsonObject(emptyMap()))
        }
    }

    private fun insets(value: JsonElement): DoubleArray? {
        val property = value as? JsonObject ?: return null
        val objectValue = property["value"] as? JsonObject ?: return null
        val top = rawNumber(objectValue["top"]) ?: return null
        val leading = rawNumber(objectValue["leading"]) ?: return null
        val bottom = rawNumber(objectValue["bottom"]) ?: return null
        val trailing = rawNumber(objectValue["trailing"]) ?: return null
        // setPadding uses left, top, right, bottom.
        return doubleArrayOf(leading, top, trailing, bottom)
    }

    private fun spacing(view: View): Double? {
        val parent = view.parent as? LinearLayout ?: return null
        val margins = view.layoutParams as? ViewGroup.MarginLayoutParams ?: return null
        val pixels = if (parent.orientation == LinearLayout.VERTICAL) margins.bottomMargin else margins.marginEnd
        return pixels / view.resources.displayMetrics.density.toDouble()
    }

    private fun setSpacing(view: View, value: Double): Boolean {
        val parent = view.parent as? LinearLayout ?: return false
        val margins = view.layoutParams as? ViewGroup.MarginLayoutParams ?: return false
        val pixels = (value * view.resources.displayMetrics.density).toInt()
        if (parent.orientation == LinearLayout.VERTICAL) {
            margins.bottomMargin = pixels
        } else {
            margins.marginEnd = pixels
        }
        view.layoutParams = margins
        return true
    }

    private fun colorValue(color: Int): JsonObject = buildJsonObject {
        put("kind", JsonPrimitive("color_rgba"))
        put("value", buildJsonObject {
            put("red", JsonPrimitive(Color.red(color) / 255.0))
            put("green", JsonPrimitive(Color.green(color) / 255.0))
            put("blue", JsonPrimitive(Color.blue(color) / 255.0))
            put("alpha", JsonPrimitive(Color.alpha(color) / 255.0))
        })
        put("color_space", JsonPrimitive("srgb"))
        put("extensions", JsonObject(emptyMap()))
    }

    private fun color(value: JsonElement): Int? {
        val property = value as? JsonObject ?: return null
        val components = property["value"] as? JsonObject ?: return null
        val red = rawNumber(components["red"])?.takeIf { it in 0.0..1.0 } ?: return null
        val green = rawNumber(components["green"])?.takeIf { it in 0.0..1.0 } ?: return null
        val blue = rawNumber(components["blue"])?.takeIf { it in 0.0..1.0 } ?: return null
        val alpha = rawNumber(components["alpha"])?.takeIf { it in 0.0..1.0 } ?: return null
        return Color.argb(
            (alpha * 255).toInt(),
            (red * 255).toInt(),
            (green * 255).toInt(),
            (blue * 255).toInt(),
        )
    }

    private fun fontValue(view: TextView): JsonObject {
        val weight = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            view.typeface?.weight ?: 400
        } else if (view.typeface?.isBold == true) {
            700
        } else {
            400
        }
        val size = view.textSize / view.resources.displayMetrics.density
        return buildJsonObject {
            put("kind", JsonPrimitive("font"))
            put("value", buildJsonObject {
                put("family", JsonPrimitive("android-system"))
                put("size", JsonPrimitive(size))
                put("weight", JsonPrimitive(weight))
                put("style", JsonPrimitive(if (view.typeface?.isItalic == true) "italic" else "normal"))
            })
            put("extensions", JsonObject(emptyMap()))
        }
    }

    private fun font(value: JsonElement): FontValue? {
        val property = value as? JsonObject ?: return null
        val objectValue = property["value"] as? JsonObject ?: return null
        val size = rawNumber(objectValue["size"])?.takeIf { it > 0 } ?: return null
        val weight = rawNumber(objectValue["weight"])?.toInt()?.takeIf { it in 1..1000 } ?: return null
        val style = (objectValue["style"] as? JsonPrimitive)?.content ?: return null
        return FontValue(size, weight, style == "italic")
    }

    private fun rawNumber(value: JsonElement?): Double? =
        (value as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.doubleOrNull
}
