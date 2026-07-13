import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.tasks.Sync
import org.gradle.api.tasks.testing.Test
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
}

val scenarioContractRoot = rootProject.layout.projectDirectory.dir("../../scenarios")
val generatedScenarioAssets = layout.buildDirectory.dir("generated/scenario-assets")
val androidCompileSdk = 36
val androidMinSdk = 26
val androidTargetSdk = 36
val initialVersionCode = 1
val javaToolchainVersion = 17
val syncScenarioContracts by tasks.registering(Sync::class) {
    from(scenarioContractRoot.file("manifest.json")) {
        into("scenarios")
    }
    from(scenarioContractRoot.dir("fixtures/v1")) {
        into("scenarios/fixtures/v1")
    }
    into(generatedScenarioAssets)
    includeEmptyDirs = false
    duplicatesStrategy = DuplicatesStrategy.FAIL
}

android {
    namespace = "dev.vistrea.demo"
    compileSdk = androidCompileSdk

    defaultConfig {
        applicationId = "dev.vistrea.demo"
        minSdk = androidMinSdk
        targetSdk = androidTargetSdk
        versionCode = initialVersionCode
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets.getByName("main").assets.srcDir(generatedScenarioAssets)

    testOptions {
        unitTests {
            // Robolectric proves the snap catalog's structural invariant on
            // the real View class from plain JVM unit tests.
            isIncludeAndroidResources = true
        }
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
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    debugImplementation("dev.vistrea:runtime-android:0.1.0")
    debugImplementation("dev.vistrea:runtime-compose:0.1.0")
    debugImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // The demo.mixed.declarative scenario renders through Jetpack Compose in
    // the Debug variant only. All Compose code lives in the :mixed-declarative
    // module because the Compose compiler refuses any compilation without the
    // Compose runtime on its classpath, and the Release APK must stay
    // framework-only, which verify-runtime-release-boundary.sh proves.
    debugImplementation(project(":mixed-declarative"))
    testImplementation(kotlin("test-junit"))
    testImplementation("org.robolectric:robolectric:4.14.1")
}

tasks.named("preBuild").configure {
    dependsOn(syncScenarioContracts)
}

tasks.withType<Test>().configureEach {
    dependsOn(syncScenarioContracts)
    inputs.dir(generatedScenarioAssets)
    systemProperty("vistrea.scenario.assets", generatedScenarioAssets.get().asFile.absolutePath)
    systemProperty("vistrea.scenario.source", scenarioContractRoot.asFile.absolutePath)
}
