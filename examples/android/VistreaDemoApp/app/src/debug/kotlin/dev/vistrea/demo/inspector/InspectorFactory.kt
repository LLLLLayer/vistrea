package dev.vistrea.demo.inspector

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import dev.vistrea.demo.R

internal object InspectorFactory {
    fun create(): InspectorLauncher = InspectorLauncher { activity, inspectedRoot ->
        Button(activity).apply {
            text = activity.getString(R.string.debug_view_tree)
            isAllCaps = false
            contentDescription = DEBUG_INSPECTOR_ID
            tag = DEBUG_INSPECTOR_ID
            setOnClickListener { showTree(activity, inspectedRoot) }
        }
    }

    private fun showTree(activity: Activity, root: View) {
        val tree = TextView(activity).apply {
            typeface = Typeface.MONOSPACE
            textSize = INSPECTOR_TEXT_SIZE_SP
            setPadding(
                INSPECTOR_PADDING_PX,
                INSPECTOR_PADDING_PX,
                INSPECTOR_PADDING_PX,
                INSPECTOR_PADDING_PX,
            )
            text = buildTree(root)
        }
        AlertDialog.Builder(activity)
            .setTitle("Local Debug View Tree")
            .setMessage("Authenticated Host capture is available when Debug configuration is present.")
            .setView(ScrollView(activity).apply { addView(tree) })
            .setPositiveButton("Close", null)
            .show()
    }

    private fun buildTree(root: View): String {
        val lines = mutableListOf<String>()
        val pending = ArrayDeque<Node>()
        pending.add(Node(root, 0))
        while (pending.isNotEmpty() && lines.size < MAX_NODES) {
            val current = pending.removeFirst()
            lines += describe(current)
            val group = current.view as? ViewGroup ?: continue
            for (index in group.childCount - 1 downTo 0) {
                pending.addFirst(Node(group.getChildAt(index), current.depth + 1))
            }
        }
        if (pending.isNotEmpty()) {
            lines += "… truncated at $MAX_NODES nodes"
        }
        return lines.joinToString("\n")
    }

    private fun describe(node: Node): String {
        val view = node.view
        val identity = view.tag ?: view.contentDescription ?: "-"
        return "  ".repeat(node.depth) +
            "${view.javaClass.simpleName} id=$identity " +
            "frame=${view.left},${view.top},${view.right},${view.bottom}"
    }

    private data class Node(
        val view: View,
        val depth: Int,
    )

    private const val MAX_NODES = 200
    private const val DEBUG_INSPECTOR_ID = "android.debug.inspector.open"
    private const val INSPECTOR_TEXT_SIZE_SP = 12f
    private const val INSPECTOR_PADDING_PX = 24
}
