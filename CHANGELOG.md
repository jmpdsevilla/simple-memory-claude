# Changelog

Todos los cambios destacables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/) y el versionado [Semantic Versioning](https://semver.org/).

> A partir de la versión 2.0.0 el proyecto pasa a llamarse **BovedIA** y a documentarse íntegramente en español. Las entradas anteriores se conservan tal cual como registro histórico.

---

## [2.4.1] — 2026-07-25

### Cambiado

**El parámetro `tags` de `write_note` queda marcado como desaconsejado** en su descripción y en la referencia. Sigue funcionando por compatibilidad, pero la clasificación va como hashtags `#snake_case` en la última línea del cuerpo: es lo único que leen los editores que agrupan por etiqueta. Si se omite, el frontmatter no escribe el campo.

---

## [2.4.0] — 2026-07-25

### Corregido

**HOME.md deja de ser un archivo invisible.** Estaba marcado como reservado desde que el índice se escribía a disco, y se quedó excluido por inercia cuando eso dejó de hacerse (v1.1.2). El efecto: la nota más enlazada de una bóveda quedaba fuera del índice — sus backlinks no se contaban, sus wikilinks no se validaban, no aparecía en `get_index` ni la alcanzaba ninguna tarea de mantenimiento. Ahora es una nota como las demás. `read_note("HOME")` sigue funcionando igual.

**El filtro de categoría entiende la raíz.** Las notas de la raíz se guardan con `category: .` pero el índice las llama internamente `raiz`, así que filtrar por `"."` —la forma que se escribe al guardar— no devolvía ninguna. Afectaba a `list_notes`, `search_notes`, `get_index`, `due_notes` y `migrate_yaml_tags`. Ahora `"."`, `""` y `raiz` son equivalentes, y filtrar por la raíz no arrastra las subcarpetas.

### Pruebas

50 casos (6 nuevos: HOME en el índice, sus backlinks y enlaces rotos, la migración alcanzándola, y el filtrado de la raíz por sus dos nombres).

---

## [2.3.1] — 2026-07-25

### Corregido

**`migrate_yaml_tags` también limpia el `tags: []` vacío.** Las notas cuyo campo `tags` existía pero no tenía valores se saltaban —no había nada que rescatar—, así que el frontmatter quedaba desigual: unas notas sin el campo y otras con la línea vacía. Ahora se procesan igual y el resultado es uniforme.

---

## [2.3.0] — 2026-07-25

### Añadido

**`migrate_yaml_tags`.** Operación one-shot para bóvedas que arrastran etiquetas en dos sitios: baja al cuerpo, como hashtags `#snake_case`, los tags que solo estaban en el frontmatter YAML, y deja el frontmatter limpio. No duplica los que ya existían en el cuerpo, normaliza la forma (`#Nano-Banana` y `Diseño Web` pasan a `#nano_banana` y `#diseno_web`), conserva la fecha de modificación y la autoría, y es idempotente. Corre en `dry_run` por defecto; acepta `category` para migrar por partes y `drop` para descartar etiquetas de ruido en vez de bajarlas.

El problema que resuelve: los editores que agrupan por etiqueta (iA Writer y similares) no leen el frontmatter, así que una nota clasificada solo en YAML figura como sin clasificar. La convención de la bóveda son los hashtags al final del cuerpo; esta herramienta salva las etiquetas que se quedaron arriba en lugar de perderlas al limpiar.

### Cambiado

**El frontmatter ya no escribe `tags: []` cuando está vacío.** Una bóveda que clasifica con hashtags no necesita arrastrar un campo vacío en cada archivo. Si la nota tiene tags, se conservan tal cual.

### Pruebas

44 casos (10 nuevos para la migración: simulación, creación de la línea de hashtags, no duplicación, limpieza del frontmatter, preservación de fechas, idempotencia, `drop` y que lo migrado quede buscable y filtrable).

---

## [2.2.0] — 2026-07-25

Versión de fortalecimiento: seguridad de rutas, rendimiento, búsqueda en español y tres herramientas nuevas. La API existente no cambia — ninguna herramienta cambia de nombre ni de parámetros.

### Seguridad

**Las rutas no pueden salirse de la bóveda.** El parámetro `category` (y equivalentes) se concatenaba a la raíz sin comprobar nada, así que un valor como `../../otra-carpeta` escribía o borraba fuera de la bóveda. Ahora toda ruta construida a partir de argumentos se resuelve y se verifica que quede dentro de la raíz configurada; si no, la operación se rechaza con un error claro. Afecta a `write_note`, `create_category`, `move_note`, `delete_category`, `update_frontmatter`, `move_category` y `bulk_move`.

**Validación de argumentos.** Si falta un parámetro obligatorio o llega con otro nombre (`old_string` en vez de `old_text`, un clásico), el servidor lo dice y enumera los parámetros correctos. Antes el argumento llegaba como `undefined` y la herramienta seguía adelante: `edit_note` respondía "no se encontró el texto a reemplazar", lo que mandaba a buscar el fallo en la nota cuando el fallo estaba en la llamada.

### Rendimiento

**Resolución de notas en memoria.** Localizar una nota por su nombre recorría el disco entero en cada llamada, y `list_broken_links` lo hacía una vez por wikilink. En una bóveda de 340 notas con 1.767 enlaces eran ~90.000 lecturas de directorio y 1,4 segundos; ahora se resuelve contra el índice ya cacheado: **1 ms**.

**Backlinks en una pasada.** El cálculo era O(N²) (por cada nota se recorrían todas las demás). Ahora se construye un mapa completo en un solo recorrido, junto al índice.

**La caché guarda el contenido.** `search_notes` releía la bóveda entera del disco en cada búsqueda. El índice ya leía cada archivo, así que ahora conserva el texto: la búsqueda no vuelve a tocar disco.

### Búsqueda

- **Insensible a acentos.** "pirámide" y "piramide" devuelven lo mismo. En una bóveda en español, la tilde partía los resultados en dos conjuntos incompletos y no había forma de saberlo.
- **Ordenada por relevancia:** una coincidencia en el título o en una etiqueta pesa más que una perdida en mitad del cuerpo.
- **Acotada:** nuevo parámetro `limit` (20 por defecto) y `category` para restringir el ámbito. Si hay más resultados, se avisa de cuántos quedan.
- **Extractos limpios:** ya no aparecen el frontmatter ni el bloque de anotaciones en los fragmentos de resultado.

### Contexto

**`get_index` ya no es una trampa.** Devolvía la bóveda entera nota a nota —unos 11.000 tokens en una bóveda mediana— y su descripción invitaba a llamarlo "al inicio de una sesión". Ahora devuelve por defecto el árbol de categorías con sus conteos (~800 tokens) y acepta `category` y `full: true` para el detalle.

**`KB_TOOLS=core`.** El listado de herramientas viaja en cada sesión y cuenta contra la ventana de contexto. Con este perfil se exponen solo las 15 de uso diario (2.400 tokens en vez de 4.500), para clientes con ventana corta. Por defecto se mantienen todas.

**Las herramientas de autoría solo aparecen si están activadas.** `read_authorship` y `migrate_annotations` se anunciaban siempre, aunque `KB_ENABLE_ANNOTATIONS` estuviera desactivado.

### Añadido

- **`due_notes`** — devuelve solo las notas programadas cuya fecha `> APARECER: AAAA-MM-DD` ya ha llegado. La comprobación de arranque pasa de abrir las notas una a una a una única llamada; el día que no toca nada, la respuesta es una línea. Con `include_upcoming` lista también las futuras.
- **`list_sections`** — índice de encabezados de una nota (nivel y tamaño en líneas) sin devolver el contenido. Permite orientarse en notas largas y luego leer solo lo necesario con `read_section`.
- **`audit_tags`** — auditoría de etiquetas: hashtags con guión medio (que los editores no agrupan y el extractor trunca en el guión, convirtiendo `#santa-marta-crea` en `#santa`), variantes de tipo, etiquetas de uso único y notas con tags en el frontmatter YAML. Con `fix_dashes: true` corrige los guiones conservando la fecha de modificación y la autoría.

### Corregido

- **Wikilinks con alias y con ancla.** `[[nota|alias]]`, `[[nota#Sección]]` y `[[#Sección]]` se contaban como enlaces rotos aunque la nota existiera, y sus backlinks no se registraban. Ahora se resuelve el destino real del enlace.
- **`create_category` con rutas anidadas.** Slugificaba la ruta entera y se comía las barras: `problemas-resueltos/mcp` acababa siendo una única carpeta llamada `problemas-resueltosmcp`. Ahora se slugifica cada segmento y se crean las carpetas anidadas.
- **`list_notes(tag)` solo miraba el frontmatter YAML.** Filtrar por una etiqueta escrita como hashtag en el cuerpo —la convención vigente— devolvía cero notas. Ahora mira las dos.
- **`validate_note`** avisa además de los hashtags con guión medio.

### Pruebas

Suite de pruebas (`npm test`, `node --test`, sin dependencias): 34 casos que levantan el servidor real por stdio contra bóvedas temporales y comprueban seguridad de rutas, búsqueda, wikilinks, etiquetas, programadas, perfiles de herramientas y el candado de escritura-solo-bandeja. Integración continua en GitHub Actions sobre Node 18, 20 y 22.

---

## [2.1.0] — 2026-07-21

### Añadido

**Publicación en npm.** BovedIA se puede instalar ahora directamente con `npx bovedia`, sin clonar el repositorio. Se añadió el shebang y el campo `bin` al paquete, más los metadatos para el registro oficial de MCP (`mcpName: io.github.jmpdsevilla/bovedia`). La configuración del cliente MCP pasa a ser tan simple como `"command": "npx", "args": ["-y", "bovedia"]`. El comportamiento del motor no cambia.

---

## [2.0.0] — 2026-07-20

### Cambiado

**Renombrado del proyecto a BovedIA** (bóveda + IA). El repositorio pasa de `simple-memory-claude` a `BovedIA`. GitHub redirige automáticamente las URLs antiguas; la antigüedad, el histórico y las releases se conservan.

**Un solo idioma: español.** El proyecto —README, documentación, bóveda de ejemplo y descripciones de las herramientas— pasa a estar íntegramente en español.

**Motor unificado.** El servidor deja de mantenerse como dos copias divergentes (una pública en inglés y una personal en español); ahora es un único código, y las diferencias de cada instalación se controlan por variables de entorno:
- `KB_MEMORY_ROOT` (con alias `MEMORY_PATH`) define la carpeta de la bóveda. Acepta rutas con `~` y relativas. Si no se define ninguna, usa `~/Documents/bovedia` por defecto.
- `KB_SERVER_NAME` permite fijar el nombre con que el servidor se anuncia (por defecto `bovedia`), para conservar un identificador propio en una instalación existente sin cambiar el flujo de trabajo.

**Bóveda de ejemplo rehecha.** `vault-example/` ahora enseña el método completo: el router `Inicio`, la pirámide de tres niveles, el alma (donde se vuelca lo que uno piensa y siente) y carpetas de ejemplo para proyectos, clientes, conocimiento y referencias.

### Notas

- La API de herramientas no cambia: las 29 herramientas conservan nombres, parámetros y comportamiento.
- Cambios incompatibles respecto a v1.5.1: el nombre del servidor por defecto pasa de `knowledge-base` a `bovedia`, y la ruta por defecto de la bóveda pasa a `~/Documents/bovedia`. Define `KB_SERVER_NAME` y `KB_MEMORY_ROOT` si dependías de los valores anteriores.

---

## [1.5.1] — 2026-06-18

### Fixed

**[ES]** Normalización Unicode a NFC. Las notas guardadas en forma descompuesta (NFD) —habitual en macOS/iCloud y en iA Writer— hacían fallar `edit_note`, `append_to_note`, `update_section` y otras operaciones de edición con "no se encontró el texto", aunque el texto fuera visualmente idéntico: las comparaciones literales (`split`/`replace`/`includes`) fallan cuando un lado está en NFC y el otro en NFD. Ahora se normaliza a NFC en las dos fronteras: en la lectura de disco (todas las lecturas de notas pasan por un único punto) y en los argumentos de entrada de cada herramienta. Los offsets de las anotaciones no se ven afectados, porque los grapheme clusters se cuentan igual en NFC y en NFD.

**[EN]** Unicode normalization to NFC. Notes stored in decomposed form (NFD) —common on macOS/iCloud and in iA Writer— made `edit_note`, `append_to_note`, `update_section` and other edit operations fail with "text not found", even when the text was visually identical: literal comparisons (`split`/`replace`/`includes`) fail when one side is NFC and the other NFD. Text is now normalized to NFC at the two boundaries: on disk reads (all note reads go through a single point) and on each tool's input arguments. Annotation offsets are unaffected, because grapheme clusters count the same in NFC and NFD.

---

## [1.5.0] — 2026-06-18

### Added

**[ES]** Caché en memoria del índice de notas. `getAllNotes()` escanea y parsea todos los archivos del disco en cada lectura; ahora el resultado se cachea y se reutiliza, con doble invalidación: por escritura (todo handler de escritura llama a `invalidateCache()` al terminar con éxito) y por un TTL corto de 20 s (para recoger ediciones hechas directamente en los archivos, fuera del MCP). Acelera notablemente los handlers de lectura.

**[EN]** In-memory cache of the note index. `getAllNotes()` scans and parses every file on disk on each read; the result is now cached and reused, with two-way invalidation: on write (every write handler calls `invalidateCache()` on success) and via a short 20 s TTL (to pick up edits made directly to the files, outside the MCP). Noticeably speeds up read handlers.

**[ES]** Autor de las anotaciones Markdown configurable por entorno: `KB_AUTHOR_NAME` y `KB_AUTHOR_EMAIL`. Permite que varias instancias del servidor (p. ej. distintos asistentes) firmen cada una con su propio nombre. Por defecto, `Claude` / `noreply@anthropic.com`.

**[EN]** Markdown annotations author configurable via environment: `KB_AUTHOR_NAME` and `KB_AUTHOR_EMAIL`. Lets multiple server instances (e.g. different assistants) each sign with their own name. Defaults to `Claude` / `noreply@anthropic.com`.

### Changed

**[ES]** El modo solo-bandeja se refina y pasa a llamarse `KB_WRITE_ONLY_INBOX` (se mantiene la compatibilidad con `KB_INBOX_ONLY`). Cambios de comportamiento: la lectura nunca se bloquea; la escritura solo se permite en la carpeta de entrada y, si el destino no es la bandeja, se **rechaza con un mensaje claro en vez de redirigir en silencio**; las notas existentes solo pueden modificarse si ya están en la bandeja; las operaciones de administración (crear/borrar/mover categorías, renombrar wikilinks, migrar anotaciones) quedan siempre bloqueadas.

**[EN]** Inbox-only mode is refined and renamed `KB_WRITE_ONLY_INBOX` (backward compatible with `KB_INBOX_ONLY`). Behavior changes: reads are never blocked; writes are only allowed in the inbox folder and, if the target is not the inbox, the operation is now **rejected with a clear message instead of being silently redirected**; existing notes can only be modified if they already live in the inbox; admin operations (create/delete/move categories, rename wikilinks, migrate annotations) are always blocked.

---

## [1.4.0] — 2026-06-17

### Added

**[ES]** Modo solo-bandeja opt-in (`KB_INBOX_ONLY=1`): candado duro pensado para asistentes locales o no confiables. Cuando está activo, el asistente solo puede LEER notas y CREAR notas nuevas en la carpeta de entrada; quedan bloqueadas las operaciones de editar, borrar, mover y renombrar. Se impone en el servidor, no depende de que el modelo obedezca. El nombre de la carpeta de entrada es configurable con `KB_INBOX_FOLDER` (por defecto `inbox`). Off por defecto.

**[EN]** Opt-in inbox-only mode (`KB_INBOX_ONLY=1`): a hard lock intended for local or untrusted assistants. When enabled, the assistant can only READ notes and CREATE new notes in the inbox folder; edit, delete, move and rename operations are blocked. Enforced in the server, not reliant on the model obeying. The inbox folder name is configurable via `KB_INBOX_FOLDER` (defaults to `inbox`). Off by default.

### Changed

**[ES]** El filtro de categoría de `list_notes` ahora es recursivo: incluye la categoría indicada y todas sus subcarpetas (p. ej. `clients` devuelve también las notas de `clients/acme`). Antes era coincidencia exacta. Descripciones de la herramienta y del parámetro `category` aclaradas.

**[EN]** The `list_notes` category filter is now recursive: it includes the given category and all of its subfolders (e.g. `clients` also returns notes under `clients/acme`). Previously it was an exact match. Tool and `category` parameter descriptions clarified.

**[ES]** `write_note` limpia ahora de forma defensiva el bloque de frontmatter o el encabezado H1 duplicado que algunos asistentes incluyen en el contenido, para que todos los clientes produzcan la misma estructura.

**[EN]** `write_note` now defensively strips a duplicated frontmatter block or leading H1 that some assistants include in the content, so all clients produce the same structure.

---

## [1.3.1] — 2026-05-19

### Added

**[ES]** Limpieza automática de carpetas vacías tras `delete_note`, `move_note`, `update_frontmatter` (con cambio de categoría) y `bulk_move`. Si la carpeta origen queda vacía tras la operación, se elimina; sube recursivamente al padre si también queda vacío. Nunca toca `MEMORY_ROOT` ni nada fuera de él. Considera `.DS_Store` residual al evaluar "carpeta vacía".

**[EN]** Automatic cleanup of empty folders after `delete_note`, `move_note`, `update_frontmatter` (with category change) and `bulk_move`. If the source folder ends up empty, it's removed; the cleanup walks up to the parent if it's also empty. Never touches `MEMORY_ROOT` or anything outside it. Considers residual `.DS_Store` files when evaluating emptiness.

---

## [1.3.0] — 2026-05-19

### Added

**[ES]**

Soporte opcional para [Markdown Annotations](https://github.com/iainc/Markdown-Annotations) (spec abierta, originalmente de iA Writer). Al activarlo, cada nota persistida lleva al final un bloque que registra qué autor escribió qué rangos del texto. Permite trazabilidad de autoría entre Claude (escribiendo vía MCP) y el usuario humano (editando en iA Writer u otro editor compatible).

**Opt-in**: la feature está desactivada por defecto. Para activarla, arranca el MCP con la variable de entorno `KB_ENABLE_ANNOTATIONS=1` (acepta también `true`, `yes`, `on`). Sin esa variable, el MCP mantiene el comportamiento de v1.2.0 (sin bloque al final).

Cuando está activado:
- `write_note`, `edit_note`, `append_to_note`, `prepend_to_note`, `update_section`, `insert_after_section`, `move_note`, `rename_wikilink`, `update_frontmatter`, `move_category`, `bulk_move` añaden o actualizan el bloque automáticamente atribuyendo el contenido nuevo a Claude (`&Claude`).
- Cuando iA Writer edita una nota y registra autoría humana (`@nombre`), el MCP preserva esos rangos en las siguientes escrituras (solo regenera lo realmente cambiado, no destruye los rangos humanos).
- `write_note` se vuelve auto-protectivo: si la nota existente tiene autoría humana, falla con un mensaje claro y sugiere usar `edit_note` u otra tool de edición puntual.

**Nuevas herramientas:**

- `read_authorship(name)` — devuelve un resumen compacto de la autoría del cuerpo de una nota: por cada autor, sus rangos (en grapheme indexes relativos al cuerpo), el porcentaje del cuerpo que cubre y un extracto de cada rango.
- `migrate_annotations({ dry_run })` — operación one-shot que añade el bloque a todas las notas existentes que aún no lo tienen, atribuyendo el cuerpo a Claude. Preserva el campo `updated` original de cada nota. Por defecto en modo `dry_run: true` para auditar sin escribir.

`read_note` ahora filtra el bloque del output devuelto (es metadata interna, no contenido relevante). Para consultar la autoría se usa `read_authorship`.

El hash SHA-256 del bloque se trunca a 20 caracteres (la spec permite 20-64; 20 es lo que usa iA Writer). El parser acepta tanto `Annotations:` (inglés) como `Anotaciones:` (formato que escribe iA Writer en archivos en español).

**[EN]**

Optional support for [Markdown Annotations](https://github.com/iainc/Markdown-Annotations) (open spec, originally from iA Writer). When enabled, every persisted note carries a block at the end recording which author wrote which ranges of the text. Enables authorship traceability between Claude (writing via MCP) and the human user (editing in iA Writer or another compatible editor).

**Opt-in**: the feature is disabled by default. To enable it, start the MCP with the environment variable `KB_ENABLE_ANNOTATIONS=1` (also accepts `true`, `yes`, `on`). Without that variable, the MCP keeps v1.2.0 behavior (no block at the end).

When enabled:
- `write_note`, `edit_note`, `append_to_note`, `prepend_to_note`, `update_section`, `insert_after_section`, `move_note`, `rename_wikilink`, `update_frontmatter`, `move_category`, `bulk_move` add or update the block automatically attributing new content to Claude (`&Claude`).
- When iA Writer edits a note and registers human authorship (`@name`), the MCP preserves those ranges in subsequent writes (only regenerates what actually changed, does not destroy human ranges).
- `write_note` becomes self-protective: if the existing note has human authorship, it fails with a clear message suggesting `edit_note` or another point-edit tool.

**New tools:**

- `read_authorship(name)` — returns a compact summary of body authorship: per author, their ranges (grapheme indexes relative to the body), the percentage they cover and a snippet of each range.
- `migrate_annotations({ dry_run })` — one-shot operation that adds the block to all existing notes that don't have one yet, attributing the body to Claude. Preserves each note's original `updated` field. Defaults to `dry_run: true` to audit without writing.

`read_note` now filters the block from the returned output (it's internal metadata, not relevant content). Use `read_authorship` to query authorship.

The block's SHA-256 hash is truncated to 20 characters (the spec allows 20-64; 20 is what iA Writer uses). The parser accepts both `Annotations:` (English) and `Anotaciones:` (the format iA Writer writes in Spanish files).

---

## [1.2.0] — 2026-05-15

### Added

**[ES]**

Esta versión amplía el MCP de 9 a 27 herramientas, agrupadas en cuatro bloques. La motivación es eliminar la sobrecarga de tener que reenviar la nota completa para cualquier cambio, además de cubrir mantenimiento de la bóveda (wikilinks, tags, validación) sin scripts ad hoc.

**Edición puntual (5):**
- `edit_note` — find/replace exacto. Falla por ambigüedad si `old_text` no es único; `replace_all: true` lo fuerza.
- `append_to_note` — añade al final del cuerpo. Si la nota termina en una línea de hashtags `#snake_case`, inserta antes de los hashtags.
- `prepend_to_note` — inserta al principio (tras el h1).
- `update_section` — reemplaza una sección markdown entera por su título de encabezado, conservando el encabezado.
- `insert_after_section` — inserta una nueva sección justo después de otra existente.

**Wikilinks y tags (6):**
- `list_broken_links` — todos los wikilinks rotos de la bóveda agrupados por nota.
- `find_backlinks` — solo backlinks de una nota, sin cargar su contenido.
- `find_orphans` — notas sin backlinks ni outlinks.
- `rename_wikilink` — sustituye globalmente `[[old]]` por `[[new]]` sin tocar archivos.
- `list_tags` — todos los hashtags `#snake_case` del cuerpo con conteo de notas.
- `update_frontmatter` — cambia campos YAML (title, category, tags, created) sin tocar el cuerpo. Si cambia category, mueve el archivo.

**Lecturas económicas (3):**
- `peek_note` — frontmatter + primer párrafo.
- `read_section` — solo una sección markdown por título.
- `read_frontmatter` — solo el YAML.

**Mantenimiento (4):**
- `recently_updated` — notas modificadas en los últimos N días (por defecto 7).
- `move_category` — renombra una carpeta entera y actualiza el `category` de cada nota.
- `validate_note` — auditoría de estructura: frontmatter, "Ver también" / "See also", hashtags, wikilinks rotos.
- `bulk_move` — mueve varias notas a la misma categoría destino en una sola llamada.

**[EN]**

This release expands the MCP from 9 to 27 tools, grouped in four blocks. The motivation is to remove the overhead of re-sending the entire note for every change, plus cover vault maintenance (wikilinks, tags, validation) without ad hoc scripts.

**Targeted editing (5):**
- `edit_note` — exact find/replace. Fails on ambiguity if `old_text` is not unique; `replace_all: true` forces it.
- `append_to_note` — appends at the end of the body. If the note ends with a `#snake_case` hashtag line, inserts before the hashtags.
- `prepend_to_note` — inserts at the beginning (after h1).
- `update_section` — replaces an entire markdown section by its heading text, preserving the heading.
- `insert_after_section` — inserts a new section right after an existing one.

**Wikilinks and tags (6):**
- `list_broken_links` — all broken wikilinks in the vault grouped by note.
- `find_backlinks` — backlinks of a note only, without loading its content.
- `find_orphans` — notes with no backlinks and no outlinks.
- `rename_wikilink` — globally substitute `[[old]]` with `[[new]]` without touching files.
- `list_tags` — all `#snake_case` hashtags from bodies with note counts.
- `update_frontmatter` — change YAML fields (title, category, tags, created) without touching the body. If category changes, the file is moved.

**Cheap reads (3):**
- `peek_note` — frontmatter + first paragraph.
- `read_section` — just one markdown section by heading.
- `read_frontmatter` — just the YAML.

**Maintenance (4):**
- `recently_updated` — notes modified in the last N days (default 7).
- `move_category` — rename an entire folder and update the `category` of each note.
- `validate_note` — structure audit: frontmatter, "See also" / "Ver también", hashtags, broken wikilinks.
- `bulk_move` — move several notes to the same destination category in a single call.

### Notes / Notas

**[ES]**
- Compatibilidad total con v1.1.4: las 9 herramientas existentes mantienen mismos nombres, parámetros y comportamiento.
- Las descripciones de las nuevas herramientas siguen la regla de v1.1.4: incluyen verbos de acción para que el ranker de `tool_search` las priorice ante consultas en lenguaje natural.

**[EN]**
- Fully backward compatible with v1.1.4: the original 9 tools keep their names, parameters and behaviour.
- New tool descriptions follow the v1.1.4 rule: they include action verbs so that the `tool_search` ranker prioritises them on natural-language queries.

---

## [1.1.4] — 2026-05-04

### Changed

**[ES]**
- Ampliadas las descripciones de las cuatro herramientas de escritura (`write_note`, `move_note`, `create_category`, `delete_category`) con más verbos de acción para que el ranker de relevancia de los clientes MCP las priorice ante consultas en lenguaje natural. Antes, herramientas como `tool_search("save note inbox")` podían dejar fuera `write_note` por debajo de las herramientas de lectura, obligando al asistente a pasar por una sintaxis de selección explícita por nombre.
- La descripción del campo `category` de `write_note` ahora menciona explícitamente la convención de carpeta de bandeja para asistentes externos (un agente deposita y otro mueve a su categoría definitiva).

**[EN]**
- Expanded the descriptions of the four write tools (`write_note`, `move_note`, `create_category`, `delete_category`) with more action verbs so that the MCP client's relevance ranker prioritises them on natural-language queries. Previously, queries like `tool_search("save note inbox")` could leave `write_note` outside the top results behind the read tools, forcing the assistant to fall back on explicit selection by name.
- The `category` field description of `write_note` now explicitly mentions the inbox-folder convention for external assistants (one agent drops the note, another moves it to its definitive category).

### Notes / Notas

**[ES]**
- Sin cambios de lógica, schema ni handlers. Solo strings de descripción y número de versión.
- Se salta la versión `1.1.3` deliberadamente: el repo y la instalación personal del autor convergen en `1.1.4` con un único cambio agrupado.

**[EN]**
- No logic, schema or handler changes. Only description strings and version number.
- Version `1.1.3` is skipped on purpose: the repository and the author's personal installation converge on `1.1.4` with a single grouped change.

---

## [1.1.2] — 2026-04-30

### Changed

**[ES]**
- El índice de la bóveda ya no se persiste en disco. `get_index` lo construye en memoria cada vez que se invoca y lo devuelve directamente.
- `regenerateIndex` se ha renombrado a `buildIndex` y ahora devuelve el índice como string en lugar de escribir un archivo.
- `write_note`, `delete_note` y `move_note` ya no escanean toda la bóveda al ejecutarse — son notablemente más rápidos en bóvedas grandes.

**[EN]**
- The vault index is no longer persisted to disk. `get_index` builds it in memory on each call and returns it directly.
- `regenerateIndex` has been renamed to `buildIndex` and now returns the index as a string instead of writing a file.
- `write_note`, `delete_note` and `move_note` no longer scan the whole vault on each call — noticeably faster on large vaults.

### Removed

**[ES]**
- El archivo `INDEX.md` ya no se genera automáticamente en la raíz de la bóveda.
- `INDEX.md` se ha eliminado del conjunto de archivos reservados.
- `INDEX` ya no es un nombre reservado en `read_note` ni en la detección de wikilinks de `write_note`.

**[EN]**
- The `INDEX.md` file is no longer auto-generated in the vault root.
- `INDEX.md` has been removed from the reserved files set.
- `INDEX` is no longer a reserved name in `read_note` or in `write_note`'s wikilink detection.

### Migration / Migración

**[ES]**

Si actualizas desde v1.1.1 y tenías un `INDEX.md` generado en la raíz de tu bóveda, puedes borrarlo manualmente — el servidor ya no lo lee. Si tienes notas con wikilinks `[[INDEX]]`, esos enlaces ahora aparecerán como rotos: sustitúyelos por una llamada a `get_index` o por una nota propia.

No hay otros cambios de comportamiento. Las 9 herramientas siguen aceptando los mismos parámetros y devolviendo los mismos resultados.

**[EN]**

If you upgrade from v1.1.1 and had an `INDEX.md` file generated at the root of your vault, you can delete it manually — the server no longer reads it. If you have notes with `[[INDEX]]` wikilinks, those links will now appear as broken: replace them with a `get_index` call or with a note of your own.

No other behavioral changes. All 9 tools still accept the same parameters and return the same results.

---

## [1.1.1] — 2026-04-14

### Fixed

**[ES]**
- La detección de wikilinks rotos ignora bloques de código e inline code (`stripCode()`).
- `get_index` regenera siempre el índice — soluciona el problema de backlinks en 0.

**[EN]**
- Broken wikilink detection now ignores fenced code blocks and inline code (`stripCode()`).
- `get_index` always regenerates the index — fixes the issue of backlinks showing as 0.

---

## [1.1.0] — 2026-04-14

### Added

**[ES]**
- `search_notes`: búsqueda multi-término con lógica AND.
- `move_note`: actualización automática de wikilinks al renombrar.
- `list_notes`: filtrado por tag con parámetro `tag`.
- Nueva herramienta: `delete_category`.

**[EN]**
- `search_notes`: multi-term search with AND logic.
- `move_note`: automatic wikilink update on rename.
- `list_notes`: filter by tag with the `tag` parameter.
- New tool: `delete_category`.

---

## [1.0.0] — 2026-04-14

### Added

**[ES]**
- Lanzamiento inicial.
- Sistema base construido en Node.js.
- 8 herramientas MCP operativas.
- Configuración del vault vía variable de entorno `MEMORY_PATH`.

**[EN]**
- Initial release.
- Core system built in Node.js.
- 8 MCP tools operational.
- Vault configuration via the `MEMORY_PATH` environment variable.

[2.1.0]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v2.1.0
[2.0.0]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v2.0.0
[1.2.0]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.2.0
[1.1.4]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.1.4
[1.1.2]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.1.2
[1.1.1]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.1.1
[1.1.0]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.1.0
[1.0.0]: https://github.com/jmpdsevilla/BovedIA/releases/tag/v1.0.0
