package dev.vistrea.runtime.compose

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

private class RecordingSemanticsReceiver : SemanticsPropertyReceiver {
    val values = mutableMapOf<String, Any?>()

    override fun <T> set(key: SemanticsPropertyKey<T>, value: T) {
        values[key.name] = value
    }
}

class VistreaComposeSemanticsTest {
    @Test
    fun `wire names match the canonical role vocabulary`() {
        assertEquals(
            listOf(
                "button",
                "text",
                "image",
                "header",
                "link",
                "text-field",
                "list-item",
                "container",
            ),
            VistreaSemanticRole.entries.map(VistreaSemanticRole::wireName),
        )
    }

    @Test
    fun `every role attaches its recoverable wire name fact`() {
        for (role in VistreaSemanticRole.entries) {
            val receiver = RecordingSemanticsReceiver()
            receiver.applyVistreaSemantics(role, label = null)
            assertEquals(role.wireName, receiver.values[VistreaRoleSemanticsKey.name])
        }
    }

    @Test
    fun `existing role and heading and label mappings stay intact`() {
        val button = RecordingSemanticsReceiver()
        button.applyVistreaSemantics(VistreaSemanticRole.BUTTON, label = "Open catalog")
        assertEquals(Role.Button, button.values["Role"])
        assertEquals(listOf("Open catalog"), button.values["ContentDescription"])

        val image = RecordingSemanticsReceiver()
        image.applyVistreaSemantics(VistreaSemanticRole.IMAGE, label = null)
        assertEquals(Role.Image, image.values["Role"])
        assertFalse(image.values.containsKey("ContentDescription"))

        val header = RecordingSemanticsReceiver()
        header.applyVistreaSemantics(VistreaSemanticRole.HEADER, label = null)
        assertEquals(Unit, header.values["Heading"])

        // Roles without a Compose equivalent set no semantics role but still
        // carry their wire name fact for recovery.
        val link = RecordingSemanticsReceiver()
        link.applyVistreaSemantics(VistreaSemanticRole.LINK, label = null)
        assertFalse(link.values.containsKey("Role"))
        assertEquals("link", link.values[VistreaRoleSemanticsKey.name])
    }
}
