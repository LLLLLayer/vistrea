pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "VistreaDemoApp"
include(":app")

includeBuild("../../../sdks/android") {
    dependencySubstitution {
        substitute(module("dev.vistrea:runtime-android"))
            .using(project(":runtime-android"))
        substitute(module("dev.vistrea:runtime-compose"))
            .using(project(":runtime-compose"))
    }
}
