/**
 * i18n (owner directive 2026-07-06): three switchable languages, English
 * default. Language is a reload-scoped machine setting — a sibling of
 * graphics-preset and CPU-threads (see Threads.ts) — so no component ever
 * needs a live re-localize path; every surface reads the active language
 * once at construction, exactly like it reads params.preset today.
 *
 * Resolution mirrors Threads.ts exactly: `?lang=` URL param (tooling/
 * deterministic screenshots) → localStorage → 'en'. No auto-detect from
 * navigator.language — English is the hard default and tooling shots must
 * stay machine-independent.
 *
 * Dictionary is key-major (all 3 languages of a string on one line) so the
 * exact drift that caused this feature (Russian hardcoded into new UI while
 * the rest of the game stayed English) is visible at the point of editing.
 * `en` is compile-mandatory, `de`/`ru` optional — t() falls back through
 * `entry[lang] ?? entry.en ?? key`, so a missing translation degrades to
 * English, never to a raw key or a crash.
 */

export const LANG_LS_KEY = 'laas.lang';
export type Lang = 'en' | 'de' | 'ru';

function resolveLang(): Lang {
  const q = new URLSearchParams(window.location.search).get('lang');
  if (q === 'en' || q === 'de' || q === 'ru') return q;
  try {
    const ls = globalThis.localStorage?.getItem(LANG_LS_KEY);
    if (ls === 'de' || ls === 'ru') return ls;
  } catch {
    /* headless probes have no storage */
  }
  return 'en';
}

export function storeLang(l: Lang): void {
  try {
    if (l === 'en') globalThis.localStorage?.removeItem(LANG_LS_KEY);
    else globalThis.localStorage?.setItem(LANG_LS_KEY, l);
  } catch {
    /* ignore */
  }
}

/** captured once at module load — see file header on why this never mutates live */
export const LANG: Lang = resolveLang();

type Entry = { en: string } & Partial<Record<Lang, string>>;

