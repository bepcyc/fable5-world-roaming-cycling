# Запуск и отладка — десктоп и мобильный (Pixel / Android)

Движок целиком на **WebGPU + TSL** (three.js WebGPU-рендерер, узловые шейдеры,
compute-пассы для эрозии/скаттера/полей/froxel-объёмки/LUT). **WebGL 2 не
поддерживается и не нужен** — WebGPU есть и на десктопном Chrome, и на Android
Chrome (проверено на Pixel 10 Pro, GPU `img-tec/d-series`, Tensor G5).

## Порты и dev-сервер

- **5173 — порт ВЛАДЕЛЬЦА** (LAN / планшет / телефон). `just run` = `npm run dev`.
- **5174 — порт ТУЛИНГА.** Свой dev-сервер поднимать только на 5174:
  `npm run dev -- --port 5174 --strictPort`. Скриншот/видео-тулзы ходят на 5174
  через `LAAS_ORIGIN` (`tools/launch-gpu.ts`, env `LAAS_PORT`).
- Для LAN-доступа (телефон): `npm run dev -- --port 5173 --strictPort --host 0.0.0.0`.
  IP машины: `hostname -I` / `ip route get 1.1.1.1`. URL телефону:
  `http://<IP>:5173/?nogate=1`.

## URL-параметры (весь запуск описан URL'ом, см. `src/core/Params.ts`)

- `seed=<n>` — сид мира. `T=<0..24>` — время суток (дефолт 14). `scene=world`.
- `preset=min|low|high|ultra` — качество (см. `src/world/WorldConst.ts qualityConfig`):
  - `min`  — height 1024² / sim 512², мало эрозии, редкие тайлы. **Слабейший, для телефона.**
  - `low`  — 2048² / 1024². `high` (дефолт) — 4096² / 2048². `ultra` — макс.
- `dpr=<f>` — кап device-pixel-ratio (например `0.6` на мобиле — режет разрешение рендера).
- `debug=1` — экранный диагностический оверлей + обратный телеметрический канал (ниже).
- `nogate=1` — пропустить BrowserGate (обязателен на не-десктопе/LAN).
- `hud=1` F3-панель, `cam="x,y,z,yaw,pitch[,fov]"`, `freeze=1`, `ridedev=1`, `surfdbg=1`.

## Отладка

### `?debug=1` — оверлей на экране
`src/core/BootUI.ts`. Слева поверх загрузки: шапка (GPU-адаптер, лимиты
устройства, preset, dpr, экран+render-разрешение) + **тайминг-лог каждого шага
бута**. НЕ прячется на успехе и **остаётся на крэше** — видно, на каком шаге умер
и сколько занял. Быстро вскрывает, world-gen это или первый рендер.

### Обратный телеметрический канал (телефон → сервер)
Для отладки на устройстве без консоли. В `?debug=1` клиент (`src/core/Telemetry.ts`)
POST'ит на **тот же хост, порт 5199**: `begin` (адаптер/лимиты/preset/экран ДО
тяжёлого бута), каждый `step`, и `CRASH` через **`navigator.sendBeacon`** (уходит,
даже когда страница умирает от device-lost) либо `READY` (доехал + время).

Сервер-сток — `tools/debug-telemetry-server.ts` (standalone, CORS, не трогает
vite.config):
```bash
TELE_LOG=/path/telemetry.jsonl TELE_PORT=5199 npx tsx tools/debug-telemetry-server.ts
```
Живой мониторинг (уведомление на begin/CRASH/READY):
```bash
tail -n0 -F /path/telemetry.jsonl | grep --line-buffered -E '"ev":"begin"|"CRASH"|"READY"'
```

### `device.lost` — главная поверхность отказа на мобиле
`src/core/Engine.ts`. На телефоне это почти всегда GPU OOM или термал/watchdog
reset под нагрузкой. Хендлер шлёт `tele().crash()` и `failLoud` с советом
`?preset=min ?dpr=…`.

### Тулинг съёмки: «No REAL WebGPU adapter»
`shoot.ts` падает так обычно из-за **СВОИХ гоняющихся headless-Chrome** от быстрых
ретраев, НЕ из-за браузера владельца. Не винить владельца, не спамить ретраи:
`pkill -f "chrome.*--headless"` → пауза 2с → ОДИН чистый запуск.

## Мобильный (Android / Pixel 10 Pro) — пошагово

1. **WebGPU в Chrome телефона** должен быть: `chrome://gpu` → строка `WebGPU:
   Hardware accelerated`. На Pixel 10 Pro / свежем Chrome — по умолчанию.
2. **Secure-context ГРАБЛЯ.** `navigator.gpu` доступен только в защищённом
   контексте. `localhost` — да, но **голый LAN-IP по HTTP (`http://192.168.x.y`)
   — НЕТ** → `navigator.gpu is missing`, хотя chrome://gpu показывает WebGPU.
   Фикс: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → вписать
   `http://<IP>:5173` → **Enabled** → **Relaunch**. (Альтернатива — HTTPS с
   самоподписанным сертом, `vite --https`, но там принимать серт на телефоне.)
3. **Слабейшая графика сразу:** `?preset=min&dpr=0.6`. На `high` Pixel падает
   (device-lost на тяжёлом world-gen + первом рендере); на `min`+низком dpr —
   доезжает.
4. **Полный URL для телефона:**
   `http://<IP>:5173/?nogate=1&preset=min&debug=1&dpr=0.6`
5. **Замер на устройстве (2026-07-14):** Pixel 10 Pro загрузился до `READY` за
   **~105с** (247 шагов), НЕ упал. Лимиты хорошие (storageBufferBinding 128МБ,
   maxBufferSize ~4ГБ, tex2D 16384) — падения НЕ из-за лимитов.

## Известные узкие места для мобильного (перф-долг)

- Бут ~105с медленно. Главные куски: **veg-бейки** (атласы/импосторы деревьев
  ~16с) и **первый рендер** (~18с, компиляция всех WebGPU-пайплайнов разом,
  разрыв 95%→100% в тайминг-логе).
- Нет пресета «mobile» для РЕНДЕРА: froxel-объёмка, bloom, TRAA, тяжёлые CSM-тени
  включены всегда. Кандидаты на отключение/упрощение на `min`.
- Нет тач-управления (сейчас клавиатура + pointer-lock).
- Упаковка Android: план в `HANDOFF_APK.md` (вариант B — нативная оболочка +
  loopback + Chrome Custom Tab, т.к. WebGPU в Chrome, не в WebView).
