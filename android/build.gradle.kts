// Root build file — plugins declared apply-false with the pinned versions so
// the :app module can apply them. Pin matrix: AGP 8.5.2 / Kotlin 1.9.24 /
// Gradle 8.7 / JDK 21 (bytecode target 17) / compileSdk 34 / minSdk 31.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
