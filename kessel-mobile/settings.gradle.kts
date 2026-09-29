// Kessel for phones: the Android app (see README.md). A separate Gradle
// build from the desktop browser in ../tauri-browser, sharing its
// address-bar answers, icons and helpers (see app/build.gradle.kts).

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

rootProject.name = "kessel-mobile"
include(":app")
