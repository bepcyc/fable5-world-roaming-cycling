plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.bepcyc.laas"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bepcyc.laas"
        minSdk = 31
        targetSdk = 34
        versionCode = 1
        versionName = "0.3.0"
    }

    compileOptions {
        // JDK 21 runs Gradle; bytecode target 17 is safe for this pin matrix.
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.core:core-ktx:1.13.1")
}
