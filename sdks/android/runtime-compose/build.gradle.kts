import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    kotlin("android")
    // The Compose compiler is needed only for the instrumented test
    // composables; the library main sources declare no @Composable function.
    kotlin("plugin.compose")
}

val androidCompileSdk = 36
val androidMinSdk = 26
val javaToolchainVersion = 17

android {
    namespace = "dev.vistrea.runtime.compose"
    compileSdk = androidCompileSdk

    defaultConfig {
        minSdk = androidMinSdk
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
    api(project(":runtime-android"))
    implementation("androidx.compose.ui:ui:1.7.8")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    testImplementation(kotlin("test"))
    androidTestImplementation(kotlin("test-junit"))
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.foundation:foundation:1.7.8")
    androidTestImplementation("androidx.activity:activity-compose:1.9.3")
}
