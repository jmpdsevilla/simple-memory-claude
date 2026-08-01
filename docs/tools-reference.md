# Referencia de herramientas — Las 38 herramientas MCP

Referencia completa de todas las herramientas de BovedIA (v2.7.0).

Las herramientas se agrupan en seis bloques:
1. **CRUD base** (9) — lectura y escritura de notas
2. **Edición dirigida** (5) — retoques incrementales sin reenviar la nota entera
3. **Mantenimiento de wikilinks y tags** (6) — operaciones sobre enlaces y tags de toda la bóveda
4. **Lecturas baratas y mantenimiento** (7) — lecturas parciales y limpieza
5. **Autoría** (2) — solo se exponen con `KB_ENABLE_ANNOTATIONS=1`
6. **Rutina de la bóveda** (6) — salud, programadas, secciones, auditoría, migración y poda de etiquetas
7. **Red de seguridad** (3) — copias de la bóveda y vuelta atrás

Con `KB_TOOLS=core` el servidor expone solo las 15 de uso diario, para clientes con poca ventana de contexto. Por defecto se exponen todas.

---

## Bloque 1 — CRUD base

### write_note

Crea o actualiza una nota (comportamiento de upsert completo: el cuerpo se sobrescribe entero). Para retoques incrementales, usa `edit_note`, `append_to_note`, `prepend_to_note`, `update_section` o `insert_after_section`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `title` | string | sí | Título de la nota |
| `content` | string | sí | Contenido Markdown (sin frontmatter ni h1) |
| `category` | string | sí | Carpeta de destino |
| `tags` | array | no | Etiquetas para el frontmatter YAML. Desaconsejado: la clasificación va como hashtags al final del cuerpo |
| `name` | string | no | Slug existente a actualizar |

### read_note

Lee el contenido completo de una nota más sus backlinks.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota (sin .md) |

### search_notes

Busca notas por texto libre con lógica AND. No distingue mayúsculas ni acentos: "pirámide" y "piramide" devuelven lo mismo. Los resultados se ordenan por relevancia (título y etiquetas por delante del cuerpo) y los extractos van limpios de frontmatter y de metadatos de autoría.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `query` | string | sí | Términos de búsqueda (separados por espacios) |
| `category` | string | no | Acotar a una categoría y sus subcarpetas |
| `limit` | number | no | Máximo de resultados. Por defecto 20 |

### list_notes

Lista notas con sus metadatos, opcionalmente filtradas. El filtro de categoría es recursivo (incluye subcarpetas). El filtro por etiqueta mira tanto los hashtags del cuerpo como los tags del frontmatter YAML.

La raíz de la bóveda se puede pedir como `"."` (la forma que se escribe al guardar) o como `raiz`: son equivalentes, y filtrar por ella no arrastra las notas de las subcarpetas. Vale para todas las herramientas con parámetro `category`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `category` | string | no | Categoría a filtrar (recursiva) |
| `tag` | string | no | Filtro por etiqueta, con o sin `#` |

### get_index

Devuelve el mapa de categorías con el número de notas de cada una. El listado nota a nota es caro en bóvedas grandes, así que se pide aparte con `full: true` y conviene acotarlo con `category`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `category` | string | no | Acotar a una categoría y sus subcarpetas |
| `full` | boolean | no | Listar cada nota con sus tags y backlinks. Por defecto false |

### delete_note

Manda una nota a la papelera (fuera de la bóveda), de donde se puede recuperar. Avisa de los backlinks que la referencian.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `permanent` | boolean | no | Borrar definitivamente, sin pasar por la papelera. Por defecto false |

### create_category

Crea una carpeta nueva.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la categoría |

### move_note

Mueve y/o renombra una nota. Cuando el slug cambia, todos los wikilinks que apuntan a ella se actualizan automáticamente.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug actual de la nota |
| `new_category` | string | no | Categoría de destino |
| `new_title` | string | no | Título nuevo (dispara el renombrado) |

### delete_category

Elimina una carpeta de categoría vacía.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la categoría |

---

## Bloque 2 — Edición dirigida

### edit_note

