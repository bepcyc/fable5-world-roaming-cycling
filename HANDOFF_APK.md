# HANDOFF — упаковка в Android APK (офлайн) + Linux binary

**Дата**: 2026-07-06. **Ветка**: `rando-3tracks`. **Для**: следующей сессии Claude.
**Парный документ**: `PLAN_NEXT_STEP.md` (WAR PLAN с ветвлениями) и
`docs/PACKAGING.md` (обоснование решения). Этот файл — как продолжить.

---

## 0. TL;DR — где мы стоим

- **Задача владельца**: перевести движок (three.js **WebGPU + TSL-compute +
  Web Bluetooth**, ~30k LOC TS, Vite) в (1) **Linux-бинарь** и (2)
  **самодостаточный ОФЛАЙН Android APK** с аппаратным WebGPU на топ-Snapdragon.
- **Linux-бинарь — ГОТОВ и собран.** `just linux-binary` работает.
- **Android APK (вариант B, офлайн) — НЕ ДОПИСАН.** Тулчейн готов, дизайн
  утверждён и сверен с Codex, но нативные файлы (Kotlin/Gradle) НЕ написаны —
  меня остановили приказом «не меняй» на рубеже 4 (см. WAR PLAN).
- **Следующий шаг**: дописать рубежи 2-5 варианта B (§6 ниже), ЛИБО по приказу
  владельца — сменить доктрину (повороты в WAR PLAN §8).

## 1. Решение (общее Claude+Codex, дословно проверено web-ресёрчем)

**Везде тащим полный Chromium — иначе нет WebGPU.** Причина жёсткая:

> **WebGPU на Android живёт ТОЛЬКО в Chrome-браузере (и Chrome-движковых
> поверхностях: Custom Tabs / TWA). В Android System WebView WebGPU по
> умолчанию НЕТ (2025-2026), `androidx.webkit` переключателя не имеет.**

Отсюда:
- Всё, что бандлит офлайн через System WebView (Capacitor/Tauri/голый WebView),
  **теряет WebGPU**. WebGL2-фолбэка у движка нет (compute-шейдеры / storage).
- Всё, что даёт WebGPU, гонит рендер через Chrome пользователя.
- **Desktop** = Electron (бандлит Chromium). **Android** = см. ниже.

### Мы сначала ошиблись (важно для контекста)
Первым ответом мы с Codex дали **TWA (Bubblewrap)** и продали как «просто».
Владелец справедливо обматерил: TWA — НЕ офлайн, это оболочка вокруг вечно-
хостящегося HTTPS-URL. Мы прочитали часть вопроса (APK) и пропустили часть
(самодостаточность/офлайн). Codex это признал дословно: *«Yes. We both missed
the offline/self-contained APK requirement.»* → выбрали **вариант B**.

## 2. Вариант B — офлайн-APK (утверждён владельцем + сверен с Codex)

Тонкая нативная Android-оболочка, которая **несёт весь контент внутри**, а
WebGPU **одалживает у установленного Chrome**:

```
APK
├── assets/www/          ← весь dist/ ВНУТРИ APK (офлайн, интернет не нужен)
├── AssetHttpServer.kt   ← ServerSocket на 127.0.0.1:47862, раздаёт assets/www
│                           (127.0.0.1 = secure context → WebGPU+BLE разрешены)
├── MainActivity.kt      ← старт сервера → Chrome Custom Tab на http://127.0.0.1:47862/
│                           (Custom Tab = движок Chrome → WebGPU on; пин на com.android.chrome)
└── AndroidManifest.xml  ← INTERNET (для loopback) + <queries> com.android.chrome
```

Поток: тап иконки → локальный сервер → Custom Tab на loopback → страница дергает
`canvas.requestFullscreen()` на первый тап (прячет тулбар) → **иммерсивно,
офлайн, аппаратный WebGPU**. BLE не переписывать — страница в Chrome, Web
Bluetooth работает, нативный плагин и Bluetooth-permission НЕ нужны.

**Честная формулировка продукта**: офлайн-APK с забандленными ассетами, WebGPU/
BLE даёт установленный **Chrome ≥121, Android 12+, GPU Adreno/Mali**. Не чистый
self-contained рантайм (свой Chromium в APK = проект на месяцы).

### Поправки Codex, которые ОБЯЗАТЕЛЬНО учесть при написании
1. Пинить Custom Tab на `com.android.chrome` (не дефолтный браузер — у Firefox/
   GeckoView WebGPU нет). `intent.intent.setPackage("com.android.chrome")`.
2. Фиксированный порт **47862** → стабильный origin → IndexedDB/localStorage/
   BLE-гранты переживают перезапуск. Занят → эфемерный (origin сбросится).
3. Биндить строго `127.0.0.1`, НИКОГДА `0.0.0.0` (иначе дыра в LAN).
4. `MainActivity.onDestroy` → `server.stop()`.
5. Не продавать гарантированный фуллскрин: `setUrlBarHidingEnabled(true)` +
   Fullscreen API; kiosk-режима в Custom Tabs нет.

