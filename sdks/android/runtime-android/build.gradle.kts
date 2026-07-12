import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    kotlin("android")
}

val androidCompileSdk = 36
val androidMinSdk = 26
val javaToolchainVersion = 17

android {
    namespace = "dev.vistrea.runtime.android"
    compileSdk = androidCompileSdk
    useLibrary("android.test.base")
    useLibrary("android.test.runner")

    defaultConfig {
        minSdk = androidMinSdk
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
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

    buildFeatures {
        buildConfig = false
    }
}

kotlin {
    jvmToolchain(javaToolchainVersion)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
    sourceSets {
        named("debug") {
            kotlin.srcDir("src/development/kotlin")
        }
        named("internal") {
            kotlin.srcDir("src/development/kotlin")
        }
    }
}

dependencies {
    api(project(":"))
    debugApi(project(":runtime-connection"))
    "internalApi"(project(":runtime-connection"))
    debugImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    "internalImplementation"("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    testImplementation(kotlin("test-junit"))
}
