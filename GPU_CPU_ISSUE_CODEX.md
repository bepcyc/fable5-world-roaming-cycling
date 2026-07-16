# CPU/GPU-конвейер на Android: диагноз и план действий

**Дата анализа:** 2026-07-15  
**Код:** Three.js `0.184.0`, `WebGPURenderer`, WebGPU  
**Исходный замер владельца:**

```text
CPU: update 1.4 + submit 31.8 = 33.2 мс
GPU:                            28.6 мс
                                ──────
сумма                           61.8 ≈ frameMs 64.2
```

## Короткий ответ

**С наблюдением согласен, с объяснением — только частично.**

Замер убедительно показывает, что на этом устройстве сейчас почти нет полезного перекрытия измеренного CPU-участка и GPU-работы: `33.2 + 28.6` действительно почти объясняют `64.2 мс`. Но WebGPU и `requestAnimationFrame` **не требуют** схемы «GPU закончил презентацию → только тогда браузер разрешил следующий rAF». По семантике API `GPUQueue.submit()` только планирует работу и возвращает `undefined`; гарантированное ожидание уже отправленной GPU-работы возникает через `mapAsync()`/`onSubmittedWorkDone()`, хотя реализация вправе задержать сам вызов из-за внутреннего backpressure. WebGPU специально разделяет content, device и queue timelines, которые реализация может выполнять параллельно.

Поэтому утверждение «конвейера принципиально быть не может, глубины очереди нет» слишком сильное. Корректный вывод другой:

> В нашей связке Chrome Android + Three.js r184 + текущий граф проходов эффективного перекрытия в этом замере не получилось. Причину надо искать в CPU-кодировании кадра, множестве render/submit границ, browser/GPU-process backpressure и методике измерения, а не считать отсутствие конвейера свойством rAF или WebGPU.

**Мы не бессильны.** Главная задача здесь — не переносить `update` на GPU: `update` уже занимает только `1.4 мс`, а culling, частицы, froxels, GI и другие тяжёлые задачи уже исполняются compute-шейдерами. Нужно убрать CPU/driver overhead внутри условно названного `cpu.submit`, после чего GPU естественно станет ограничителем.

---

## 1. Что на самом деле измеряет `cpu.submit`

Название счётчика вводит в заблуждение.

В `src/core/Engine.ts:205-236`:

```ts
const c1 = performance.now();

if (this.post) {
  this.post.meter(this.renderer);
  this.post.render();
} else {
  this.renderer.render(this.scene, this.camera);
}

const c2 = performance.now();
cpu.submit = c2 - c1;
```

Следовательно, `31.8 мс` — это **не длительность одного `device.queue.submit()`**. Это весь синхронный CPU-путь `PostStack.meter()` + `RenderPipeline.render()`:

- обновление узлов и uniform groups;
- обход scene graph;
- построение и сортировка render lists;
- подготовка shadow passes;
- проверки и обновления geometries, bindings и pipelines;
- кодирование сотен draw-команд;
- кодирование всех вложенных post-processing render passes;
- вызовы `GPUCommandEncoder.finish()`;
- несколько `GPUQueue.submit()`;
- возможный backpressure внутри браузера/GPU process, когда очередь уже насыщена.

Текущий код измеряет compute-диспетчи подсистем, зарегистрированных через `engine.onUpdate()`, в `cpu.update`, а не в `cpu.submit`. Это важно: нельзя объяснить `31.8 мс` циклами `renderer.compute()` из `GroundRing.update()` или `Forests.update()` напрямую. Их синхронная CPU-цена уже входит в небольшие `1.4 мс`. В `cpu.submit` из явных compute-вызовов входит только exposure kernel из `PostStack.meter()` (`src/render/PostStack.ts:702-710`).

---

## 2. Почему текущий render path дорог на CPU

### 2.1. Сотни draw calls проходят через тяжёлый Three.js WebGPU renderer