const DICT: Record<string, Entry> = {
  // ---- main menu / pause / machine settings (src/core/GameMenu.ts) ----
  'menu.start': { en: 'START', de: 'START', ru: 'СТАРТ' },
  'menu.resume': { en: 'RESUME', de: 'FORTSETZEN', ru: 'ПРОДОЛЖИТЬ' },
  'menu.loading': { en: 'LOADING {pct}%', de: 'LÄDT {pct}%', ru: 'ЗАГРУЗКА {pct}%' },
  'menu.waitingHint': {
    en: 'entering as soon as the world is ready…',
    de: 'startet, sobald die Welt bereit ist…',
    ru: 'входим, как только мир будет готов…',
  },
  'menu.exitBlockedHint': {
    en: "the browser won't let a script close this tab — close it manually",
    de: 'der Browser lässt ein Skript diesen Tab nicht schließen — bitte manuell schließen',
    ru: 'браузер не даёт закрыть вкладку скриптом — закройте её вручную',
  },
  'menu.confirmReload': {
    en: 'This setting requires a reload. Current ride progress will be lost. Continue?',
    de: 'Diese Einstellung erfordert einen Neustart. Der aktuelle Fahrtfortschritt geht verloren. Fortfahren?',
    ru: 'Эта настройка требует перезагрузки. Текущий прогресс поездки будет потерян. Продолжить?',
  },
  // Static markup labels (index.html, applied by applyStaticI18n below). These
  // used to live in the markup as `data-de="..." data-ru="..."` attributes —
  // which nothing ever read, so in practice these strings were ALWAYS English
  // no matter the language, and they also put Cyrillic outside this file.
  'menu.settings': { en: 'SETTINGS', de: 'EINSTELLUNGEN', ru: 'НАСТРОЙКИ' },
  'menu.graphics': { en: 'GRAPHICS', de: 'GRAFIK', ru: 'ГРАФИКА' },
  'menu.exit': { en: 'EXIT', de: 'BEENDEN', ru: 'ВЫХОД' },
  'menu.mainMenu': { en: 'MAIN MENU', de: 'HAUPTMENÜ', ru: 'ГЛАВНОЕ МЕНЮ' },
  'menu.pause': { en: 'PAUSE', de: 'PAUSE', ru: 'ПАУЗА' },
  'menu.rotate': { en: 'ROTATE YOUR DEVICE', de: 'GERÄT DREHEN', ru: 'ПОВЕРНИТЕ УСТРОЙСТВО' },
  'msettings.title': { en: 'SETTINGS', de: 'EINSTELLUNGEN', ru: 'НАСТРОЙКИ' },
  'msettings.graphics': {
    en: 'GRAPHICS (RELOAD)',
    de: 'GRAFIK (NEUSTART)',
    ru: 'ГРАФИКА (ПЕРЕЗАГРУЗКА)',
  },
  'msettings.seedHeading': { en: 'SEED (RELOAD)', de: 'SEED (NEUSTART)', ru: 'СИД (ПЕРЕЗАГРУЗКА)' },
  'msettings.threads': { en: 'CPU THREADS', de: 'CPU-THREADS', ru: 'ПОТОКИ CPU' },
  'msettings.language': { en: 'LANGUAGE', de: 'SPRACHE', ru: 'ЯЗЫК' },

  // A language picker names each language in ITS OWN language, so these are
  // deliberately identical across the three columns.
  'lang.en': { en: 'English', de: 'English', ru: 'English' },
  'lang.de': { en: 'Deutsch', de: 'Deutsch', ru: 'Deutsch' },
  'lang.ru': { en: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', de: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', ru: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },

  // ---- BLE device manager (src/ride/ble/DeviceManagerUi.ts) ----
  'ble.unavailable': {
    en:
      'Web Bluetooth is unavailable in this browser.<br>' +
      'Linux Chrome: enable<br><b>chrome://flags/#enable-experimental-web-platform-features</b><br>' +
      '(needs BlueZ \u2265 5.41) and restart.',
    de:
      'Web Bluetooth ist in diesem Browser nicht verf\u00fcgbar.<br>' +
      'Linux-Chrome: aktiviere<br><b>chrome://flags/#enable-experimental-web-platform-features</b><br>' +
      '(ben\u00f6tigt BlueZ \u2265 5.41) und starte neu.',
    ru:
      'Web Bluetooth \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u0432 \u044d\u0442\u043e\u043c \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435.<br>' +
      'Linux Chrome: \u0432\u043a\u043b\u044e\u0447\u0438\u0442\u044c<br><b>chrome://flags/#enable-experimental-web-platform-features</b><br>' +
      '(\u043d\u0443\u0436\u0435\u043d BlueZ \u2265 5.41) \u0438 \u043f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c.',
  },
  'ble.noDevices': {
    en: 'No devices yet \u2014 tap ADD DEVICE.',
    de: 'Noch keine Ger\u00e4te \u2014 tippe auf ADD DEVICE.',
    ru: '\u041f\u043e\u043a\u0430 \u043d\u0438 \u043e\u0434\u043d\u043e\u0433\u043e \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0430 \u2014 \u043d\u0430\u0436\u043c\u0438 ADD DEVICE.',
  },
  // ---- native BLE bridge chooser (Android WebView APK; see
  // src/ride/ble/NativeBridgeTransport.ts). WebView has no Web Bluetooth and
  // therefore no browser-supplied chooser, so the app draws its own and these
  // are its strings.
  'ble.scan.title': {
    en: 'SELECT A DEVICE',
    de: 'GERÄT AUSWÄHLEN',
    ru: 'ВЫБЕРИ УСТРОЙСТВО',
  },
  'ble.scan.hint': {
    en: 'Wake the sensor first — spin the cranks, or put the strap on.',
    de: 'Sensor zuerst aufwecken — Kurbel drehen oder Gurt anlegen.',
    ru: 'Сначала разбуди датчик — крутни шатуны или надень ремень.',
  },
  'ble.scan.searching': {
    en: 'Searching…',
    de: 'Suche…',
    ru: 'Поиск…',
  },
  'ble.scan.cancel': { en: 'CANCEL', de: 'ABBRECHEN', ru: 'ОТМЕНА' },
  'ble.scan.saved': { en: 'saved', de: 'gespeichert', ru: 'сохранён' },
  'ble.err.off': {
    en: 'Bluetooth is switched off. Turn it on and try again.',
    de: 'Bluetooth ist ausgeschaltet. Schalte es ein und versuche es erneut.',
    ru: 'Bluetooth выключен. Включи его и повтори.',
  },
  'ble.err.perm': {
    en: 'Bluetooth permission denied. Grant "Nearby devices" in Android app settings.',
    de: 'Bluetooth-Berechtigung verweigert. Erteile "Geräte in der Nähe" in den App-Einstellungen.',
    ru: 'Нет разрешения на Bluetooth. Выдай «Устройства поблизости» в настройках приложения.',
  },
  'ble.err.noadapter': {
    en: 'This device has no Bluetooth adapter.',
    de: 'Dieses Gerät hat keinen Bluetooth-Adapter.',
    ru: 'На этом устройстве нет Bluetooth-адаптера.',
  },
  'ble.showAll': {
    en: "Don't see your device? Show all Bluetooth devices",
    de: 'Ger\u00e4t nicht dabei? Alle Bluetooth-Ger\u00e4te anzeigen',
    ru: '\u041d\u0435 \u0432\u0438\u0436\u0443 \u0441\u0432\u043e\u0451 \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u043e? \u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0432\u0441\u0435 Bluetooth-\u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0430',
  },
  'ble.sensorLost': {
    en: 'Sensor lost \u2014 tap to reconnect',
    de: 'Sensor verloren \u2014 zum Neuverbinden tippen',
    ru: '\u0414\u0430\u0442\u0447\u0438\u043a \u043f\u043e\u0442\u0435\u0440\u044f\u043d \u2014 \u043a\u043e\u0441\u043d\u0438\u0441\u044c, \u0447\u0442\u043e\u0431\u044b \u043f\u0435\u0440\u0435\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u044c',
  },

  'msettings.auto': { en: 'auto', de: 'auto', ru: '\u0430\u0432\u0442\u043e' },
  'msettings.seed': { en: 'seed', de: 'Seed', ru: 'сид' },
  'msettings.seedApply': { en: 'apply', de: 'anwenden', ru: 'применить' },
  'msettings.seedRandom': { en: 'random seed', de: 'zufälliger Seed', ru: 'случайный сид' },

  // ---- graphics preset (GameMenu.ts + SettingsMenu.ts, QualityPreset enum) ----
  'preset.min': { en: 'min', de: 'minimal', ru: 'минимум' },
  'preset.low': { en: 'low', de: 'niedrig', ru: 'низкая' },
  'preset.mid': { en: 'medium', de: 'mittel', ru: 'средняя' },
  'preset.high': { en: 'high', de: 'hoch', ru: 'высокая' },
  'preset.ultra': { en: 'ultra', de: 'ultra', ru: 'ультра' },
  'preset.custom': { en: 'custom', de: 'eigene', ru: 'своя' },

  // ---- graphics settings screen (SettingsMenu.ts) ----
  'settings.title': { en: 'GRAPHICS SETTINGS', de: 'GRAFIK-EINSTELLUNGEN', ru: 'НАСТРОЙКИ ГРАФИКИ' },
  'settings.advanced': { en: 'advanced mode', de: 'Experten-Modus', ru: 'расширенный режим' },
  'settings.reset': { en: 'reset', de: 'zurücksetzen', ru: 'сбросить' },
  'settings.restart': { en: 'apply & restart', de: 'anwenden & neu starten', ru: 'применить и перезапустить' },
  'settings.restartNote': {
    en: 'changes are saved; a restart applies them to the world',
    de: 'Änderungen sind gespeichert; ein Neustart wendet sie auf die Welt an',
    ru: 'изменения сохранены; перезапуск применит их к миру',
  },
  'settings.savedNote': {
    en: 'settings match the running world',
    de: 'Einstellungen entsprechen der laufenden Welt',
    ru: 'настройки совпадают с запущенным миром',
  },
  'settings.reloadBadge': { en: 'RESTART', de: 'NEUSTART', ru: 'РЕСТАРТ' },
  'settings.auto': { en: 'auto', de: 'auto', ru: 'авто' },
  'settings.tab.display': { en: 'display', de: 'Anzeige', ru: 'экран' },
  'settings.tab.vegetation': { en: 'vegetation', de: 'Vegetation', ru: 'растительность' },
  'settings.tab.shadows': { en: 'shadows', de: 'Schatten', ru: 'тени' },
  'settings.tab.atmosphere': { en: 'atmosphere', de: 'Atmosphäre', ru: 'атмосфера' },
  'settings.tab.effects': { en: 'effects', de: 'Effekte', ru: 'эффекты' },
  'settings.tab.world': { en: 'world detail', de: 'Welt-Detail', ru: 'детализация мира' },

  'settings.renderScale': { en: 'render scale', de: 'Render-Auflösung', ru: 'масштаб рендера' },
  'settings.renderScale.hint': {
    en: 'resolution multiplier; 0 = auto (device, capped)',
    de: 'Auflösungsfaktor; 0 = auto (Gerät, begrenzt)',
    ru: 'множитель разрешения; 0 = авто (устройство, с потолком)',
  },
  'settings.grassScale': { en: 'grass density divisor', de: 'Gras-Dichteteiler', ru: 'делитель плотности травы' },
  'settings.grassScale.hint': {
    en: 'higher = fewer, wider blades (coverage is preserved)',
    de: 'höher = weniger, breitere Halme (Deckung bleibt erhalten)',
    ru: 'выше = меньше, но шире травинки (покрытие сохраняется)',
  },
  'settings.grassBladesNear': { en: 'near clump blades', de: 'Halme pro Büschel (nah)', ru: 'травинок в пучке (близко)' },
  'settings.grassBladesNear.hint': {
    en: 'blades per grass clump within 26 m',
    de: 'Halme pro Grasbüschel innerhalb von 26 m',
    ru: 'травинок в пучке в радиусе 26 м',
  },
  'settings.grassSegsNear': { en: 'near blade segments', de: 'Halm-Segmente (nah)', ru: 'сегментов травинки (близко)' },
  'settings.grassSegsNear.hint': {
    en: 'triangles per near blade — bend smoothness',
    de: 'Dreiecke pro nahem Halm — Biegungsglätte',
    ru: 'треугольники ближней травинки — плавность изгиба',
  },
  'settings.grassBladesMid': { en: 'mid clump blades', de: 'Halme pro Büschel (mittel)', ru: 'травинок в пучке (средне)' },
  'settings.grassBladesMid.hint': {
    en: 'blades per clump in the 26-70 m band',
    de: 'Halme pro Büschel im 26-70-m-Band',
    ru: 'травинок в пучке в поясе 26-70 м',
  },
  'settings.grassSegsMid': { en: 'mid blade segments', de: 'Halm-Segmente (mittel)', ru: 'сегментов травинки (средне)' },
  'settings.grassSegsMid.hint': {
    en: 'triangles per mid-band blade',
    de: 'Dreiecke pro Halm im Mittelband',
    ru: 'треугольники травинки среднего пояса',
  },
  'settings.grassRadius': { en: 'grass ring reach', de: 'Gras-Ring-Reichweite', ru: 'радиус кольца травы' },
  'settings.grassRadius.hint': {
    en: 'meters of full blade grass around the camera',
    de: 'Meter volles Halmgras um die Kamera',
    ru: 'метры полной травы вокруг камеры',
  },
  'settings.grassFarLayer': { en: 'far meadow tufts', de: 'ferne Wiesenbüschel', ru: 'дальние пучки луга' },
  'settings.grassFarLayer.hint': {
    en: 'super-tuft silhouette layer 150-265 m',
    de: 'Silhouettenschicht 150-265 m',
    ru: 'слой силуэта луга 150-265 м',
  },
  'settings.debris': { en: 'ground debris', de: 'Bodenstreu', ru: 'мусор на земле' },
  'settings.debris.hint': {
    en: 'cobbles, twigs, litter, road grit and verge blooms',
    de: 'Steine, Zweige, Laub, Wegschotter und Randblüten',
    ru: 'галька, ветки, листва, дорожная крошка и цветы обочин',
  },
  'settings.treeRingScale': { en: 'tree detail distance', de: 'Baum-Detaildistanz', ru: 'дальность детализации деревьев' },
  'settings.treeRingScale.hint': {
    en: 'scales every tree LOD ring (cards, impostors)',
    de: 'skaliert alle Baum-LOD-Ringe (Karten, Impostor)',
    ru: 'масштабирует все LOD-кольца деревьев (карты, импосторы)',
  },
  'settings.vegShadowCasters': { en: 'vegetation shadows', de: 'Vegetationsschatten', ru: 'тени растительности' },
  'settings.vegShadowCasters.hint': {
    en: 'trees and rocks cast sun shadows',
    de: 'Bäume und Felsen werfen Sonnenschatten',
    ru: 'деревья и камни отбрасывают тени',
  },
  'settings.shadowCascades': { en: 'shadow cascades', de: 'Schatten-Kaskaden', ru: 'каскады теней' },
  'settings.shadowCascades.hint': {
    en: 'CSM splits; fewer = shorter shadow reach',
    de: 'CSM-Stufen; weniger = kürzere Schattenreichweite',
    ru: 'ступени CSM; меньше = короче дальность теней',
  },
  'settings.shadowMapSize': { en: 'shadow map size', de: 'Schattenkarten-Größe', ru: 'размер карты теней' },
  'settings.shadowMapSize.hint': {
    en: 'texels per cascade; sharpness of shadow edges',
    de: 'Texel pro Kaskade; Schärfe der Schattenkanten',
    ru: 'текселей на каскад; резкость краёв теней',
  },
  'settings.shadowMaxFar': { en: 'shadow distance', de: 'Schattendistanz', ru: 'дальность теней' },
  'settings.shadowMaxFar.hint': {
    en: 'meters the cascades cover',
    de: 'Meter, die die Kaskaden abdecken',
    ru: 'метры, покрываемые каскадами',
  },
  'settings.pcss': { en: 'soft shadows (PCSS)', de: 'weiche Schatten (PCSS)', ru: 'мягкие тени (PCSS)' },
  'settings.pcss.hint': {
    en: 'contact-hardening penumbra; off = simple filter',
    de: 'kontaktabhängige Halbschatten; aus = einfacher Filter',
    ru: 'контактная полутень; выкл = простой фильтр',
  },
  'settings.contactShadows': { en: 'contact shadows', de: 'Kontaktschatten', ru: 'контактные тени' },
  'settings.contactShadows.hint': {
    en: 'screen-space grounding under blades and stones',
    de: 'Screen-Space-Verankerung unter Halmen und Steinen',
    ru: 'экранное заземление травы и камней',
  },
  'settings.froxels': { en: 'volumetric fog', de: 'volumetrischer Nebel', ru: 'объёмный туман' },
  'settings.froxels.hint': {
    en: 'valley mist and canopy light shafts',
    de: 'Talnebel und Lichtschächte im Blätterdach',
    ru: 'туман долин и световые шахты крон',
  },
  'settings.froxelScale': { en: 'fog grid divisor', de: 'Nebelgitter-Teiler', ru: 'делитель сетки тумана' },
  'settings.froxelScale.hint': {
    en: '2 = 8x fewer fog cells (softer shafts)',
    de: '2 = 8x weniger Nebelzellen (weichere Schächte)',
    ru: '2 = в 8 раз меньше ячеек (мягче шахты)',
  },
  'settings.clouds': { en: 'volumetric clouds', de: 'volumetrische Wolken', ru: 'объёмные облака' },
  'settings.clouds.hint': {
    en: 'raymarched cloud layer and its ground shadows',
    de: 'Raymarching-Wolkenschicht und ihre Bodenschatten',
    ru: 'облачный слой и его тени на земле',
  },
  'settings.cloudMarchSteps': { en: 'cloud march steps', de: 'Wolken-March-Schritte', ru: 'шаги марша облаков' },
  'settings.cloudMarchSteps.hint': {
    en: 'samples per cloud ray; density detail',
    de: 'Samples pro Wolkenstrahl; Dichtedetail',
    ru: 'сэмплов на луч; детальность плотности',
  },
  'settings.cloudShadowRes': { en: 'cloud shadow map', de: 'Wolkenschatten-Karte', ru: 'карта теней облаков' },
  'settings.cloudShadowRes.hint': {
    en: 'resolution of the drifting cloud shadow',
    de: 'Auflösung des ziehenden Wolkenschattens',
    ru: 'разрешение плывущей тени облаков',
  },
  'settings.caustics': { en: 'water caustics', de: 'Wasser-Kaustiken', ru: 'каустика воды' },
  'settings.caustics.hint': {
    en: 'sun ripples on stream and lake beds',
    de: 'Sonnenmuster auf Bach- und Seeböden',
    ru: 'солнечная рябь на дне ручьёв и озёр',
  },
  'settings.giProbesPerFrame': { en: 'GI refresh budget', de: 'GI-Aktualisierungsbudget', ru: 'бюджет обновления GI' },
  'settings.giProbesPerFrame.hint': {
    en: 'probes re-lit per frame; lower = slower light updates',
    de: 'Probes pro Frame; niedriger = langsamere Lichtupdates',
    ru: 'проб на кадр; меньше = медленнее обновление света',
  },
  'settings.particleCount': { en: 'particles', de: 'Partikel', ru: 'частицы' },
  'settings.particleCount.hint': {
    en: 'pollen, leaves and snow motes; 0 = off',
    de: 'Pollen, Blätter und Schneeflocken; 0 = aus',
    ru: 'пыльца, листья и снег; 0 = выкл',
  },
  'settings.ao': { en: 'ambient occlusion', de: 'Umgebungsverdeckung', ru: 'фоновое затенение (AO)' },
  'settings.ao.hint': {
    en: 'GTAO; also carries contact shadows',
    de: 'GTAO; trägt auch die Kontaktschatten',
    ru: 'GTAO; несёт и контактные тени',
  },
  'settings.aoSamples': { en: 'AO samples', de: 'AO-Samples', ru: 'сэмплы AO' },
  'settings.aoSamples.hint': {
    en: 'quality of the occlusion cone',
    de: 'Qualität des Verdeckungskegels',
    ru: 'качество конуса затенения',
  },
  'settings.bounce': { en: 'local color bounce', de: 'lokale Farbreflexion', ru: 'локальный отскок цвета' },
  'settings.bounce.hint': {
    en: 'green-on-trunk / warm-on-rock bleed',
    de: 'Grün auf Stämmen / Wärme auf Fels',
    ru: 'зелень на стволах / тепло на камне',
  },
  'settings.taa': { en: 'temporal AA', de: 'temporales AA', ru: 'временное сглаживание (TAA)' },
  'settings.taa.hint': {
    en: 'off shimmers heavily; also disables motion blur',
    de: 'aus flimmert stark; deaktiviert auch Motion Blur',
    ru: 'выкл сильно мерцает; отключает и размытие движения',
  },
  'settings.motionBlur': { en: 'motion blur', de: 'Bewegungsunschärfe', ru: 'размытие движения' },
  'settings.motionBlur.hint': {
    en: 'road-speed streaking; cockpit stays sharp',
    de: 'Geschwindigkeitsstreifen; Cockpit bleibt scharf',
    ru: 'смаз скорости; кокпит остаётся резким',
  },
  'settings.bloom': { en: 'bloom', de: 'Bloom', ru: 'свечение (bloom)' },
  'settings.bloom.hint': {
    en: 'HDR glow around bright sky and water',
    de: 'HDR-Glühen um hellen Himmel und Wasser',
    ru: 'HDR-ореол вокруг яркого неба и воды',
  },
  'settings.heightRes': { en: 'terrain resolution', de: 'Gelände-Auflösung', ru: 'разрешение рельефа' },
  'settings.heightRes.hint': {
    en: 'heightfield texels (bake time and VRAM)',
    de: 'Höhenfeld-Texel (Bake-Zeit und VRAM)',
    ru: 'тексели высот (время генерации и VRAM)',
  },
  'settings.simRes': { en: 'erosion grid', de: 'Erosionsgitter', ru: 'сетка эрозии' },
  'settings.simRes.hint': {
    en: 'hydrology simulation resolution (bake)',
    de: 'Auflösung der Hydrologie-Simulation (Bake)',
    ru: 'разрешение симуляции гидрологии (генерация)',
  },
  'settings.erosionIters': { en: 'erosion iterations', de: 'Erosions-Iterationen', ru: 'итерации эрозии' },
  'settings.erosionIters.hint': {
    en: 'terrain aging passes (bake time)',
    de: 'Gelände-Alterungsdurchläufe (Bake-Zeit)',
    ru: 'проходы старения рельефа (генерация)',
  },
  'settings.tileVerts': { en: 'terrain mesh density', de: 'Gelände-Mesh-Dichte', ru: 'плотность меша рельефа' },
  'settings.tileVerts.hint': {
    en: 'vertices per terrain tile edge',
    de: 'Vertices pro Geländekachel-Kante',
    ru: 'вершин на грань тайла рельефа',
  },

  // ---- bike mode (OptionsMenu.ts + RideHud.ts, shared ride-mode enum) ----
  'mode.hike': { en: 'hike', de: 'Wandern', ru: 'пешком' },
  'mode.road': { en: 'road', de: 'Rennrad', ru: 'шоссе' },
  'mode.gravel': { en: 'gravel', de: 'Gravel', ru: 'гравел' },
  'mode.mtb': { en: 'MTB', de: 'MTB', ru: 'МТБ' },

  // ---- weather (OptionsMenu.ts, WeatherKind enum) ----
  'weather.dry': { en: 'dry', de: 'trocken', ru: 'сухо' },
  'weather.rain': { en: 'rain', de: 'Regen', ru: 'дождь' },
  'weather.after-rain': { en: 'after rain', de: 'nach Regen', ru: 'после дождя' },
  'weather.fog': { en: 'fog', de: 'Nebel', ru: 'туман' },

  // ---- surface names (SurfaceMatrix.ts SURFACE_NAMES, ALL 15 IDs — RideHud's
  // blocked/stalled/hazard states can report any terrain surface, not just
  // the 5 road classes OptionsMenu's teleport hint uses; display leaf only,
  // never localize the underlying surfaceName()/cls.name match key) ----
  'surface.grass': { en: 'grass', de: 'Gras', ru: 'трава' },
  'surface.forest': { en: 'forest floor', de: 'Waldboden', ru: 'лесная подстилка' },
  'surface.soil': { en: 'soil', de: 'Erdboden', ru: 'грунт' },
  'surface.scree': { en: 'scree', de: 'Geröll', ru: 'осыпь' },
  'surface.rock': { en: 'rock', de: 'Fels', ru: 'скалы' },
  'surface.gravel-river': { en: 'river gravel', de: 'Flusskies', ru: 'речная галька' },
  'surface.mud': { en: 'mud', de: 'Schlamm', ru: 'грязь' },
  'surface.snow': { en: 'snow', de: 'Schnee', ru: 'снег' },
  'surface.water-shallow': { en: 'shallow water', de: 'seichtes Wasser', ru: 'мелководье' },
  'surface.water-deep': { en: 'deep water', de: 'tiefes Wasser', ru: 'глубокая вода' },
  'surface.asphalt': { en: 'asphalt', de: 'Asphalt', ru: 'асфальт' },
  'surface.gravel-fine': { en: 'fine gravel', de: 'feiner Schotter', ru: 'мелкий гравий' },
  'surface.gravel-coarse': { en: 'coarse gravel', de: 'grober Schotter', ru: 'крупный гравий' },
  'surface.dirt-road': { en: 'dirt road', de: 'Feldweg', ru: 'грунтовая дорога' },
  'surface.singletrack': { en: 'singletrack', de: 'Singletrail', ru: 'синглтрек' },

  // ---- power source (OptionsMenu.ts, SourceKind enum) ----
  'source.off': { en: 'off', de: 'aus', ru: 'выкл' },
  'source.demo': { en: 'demo', de: 'Demo', ru: 'демо' },
  'source.keys': { en: 'keys', de: 'Tasten', ru: 'клавиши' },
  'source.ble': { en: 'BLE ↻', de: 'BLE ↻', ru: 'BLE ↻' },
  'source.offHint': {
    en: 'no power source — bikes locked (honesty rule)',
    de: 'keine Energiequelle — Räder gesperrt (Ehrlichkeitsregel)',
    ru: 'нет источника мощности — байки заблокированы (правило честности)',
  },
  'source.demoHint': {
    en: 'simulated watts/cadence/HR — DEMO badge shows',
    de: 'simulierte Watt/Trittfrequenz/Herzfrequenz — DEMO-Badge erscheint',
    ru: 'смоделированные ватты/каданс/пульс — показывается значок DEMO',
  },
  'source.keysHint': {
    en: 'keyboard bike: W pedal, Shift burst, +/- watts',
    de: 'Tastatur-Bike: W treten, Shift Antritt, +/- Watt',
    ru: 'клавиатурный байк: W педалирование, Shift рывок, +/- ватты',
  },
  'source.bleHint': {
    en: 'real sensors — reloads with the connect panel',
    de: 'echte Sensoren — lädt mit dem Verbindungs-Panel neu',
    ru: 'реальные датчики — перезагрузка с панелью подключения',
  },

  // ---- OptionsMenu.ts (settings panel chrome) ----
  'opt.fabTitle': { en: 'settings (O)', de: 'Einstellungen (O)', ru: 'настройки (O)' },
  'opt.title': { en: 'settings', de: 'Einstellungen', ru: 'настройки' },
  'opt.weather': { en: 'weather', de: 'Wetter', ru: 'погода' },
  'opt.timeOfDay': { en: 'time of day', de: 'Tageszeit', ru: 'время суток' },
  'opt.powerSource': { en: 'power source', de: 'Energiequelle', ru: 'источник мощности' },
  'opt.bike': { en: 'bike', de: 'Rad', ru: 'байк' },
  'opt.keys': { en: 'keys', de: 'Tasten', ru: 'клавиши' },
  'opt.dawn': { en: 'dawn', de: 'Morgengrauen', ru: 'рассвет' },
  'opt.dusk': { en: 'dusk', de: 'Abenddämmerung', ru: 'закат' },
  'opt.needPowerHint': {
    en: 'bikes need a power source — pick one above',
    de: 'Räder brauchen eine Energiequelle — oben auswählen',
    ru: 'байкам нужен источник мощности — выберите выше',
  },
  'opt.teleportedTo': {
    en: 'teleported to the nearest {surface}',
    de: 'teleportiert zum nächsten Abschnitt: {surface}',
    ru: 'телепортация к ближайшему участку: {surface}',
  },
  'opt.noRideableRoad': {
    en: 'no rideable road on the map',
    de: 'keine befahrbare Straße auf der Karte',
    ru: 'на карте нет пригодной для езды дороги',
  },
  'opt.keyBikeMode': { en: 'bike mode', de: 'Bike-Modus', ru: 'режим байка' },
  'opt.keyWalkFly': { en: 'walk/fly', de: 'Gehen/Fliegen', ru: 'ходьба/полёт' },
  'opt.keyDashboard': { en: 'dashboard', de: 'Dashboard', ru: 'приборка' },
  'opt.keyThisMenu': { en: 'this menu', de: 'dieses Menü', ru: 'это меню' },
  'opt.keyPickTurn': { en: 'pick turn', de: 'Abzweigung wählen', ru: 'выбор поворота' },
  'opt.keyBrake': { en: 'brake', de: 'bremsen', ru: 'тормоз' },
  'opt.keyTime': { en: 'time', de: 'Zeit', ru: 'время' },
  'opt.keyViews': { en: 'views', de: 'Ansichten', ru: 'виды' },
  'opt.keyDebug': { en: 'debug', de: 'Debug', ru: 'отладка' },
  'opt.keyHands': { en: 'hands', de: 'Hände', ru: 'руки' },
  'opt.keyDismount': { en: 'dismount', de: 'absteigen', ru: 'спешиться' },
  'opt.keyUturn': { en: 'U-turn', de: 'wenden', ru: 'разворот' },

  // ---- GESTURES sheet (OptionsMenu.ts, shown instead of KEYS on touch —
  // UX-04: a phone/tablet has no keyboard) ----
  'opt.gestures': { en: 'gestures', de: 'Gesten', ru: 'жесты' },
  'opt.gesStick': { en: 'left stick — move', de: 'linker Stick — gehen', ru: 'левый стик — идти' },
  'opt.gesDrag': { en: 'drag — look', de: 'ziehen — umsehen', ru: 'драг — камера' },
  'opt.gesJump': { en: 'button — jump', de: 'Taste — springen', ru: 'кнопка — прыжок' },
  'opt.gesTurnCard': { en: 'tap card — pick turn', de: 'Karte tippen — abzweigen', ru: 'тап по карточке — поворот' },
  'opt.gesRide': { en: 'ride buttons', de: 'Fahrtasten', ru: 'кнопки езды' },

  // ---- hands visibility (OptionsMenu.ts touch row + Cockpit.ts Shift+H) ----
  'opt.hands': { en: 'hands', de: 'Hände', ru: 'руки' },
  'opt.handsHide': { en: 'hide', de: 'ausblenden', ru: 'скрыть' },
  'opt.handsShow': { en: 'show', de: 'einblenden', ru: 'показать' },

  // ---- touch pedal/brake (RideHud.ts — the ?ridedev=1 'dev' keyboard
  // source has no keyboard on a phone/tablet, so these hold-buttons are the
  // touch equivalent of W/S) ----
  'ride.pedalBtn': { en: 'PEDAL', de: 'TRETEN', ru: 'ПЕДАЛИ' },
  'ride.brakeBtn': { en: 'BRAKE', de: 'BREMSE', ru: 'ТОРМОЗ' },

  // ---- RideHud.ts (live ride dashboard — highest player visibility) ----
  'ride.speed': { en: 'speed', de: 'Tempo', ru: 'скорость' },
  'ride.power': { en: 'power', de: 'Leistung', ru: 'мощность' },
  'ride.grade': { en: 'grade', de: 'Steigung', ru: 'уклон' },
  'ride.distance': { en: 'distance', de: 'Distanz', ru: 'дистанция' },
  'ride.cadence': { en: 'cadence', de: 'Trittfrequenz', ru: 'каданс' },
  'ride.heartRate': { en: 'heart rate', de: 'Herzfrequenz', ru: 'пульс' },
  'ride.demoBadgeHint': {
    en: 'simulated cadence/HR/power — connect real sensors for real data',
    de: 'simulierte Trittfrequenz/Herzfrequenz/Leistung — echte Sensoren für echte Daten verbinden',
    ru: 'смоделированные каданс/пульс/мощность — подключите реальные датчики для реальных данных',
  },
  'ride.devBadgeHint': {
    en: 'keyboard bike — W pedal, Shift burst, +/- watts, S/Space brake',
    de: 'Tastatur-Bike — W treten, Shift Antritt, +/- Watt, S/Leertaste bremsen',
    ru: 'клавиатурный байк — W педалирование, Shift рывок, +/- ватты, S/пробел тормоз',
  },
  'ride.tooSteep': {
    en: 'too steep for {mode} — {pct}% · dismount (M)',
    de: 'zu steil für {mode} — {pct}% · absteigen (M)',
    ru: 'слишком круто для режима «{mode}» — {pct}% · спешиться (M)',
  },
  'ride.surfaceBlocks': {
    en: '{surface} blocks {mode} — dismount (M)',
    de: '{surface} für {mode} gesperrt — absteigen (M)',
    ru: '{surface} блокирует режим «{mode}» — спешиться (M)',
  },
  'ride.bogged': {
    en: 'bogged down in {surface} — dismount (M)',
    de: 'festgefahren: {surface} — absteigen (M)',
    ru: 'застряли: {surface} — спешиться (M)',
  },
  'ride.hazardSlope': {
    en: 'too steep ahead ({pct})',
    de: 'zu steil voraus ({pct})',
    ru: 'слишком круто впереди ({pct})',
  },
  'ride.hazardSurface': {
    en: '{surface} ahead',
    de: '{surface} voraus',
    ru: '{surface} впереди',
  },
  'ride.dismountOrTurn': {
    en: '— dismount (M) or turn',
    de: '— absteigen (M) oder abbiegen',
    ru: '— спешиться (M) или свернуть',
  },
  'ride.turnAhead': { en: 'turn ahead', de: 'Abzweigung voraus', ru: 'поворот впереди' },
  'ride.turnHint': { en: '← / → choose', de: '← / → wählen', ru: '← / → выбор' },
  'ride.turnHintTouch': { en: 'tap to choose', de: 'zum Wählen tippen', ru: 'коснись для выбора' },
  'ride.turnLocked': { en: 'turn locked', de: 'Abzweig fixiert', ru: 'поворот зафиксирован' },

  // ---- BikeRig.ts flash() notes (surfaced verbatim through RideHud's banner) ----
  'ride.lockedNoPower': {
    en: 'bikes locked — no power source (?ride=ble to connect sensors)',
    de: 'Räder gesperrt — keine Energiequelle (?ride=ble zum Verbinden von Sensoren)',
    ru: 'байки заблокированы — нет источника мощности (?ride=ble для подключения датчиков)',
  },
  'ride.lockedConnectPower': {
    en: 'bikes locked — connect a power source (trainer or power meter)',
    de: 'Räder gesperrt — Energiequelle verbinden (Trainer oder Leistungsmesser)',
    ru: 'байки заблокированы — подключите источник мощности (тренажёр или измеритель мощности)',
  },
  'ride.mountBike': { en: '{mode}', de: '{mode}', ru: '{mode}' },
  'ride.onFoot': { en: 'on foot', de: 'zu Fuß', ru: 'пешком' },
  'ride.noRoadWithin': {
    en: 'no road within {dist} m',
    de: 'keine Straße innerhalb von {dist} m',
    ru: 'нет дороги в радиусе {dist} м',
  },
  'ride.deadEndUturn': { en: 'dead end — U-turn', de: 'Sackgasse — wenden', ru: 'тупик — разворот' },
  'ride.uTurn': { en: 'U-turn', de: 'Wende', ru: 'разворот' },
  'ride.uturnBtn': { en: 'U-TURN', de: 'WENDE', ru: 'РАЗВОРОТ' },
  'ride.dismountBtn': { en: 'GET OFF', de: 'ABSTEIGEN', ru: 'СПЕШИТЬСЯ' },

  // ---- Cockpit.ts on-device screen (tiny canvas texture, no CSS/DOM —
  // keep short, the hazard strip has a fixed pixel width and no wrap) ----
  'cockpit.steep': { en: 'STEEP', de: 'STEIL', ru: 'КРУТО' },

  // ---- ride-recording control (RideMenu.ts): pause / finish card ----
  'ride.menu.recordTitle': { en: 'ride menu', de: 'Fahrtmenü', ru: 'меню поездки' },
  'ride.menu.paused': { en: 'RIDE PAUSED', de: 'FAHRT PAUSIERT', ru: 'ПОЕЗДКА НА ПАУЗЕ' },
  'ride.menu.elapsed': { en: 'elapsed', de: 'Dauer', ru: 'время' },
  'ride.menu.resume': { en: 'RESUME', de: 'FORTSETZEN', ru: 'ПРОДОЛЖИТЬ' },
  'ride.menu.finish': { en: 'FINISH', de: 'BEENDEN', ru: 'ЗАВЕРШИТЬ' },
  'ride.menu.finishTitle': { en: 'FINISH RIDE', de: 'FAHRT BEENDEN', ru: 'ЗАВЕРШИТЬ ПОЕЗДКУ' },
  'ride.menu.activityName': { en: 'activity name', de: 'Aktivitätsname', ru: 'название заезда' },
  'ride.menu.saveSync': {
    en: 'SAVE & SYNC TO STRAVA',
    de: 'SPEICHERN & ZU STRAVA',
    ru: 'СОХРАНИТЬ И В STRAVA',
  },
  'ride.menu.saveFile': { en: 'SAVE .FIT FILE', de: '.FIT-DATEI SPEICHERN', ru: 'СОХРАНИТЬ .FIT' },
  'ride.menu.discard': { en: 'DISCARD', de: 'VERWERFEN', ru: 'СБРОСИТЬ' },
  'ride.menu.discardConfirm': {
    en: 'Discard this ride? The recording will be deleted.',
    de: 'Diese Fahrt verwerfen? Die Aufzeichnung wird gelöscht.',
    ru: 'Сбросить эту поездку? Запись будет удалена.',
  },
  'ride.menu.savedFile': { en: 'saved .fit file', de: '.fit-Datei gespeichert', ru: '.fit-файл сохранён' },
  'ride.menu.tooShort': {
    en: 'ride too short to save yet',
    de: 'Fahrt noch zu kurz zum Speichern',
    ru: 'заезд слишком короткий для сохранения',
  },
  'ride.menu.close': { en: 'close', de: 'schließen', ru: 'закрыть' },

  // ---- Strava connection + upload (RideMenu.ts) ----
  'ride.strava.connected': { en: 'Connected to Strava', de: 'Mit Strava verbunden', ru: 'Подключено к Strava' },
  'ride.strava.notConnected': { en: 'Not connected', de: 'Nicht verbunden', ru: 'Не подключено' },
  'ride.strava.connect': { en: 'CONNECT', de: 'VERBINDEN', ru: 'ПОДКЛЮЧИТЬ' },
  'ride.strava.disconnect': { en: 'DISCONNECT', de: 'TRENNEN', ru: 'ОТКЛЮЧИТЬ' },
  'ride.strava.settings': { en: 'Strava settings', de: 'Strava-Einstellungen', ru: 'Настройки Strava' },
  'ride.strava.clientId': { en: 'Client ID', de: 'Client-ID', ru: 'Client ID' },
  'ride.strava.clientSecret': { en: 'Client secret', de: 'Client-Secret', ru: 'Client secret' },
  'ride.strava.redirectUri': { en: 'Redirect URI', de: 'Redirect-URI', ru: 'Redirect URI' },
  'ride.strava.corsProxy': {
    en: 'CORS proxy (optional)',
    de: 'CORS-Proxy (optional)',
    ru: 'CORS-прокси (необязательно)',
  },
  'ride.strava.save': { en: 'SAVE', de: 'SPEICHERN', ru: 'СОХРАНИТЬ' },
  'ride.strava.saved': { en: 'settings saved', de: 'Einstellungen gespeichert', ru: 'настройки сохранены' },
  'ride.strava.needCreds': {
    en: 'Enter your Strava API Client ID and secret first (Strava settings below).',
    de: 'Zuerst Strava-API Client-ID und Secret eingeben (Strava-Einstellungen unten).',
    ru: 'Сначала введите Client ID и secret из Strava API (настройки Strava ниже).',
  },
  'ride.strava.registerHint': {
    en: 'Register an app at strava.com/settings/api, then paste the Client ID and secret. Callback domain: 127.0.0.1 for development.',
    de: 'Registriere eine App unter strava.com/settings/api und füge Client-ID und Secret ein. Callback-Domain: 127.0.0.1 für die Entwicklung.',
    ru: 'Зарегистрируйте приложение на strava.com/settings/api и вставьте Client ID и secret. Callback-домен: 127.0.0.1 для разработки.',
  },
  'ride.strava.pasteCode': {
    en: 'Paste the code from the redirect URL',
    de: 'Code aus der Redirect-URL einfügen',
    ru: 'Вставьте code из URL перенаправления',
  },
  'ride.strava.pasteHint': {
    en: 'A Strava tab opened. After you approve, copy the code=… value from the address bar and paste it here.',
    de: 'Ein Strava-Tab wurde geöffnet. Nach der Freigabe den Wert code=… aus der Adresszeile kopieren und hier einfügen.',
    ru: 'Открылась вкладка Strava. После подтверждения скопируйте значение code=… из адресной строки и вставьте сюда.',
  },
  'ride.strava.connectCode': { en: 'CONNECT', de: 'VERBINDEN', ru: 'ПОДКЛЮЧИТЬ' },
  'ride.strava.authOpening': { en: 'opening Strava…', de: 'Strava wird geöffnet…', ru: 'открываем Strava…' },
  'ride.strava.uploading': { en: 'uploading to Strava…', de: 'Upload zu Strava…', ru: 'загрузка в Strava…' },
  'ride.strava.processing': { en: 'Strava is processing…', de: 'Strava verarbeitet…', ru: 'Strava обрабатывает…' },
  'ride.strava.uploaded': { en: 'uploaded to Strava', de: 'zu Strava hochgeladen', ru: 'загружено в Strava' },
  'ride.strava.viewActivity': { en: 'view activity', de: 'Aktivität ansehen', ru: 'открыть заезд' },
  'ride.strava.uploadFailed': { en: 'upload failed', de: 'Upload fehlgeschlagen', ru: 'ошибка загрузки' },
  'ride.strava.connectFailed': { en: 'connect failed', de: 'Verbindung fehlgeschlagen', ru: 'ошибка подключения' },
  'ride.strava.disconnected': { en: 'disconnected from Strava', de: 'von Strava getrennt', ru: 'отключено от Strava' },
};

/**
 * Localize every static label in the markup: `<span data-i18n="menu.exit">`.
 *
 * The markup used to carry the translations themselves —
 * `data-i18n data-de="BEENDEN" data-ru="ВЫХОД"` — and NOTHING read those
 * attributes. Two bugs in one: the labels silently stayed English in every
 * language, and Cyrillic sat outside this file, which the owner requires to be
 * its only home. Now the markup carries a Latin KEY and the words live here.
 *
 * Called once at boot, before the menu is shown. Language is reload-scoped (see
 * the header), so a single pass is enough — same contract as every other
 * surface, which reads LANG once at construction.
 */
export function applyStaticI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset['i18n'];
    if (key) el.textContent = t(key);
  }
}

export function t(key: string, params?: Record<string, string | number>): string {
  const entry = DICT[key];
  let s = entry ? (entry[LANG] ?? entry.en) : key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
  }
  return s;
}