## 3. Что УЖЕ сделано (файлы + тулинг)

### Linux (готово, собрано)
- `electron/main.cjs` — Electron-шелл. Флаги `--enable-unsafe-webgpu
  --enable-features=Vulkan`, **БЕЗ `--use-angle=vulkan`** (иначе SIGFPE-краш
  GPU-процесса на кокпите — задокументировано в Justfile `run-rxgpu`).
  Раздаёт dist с loopback 127.0.0.1 (secure context). BLE через
  `select-bluetooth-device` (авто-выбор первого; TODO нормальный чузер).
- `electron-builder.yml` — target `dir` + `AppImage`, `extraMetadata.main`.
- **Артефакты собраны**: `dist-electron/laas-linux-x86_64.AppImage` (135 МБ) +
  `dist-electron/linux-unpacked/laas` (221 МБ ELF, `ldd` чист).
- `just linux-binary` — цель добавлена и работает.

### Общее
- `public/manifest.webmanifest` — PWA-манифест (start_url `/laas/?nogate=1&
  preset=low&dpr=1`). Нужен и для TWA-поворота.
- `public/icons/icon-{192,512,maskable-512}.png` — сгенерены sharp из
  bike-gravel.png.
- `index.html` — добавлен `<link rel="manifest">` + theme-color (в HEAD чисто).
- `vite.config.ts` — `ELECTRON=1` → base `/`. **Нужно ДОБАВИТЬ**
  `ANDROID_APK=1` → тоже base `/` (Codex): см. §6.
- `Justfile` — добавлены цели `linux-binary` (готова) и `android-apk` (**сейчас
  в TWA/Bubblewrap-режиме — НАДО ПЕРЕПИСАТЬ под вариант B**, см. §6).
- `.gitignore` — добавлены `dist-electron/` и `android/`.
- `docs/PACKAGING.md`, `PLAN_NEXT_STEP.md` — документация + war plan.

### Тулчейн (установлен ВНЕ репо, готов)
- `~/Android/Sdk`: `build-tools/34.0.0`, `platforms/android-34`, `platform-tools`
  (adb). Ставился через cmdline-tools 11076708.
- `~/.cache/laas-gradle/gradle-8.7` — Gradle 8.7 (gradle не был установлен).
- Electron 43 + electron-builder 26 — в devDependencies (`npm i` их поставил;
  package.json/package-lock — M).

### ⚠️ ЛАНДМАЙН JAVA_HOME (уже подорвались, разминировано)
`JAVA_HOME` в окружении = `~/.sdkman/candidates/java/current` → **Java 8**
(единственная в sdkman). sdkmanager/gradle слушают JAVA_HOME → падают с
`sun.misc.Launcher`/ClassLoader. **Для ЛЮБОЙ Android-команды форсить**:
```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
```
Система имеет java-21-openjdk (`/bin/java` = 21.0.11). Это ОБЯЗАНО попасть в
`just android-apk`, иначе gradle подорвётся снова.

## 4. Что НЕ сделано
- `android/` — только ПУСТЫЕ директории (`app/src/main/{java/com/bepcyc/laas,
  assets,res/values}`, `gradle/wrapper`). **Ни одного Kotlin/Gradle-файла.**
- `MainActivity.kt`, `AssetHttpServer.kt` — НЕ написаны.
- `settings.gradle.kts`, `build.gradle.kts` (root+app), `AndroidManifest.xml`,
  `gradle-wrapper` — НЕ написаны.
- `BrowserGate.ts` — НЕ тронут (нужна правка: пускать `hostname===127.0.0.1`).
- `vite.config.ts` — `ANDROID_APK=1` ветка НЕ добавлена.
- `just android-apk` — всё ещё TWA-режим, НЕ вариант B.
- APK не собран. На устройстве не проверен (рубеж 5 — туман, нужен телефон).

## 5. ⚠️ Параллельный владелец — ОСТОРОЖНО с git
**Владелец коммитит в `rando-3tracks` в реальном времени** (за эту сессию
появились `5859972`, `3a47e05` — его WIP WaterMaterial.ts/TerrainTiles.ts ушёл
туда). **Мои изменения — uncommitted:**
- M (tracked): `.gitignore`, `Justfile`, `package.json`, `package-lock.json`,
  `vite.config.ts`.
- ?? (untracked): `electron/`, `electron-builder.yml`, `docs/PACKAGING.md`,
  `PLAN_NEXT_STEP.md`, `HANDOFF_APK.md`, `public/manifest.webmanifest`,
  `public/icons/icon-*.png`.

**Не коммитить owner WIP. Не пушить без приказа.** Перед работой — `git status`,
`git log --oneline -5`: владелец мог уйти вперёд. `/home/bepcyc/dev/my/
fable5-world-roaming-cycling` = bind-mount того же дерева (`/d/models2/...`).

