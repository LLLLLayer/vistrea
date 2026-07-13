import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Jetpack Compose content of the demo.mixed.declarative scenario. It is
// a separate module because the Compose compiler refuses to run over any
// compilation that lacks the Compose runtime on its classpath, and the Demo
// application's Release variant must stay framework-only. The application
// consumes this module through debugImplementation exclusively;
// sdks/android/tools/verify-runtime-release-boundary.sh proves no Compose or
// AndroidX marker reaches the Release APK.
plugins {
    id("com.android.library")
    kotlin("android")
    kotlin("plugin.compose")
}

val androidCompileSdk = 36
val androidMinSdk = 26
val javaToolchainVersion = 17

android {
    namespace = "dev.vistrea.demo.mixed"
    compileSdk = androidCompileSdk

    defaultConfig {
        minSdk = androidMinSdk
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
        compose = true
    }
}

kotlin {
    jvmToolchain(javaToolchainVersion)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    implementation("dev.vistrea:runtime-compose:0.1.0")
    implementation("androidx.compose.foundation:foundation:1.7.8")
    implementation("androidx.compose.runtime:runtime:1.7.8")
    implementation("androidx.compose.ui:ui:1.7.8")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.savedstate:savedstate:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
