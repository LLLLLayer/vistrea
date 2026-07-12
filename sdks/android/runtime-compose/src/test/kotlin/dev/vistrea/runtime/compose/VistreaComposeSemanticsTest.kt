package dev.vistrea.runtime.compose

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
