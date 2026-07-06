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
  'msettings.auto': { en: 'auto', de: 'auto', ru: 'авто' },
  'msettings.seed': { en: 'seed', de: 'Seed', ru: 'сид' },
  'msettings.seedApply': { en: 'apply', de: 'anwenden', ru: 'применить' },
  'msettings.seedRandom': { en: 'random seed', de: 'zufälliger Seed', ru: 'случайный сид' },

  // ---- graphics preset (GameMenu.ts, QualityPreset enum) ----
  'preset.low': { en: 'low', de: 'niedrig', ru: 'низкая' },
  'preset.high': { en: 'high', de: 'hoch', ru: 'высокая' },
  'preset.ultra': { en: 'ultra', de: 'ultra', ru: 'ультра' },

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

  // ---- Cockpit.ts on-device screen (tiny canvas texture, no CSS/DOM —
  // keep short, the hazard strip has a fixed pixel width and no wrap) ----
  'cockpit.steep': { en: 'STEEP', de: 'STEIL', ru: 'КРУТО' },
};

export function t(key: string, params?: Record<string, string | number>): string {
  const entry = DICT[key];
  let s = entry ? (entry[LANG] ?? entry.en) : key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
  }
  return s;
}
