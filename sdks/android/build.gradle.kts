plugins {
    kotlin("jvm") version "2.1.20"
    kotlin("plugin.serialization") version "2.1.20"
}

group = "dev.vistrea"
version = "0.1.0"
val jvmToolchainVersion = 17

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    testImplementation(kotlin("test-junit"))
}

kotlin {
    jvmToolchain(jvmToolchainVersion)
    compilerOptions {
        allWarningsAsErrors.set(true)
    }
}

tasks.test {
    systemProperty(
        "vistrea.repository.root",
        rootProject.projectDir.resolve("../..").canonicalPath,
    )
}
