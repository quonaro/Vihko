# Vihko — редактор: исследование и дорожная карта

> Рабочий документ. Позиционирование: **Paper-метафора журналов снаружи,
> редактор уровня ibisPaint внутри страницы**. Движок — Go→WASM для
> математики, Canvas2D/GPU для композитинга, Vue для UI.

## 1. Референс-проекты

### Движки чернил / сглаживание ввода

| Проект                                                                          | Лицензия   | Что брать                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [steveruizok/perfect-freehand](https://github.com/steveruizok/perfect-freehand) | MIT        | Точки → цельный полигон обводки переменной ширины (thinning, smoothing, streamline, taper). Порт ~300 строк в `engine/ink.go`. Алгоритм пера tldraw.                                          |
| [google/ink-stroke-modeler](https://github.com/google/ink-stroke-modeler)       | Apache-2.0 | Модель сглаживания + предикция позиции (основа Jetpack Ink). Читать как спецификацию; Rust-порт [flxzt/ink-stroke-modeler-rs](https://github.com/flxzt/ink-stroke-modeler-rs) читается легче. |
| [szimek/signature_pad](https://github.com/szimek/signature_pad)                 | MIT        | velocity→width + Безье — тот же подход, доведён до прода.                                                                                                                                     |
| [flxzt/rnote](https://github.com/flxzt/rnote)                                   | —          | Приложение заметок (Rust/GTK): как связывать stroke-modeler с рендером.                                                                                                                       |

### Приложения для рисования / заметки

| Проект                                                          | Лицензия          | Что брать                                                                                                   |
| --------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| [LinwoodDev/Butterfly](https://github.com/LinwoodDev/Butterfly) | AGPL? (проверить) | Flutter, слои, инструменты — ближайший архитектурный аналог. Только как референс.                           |
| [adil192/Saber](https://github.com/adil192/Saber)               | GPL? (проверить)  | Работа со стилусом (инверсия пера → ластик), порт perfect-freehand.                                         |
| [Catrobat/Paintroid](https://github.com/Catrobat/Paintroid)     | AGPL-3.0          | Каталог инструментов и UX-паттернов Android-редактора. Код не копировать.                                   |
| [drawpile/Drawpile](https://github.com/drawpile/Drawpile)       | GPL-3.0           | Движок кистей взрослого уровня — только идеи.                                                               |
| [mypaint/mypaint](https://github.com/mypaint/mypaint)           | GPL               | libmypaint — референс для wet mixing / smudge (акварель, смешивание на холсте). Переписывать своими руками. |

### Веб-редакторы на Canvas (JS/TS)

| Проект                                                                                            | Лицензия                                | Что брать                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| [tldraw/tldraw](https://github.com/tldraw/tldraw)                                                 | Своя (source-available, вотермарк/ключ) | Код не копировать. Читать: state machine жестов, камера, ink через perfect-freehand. |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)                                 | MIT                                     | Мобильная адаптация жестов, pointer events, undo.                                    |
| [nhn/tui.image-editor](https://github.com/nhn/tui.image-editor)                                   | MIT                                     | Каталог фич фоторедактора: crop/rotate/draw/shapes/text/filters.                     |
| [viliusle/miniPaint](https://github.com/viliusle/miniPaint)                                       | GPL-3.0                                 | «Photoshop в браузере», читаемый код — только идеи.                                  |
| [1j01/jspaint](https://github.com/1j01/jspaint)                                                   | MIT                                     | Flood fill, история undo, мобильная поддержка.                                       |
| [GraphiteEditor/Graphite](https://github.com/GraphiteEditor/Graphite)                             | Apache-2.0 (проверить)                  | Та же архитектура: WASM-движок (Rust) + веб-фронт. Как градировать движок.           |
| [advanced-cropper/vue-advanced-cropper](https://github.com/advanced-cropper/vue-advanced-cropper) | MIT                                     | Mobile-first кроппер, Vue — можно встраивать.                                        |
| [ailon/markerjs2](https://github.com/ailon/markerjs2)                                             | MIT                                     | Аннотации поверх изображения.                                                        |
| [scaleflex/filerobot-image-editor](https://github.com/scaleflex/filerobot-image-editor)           | MIT                                     | React-редактор на Konva — референс UI/фич (полузаброшен).                            |

### Нативные фоторедакторы

| Проект                                                                        | Лицензия   | Что брать                                                                     |
| ----------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| [burhanrashid52/PhotoEditor](https://github.com/burhanrashid52/PhotoEditor)   | MIT        | Android-библиотека: brush/text/sticker/filter/crop, pinch-transform стикеров. |
| [fossasia/phimpme-android](https://github.com/fossasia/phimpme-android)       | —          | Полноценное приложение (OpenGL-фильтры).                                      |
| [longitachi/ZLImageEditor](https://github.com/longitachi/ZLImageEditor)       | MIT        | iOS: crop/draw/text/mosaic/filters.                                           |
| [muukii/Brightroom](https://github.com/muukii/Brightroom)                     | MIT        | iOS non-destructive пайплайн (CoreImage/LUT).                                 |
| [thedhruvhegde/photolab](https://github.com/thedhruvhegde/photolab)           | —          | RN+Skia, правки как JSON-рецепты — модель, похожая на наши `ops`.             |
| [Muzamilabdallah/photoEditor](https://github.com/Muzamilabdallah/photoEditor) | Apache-2.0 | Compose, разделение `core`/`ui-default`.                                      |

## 2. Правила заимствования (clean-room)

- MIT/Apache/BSD — можно портировать почти дословно с атрибуцией (header-комментарий + NOTICE).
- GPL/AGPL (Drawpile, Paintroid, miniPaint, mypaint, Butterfly?) — читать как спецификацию, код писать свой. Иначе проект заражается copyleft.
- tldraw SDK — своя лицензия (вотермарк/платный ключ), копировать нельзя. `perfect-freehand` — MIT, можно.
- Оригинальный Paper — **не декомпилировать**. Нарушение ToS + ломает clean-room. Ценность Paper — итерации «feel», не алгоритмы.
- Перед копированием любого файла: проверить лицензию в шапке репо.

## 3. Архитектура: граница WASM / JS

**Решение: НЕ «всё на wasm».** WASM не имеет доступа к DOM/Canvas2D — каждый
`ctx.*` из Go идёт через `syscall/js` маршаллинг, это чистый оверхед.
WASM ускоряет только математику над своими буферами.

| Слой                                            | Где живёт                 | Почему                                                           |
| ----------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Stroke modeling, сглаживание, предикция         | WASM (`engine/ink.go`)    | Чистая математика, на каждое событие                             |
| Пиксельные опы: flood fill, wet mixing, фильтры | WASM над своим буфером    | Попиксельные циклы ×10 быстрее JS, без getImageData туда-обратно |
| Композитинг слоёв, блит растров                 | Canvas2D `drawImage` (JS) | Уже GPU-ускорено; если упрёмся — WebGL                           |
| Рендер штрихов в canvas                         | JS (`renderer.ts`)        | Это вызовы Canvas API, не математика                             |
| Жесты, инструменты, UI                          | TS/Vue                    | DOM, accessibility, ввод текста                                  |

**Цена WASM**: `jsEngine` fallback обязан зеркалить Go (parity-тесты).
Каждая фича движка пишется дважды → расширять wasm-поверхность только
там, где есть измеримый профит.

Целевая схема пиксельного движка (этап 4): растр слоя живёт в wasm-памяти,
JS держит `ImageData`-view на линейный буфер, blit через `putImageData`
только при изменении.

## 4. Аудит текущего кода

Сильное:
- Модель «векторные штрихи + растровые ops с `after`» — реплей по порядку,
  undo бесплатно, пересекается с моделью photolab («рецепты»).
- Per-layer растровый кэш + композитинг `drawImage` с opacity/transform —
  та же модель, что у Procreate/ibisPaint.
- Снапшот страницы (`ensureSnap`) — пан/зум не реплеят сцену.
- `engine/ink.go` без build-тегов → `go test` нативно; JS fallback с parity.

Мины (по приоритету):
1. **Растр слоя привязан к зуму** — ключ кэша `pageId|layerId|scale`
   (`src/ink/layers.ts:221`). Каждый зум → полный реплей всех слоёв.
   На 5–8 слоях pinch-зум заикается; память ≈ 29 МБ/слой при scale≈8.
   → **Фиксированное разрешение документа**: растр слоя один раз в
   ~2048–3072px, зум = `drawImage` с масштабом. Ключевое изменение под
   ibisPaint-модель.
2. **Pressure игнорируется** — поле `P` есть в `Point`/API, но не
   используется ни Go, ни JS. Ширина только от velocity.
3. **Швы в рендере** — quads + joint-кружки (`renderer.ts`) дают артефакты
   при изменении ширины. → perfect-freehand строит цельный полигон.
4. **Нет coalesced/predicted events** — на 90+ Гц теряем точки и латентность.
5. `rasterCache` LRU=8 листается при зуме — после п.1 станет неактуально.
6. Нет blend modes / alpha lock / clipping — при этом это почти бесплатно
   (`globalCompositeOperation`, `source-atop`/`destination-in`).

## 5. Дорожная карта

### Этап 1 — качество штриха (feel)

- Порт `perfect-freehand` → `engine/ink.go` + `jsEngine` + parity-тесты.
- Pressure (`P`) + velocity в ширину; taper на концах.
- `getCoalescedEvents()`/`getPredictedEvents()` в pointer-обработчике.
- Опция стабилизатора (как у ibisPaint): сила сглаживания per-tool.
- Критерий: плавная линия без швов/артефактов при любом зуме и скорости.

### Этап 2 — слои v2 (фундамент ibisPaint)

- Фиксированное разрешение растров слоёв; зум не реплеет.
- `Layer.blend` — ~10 режимов из `globalCompositeOperation` для начала
  (multiply, screen, overlay, soft-light, darken, lighten, color-dodge,
  difference).
- Alpha lock (`source-atop`), clipping mask (`destination-in` к нижнему слою).
- Миниатюры слоёв в менеджере.
- Тесты: композитинг, порядок, undo/redo при blend/clip.

### Этап 3 — кисти и панель инструмента

- Текстурные штампы: canvas-pattern tip, spacing/jitter/scatter/angle.
- Панель свойств инструмента (size/opacity/stabilizer/blend) —
  центральный UX-блок ibisPaint, которого у нас нет.
- Пресеты кистей (карандаш/круглый/маркер/аэрограф/акварель).

### Этап 4 — пиксельный движок в WASM

- flood fill в wasm-буфере (сейчас get/putImageData на ~3200px).
- Wet mixing (акварель-модель по мотивам libmypaint) на холсте.
- База для фильтров (blur/sharpen/adjust) — те же ядра.

### Этап 5 — продвинутое

- Маски слоёв, симметрия, линейки/французские кривые, фильтры.

## 6. UX/UI — что копировать паттернами

ibisPaint (юзать как UX-референс, не код):
- Нижний док инструментов → тап открывает панель свойств инструмента.
- Панель слоёв: миниатюра, blend, opacity-ползунок, alpha-lock/clip иконки.
- Долгие тапы/жесты: eyedropper по long-press, быстрый undo двумя пальцами.
- Стабилизатор как ползунок в свойствах кисти.
- Color wheel + палитры + недавние цвета.

Что у нас остаётся из Paper-мира: полка/журналы/page fan — как «обёртка»
документов; редактор внутри страницы — полноценный.

## 7. Открытые вопросы

- Формат документа: фиксированное разрешение растра слоя — одно на все
  зумы (2048?) или mip-уровни?
- Оставлять ли `layer.x/y/scale/rotation` (transform слоя) при ibisPaint-
  трансформе — это дублирует transform tool?
- Wet mixing — на слое или через «умный» инструмент-размазню?
- Векторные штрихи vs чистый растр: при wet mixing векторная модель
  частично теряет смысл — стоит ли со временем стать чисто растровым
  редактором с штрихами только для undo?

## 8. Аудит фич референсов (VI-11)

Clean-room: список ниже — паттерны для переноса, не код. Матрица —
ibisPaint X / Clip Studio Paint против текущего состояния Vihko
(после этапов 1–5 и FIXME-эпиков VI-32…VI-34).

| Фича                                                    | ibisPaint | CSP                                       | Vihko                     | Зазор                                                               |
| ------------------------------------------------------- | --------- | ----------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| Переменная ширина от давления/скорости, taper           | +         | +                                         | +                         | —                                                                   |
| Стабилизатор (force fade/wobble у CSP)                  | +         | + (богаче)                                | + (streamline)            | post-correction (start/end taper, round stroke)                     |
| coalesced/predicted events                              | +         | +                                         | +                         | —                                                                   |
| Текстурные штампы (spacing/jitter/scatter/angle)        | +         | +                                         | +                         | dual brush, color dynamics, texture-качество                        |
| Панель свойств инструмента                              | +         | +                                         | +                         | quick menu, per-tip палитра                                         |
| Пресеты кистей                                          | +         | +                                         | +                         | импорт/шеринг материалов, браш-магазин                              |
| Слои: blend modes                                       | 27        | ~30                                       | 10                        | hue/sat/color/luminosity, divide, subtract                          |
| Alpha lock / clipping                                   | +         | +                                         | +                         | —                                                                   |
| Миниатюры слоёв                                         | +         | +                                         | +                         | —                                                                   |
| Маски слоёв                                             | +         | +                                         | +                         | luminosity-mask, маска из выделения                                 |
| Симметрия                                               | +         | +                                         | +                         | multi-axis kaleidoscope (3..8 лучей), симметрия по произвольной оси |
| Линейки/кривые                                          | +         | +++ (перспектива, фигурные, симметричные) | line/arc                  | перспективная линейка — главный кандидат                            |
| Фильтры                                                 | ~50       | ~40                                       | blur/sharpen/adjust       | gaussian (больший радиус), posterize, curves/levels, unsharp UI     |
| Заливка + обратная + magic wand                         | +         | +                                         | +                         | lasso/selection tool — крупный зазор                                |
| Wet mixing / smudge                                     | +         | +                                         | + (pickup модель)         | выделенный инструмент-размазня, загрузка краски                     |
| Размер холста                                           | +         | +                                         | + (3 пресета)             | произвольный w/h в диалоге, DPI                                     |
| Редактирование выделения (lasso/marquee + transform)    | +         | +                                         | − (только cut-lift-move)  | **выделение как отдельная сущность** — крупнейший UX-зазор          |
| Текст/шрифты                                            | +         | +                                         | −                         | задача на roadmap                                                   |
| Векторные слои/линии                                    | −         | +                                         | −                         | осознанно пропускаем                                                |
| Таймлапс-запись                                         | +         | +                                         | −                         | нишево, не нужно                                                    |
| Облачные материалы/синк                                 | +         | +                                         | −                         | вне скоупа                                                          |
| Быстрые жесты (2-пальцевый undo, long-press eyedropper) | +         | +                                         | частично (Ctrl+Z, пинч)   | **eyedropper по long-press** — дешёвая крупная победа               |
| Поворот холста жестом                                   | +         | +                                         | − (только трансформ слоя) | кандидат                                                            |
| Onion skin / анимация                                   | +         | +                                         | −                         | вне скоупа                                                          |

### Кандидаты в бэклог (по убыванию ценность/цена)

1. **Eyedropper по long-press** — временно берёт цвет под курсором без смены
   инструмента; паттерн ibisPaint, дёшево.
2. **Выделение (lasso/rect marquee)** — как объект с режимами
   new/add/subtract, transform, fill/stroke по выделению; сейчас cut —
   одноразовый жест.
3. **Двухпальцевый undo / трёхпальцевый redo** — стандарт индустрии.
4. **Kaleidoscope-симметрия N лучей** — расширение `mirroredPtSets`.
5. **Перспективная линейка** (1–2 точки схода) — на базе guide-системы.
6. **Поворот холста** (view rotation, не слой) — матрица вида.
7. **Инструмент-размазня (smudge)** — wetStroke уже умеет pickup; нужен
   tool, который ничего не кладёт, только подхватывает.
8. **Текстовый инструмент** — шрифт/размер/цвет → растр в слой.
9. **Curves/levels в фильтрах** — LUT-подход поверх px-ядер.
10. **Недостающие blend-режимы** (hue/sat/color/luminosity, subtract,
    divide) — часть есть в `globalCompositeOperation`, часть — руками.
