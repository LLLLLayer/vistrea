import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.testing.Test
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    kotlin("android")
    kotlin("plugin.serialization")
}

val androidCompileSdk = 36
val androidMinSdk = 26
val javaToolchainVersion = 17

android {
    namespace = "dev.vistrea.runtime.connection"
    compileSdk = androidCompileSdk

    defaultConfig {
        minSdk = androidMinSdk
    }

    buildTypes {
        create("internal") {
            initWith(getByName("debug"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(javaToolchainVersion)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
    sourceSets {
        named("main") {
            kotlin.setSrcDirs(emptyList<String>())
        }
        named("debug") {
            kotlin.srcDir("src/main/kotlin")
        }
        named("internal") {
            kotlin.srcDir("src/main/kotlin")
        }
        named("test") {
            kotlin.setSrcDirs(emptyList<String>())
        }
        named("testDebug") {
            kotlin.srcDir("src/test/kotlin")
        }
    }
}

dependencies {
    debugApi(project(":"))
    "internalApi"(project(":"))
    debugImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    "internalImplementation"("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    debugImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    "internalImplementation"("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    testImplementation(kotlin("test-junit"))
}

tasks.withType<Test>().configureEach {
    systemProperty(
        "vistrea.repository.root",
        rootProject.projectDir.resolve("../..").canonicalPath,
    )
}

tasks.register<JavaExec>("runInteropFixtureClient") {
    group = "verification"
    description = "Runs the Debug-only Kotlin Runtime client against an external Host."
    val debugUnitTests = tasks.named<Test>("testDebugUnitTest")
    dependsOn(debugUnitTests)
    mainClass.set("dev.vistrea.runtime.connection.interop.RuntimeConnectionInteropClientKt")
    classpath(debugUnitTests.map(Test::getClasspath))
}