Buscar/reemplazar dentro del cuerpo de una nota sin reenviar el archivo entero. Falla si `old_text` no aparece o aparece más de una vez (ambiguo), salvo con `replace_all: true`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `old_text` | string | sí | Texto exacto a reemplazar (debe ser único) |
| `new_text` | string | sí | Texto de reemplazo |
| `replace_all` | boolean | no | Reemplaza todas las apariciones. Por defecto false |

**Ejemplo:**
```
edit_note(
  name: "referencia-ejemplo",
  old_text: "clave: valor_viejo",
  new_text: "clave: valor_nuevo"
)
```

### append_to_note

Añade contenido al final del cuerpo. Si la nota termina con una línea de hashtags `#snake_case`, el contenido nuevo se inserta **antes** de los hashtags para que el bloque de tags quede al fondo.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `content` | string | sí | Contenido Markdown a añadir |

### prepend_to_note

Inserta contenido al principio del cuerpo, justo después del título h1 (si lo hay).

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `content` | string | sí | Contenido Markdown a insertar |

### update_section

Reemplaza el contenido entre un encabezado Markdown y el siguiente encabezado de igual o mayor nivel. El encabezado se conserva; solo se reescribe el cuerpo de la sección.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `section_title` | string | sí | Texto exacto del encabezado sin `#` |
| `new_content` | string | sí | Nuevo contenido de la sección (sin encabezado) |

**Ejemplo:**
```
update_section(
  name: "cliente-ejemplo",
  section_title: "Trabajos",
  new_content: "| Trabajo | Estado |\n|---|---|\n| Web | Activo |\n"
)
```

### insert_after_section

Inserta un bloque Markdown nuevo justo después de que termina la sección indicada. El bloque nuevo normalmente lleva su propio encabezado.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `after_section_title` | string | sí | Encabezado tras el cual insertar |
| `new_content` | string | sí | Bloque Markdown nuevo (con su propio encabezado) |

---

## Bloque 3 — Mantenimiento de wikilinks y tags

### list_broken_links

Devuelve todos los wikilinks de la bóveda que apuntan a una nota inexistente, agrupados por nota de origen. Sin parámetros.

### find_backlinks

Devuelve solo los backlinks de una nota, sin cargar su contenido. Más barato que `read_note` cuando solo necesitas los backlinks.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### find_orphans

Lista las notas que no tienen backlinks **ni** wikilinks salientes. Sin parámetros.

### rename_wikilink

Sustituye globalmente un wikilink por otro en todas las notas. No mueve archivos. Usa `move_note` si quieres renombrar la nota real.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `old_slug` | string | sí | Wikilink viejo (sin corchetes) |
| `new_slug` | string | sí | Wikilink nuevo (sin corchetes) |

### list_tags

Devuelve todos los hashtags `#snake_case` encontrados en los cuerpos de las notas, con el número de notas que los usan. Útil para auditar la taxonomía y detectar variantes. Sin parámetros.

### update_frontmatter

Actualiza campos YAML concretos sin tocar el cuerpo. El campo `updated` se refresca siempre a hoy. Si cambia el campo `category`, el archivo se mueve a la carpeta nueva.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `fields` | object | sí | Objeto con `title`, `category`, `tags` (array) y/o `created` |

---

## Bloque 4 — Lecturas baratas y mantenimiento

### peek_note

Devuelve el frontmatter más el primer párrafo del cuerpo. Ahorra tokens cuando solo necesitas verificar una categoría, tag o tema.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### read_section

Devuelve solo una sección Markdown, identificada por su encabezado. Va desde el encabezado hasta el siguiente de igual o mayor nivel.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |
| `section_title` | string | sí | Texto exacto del encabezado sin `#` |

### read_frontmatter

Devuelve solo el frontmatter YAML de una nota.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### recently_updated

Lista las notas cuyo campo `updated` cae dentro de los últimos N días.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `days` | number | no | Días hacia atrás. Por defecto 7 |

### move_category

Renombra o reubica una carpeta de categoría entera con sus notas. Actualiza el campo `category` en el frontmatter de cada nota afectada. Los wikilinks no se tocan (los slugs no cambian).

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Ruta de categoría actual |
| `new_name` | string | sí | Ruta de categoría nueva |

### validate_note