Существующий harness фиксирует примерно `553…995` draw calls по кадрам, среднее около `700`; колебание ожидаемо из-за staggered CSM и периодического cloud-shadow bake (`tools/perf-tablet.ts:267-305`, `docs/PERF_FPS_MOBILE.md:213-226`).

Для каждого render object Three.js выполняет node/binding/pipeline работу. Старый CDP-профиль проекта уже нашёл конкретные CPU-затраты:

- `Bindings._update`: `2.64 мс`;
- `UniformsGroup.update`: `1.1 мс`;
- nodes `updateForRender`: `1.6 мс`;
- `updateMatrixWorld`: `0.67 мс`;
- `_projectObject`: `0.51 мс`.

См. `STATUS.md:538-559`. Там же уже доказано, что устранение повторного material node-graph hashing снизило `cpu.submit` с `15.7` до `11.7 мс` на прежней машине (`STATUS.md:457-474`). Это прямое подтверждение: счётчик в значительной степени измеряет Three.js/JS render overhead, а не GPU.

У Three.js есть открытая high-priority проблема по дорогой UBO-системе WebGPURenderer при большом числе render items: [three.js #30560](https://github.com/mrdoob/three.js/issues/30560).

### 2.2. Three.js создаёт отдельную submission boundary для каждого render context

В закреплённом `three@0.184.0`:

- `Renderer._renderScene()` завершает каждый render context через `backend.finishRender()` (`node_modules/three/src/renderers/common/Renderer.js:1710-1729`);
- `WebGPUBackend.finishRender()` делает `device.queue.submit([encoder.finish()])` (`node_modules/three/src/renderers/webgpu/WebGPUBackend.js:1094`);
- `PassNode.updateBefore()` вызывает новый `renderer.render(scene, camera)` (`node_modules/three/src/nodes/display/PassNode.js:802-869`);
- `HalfResMrtNode` тоже выполняет отдельный quad render (`src/render/HalfResMrt.ts:100-117`).

Иными словами, TSL-граф постобработки выглядит как единый `RenderPipeline`, но внутри он запускает отдельные scene/quad passes, каждый со своим обходом/кодированием/submit. Проект уже выиграл от объединения clouds + GTAO + bounce в один half-resolution MRT: комментарий в `src/render/PostStack.ts:146-152` прямо указывает, что раньше это были три raster/encoder/RT round-trip, теперь один.

### 2.3. Compute тоже раздроблен, но это не главный источник именно `31.8 мс`

`WebGPUBackend.finishCompute()` также делает отдельный `queue.submit()` на каждый вызов `renderer.compute()` (`node_modules/three/src/renderers/webgpu/WebGPUBackend.js:1508-1516`). Например, `GroundRing.update()` вызывает несколько kernels по одному (`src/vegetation/GroundRing.ts:1244-1256`).

Three.js уже умеет принять массив compute nodes одним вызовом: `renderer.compute([a, b, c])` кодирует их в один compute pass и делает один submit (`node_modules/three/src/renderers/common/Renderer.js:2688-2779`). Поэтому локальные циклы следует объединять.

Но ожидать, что это само по себе уберёт десятки миллисекунд `cpu.submit`, нельзя: эти вызовы находятся до `c1` и уже укладываются вместе со всей update-фазой в `1.4 мс`. Польза будет в меньшем числе IPC/driver submissions, более ровном GPU feed, меньшем энергопотреблении и потенциально меньшем backpressure позже в кадре.

### 2.4. Главная GPU-команда кадра поступает поздно

Three.js кодирует весь render pass, а затем вызывает `queue.submit()`. Пока CPU обходит объекты, обновляет bindings и записывает сотни draw-команд, GPU ещё не может начать именно этот command buffer. Некоторые более ранние compute/shadow submissions могут исполняться параллельно, но крупный scene pass становится доступен GPU только после CPU-кодирования.

Даже при наличии нескольких frames in flight браузер и swapchain держат глубину ограниченной. Когда CPU и GPU оба медленные, Chrome может применять backpressure и пропускать BeginFrame/rAF возможности ради ограничения задержки. Это может дать наблюдаемую почти последовательную картину, но это **поведение реализации под нагрузкой**, не обязательная семантика rAF.

---

## 3. Что доказывает арифметика, а чего она не доказывает

### Доказывает

1. На измеренном Android-устройстве нельзя считать приложение чисто GPU-bound.
2. `cpu.submit` сопоставим или даже больше суммарного timestamped GPU time.
3. Снижение DPR не обязано помогать: оно почти не меняет draw-list traversal, uniform/binding updates и command encoding.
4. Если удалить только GPU-проход, выигрыш FPS может быть меньше его timestamp duration, пока CPU остаётся стеной.
5. Чтобы приложение снова упиралось в GPU, нужно опустить CPU render/encode ниже примерно `28.6 мс`, а лучше значительно ниже.

### Не доказывает

1. Что `GPUQueue.submit()` ждёт завершения GPU. По API он только планирует работу.
2. Что rAF по стандарту ждёт presentation предыдущего WebGPU canvas frame.
3. Что в Chrome Android всегда ровно один frame in flight.
4. Что `28.6 мс` и `31.8 мс` относятся к одной и той же физической работе на одном временном интервале. GPU timestamp resolve асинхронен и отстаёт; render и compute pools разрешаются отдельно.
5. Что сумма per-pass timestamp всегда равна GPU critical path. В проекте уже отмечалось, что суммы timestamped passes могут превышать wall time (`STATUS.md:472-476,538-543`).

Поэтому равенство `CPU + GPU ≈ frameMs` — сильный симптом отсутствия полезного overlap, но не достаточное доказательство конкретного механизма.

---

## 4. Сначала исключить влияние самого профайлера

Это самый дешёвый и важный контрольный эксперимент.

`Engine.create()` всегда создаёт renderer с `trackTimestamp: true` (`src/core/Engine.ts:89-95`). После каждого кадра `collectStats()` запускает два `resolveTimestampsAsync()` (`src/core/Engine.ts:264-286`). В Three.js каждый resolve:

1. создаёт новый command encoder;
2. делает `resolveQuerySet`;
3. копирует query buffer в MAP_READ buffer;
4. вызывает дополнительный `queue.submit()`;
5. запускает `mapAsync()`.

См. `node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js:115-218`.

Код не `await`-ит resolve внутри rAF, поэтому это не явный CPU fence. Однако на Android это всё равно дополнительная GPU submission, readback и pressure на одну очередь после каждого кадра. Нельзя считать её бесплатной.

### Обязательный A/B

На реальном устройстве сравнить по три запуска:

- **profiling ON:** текущий `trackTimestamp: true` + resolve каждый кадр;
- **profiling OFF:** `trackTimestamp: false`, без `resolveTimestampsAsync()` и без `GpuProfiler`.

Сравнивать median `frameMs`, `cpu.update`, `cpu.submit`, mean draw calls и thermal state. В режиме OFF не будет GPU ms — это нормально; цель эксперимента состоит в измерении observer effect. Если FPS или `cpu.submit` заметно улучшатся, production build не должен разрешать timestamps каждый кадр. Для профилирования достаточно редкой выборки либо отдельной диагностической сборки.

---

## 5. Практический путь к GPU-bound режиму

### P0 — правильно атрибутировать `31.8 мс`

До архитектурной переделки нужны три измерения.

#### P0.1. Добавить в tablet harness число render/compute calls

Three.js уже ведёт:

- `renderer.info.render.frameCalls`;
- `renderer.info.compute.frameCalls`;
- `renderer.info.render.drawCalls`.

Нужно усреднять их каждый кадр так же, как draw calls. Это покажет реальное количество render contexts/submissions, а не оценку по графу TSL.

#### P0.2. Разделить `post.render()` на CPU-сегменты

Нужны отдельные синхронные счётчики хотя бы для:

- exposure compute;
- scene pass вместе с shadows;
- half-res MRT;
- TRAA;
- bloom;
- final composite;
- остального post graph.

Если прямые границы TSL nodes неудобны, использовать CDP CPU profile на 200–300 кадров реального планшета и искать `Bindings._update`, `UniformsGroup.update`, `NodeManager.updateForRender`, `_projectObject`, `WebGPUBackend._draw`, `GPUQueue.submit`/Dawn wire calls.

#### P0.3. A/B по уже имеющимся флагам

Прогнать одинаковые cooled runs с matching mean draw calls:

- `ablate=shadows` — цена shadow render-list/draw encoding;
- `ablate=veg` и отдельно `ablate=grass` — цена основных render items;
- `prepass=0` — цена дополнительных depth draws;
- `postmin=1` — сцена без полного post graph;
- `ablate=ao,bounce,clouds,taa,bloom` по одному и группами.

Здесь важны одновременно `cpu.submit` и GPU ms. Проход, который почти не стоит GPU, но сильно увеличивает `cpu.submit`, является первым кандидатом на удаление/объединение.

### P1 — применить `BundleGroup` к GPU-driven геометрии

Это наиболее прямой способ убрать повторное кодирование draw-команд и реально сделать кадр более GPU-driven.

Three.js r184 уже содержит `BundleGroup` (`three/webgpu`). Его потомки записываются в `GPURenderBundle`, а следующие кадры вызывают `executeBundles()` вместо повторного набора pipeline/bind/draw команд. Официальная документация прямо называет это способом снизить JavaScript draw-call overhead:

- [Three.js BundleGroup](https://threejs.org/docs/pages/BundleGroup.html)
- [MDN GPURenderBundle](https://developer.mozilla.org/en-US/docs/Web/API/GPURenderBundle)
- [WebGPU Render Bundle best practices](https://toji.dev/webgpu-best-practices/render-bundles.html)
- Three.js получил более 32% снижения CPU time в синтетическом тесте 8000 meshes, но это **не прогноз для этого проекта**: [three.js PR #28347](https://github.com/mrdoob/three.js/pull/28347).

Лучшие кандидаты проекта:

1. `GroundRing.group` и его prepass draw set;
2. `Forests.group`, где структура draw list постоянна;
3. terrain/far shell;
4. отдельные постоянные shadow-caster sets по cascade/layer.

Это особенно хорошо сочетается с уже реализованным GPU culling + indirect draws: bundle сохраняет команду `drawIndirect`, а compute shader продолжает менять indirect argument buffer каждый кадр. То есть видимость и instance counts остаются динамическими без повторного CPU-кодирования draw list.

Ограничения, которые нужно проверить отдельным A/B:

- bundle кэшируется на camera/render context, поэтому scene, prepass и shadow cameras создадут свои варианты;
- Three.js всё ещё обходит hierarchy и обновляет refresh-needed nodes/bindings;
- изменение структуры group требует `bundle.needsUpdate = true`;
- слишком много мелких bundles может проиграть одному крупному;
- прозрачные и меняющие сортировку объекты лучше оставить вне bundle.

Начинать следует с одного крупного непрозрачного GPU-indirect набора, вероятнее всего `GroundRing`, и измерять. Не переносить весь мир одновременно.

### P2 — продолжить уменьшать число render items и CPU updates

Подтверждённые направления уже есть в `STATUS.md:544-559`:

1. расширить `runiform()`/render-group sweep, особенно для констант species, probe-GI и материалов;
2. поставить `matrixAutoUpdate=false` и при необходимости `matrixWorldAutoUpdate=false` для действительно статических объектов после финальной матрицы;
3. baked/static mesh вместо навсегда замороженного skinned rider (`src/ride/cockpit/RiderBody.ts:16-17`);
4. объединять material variants и геометрии там, где это уменьшает render items без роста overdraw;
5. уменьшать количество shadow caster draws и каскадов;
6. на TBDR отключить depth prepass, если `prepass=0` выигрывает на устройстве.

Инстансинг и GPU indirect уже используются, поэтому общий совет «перенесите culling на GPU» для проекта запоздал. Следующий уровень — записать постоянные draw sequences в bundles и сократить per-object UBO/binding работу.

### P3 — объединить локальные compute submissions

Без нового abstraction layer можно заменить циклы вида:

```ts
for (const k of kernels) renderer.compute(k);
```

на:

```ts
renderer.compute(kernels);
```

Three.js в таком случае создаёт один compute encoder/pass/submit для массива nodes. Первые кандидаты:

- kernels `GroundRing`;
- kernels `Forests`;
- `Froxels.scatterK + integK`;
- `ProbeGI.gatherK + publishK`.

Перед объединением сохранить порядок dispatches и проверить resource hazards. Не нужен «ComputeBatcher», который внутри просто вызывает `renderer.compute()` в цикле: такой wrapper **ничего не объединит**, потому что каждый вызов всё равно немедленно завершает encoder и делает submit.

Ожидаемый эффект нельзя заранее выражать десятками миллисекунд: текущая update-фаза целиком занимает `1.4 мс`. Это оптимизация количества submissions/backpressure и p95, а не доказанный основной фикс `cpu.submit`.

### P4 — дальше объединять render passes

Проект уже подтвердил ценность этого подхода через `HalfResMrtNode`. Следующие кандидаты определяются только P0-профилем:

- удалить или слить проходы, которые создают отдельный render context ради дешёвой операции;
- оставить TAA resolve/final output раздельными только там, где это требует history/resource dependency;
- уменьшить число full-screen quad passes;
- не делать отдельный pass для эффекта, который можно включить в существующий MRT/final composite без изменения результата.

Прямой patch Three.js, откладывающий все `queue.submit()` до конца кадра и использующий один общий `GPUCommandEncoder`, теоретически уменьшит boundaries, но это рискованный последний шаг. Render targets, readbacks, uploads, nested pass nodes и timestamp queries сейчас полагаются на внутренний lifecycle renderer. Сначала использовать публичные `BundleGroup`, массивы compute nodes и pass consolidation.

### P5 — Worker/OffscreenCanvas только после устранения renderer overhead

WebGPU доступен в Web Workers, и renderer можно перенести на `OffscreenCanvas`. Это разгрузит main thread для input/UI и может улучшить responsiveness. Но worker:

- не уменьшает общий CPU render cost;
- не превращает Three.js traversal/binding work в GPU work;
- не гарантирует более глубокий presentation pipeline;
- усложняет ввод, загрузку ресурсов, telemetry и Android WebView/Chrome integration.

Это архитектурный вариант после bundles и сокращения per-object work, а не первый ответ на `31.8 мс`.

---

## 6. Что делать с GPU-нагрузкой

Цель «сделать GPU bottleneck» не означает, что GPU work можно оставить без изменений. Если CPU снизится с `31.8` ниже `28.6 мс`, ограничителем станет GPU, но целевой frame time всё равно будет около GPU critical path плюс compositor/vsync overhead.

Поэтому GPU-план из `docs/PERF_FPS_MOBILE.md` остаётся актуален:

- grass grid/cull workload;
- froxel resolution/cadence;
- particle count/cadence;
- shadow cascades;
- clouds/GTAO/bounce;
- periodic GI/LUT updates;
- TBDR attachment/store hygiene.

Разница в приоритете: GPU cuts следует делать параллельно с CPU renderer cuts и проверять обе оси. Сейчас удаление GPU work не гарантирует пропорциональный FPS win, а удаление draw/pass overhead может улучшить и CPU, и GPU.

---

## 7. Реалистичная целевая архитектура кадра

```text
rAF
 ├─ fixed/update CPU                       ~1–2 ms
 ├─ один/несколько крупных compute groups  GPU cull/sim/indirect args
 ├─ обновление нескольких frame uniforms
 ├─ scene render:
 │    ├─ executeBundle(terrain)
 │    ├─ executeBundle(ground ring)
 │    ├─ executeBundle(forests)
 │    └─ небольшой dynamic set (bike/water/transparency)
 ├─ минимальное число consolidated post passes
 └─ submit/present
```

При такой схеме CPU не повторяет сотни pipeline/bind/draw команд, а лишь обновляет frame data, dispatches и исполняет крупные предзаписанные bundles. Это и есть практический способ сделать проект GPU-driven в WebGPU, не переписывая сразу весь renderer.

---

## 8. Критерий успеха

Нельзя объявлять успех по одному FPS или по одной сумме timestamp passes.

Для каждого изменения на реальном устройстве нужны три cooled runs и median при одинаковых:

- camera/seed/preset/DPR;
- mean draw calls и triangles;
- thermal state;
- profiling mode;
- browser foreground state.

Главные метрики:

1. `cpu.submit` — должен устойчиво снижаться;
2. `cpu.update` — не должен регрессировать;
3. `render.frameCalls`, `compute.frameCalls`, `drawCalls` — объясняют механизм;
4. GPU total и top passes — не должны неожиданно расти;
5. `frameMs`/FPS — конечный результат на Android;
6. p95/1% low — защита от периодических readback/shadow/cloud hitches.

**Первый рубеж:** `cpu.update + cpu.submit < GPU total` без потери картинки.  
**Второй рубеж:** frame time начинает реагировать на GPU ablations и почти перестаёт реагировать на CPU-only reductions. Тогда можно честно сказать, что приложение стало GPU-bound.

---

## Итоговый приоритет

1. **A/B timestamps ON/OFF** — исключить observer effect.
2. **Записать `render.frameCalls` и `compute.frameCalls`; снять CDP CPU profile на планшете.**
3. **Один эксперимент с `BundleGroup` на крупном GPU-indirect draw set.** Это наиболее перспективный прямой фикс `cpu.submit`.
4. **Продолжить uniform-group и static-matrix работу**, уже подтверждённую прежним профилем.
5. **Объединить локальные compute kernels массивами** для снижения submissions и backpressure, но не выдавать это за доказанный десяткимиллисекундный выигрыш.
6. **Сокращать draw calls, shadow passes и post render contexts.**
7. Только если публичные механизмы исчерпаны — **patch/custom renderer backend** с frame-level command encoding или перенос renderer в worker.

**Финальный ответ:** ситуация тяжёлая, но не безвыходная. Мы уже перенесли собственно вычисления на GPU; текущая стена — CPU orchestration и command encoding в Three.js WebGPURenderer. WebGPU предоставляет нужный механизм для следующего шага — render bundles с GPU-updated indirect buffers. Если bundles и сокращение render contexts снизят `cpu.submit` ниже GPU time, кадр снова упрётся в GPU. Переписывать приложение или отказываться от WebGPU до этих измерений оснований нет.

---

## Источники

### Web standards/API

- W3C WebGPU, programming model and timelines: https://www.w3.org/TR/webgpu/#programming-model-timelines
- MDN `GPUQueue.submit()`: https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/submit
- MDN `GPUQueue.onSubmittedWorkDone()`: https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/onSubmittedWorkDone
- MDN `requestAnimationFrame()`: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- MDN `GPURenderBundle`: https://developer.mozilla.org/en-US/docs/Web/API/GPURenderBundle

### Three.js/WebGPU

- Three.js `BundleGroup`: https://threejs.org/docs/pages/BundleGroup.html
- Three.js render-bundle implementation/performance PR: https://github.com/mrdoob/three.js/pull/28347
- Three.js WebGPURenderer UBO issue: https://github.com/mrdoob/three.js/issues/30560
- WebGPU render-bundle best practices: https://toji.dev/webgpu-best-practices/render-bundles.html

### Репозиторий

- `src/core/Engine.ts`
- `src/core/GpuProfiler.ts`
- `src/render/PostStack.ts`
- `src/render/HalfResMrt.ts`
- `src/render/ThreePatches.ts`
- `src/vegetation/GroundRing.ts`
- `src/vegetation/Forests.ts`
- `tools/perf-tablet.ts`
- `docs/PERF_FPS_MOBILE.md`
- `STATUS.md`
- pinned Three.js r184 sources under `node_modules/three/src/renderers/`
