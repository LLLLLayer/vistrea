package dev.vistrea.demo.runtime

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.fail

class RuntimeConnectionManagerTest {
    @Test
    fun scenarioOnlyUpdateKeepsConnectionAndValidReplacementSwapsOnce() {
        val manager = RuntimeConnectionManager()
        val first = RecordingController()
        val second = RecordingController()

        manager.replaceIfRequested(requested = true) { first }
        manager.replaceIfRequested(requested = false) {
            fail("A scenario-only Intent must not create a Runtime replacement.")
        }
        manager.replaceIfRequested(requested = true) { null }
        assertEquals(1, first.startCount)
        assertEquals(0, first.stopCount)

        manager.replaceIfRequested(requested = true) { second }
        assertEquals(1, first.stopCount)
        assertEquals(1, second.startCount)
        assertEquals(0, second.stopCount)

        manager.stop()
        assertEquals(1, second.stopCount)
    }

    private class RecordingController : RuntimeConnectionController {
        var startCount = 0
        var stopCount = 0

        override fun start() {
            startCount += 1
        }

        override fun stop() {
            stopCount += 1
        }
    }
}