Audita una nota contra las convenciones de la bóveda:
- El frontmatter debe incluir `title`, `category`, `created`, `updated`
- El cuerpo debe terminar con una sección `## Ver también` (también se acepta `## See also`)
- El cuerpo debe incluir al menos un hashtag `#snake_case`
- Los wikilinks deben apuntar a notas existentes

Devuelve un informe con los problemas encontrados.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### bulk_move

Mueve varias notas a la misma categoría de destino en una sola llamada. No renombra — usa `move_note` por nota para renombrar.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `names` | array | sí | Lista de slugs a mover |
| `new_category` | string | sí | Categoría de destino |

---

## Bloque 5 — Autoría (opcional)

Estas dos herramientas solo se exponen cuando el servidor arranca con `KB_ENABLE_ANNOTATIONS=1`. Registran la autoría por rangos según la spec [Markdown Annotations](https://github.com/iainc/Markdown-Annotations).

### read_authorship

Devuelve un resumen compacto de qué autor escribió qué rangos de una nota.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### migrate_annotations

Añade el bloque de autoría a todas las notas existentes de una sola vez (conserva el campo `updated` original). Ejecútala con `dry_run: true` primero para auditar sin escribir.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `dry_run` | boolean | no | Si es true, solo informa de lo que haría sin escribir |

---

## Bloque 6 — Rutina de la bóveda

### due_notes

Devuelve solo las notas programadas cuya fecha ya ha llegado. Lee la línea `> APARECER: AAAA-MM-DD` del principio de cada nota de la carpeta indicada y la compara con hoy. Pensada para la comprobación de arranque de sesión: una sola llamada barata en lugar de abrir las notas una a una.

Con cada tarea vencida devuelve también su fecha de modificación y, si la hay, la **sospecha de que ya esté cerrada**. Una nota programada solo sabe su día, no si su trabajo se hizo, así que se cruzan dos señales que sí lo dicen:

- **Las notas que la tarea enlaza se han modificado en su fecha o después** — alguien ya trabajó en eso, así que la tarea probablemente esté cumplida y sobreviva por olvido.
- **Otra tarea posterior comparte dos o más de esas notas enlazadas** — la ha absorbido, y este registro es el duplicado que sobra.

La regla que sostiene esto es **una tarea, un registro**: si se resuelve, su nota se borra; si se pasa a otro día, se cambia *su* fecha `APARECER`, nunca se crea otra nota. Las herramientas de escritura avisan en la misma línea: al escribir en una nota que una tarea vencida enlaza, y al escribir en la carpeta de programadas.

Cuando hay tareas vencidas, la respuesta trae además el **contexto entero servido de una vez**: el texto completo de cada tarea y el de todas las notas que enlaza (sin repetir ninguna, avisando de los enlaces que no tienen nota detrás). El motivo es que una nota programada es un disparador, no una conclusión: su planteamiento puede haber envejecido o haberse escrito mal, y lo que lo desmiente suele estar justo en las fichas que enlaza. Servirlo aquí evita depender de que alguien se acuerde de ir a buscarlo. Hay un tope de 60.000 caracteres; lo que no cabe se marca para leerlo con `read_note`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `category` | string | no | Carpeta de programadas. Por defecto `programado` |
| `include_upcoming` | boolean | no | Incluir también las futuras, con los días que faltan |

### list_sections

Devuelve el índice de encabezados de una nota (nivel y tamaño en líneas) sin su contenido. Para orientarse en notas largas y leer después solo lo necesario con `read_section`.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Slug de la nota |

### audit_tags

Informe de salud de las etiquetas de la bóveda: hashtags con guión medio, variantes de tipo, etiquetas usadas una sola vez y notas con tags en el frontmatter YAML.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `fix_dashes` | boolean | no | Corregir los hashtags con guión a `snake_case`. Por defecto false (solo informa) |

### vault_health

Parte de salud de toda la bóveda en una sola llamada: wikilinks rotos, notas sin etiquetar o con demasiadas, etiquetas mal formadas, restos de tags en el frontmatter, tipos en uso, huérfanas y notas sin "Ver también". Cada línea indica qué herramienta lo arregla. Pensada para pasarla de vez en cuando y que el desorden no se acumule sin que nadie lo vea.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `max_tags` | number | no | Máximo de etiquetas por nota que se considera correcto. Por defecto 6 |
| `detail` | boolean | no | Listar las notas afectadas, no solo el recuento |

### prune_tags

Poda la taxonomía: fusiona variantes que significan lo mismo y recorta las notas que llevan más etiquetas de la cuenta. Conserva el `#tipo_*`, lo indicado en `keep`, **las etiquetas que aparecen en el título de la nota** (son su identidad: agruparán en cuanto lleguen más notas del mismo tema) y las más usadas; retira primero las de uso único ajenas al título, que no agrupan nada (una categoría con una sola nota no es una categoría) y cuyo contenido sigue estando en el texto de la nota. Preserva la fecha de modificación y la autoría, y no toca las notas que ya cumplen.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `dry_run` | boolean | no | Simular sin escribir. Por defecto true |
| `max` | number | no | Máximo de etiquetas por nota. Por defecto 6 |
| `merge` | object | no | Fusiones `{etiqueta_vieja: etiqueta_nueva}`, sin almohadilla |
| `keep` | array | no | Etiquetas que nunca se retiran |
| `category` | string | no | Acotar a una categoría y sus subcarpetas |

### migrate_yaml_tags

Baja al cuerpo, como hashtags `#snake_case`, las etiquetas que solo estaban en el frontmatter YAML, y deja el frontmatter limpio. No duplica las que ya estaban en el cuerpo, normaliza la forma, conserva `updated` y la autoría, y es idempotente. Pensada para bóvedas que vienen de clasificar en los dos sitios: los editores que agrupan por etiqueta no leen el YAML, así que esas notas figuran como sin clasificar.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `dry_run` | boolean | no | Simular sin escribir. Por defecto true |
| `category` | string | no | Acotar a una categoría y sus subcarpetas |
| `drop` | array | no | Etiquetas que se descartan en vez de bajarse al cuerpo |

---

## Wikilinks

Todas las herramientas que procesan wikilinks usan el formato `[[slug]]`:

```markdown
## Ver también

- [[referencia-ejemplo]] — referencia relacionada
- [[proyecto-ejemplo]] — proyecto que usa esto
```

Reglas:
- Usa siempre el slug de la nota (nombre de archivo kebab-case, sin `.md`)
- Sin rutas: ~~`[[referencias/x]]`~~ → `[[x]]`
- Los bloques de código quedan excluidos de la detección de wikilinks

El motor entiende además estas variantes, y en todas resuelve el destino real (cuentan como backlink y no se marcan como rotas):

| Forma | Destino |
|---|---|
| `[[nota]]` | `nota` |
| `[[nota\|texto visible]]` | `nota` |
| `[[nota#Sección]]` | `nota` |
| `[[#Sección]]` | ninguno: es un ancla dentro de la propia nota |

---

## Hashtags

La convención de la bóveda es poner los hashtags `#snake_case` al final del cuerpo, en una sola línea, separados por espacios:

```markdown
## Ver también

- [[otra-nota]]

#tipo_referencia #nombre_proyecto #autor_claude
```

`list_tags` encuentra todos los hashtags de este formato en cualquier parte del cuerpo. `append_to_note` detecta la línea de hashtags al final e inserta el contenido nuevo **antes** de ella para que la línea se quede al fondo.

---

## Bloque 7 — Red de seguridad

Las operaciones masivas guardan **solas** una copia completa de la bóveda antes de tocar nada. Las copias viven fuera de la bóveda (`KB_BACKUP_ROOT`, por defecto `~/.bovedia`), no se sincronizan con ella y se conservan las 10 últimas (`KB_SNAPSHOT_KEEP`).

### create_snapshot

Crea ahora una copia completa, antes de hacer algo arriesgado.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `reason` | string | no | Motivo, para reconocerla después |

### list_snapshots

Lista las copias disponibles con su fecha, motivo y número de notas. Sin parámetros.

### restore_snapshot

Devuelve las notas al estado de una copia. Antes guarda otra copia del estado actual, así que la restauración también se puede deshacer. Las notas creadas después de la copia no se tocan.

| Parámetro | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre de la copia (de `list_snapshots`) |
| `dry_run` | boolean | no | Simular. Por defecto true |
