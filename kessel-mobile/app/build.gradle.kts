import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for both apps: the desktop's package.json.
val desktopPackage = rootProject.file("../tauri-browser/package.json")
val kesselVersion = (JsonSlurper().parseText(desktopPackage.readText()) as Map<*, *>)["version"] as String
val kesselVersionCode = kesselVersion.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }

// Release signing: from the environment when a key is given (CI secrets,
// see .github/workflows/android.yml), else the debug key -- so a release
// build always installs, it just can't update a copy signed with the real key.
val releaseKeystore = System.getenv("KESSEL_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "com.kessel.browser"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kessel.browser"
        minSdk = 29
        targetSdk = 35
        versionCode = kesselVersionCode
        versionName = kesselVersion
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("KESSEL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KESSEL_KEY_ALIAS")
                keyPassword = System.getenv("KESSEL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Nothing to shrink: the app is a few Kotlin classes and a web UI.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = false
    }

    lint {
        // Lint's warnings are reported, its fatal errors still stop a release build.
        abortOnError = false
    }
}

// The desktop's address-bar answers (calculator, conversions...), icons and
// helpers, copied into the phone UI's assets at build time: one copy of that
// code for both apps.
abstract class CopyDesktopShared : DefaultTask() {
    @get:InputFiles
    abstract val sources: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val target = outputDir.get().asFile.resolve("ui/shared")
        target.deleteRecursively()
        target.mkdirs()
        sources.files.forEach { it.copyTo(target.resolve(it.name), overwrite = true) }
    }
}

val desktopShared = rootProject.file("../tauri-browser/src/shared")

androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyDesktopShared>("copy${variant.name.replaceFirstChar(Char::uppercase)}DesktopShared") {
            sources.from(listOf("answers.js", "icons.js", "api.js").map { desktopShared.resolve(it) })
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyDesktopShared::outputDir)
    }
}

dependencies {
    // Private tabs' own cookies and storage (the WebView "profile" API).
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
