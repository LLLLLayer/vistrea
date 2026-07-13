package dev.vistrea.runtime.android

import dev.vistrea.protocol.v1.CaptureLimitation
import dev.vistrea.protocol.v1.CaptureLimitationScope
import dev.vistrea.protocol.v1.CaptureLimitationSeverity
import dev.vistrea.protocol.v1.Extensions
import dev.vistrea.protocol.v1.NodeId
import dev.vistrea.protocol.v1.TreeId

/**
 * Bounds observed values against the canonical model limits instead of failing
 * the whole capture, reporting every loss as an explicit Capture Limitation.
 *
 * The canonical `ui-node` schema counts `maxLength` in Unicode code points, so
 * truncation always cuts on a code-point boundary and never splits a surrogate
 * pair. This mirrors `CaptureContentLimits` in the iOS SDK: the same fields,
 * the same limits, and the same node-scoped limitation, so one over-long
 * TextView or Compose text node degrades to a truncated, flagged value instead
 * of a Snapshot the Host rejects as schema-invalid.
 *
 * Shared by the View walker and by semantics extensions such as the Compose
 * bridge, so both content paths bound identically.
 */
object CaptureContentLimits {
    /** `text`, `value`, `content_description`, and both accessibility strings. */
    const val TEXT_CODE_POINT_LIMIT: Int = 65_536

    /** `placeholder`. */
    const val PLACEHOLDER_CODE_POINT_LIMIT: Int = 4_096

    /** Recorded when an observed string exceeded its canonical field limit. */
    const val TEXT_TRUNCATED_CODE: String = "android.capture.text-truncated"

    /** Recorded when a present identifier cannot become a canonical `stable_id`. */
    const val STABLE_ID_INVALID_CODE: String = "android.capture.stable-id-invalid"

    /** A bounded value plus the limitation its truncation produced, if any. */
    class BoundedValue internal constructor(
        val value: String?,
        val limitation: CaptureLimitation?,
    )

    /**
     * Truncates an over-limit [value] on a Unicode code-point boundary and
     * records a node-scoped limitation; in-limit values pass through untouched.
     *
     * [field] names the canonical field, for example `content.text`.
     */
    fun bounded(
        value: String?,
        limit: Int,
        field: String,
        treeId: TreeId,
        nodeId: NodeId,
    ): BoundedValue {
        require(limit > 0) { "The content limit must be positive." }
        // A UTF-16 length within the limit always bounds the code-point count,
        // so the common short-string case never walks the string.
        if (value == null || value.length <= limit) {
            return BoundedValue(value, null)
        }
        if (value.codePointCount(0, value.length) <= limit) {
            return BoundedValue(value, null)
        }
        val end = value.offsetByCodePoints(0, limit)
        return BoundedValue(
            value = value.substring(0, end),
            limitation = CaptureLimitation(
                code = TEXT_TRUNCATED_CODE,
                severity = CaptureLimitationSeverity.WARNING,
                message = "The observed text exceeds the canonical field limit and was " +
                    "truncated to $limit Unicode code points.",
                scope = CaptureLimitationScope(treeId = treeId, nodeId = nodeId, field = field),
                retryable = false,
                extensions = Extensions.empty(),
            ),
        )
    }

    /**
     * Reports an observed identifier that cannot become a canonical
     * `stable_id`, so vanished stable identity stays diagnosable instead of
     * silently disappearing from the node.
     */
    fun invalidStableIdentifier(treeId: TreeId, nodeId: NodeId): CaptureLimitation = CaptureLimitation(
        code = STABLE_ID_INVALID_CODE,
        severity = CaptureLimitationSeverity.WARNING,
        message = "The observed identifier is not a canonical stable_id and was omitted from this node.",
        scope = CaptureLimitationScope(treeId = treeId, nodeId = nodeId, field = "stable_id"),
        retryable = false,
        extensions = Extensions.empty(),
    )
}
