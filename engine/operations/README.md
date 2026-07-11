# Operations Engine

Owns generic long-running operation lifecycle, progress events, cancellation, result resolution, and durable operation history used by exploration, validation, import/export, garbage collection, and synchronization.

Domain engines create typed operations; this module provides shared lifecycle semantics without implementing domain work.