## 6. КАК ПРОДОЛЖИТЬ вариант B (конкретные шаги — рубежи 2-5)

Порядок = ось наступления из WAR PLAN. Каждый шаг: см. риски/манёвры в
`PLAN_NEXT_STEP.md` §2-7.

1. **vite.config.ts** — `ANDROID_APK=1` → base `/`:
   ```ts
   base: (process.env.ELECTRON === "1" || process.env.ANDROID_APK === "1")
     ? "/" : command === "build" ? "/laas/" : "/",
   ```
2. **BrowserGate.ts** (~строка 65, `if (isMobileDevice())`) — пускать APK:
   допустить `location.hostname === "127.0.0.1"` ДО отклонения по мобильному UA;
   **оставить** проверку `navigator.gpu` (строка 86) для честной диагностики.
3. **Написать нативный проект** (`android/`):
   - `settings.gradle.kts`, `build.gradle.kts` (root), `app/build.gradle.kts`.
     Пин-матрица: **AGP 8.5.2 / Gradle 8.7 / Kotlin 1.9.24 / JDK 21 /
     compileSdk 34 / minSdk 31 / targetSdk 34**. Dep: `androidx.browser:browser:1.8.0`.
   - `AndroidManifest.xml`: `<uses-permission INTERNET>` + `<queries><package
     android:name="com.android.chrome"/></queries>`, launcher activity.
   - `AssetHttpServer.kt`: `ServerSocket` на `127.0.0.1`, порт 47862 (fallback
     ephemeral), раздаёт `assets/www`, MIME-таблица (`.wasm/.glb/.webmanifest/
     .js/.css/.png/.webp` — как в `electron/main.cjs`), SPA-fallback index.html,
     traversal-guard.
   - `MainActivity.kt`: старт сервера → дождаться `isAlive` → `CustomTabsIntent`
     `.setPackage("com.android.chrome")` → `launchUrl(http://127.0.0.1:PORT/)`;
     `onDestroy` → stop. Проверка наличия Chrome через PackageManager +
     внятное сообщение если нет.
   - `gradle/wrapper`: сгенерить `~/.cache/laas-gradle/gradle-8.7/bin/gradle
     wrapper` (с `JAVA_HOME=java-21`), чтобы проект был самодостаточен.
4. **Переписать `just android-apk`** под вариант B:
   ```
   export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
   export ANDROID_HOME=$HOME/Android/Sdk
   ANDROID_APK=1 npx vite build           # base '/'
   rm -rf android/app/src/main/assets/www && cp -r dist android/app/src/main/assets/www
   cd android && ./gradlew assembleDebug   # debug-подпись = ставится (release-keystore позже)
   # → android/app/build/outputs/apk/debug/app-debug.apk
   ```
5. **Проверка** (рубеж 5, туман — нужен телефон):
   - `adb install app-debug.apk`, запуск офлайн, `chrome://gpu` → WebGPU
     «Hardware accelerated», BLE-чузер всплывает.
   - **Каждый кадр с телефона → в бот с ОЖИДАЛ/ВИЖУ** (правило sbs действует).
   - Провалы и развороты — WAR PLAN §7-8.

## 7. Команды-шпаргалка
```bash
# Linux binary (готово):
just linux-binary
# → dist-electron/laas-linux-x86_64.AppImage

# Android (после дописи §6):
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=$HOME/Android/Sdk
just android-apk

# Тулчейн-санити:
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --list | head
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ~/.cache/laas-gradle/gradle-8.7/bin/gradle -v
```

## 8. Откат (если владелец отменит переход)
```bash
rm -rf android/ dist-electron/ electron/ docs/PACKAGING.md PLAN_NEXT_STEP.md HANDOFF_APK.md
git checkout -- Justfile vite.config.ts .gitignore index.html   # index.html — если правка не в HEAD
rm -f public/manifest.webmanifest public/icons/icon-*.png
npm remove electron electron-builder
```
SDK/Gradle (`~/Android/Sdk`, `~/.cache/laas-gradle`) — вне репо, удалять
отдельно. Owner WIP не тронут.

## 9. Ключевые источники (проверено этой сессией)
- WebGPU в Chrome Android 121+ (не в WebView): web.dev/blog/webgpu-supported-major-browsers
- WebView без WebGPU: webo360solutions.com/blog/webgpu-browser-support
- Custom Tabs = движок браузера, все web-фичи: developer.chrome.com/docs/android/custom-tabs
- 127.0.0.1 = secure context: MDN WebGPU_API
- Android 16 Advanced Protection глушит WebGPU: android.gadgethacks.com
- Codex-ответы сохранены: `/tmp/.../scratchpad/codex-answer.txt`,
  `codex-q2-answer.txt` (могут быть стёрты — суть в §1-2).
