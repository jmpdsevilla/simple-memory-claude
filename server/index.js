#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Raíz de la bóveda: la carpeta donde viven tus notas .md.
// Configúrala con la variable de entorno KB_MEMORY_ROOT (o su alias MEMORY_PATH)
// para apuntar a tu carpeta sincronizada en la nube (iCloud, OneDrive, Dropbox,
// Google Drive) o a cualquier carpeta local. Acepta rutas con ~ y relativas.
// Si no se define ninguna, usa ~/Documents/bovedia por defecto.
const MEMORY_ROOT = (process.env.KB_MEMORY_ROOT || process.env.MEMORY_PATH)
  ? path.resolve((process.env.KB_MEMORY_ROOT || process.env.MEMORY_PATH).replace(/^~/, os.homedir()))
  : path.join(os.homedir(), 'Documents', 'bovedia');

// ─── Estructura de la bóveda ────────────────────────────────────────────────
// La estructura de carpetas es libre: crea las categorías que tu trabajo pida.
// El vault-example/ de este repo trae una estructura de referencia lista para
// usar: el router "Inicio", la pirámide, el alma, y carpetas para proyectos,
// clientes, conocimiento y referencias.

// Archivos reservados que no se tratan como notas
const RESERVED = new Set(['HOME.md']);

// Autor IA registrado en el bloque Markdown Annotations (spec iainc/Markdown-Annotations v0.2).
// `&` indica autoría de IA, `@` se reserva para humanos, `*` para referencias.
const CLAUDE_AUTHOR = { prefix: '&', name: process.env.KB_AUTHOR_NAME || 'Claude', identifier: process.env.KB_AUTHOR_EMAIL || 'noreply@anthropic.com' };

// Feature flag: el bloque Markdown Annotations solo se genera si el usuario
// lo activa explícitamente con la variable de entorno KB_ENABLE_ANNOTATIONS=1
// (o "true"). Por defecto está desactivado para no añadir contenido extra al
// final de las notas en editores que no soporten la spec (la mayoría).
// Quien use iA Writer u otro editor compatible con Markdown Annotations puede
// activarlo y obtiene la trazabilidad de autoría completa.
const ANNOTATIONS_ENABLED = (() => {
  const v = (process.env.KB_ENABLE_ANNOTATIONS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

// ─── Markdown Annotations: utilidades de graphemes ─────────────────────────

// La spec exige offsets en grapheme cluster indexes para que las anotaciones
// sobrevivan a cambios de codificación y a emojis/secuencias compuestas.
const _graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// ─── Normalización Unicode (NFC) ───────────────────────────────────────────
// macOS/iCloud y algunos editores (iA Writer) pueden guardar texto en forma
// DESCOMPUESTA (NFC vs NFD): "Versión" como "Versio" + tilde combinante. Si el
// archivo está en NFD y el texto que llega de la herramienta en NFC (o al revés),
// las comparaciones literales (split/replace/includes) fallan con "no se encontró
// el texto" aunque visualmente sean idénticos. Para evitarlo, normalizamos a NFC
// en las dos fronteras: lo que se lee de disco y lo que entra como argumento.
const nfc = (s) => (typeof s === 'string' ? s.normalize('NFC') : s);

// Lee un archivo de nota de disco normalizado a NFC. Único punto de lectura.
function readNoteFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').normalize('NFC');
}

// Normaliza a NFC todos los valores de texto de los argumentos de una tool
// (strings y arrays de strings). Idempotente y seguro: NFC es la forma canónica.
function normalizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === 'string') args[k] = nfc(v);
    else if (Array.isArray(v)) args[k] = v.map((x) => (typeof x === 'string' ? nfc(x) : x));
  }
  return args;
}

function countGraphemes(text) {
  let count = 0;
  for (const _ of _graphemeSegmenter.segment(text)) count++;
  return count;
}

// Convierte un offset en UTF-16 code units a offset en graphemes.
function utf16PosToGraphemePos(text, utf16Pos) {
  let g = 0;
  for (const seg of _graphemeSegmenter.segment(text)) {
    if (seg.index >= utf16Pos) return g;
    g++;
  }
  return g;
}

// Calcula el "diff" entre dos textos en términos de graphemes: el segmento del
// cuerpo viejo que cambia (editStart..editStart+oldLength) y la longitud del
// segmento nuevo que lo reemplaza. Es la forma robusta de aplicar applyEditToAuthors
// sin tener que calcular manualmente los offsets de separadores/whitespace que
// añade cada tool.
function computeBodyDiff(oldBody, newBody) {
  const oldGs = [];
  for (const s of _graphemeSegmenter.segment(oldBody)) oldGs.push(s.segment);
  const newGs = [];
  for (const s of _graphemeSegmenter.segment(newBody)) newGs.push(s.segment);

  let prefix = 0;
  const minLen = Math.min(oldGs.length, newGs.length);
  while (prefix < minLen && oldGs[prefix] === newGs[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldGs.length - prefix &&
    suffix < newGs.length - prefix &&
    oldGs[oldGs.length - 1 - suffix] === newGs[newGs.length - 1 - suffix]
  ) suffix++;

  return {
    editStart: prefix,
    oldLength: oldGs.length - prefix - suffix,
    newLength: newGs.length - prefix - suffix,
  };
}

// Extrae el slice de un texto entre dos posiciones expresadas en graphemes.
function graphemeSlice(text, startG, endG) {
  let g = 0;
  let startIdx = startG === 0 ? 0 : -1;
  let endIdx = text.length;
  for (const seg of _graphemeSegmenter.segment(text)) {
    if (g === startG) startIdx = seg.index;
    if (g === endG) { endIdx = seg.index; break; }
    g++;
  }
  if (startIdx === -1) return '';
  return text.slice(startIdx, endIdx);
}

// ─── Markdown Annotations: parser ──────────────────────────────────────────

// Parsea un bloque de anotaciones crudo y devuelve { hashRange, hash, authors }
// donde authors es un array de { prefix, name, identifier, ranges }. Cada rango
// es { start, length } en grapheme indexes RELATIVOS AL ARCHIVO COMPLETO.
// Acepta tanto `Annotations:` (inglés) como `Anotaciones:` (español, formato que
// iA Writer escribe en archivos en español). Tolera trailing whitespace (dos
// espacios al final de línea, convención de la spec).
function parseAnnotationBlock(blockText) {
  // blockText empieza con `---\n` y acaba con `...\n` (o sin newline final).
  const lines = blockText.split('\n').map((l) => l.replace(/\s+$/, ''));
  // Buscar la línea de hash (primera que matchee Annotations o Anotaciones)
  const hashLineIdx = lines.findIndex((l) => /^(?:Annotations|Anotaciones):/.test(l));
  if (hashLineIdx === -1) return null;
  const hashMatch = lines[hashLineIdx].match(/^(?:Annotations|Anotaciones):\s*(\d+)(?:,(\d+))?\s+SHA-256\s+([a-f0-9]+)/);
  if (!hashMatch) return null;
  const hashRange = { start: parseInt(hashMatch[1], 10), length: hashMatch[2] ? parseInt(hashMatch[2], 10) : 1 };
  const hash = hashMatch[3];

  const authors = [];
  for (let i = hashLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '...' || line === '') continue;
    // Formato: <prefix><name>[ <identifier>]: <range> [<range> ...]
    // prefix: & @ *
    const m = line.match(/^([&@*])\s*([^<:]+?)(?:\s*<([^>]+)>)?\s*:\s*(.+)$/);
    if (!m) continue;
    const prefix = m[1];
    const name = m[2].trim();
    const identifier = m[3] ? m[3].trim() : null;
    const rangesStr = m[4].trim();
    const ranges = rangesStr.split(/\s+/).map((r) => {
      const [s, l] = r.split(',');
      return { start: parseInt(s, 10), length: l ? parseInt(l, 10) : 1 };
    }).filter((r) => Number.isFinite(r.start) && Number.isFinite(r.length));
    if (ranges.length) authors.push({ prefix, name, identifier, ranges });
  }
  return { hashRange, hash, authors };
}

// Detecta si un cuerpo termina en un bloque Markdown Annotations y lo separa.
// Devuelve { cleanBody, blockText } — blockText es el bloque crudo o null si no lo hay.
// El bloque puede empezar con "Annotations:" (inglés) o "Anotaciones:" (español, iA Writer
// localizado). El cierre es la línea `...`.
function stripAnnotationBlock(body) {
  const match = body.match(/\n+---\s*\n(?:Annotations|Anotaciones):[\s\S]*?\n\.\.\.\s*\n?$/);
  if (!match) return { cleanBody: body, blockText: null };
  // El blockText debe incluir desde el primer `---` hasta `...\n` final
  const blockStart = body.indexOf('---', match.index);
  return { cleanBody: body.slice(0, match.index), blockText: body.slice(blockStart) };
}

// ─── Markdown Annotations: manipulación de rangos ──────────────────────────

// Los rangos del bloque están en offsets RELATIVOS AL ARCHIVO (incluyen frontmatter).
// Internamente trabajamos con rangos RELATIVOS AL CUERPO para que las operaciones
// de edición no se vean afectadas por el tamaño del frontmatter.

// Convierte rangos archivo-relativos a cuerpo-relativos.
// Descarta rangos que caen completamente dentro del frontmatter.
// Recorta rangos que cruzan la frontera frontmatter/cuerpo.
function toBodyRanges(fileRanges, bodyOffset) {
  const out = [];
  for (const r of fileRanges) {
    const start = r.start - bodyOffset;
    const end = start + r.length;
    if (end <= 0) continue;          // rango entero en el frontmatter, descartar
    const clamped = { start: Math.max(0, start), length: end - Math.max(0, start) };
    if (clamped.length > 0) out.push(clamped);
  }
  return out;
}

// Convierte rangos cuerpo-relativos a archivo-relativos.
function toFileRanges(bodyRanges, bodyOffset) {
  return bodyRanges.map((r) => ({ start: r.start + bodyOffset, length: r.length }));
}

// Desplaza todos los rangos cuyo inicio sea >= fromOffset por `delta`.
// Si fromOffset cae DENTRO de un rango existente, ese rango se parte:
// la parte anterior queda igual, la parte posterior se desplaza.
function shiftRangesAfter(ranges, fromOffset, delta) {
  const out = [];
  for (const r of ranges) {
    const end = r.start + r.length;
    if (end <= fromOffset) {
      // Rango entero antes del punto: sin cambio
      out.push({ ...r });
    } else if (r.start >= fromOffset) {
      // Rango entero a partir del punto: desplazar
      out.push({ start: r.start + delta, length: r.length });
    } else {
      // Rango cruza el punto: dividir
      const beforeLen = fromOffset - r.start;
      const afterLen = end - fromOffset;
      if (beforeLen > 0) out.push({ start: r.start, length: beforeLen });
      if (afterLen > 0) out.push({ start: fromOffset + delta, length: afterLen });
    }
  }
  return out;
}

// Aplica un edit a una lista de rangos: el segmento [editStart, editStart+oldLength)
// se reemplaza por contenido de longitud `newLength`. Devuelve los rangos actualizados,
// SIN incluir el rango nuevo de la inserción (eso lo gestiona el llamador).
function clearRangeSegment(ranges, editStart, oldLength) {
  const editEnd = editStart + oldLength;
  const out = [];
  for (const r of ranges) {
    const rEnd = r.start + r.length;
    if (rEnd <= editStart) {
      // Rango entero antes del edit
      out.push({ ...r });
    } else if (r.start >= editEnd) {
      // Rango entero después del edit
      out.push({ ...r });
    } else {
      // Rango cruza o se solapa con el edit: recortar
      if (r.start < editStart) {
        out.push({ start: r.start, length: editStart - r.start });
      }
      if (rEnd > editEnd) {
        out.push({ start: editEnd, length: rEnd - editEnd });
      }
    }
  }
  return out;
}

// Helpers a nivel de "autores con rangos" (no rangos sueltos).

function shiftAuthorsRangesAfter(authors, fromOffset, delta) {
  return authors
    .map((a) => ({ ...a, ranges: shiftRangesAfter(a.ranges, fromOffset, delta) }))
    .filter((a) => a.ranges.length > 0);
}

function clearAuthorsSegment(authors, editStart, oldLength) {
  return authors
    .map((a) => ({ ...a, ranges: clearRangeSegment(a.ranges, editStart, oldLength) }))
    .filter((a) => a.ranges.length > 0);
}

// Devuelve el autor que cubre completamente el segmento [start, start+length).
// Si el segmento está cubierto por exactamente UN autor, lo devuelve; si lo cruzan
// varios autores o ninguno, devuelve null.
function uniqueAuthorOfSegment(authors, segStart, segLength) {
  const segEnd = segStart + segLength;
  const covering = authors.filter((a) =>
    a.ranges.some((r) => r.start < segEnd && r.start + r.length > segStart),
  );
  return covering.length === 1 ? covering[0] : null;
}

// Aplica un edit completo: borra el segmento viejo, desplaza posteriores,
// y añade un rango nuevo atribuido a `newAuthor` cubriendo el contenido nuevo.
function applyEditToAuthors(authors, editStart, oldLength, newLength, newAuthor = CLAUDE_AUTHOR) {
  const delta = newLength - oldLength;
  // 1) Limpiar el segmento editado
  let next = clearAuthorsSegment(authors, editStart, oldLength);
  // 2) Desplazar lo que queda >= editStart + oldLength por delta
  next = next.map((a) => ({
    ...a,
    ranges: a.ranges.map((r) =>
      r.start >= editStart + oldLength ? { start: r.start + delta, length: r.length } : r,
    ),
  }));
  // 3) Añadir el rango nuevo para el contenido insertado
  if (newLength > 0) {
    next = addRange(next, newAuthor, { start: editStart, length: newLength });
  }
  return mergeAdjacentRanges(next);
}

// Añade un rango a un autor (lo crea si no existe).
function addRange(authors, author, range) {
  if (range.length <= 0) return authors;
  const idx = authors.findIndex((a) => a.prefix === author.prefix && a.name === author.name && (a.identifier || null) === (author.identifier || null));
  if (idx === -1) {
    return [...authors, { ...author, ranges: [range] }];
  }
  return authors.map((a, i) => (i === idx ? { ...a, ranges: [...a.ranges, range] } : a));
}

// Fusiona rangos contiguos del mismo autor y ordena por inicio.
function mergeAdjacentRanges(authors) {
  return authors.map((a) => {
    const sorted = [...a.ranges].sort((x, y) => x.start - y.start);
    const merged = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last && last.start + last.length === r.start) {
        last.length += r.length;
      } else {
        merged.push({ ...r });
      }
    }
    return { ...a, ranges: merged };
  });
}

// ─── Markdown Annotations: generación del bloque ───────────────────────────

// Genera el bloque Markdown Annotations completo.
// `text` = todo el contenido del archivo ANTES del bloque.
// `authors` = array de { prefix, name, identifier, ranges } donde los rangos están
//   en grapheme offsets RELATIVOS AL ARCHIVO. El hash cubre todo el `text`.
// Hash SHA-256 truncado a 20 caracteres (convención que usa iA Writer).
// Cada línea de datos termina con dos espacios + newline (convención de la spec).
function computeAnnotationBlock(text, authors) {
  const totalLength = countGraphemes(text);
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 20);
  let block = `---\nAnnotations: 0,${totalLength} SHA-256 ${hash}  \n`;
  for (const a of authors) {
    if (!a.ranges.length) continue;
    const id = a.identifier ? ` <${a.identifier}>` : '';
    const rs = a.ranges.map((r) => (r.length === 1 ? `${r.start}` : `${r.start},${r.length}`)).join(' ');
    block += `${a.prefix}${a.name}${id}: ${rs}  \n`;
  }
  block += `...\n`;
  return block;
}

// ─── Utilidades ────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

// Convierte un título en nombre de archivo kebab-case sin tildes ni ñ
function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ñÑ]/g, 'n')
    .replace(/[^a-z0-9\s-]/gi, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

// Elimina bloques de código e inline code para no detectar wikilinks dentro de ejemplos de sintaxis
function stripCode(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');
}

// ─── Seguridad de rutas ────────────────────────────────────────────────────
// Toda ruta construida a partir de datos que llegan en los argumentos de una
// tool (category, new_category, nombres de carpeta) tiene que quedar DENTRO de
// MEMORY_ROOT. Sin esta comprobación, un valor como "../../otra-carpeta" haría
// que el servidor escribiera o borrara fuera de la bóveda. Lanza PathError, que
// el handler central convierte en un error legible sin tumbar el servidor.
class PathError extends Error {}

function safeJoin(...segments) {
  const root = path.resolve(MEMORY_ROOT);
  const raw = segments.filter((s) => s !== undefined && s !== null && s !== '').join('/');
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathError(`Ruta fuera de la bóveda: "${raw}". Las notas y carpetas solo pueden vivir dentro de la raíz configurada.`);
  }
  return target;
}

// Normaliza una categoría recibida como argumento: quita barras sobrantes y
// comprueba que no se escapa de la raíz. Devuelve la categoría en forma canónica
// (con "/" como separador), lista para guardar en el frontmatter.
function safeCategory(category) {
  if (!category) return '';
  safeJoin(category); // valida (lanza PathError si escapa)
  return String(category).replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

// ─── Texto: comparación insensible a acentos ───────────────────────────────
// La bóveda está escrita en español: "pirámide" y "piramide" tienen que
// encontrarse la una a la otra. Se compara siempre sobre la forma sin
// diacríticos y en minúsculas.
function deaccent(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function foldText(text) {
  return deaccent(String(text)).toLowerCase();
}

// ─── Wikilinks ─────────────────────────────────────────────────────────────
// Devuelve el slug de nota al que apunta un wikilink, o null si el enlace no
// apunta a una nota (ancla interna del tipo [[#Sección]]).
// Soporta las tres formas que aparecen en la práctica:
//   [[slug]]            → slug
//   [[slug|alias]]      → slug   (el alias es solo texto visible)
//   [[slug#Sección]]    → slug   (enlace a una sección de otra nota)
//   [[#Sección]]        → null   (ancla dentro de la propia nota)
function wikilinkTarget(raw) {
  const target = String(raw).split('|')[0].trim();
  if (!target || target.startsWith('#')) return null;
  const withoutAnchor = target.split('#')[0].trim();
  return withoutAnchor || null;
}

// Extrae los destinos de nota de un contenido (ya sin bloques de código).
function extractLinkTargets(content) {
  return [...stripCode(content).matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((m) => wikilinkTarget(m[1]))
    .filter(Boolean);
}

// Parsea el frontmatter YAML básico de una nota
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: match[2] };
}

// Construye el bloque frontmatter.
// El campo `tags` solo se escribe si la nota tiene alguno: una bóveda que
// clasifica con hashtags en el cuerpo no necesita arrastrar un `tags: []` vacío
// en cada archivo. Si la nota trae tags, se conservan tal cual.
function buildFrontmatter({ title, category, tags, created, updated }) {
  const lista = Array.isArray(tags) ? tags.filter((t) => String(t).trim()) : (tags ? [tags] : []);
  const tagsLine = lista.length ? `tags: [${lista.join(', ')}]\n` : '';
  return `---\ntitle: ${title}\ncategory: ${category}\n${tagsLine}created: ${created}\nupdated: ${updated}\n---\n`;
}

// Busca una nota por nombre en todas las subcarpetas.
// Primero consulta el índice en memoria (instantáneo); solo si no aparece ahí
// recorre el disco, que es el caso de notas creadas fuera del MCP hace menos de
// lo que dura la caché.
function findNote(name) {
  const slug = slugify(name);

  try {
    const cached = resolveNotePath(name);
    if (cached && fs.existsSync(cached)) return cached;
  } catch {
    // Si el índice no se puede construir, se sigue por el camino de disco.
  }

  function searchDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const found = searchDir(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED.has(entry.name)) {
        const base = entry.name.replace('.md', '');
        if (base === name || base === slug) return fullPath;
      }
    }
    return null;
  }

  return searchDir(MEMORY_ROOT);
}

// Devuelve todas las notas con sus metadatos
function getAllNotes() {
  const notes = [];

  function scanDir(dir, category) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const childCategory = category ? `${category}/${entry.name}` : entry.name;
        scanDir(fullPath, childCategory);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED.has(entry.name)) {
        try {
          const content = readNoteFile(fullPath);
          const { frontmatter, body } = parseFrontmatter(content);
          // `wikilinks` guarda los DESTINOS ya resueltos (sin alias ni anclas):
          // es lo que consultan backlinks, huérfanas y enlaces rotos.
          const wikilinks = extractLinkTargets(content);
          notes.push({
            name: entry.name.replace('.md', ''),
            path: fullPath,
            category: category || 'raiz',
            frontmatter,
            wikilinks,
            // El contenido se guarda en el índice para que search_notes no tenga
            // que releer la bóveda entera en cada búsqueda. La caché ya lee cada
            // archivo aquí, así que no añade E/S: solo memoria (unos pocos MB).
            // `body` va sin el bloque de anotaciones, que es metadata interna y
            // no debe aparecer en búsquedas ni en extractos.
            content,
            body: stripAnnotationBlock(body).cleanBody.replace(/^\s+/, '').replace(/\s+$/, ''),
          });
        } catch {
          // Ignorar archivos ilegibles
        }
      }
    }
  }

  scanDir(MEMORY_ROOT, '');
  return notes;
}

// ─── Caché del índice de notas (rendimiento) ────────────────────────────────
// getAllNotes() escanea y parsea todos los archivos del disco; es caro y se
// invoca en cada handler de lectura. Cacheamos el resultado en memoria.
// Invalidación por dos vías complementarias:
//  - Por escritura: los handlers de escritura llaman invalidateCache() al
//    terminar con éxito (la más fiable: refleja cambios del propio MCP al instante).
//  - Por TTL corto (20 s): el usuario edita notas directamente en iA Writer,
//    fuera del MCP. Sin TTL, esas ediciones externas no se verían hasta reiniciar
//    el server. Con el TTL, la caché caduca sola y se reconstruye desde disco,
//    recogiendo los cambios externos en como mucho 20 segundos.
const CACHE_TTL_MS = 20000;
let _cache = null;
let _cacheTimestamp = 0;
function getCachedAllNotes() {
  if (_cache && Date.now() - _cacheTimestamp < CACHE_TTL_MS) return _cache;
  _cache = getAllNotes();
  _cacheTimestamp = Date.now();
  return _cache;
}
function invalidateCache() {
  _cache = null;
  _maps = null;
}

// ─── Mapas de resolución (rendimiento) ──────────────────────────────────────
// Resolver un nombre de nota a su archivo se hacía escaneando el disco entero en
// cada llamada (findNote). Con 340 notas y 1.767 wikilinks eso son ~90.000
// lecturas de directorio para listar los enlaces rotos. Estos mapas resuelven lo
// mismo en memoria, a partir del índice que ya está cacheado.
let _maps = null;
function getMaps() {
  const notes = getCachedAllNotes();
  if (_maps && _maps.notes === notes) return _maps;

  const byName = new Map();   // slug exacto → nota
  const bySlug = new Map();   // slug normalizado → nota
  for (const note of notes) {
    byName.set(note.name, note);
    const s = slugify(note.name);
    if (!bySlug.has(s)) bySlug.set(s, note);
  }

  // Backlinks en UNA pasada (antes era O(N²): por cada nota se recorrían todas).
  const backlinks = new Map();
  for (const note of notes) {
    for (const link of new Set(note.wikilinks)) {
      const target = byName.get(link) || bySlug.get(slugify(link));
      if (!target) continue;
      if (!backlinks.has(target.name)) backlinks.set(target.name, new Set());
      backlinks.get(target.name).add(note.name);
    }
  }

  _maps = { notes, byName, bySlug, backlinks };
  return _maps;
}

// Resuelve un nombre de nota contra el índice en memoria. Devuelve la ruta del
// archivo o null. Equivalente a findNote() pero sin tocar disco.
function resolveNotePath(name) {
  if (!name) return null;
  const { byName, bySlug } = getMaps();
  const hit = byName.get(name) || bySlug.get(slugify(name));
  return hit ? hit.path : null;
}

// ¿Existe la nota a la que apunta este enlace? Se usa para detectar rotos.
function noteExists(name) {
  if (!name) return false;
  const { byName, bySlug } = getMaps();
  return byName.has(name) || bySlug.has(slugify(name));
}

// Devuelve los nombres de notas que enlazan a targetName
function getBacklinks(targetName, allNotes) {
  // Camino rápido: el índice cacheado ya tiene los backlinks precalculados.
  const maps = getMaps();
  if (!allNotes || allNotes === maps.notes) {
    const target = maps.byName.get(targetName) || maps.bySlug.get(slugify(targetName));
    const key = target ? target.name : targetName;
    return [...(maps.backlinks.get(key) || [])];
  }
  // Camino compatible: si el llamador pasa su propia lista (p. ej. recién leída
  // de disco antes de borrar una nota), se calcula sobre ella.
  const targetSlug = slugify(targetName);
  return allNotes
    .filter((note) =>
      note.wikilinks.some((link) => link === targetName || slugify(link) === targetSlug)
    )
    .map((note) => note.name);
}

// Construye el índice de la bóveda en memoria y lo devuelve como string.
// - modo `full: false` (por defecto): solo el árbol de categorías con el número
//   de notas de cada una. Es un mapa de orientación de unos cientos de tokens.
// - modo `full: true`: además, cada nota con sus tags y su número de backlinks.
//   En una bóveda de 340 notas eso son ~11.000 tokens, así que se pide a
//   propósito y, preferiblemente, acotado con `category`.
function buildIndex(allNotes, { full = false, category = null } = {}) {
  const notes = category
    ? allNotes.filter((n) => n.category === category || n.category.startsWith(category + '/'))
    : allNotes;

  const byCategory = {};
  for (const note of notes) {
    const cat = note.category || 'sin-categoria';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(note);
  }

  const { backlinks } = getMaps();
  const scope = category ? ` — categoría "${category}"` : '';
  let index = `# Base de Conocimiento — Índice${scope}\n\nÚltima actualización: ${today()}\n\n`;
  index += `> ${notes.length} ${notes.length === 1 ? 'nota' : 'notas'} en ${Object.keys(byCategory).length} categoría(s)\n\n`;

  for (const [cat, catNotes] of Object.entries(byCategory).sort()) {
    index += `## ${cat} (${catNotes.length} ${catNotes.length === 1 ? 'nota' : 'notas'})\n`;
    if (full) {
      for (const note of catNotes.sort((a, b) => a.name.localeCompare(b.name))) {
        const tags = Array.isArray(note.frontmatter.tags)
          ? note.frontmatter.tags.join(', ')
          : note.frontmatter.tags || '';
        const bl = (backlinks.get(note.name) || new Set()).size;
        index += `- [[${note.name}]] — tags: ${tags || 'sin tags'} — ${bl} backlinks\n`;
      }
    }
    index += '\n';
  }

  if (!full) {
    index += '_Solo el árbol de categorías. Para ver las notas de una categoría: `list_notes(category)`; para el listado completo: `get_index(full: true)`._\n';
  }

  return index;
}

// ─── Índice de secciones de una nota ────────────────────────────────────────
// Devuelve los encabezados markdown del cuerpo (nivel, título y nº de líneas de
// la sección), ignorando los que estén dentro de bloques de código.
function outlineOf(body) {
  const lines = body.split('\n');
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: i });
  }
  return headings.map((h, idx) => {
    const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
    const end = next ? next.line : lines.length;
    return { ...h, lines: end - h.line };
  });
}

// ─── Notas programadas ──────────────────────────────────────────────────────
// Convención de la bóveda: una nota con fecha empieza por una línea
// `> APARECER: AAAA-MM-DD` (admite negritas y texto detrás). Devuelve la fecha
// como string ISO o null si la nota no la lleva.
function parseAparecer(body) {
  const m = body.match(/APARECER:?\**\s*:?\s*\**\s*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

// Extrae hashtags `#snake_case` del cuerpo (excluye bloques de código)
function extractHashtags(body) {
  const stripped = stripCode(body);
  const matches = [...stripped.matchAll(/(?:^|\s)(#[a-z][a-z0-9_]*)/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Extrae hashtags MAL FORMADOS: los que llevan guión medio (`#nano-banana`).
// Importan porque los editores que agrupan por hashtag (iA Writer) no los
// reconocen, y porque el extractor oficial los trunca en el guión, con lo que
// `#santa-marta-crea` acaba contando como la etiqueta `#santa`. Sirven para
// auditar la taxonomía y corregirlos a snake_case.
function extractDashedHashtags(body) {
  const stripped = stripCode(body);
  const matches = [...stripped.matchAll(/(?:^|\s)(#[a-z][a-z0-9_]*(?:-[a-z0-9_]+)+)/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Lleva una etiqueta a la forma canónica de la bóveda: `snake_case`, sin `#`,
// sin acentos ni ñ, sin mayúsculas. Es la forma que los editores agrupan y la
// que el extractor de hashtags reconoce entera.
//   "#Nano-Banana" → "nano_banana" · "Diseño Web" → "diseno_web"
function normalizeTagName(tag) {
  return String(tag)
    .trim()
    .replace(/^#/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ñÑ]/g, 'n')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Todas las etiquetas de una nota: hashtags del cuerpo + tags del frontmatter
// YAML (que la doctrina jubiló pero que muchas notas antiguas conservan). Se
// devuelven normalizadas y sin `#` para poder filtrar por cualquiera de las dos.
function allTagsOf(note) {
  const out = new Set();
  const body = note.body !== undefined ? note.body : '';
  for (const h of extractHashtags(body)) out.add(h.slice(1));
  for (const h of extractDashedHashtags(body)) out.add(normalizeTagName(h));
  const yaml = note.frontmatter?.tags;
  const list = Array.isArray(yaml) ? yaml : (yaml ? [yaml] : []);
  for (const t of list) {
    const clean = normalizeTagName(t);
    if (clean) out.add(clean);
  }
  return out;
}

// Separa el cuerpo del bloque final de hashtags y/o footer de backlinks añadido por read_note.
// Devuelve { mainBody, trailing } donde trailing puede contener hashtags + backlinks.
function splitBodyAndTrailing(body) {
  const lines = body.split('\n');
  // Localizar la última línea no vacía
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx--;

  // Buscar hacia atrás una línea de hashtags al final del cuerpo
  // (formato: línea que solo contiene tokens #snake_case separados por espacios)
  let hashtagLine = -1;
  for (let i = lastIdx; i >= 0 && i >= lastIdx - 4; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (/^(#[a-z][a-z0-9_]*)(\s+#[a-z][a-z0-9_]*)*\s*$/.test(trimmed)) {
      hashtagLine = i;
      break;
    }
    // Si encuentra otro contenido antes, no hay línea de hashtags identificable
    break;
  }

  if (hashtagLine === -1) {
    return { mainBody: body, trailing: '' };
  }

  // Eliminar separadores `---` justo antes del hashtag si están aislados
  let cutIdx = hashtagLine;
  let probe = cutIdx - 1;
  while (probe >= 0 && lines[probe].trim() === '') probe--;
  // No tocamos los `---`: que sigan en mainBody si existen, así el append queda antes.
  const mainBody = lines.slice(0, cutIdx).join('\n').replace(/\s+$/, '');
  const trailing = lines.slice(cutIdx).join('\n');
  return { mainBody, trailing };
}

// Extrae los autores del cuerpo a partir del contenido crudo del archivo.
// Devuelve un array de { prefix, name, identifier, ranges } con rangos CUERPO-RELATIVOS.
// Array vacío si no hay bloque de anotaciones, si el bloque es inválido,
// o si la feature está desactivada.
function extractBodyAuthorsFromRaw(rawContent) {
  if (!ANNOTATIONS_ENABLED) return [];
  const { body: rawBody } = parseFrontmatter(rawContent);
  const { blockText } = stripAnnotationBlock(rawBody);
  if (!blockText) return [];
  const parsed = parseAnnotationBlock(blockText);
  if (!parsed) return [];
  // Calcular el offset (en graphemes) del inicio del cuerpo limpio dentro del archivo.
  const fmEndUtf16 = rawContent.indexOf('---\n', 4) + 4;
  const rawBodyLeadingWs = rawBody.match(/^\s*/)[0];
  const bodyStartUtf16 = fmEndUtf16 + rawBodyLeadingWs.length;
  const bodyOffsetGraphemes = countGraphemes(rawContent.slice(0, bodyStartUtf16));
  return parsed.authors
    .map((a) => ({ ...a, ranges: toBodyRanges(a.ranges, bodyOffsetGraphemes) }))
    .filter((a) => a.ranges.length > 0);
}

// Tras borrar o mover una nota, comprueba si la carpeta origen ha quedado vacía
// y, en ese caso, la elimina. Sube recursivamente: si el padre también queda
// vacío, lo elimina también. Nunca toca MEMORY_ROOT ni nada fuera de él.
function cleanupEmptyAncestors(dir) {
  try {
    const root = path.resolve(MEMORY_ROOT);
    let current = path.resolve(dir);
    while (current.startsWith(root + path.sep) && current !== root) {
      let entries;
      try { entries = fs.readdirSync(current); } catch { return; }
      // Ignorar archivos ocultos típicos de macOS (.DS_Store) al evaluar vacío
      const visible = entries.filter((e) => e !== '.DS_Store');
      if (visible.length > 0) return;
      // Borrar .DS_Store residual si lo hubiera y luego la carpeta
      for (const e of entries) {
        try { fs.unlinkSync(path.join(current, e)); } catch {}
      }
      try { fs.rmdirSync(current); } catch { return; }
      current = path.dirname(current);
    }
  } catch {
    // Cualquier error silencioso: la limpieza no debe romper la operación principal
  }
}

// Lee una nota desde disco y devuelve { filePath, content, frontmatter, body, bodyAuthors }.
// - `body`: cuerpo sin frontmatter, sin bloque Markdown Annotations, sin whitespace
//   al inicio ni al final (trimmed). Los offsets de bodyAuthors están alineados con
//   este `body` exacto.
// - `bodyAuthors`: autores con rangos CUERPO-RELATIVOS (vacío si no hay bloque).
// - `content`: archivo completo tal cual está en disco.
function loadNote(name) {
  const reservedNames = { HOME: 'HOME.md' };
  const reservedFile = reservedNames[name?.toUpperCase?.()];
  const filePath = reservedFile
    ? path.join(MEMORY_ROOT, reservedFile)
    : findNote(name);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const content = readNoteFile(filePath);
  const { frontmatter, body: rawBody } = parseFrontmatter(content);
  const { cleanBody } = stripAnnotationBlock(rawBody);
  const body = cleanBody.replace(/^\s+/, '').replace(/\s+$/, '');
  const bodyAuthors = extractBodyAuthorsFromRaw(content);
  return { filePath, content, frontmatter, body, bodyAuthors };
}

// Persiste una nota a disco. Punto único de escritura para toda escritura del MCP.
// - Renueva el campo `updated` del frontmatter a hoy, salvo que se pase
//   `preserveUpdated: true` (caso migración masiva).
// - Regenera siempre el bloque Markdown Annotations al final.
// - `bodyAuthors` (opcional): array de autores con rangos CUERPO-RELATIVOS. Si se
//   omite o se pasa null, todo el cuerpo se atribuye a Claude (caso write_note inicial).
// - Si se pasa array vacío, NINGUNA atribución se persiste (todo cuerpo queda sin
//   atribuir, comportamiento improbable en la práctica).
function persistNote(filePath, frontmatter, body, bodyAuthors = null, { preserveUpdated = false } = {}) {
  const fm = buildFrontmatter({
    title: frontmatter.title || '',
    category: frontmatter.category || '',
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : (frontmatter.tags ? [frontmatter.tags] : []),
    created: frontmatter.created || today(),
    updated: preserveUpdated && frontmatter.updated ? frontmatter.updated : today(),
  });

  // Si las anotaciones están desactivadas, escribir el archivo sin bloque.
  if (!ANNOTATIONS_ENABLED) {
    const cleaned = body.replace(/^\s+/, '');
    const { cleanBody: bodyNoAnnotation } = stripAnnotationBlock(cleaned);
    const trimmed = bodyNoAnnotation.replace(/\s+$/, '');
    fs.writeFileSync(filePath, `${fm}\n${trimmed}\n`, 'utf8');
    return;
  }
  const cleaned = body.replace(/^\s+/, '');
  const { cleanBody: bodyNoAnnotation } = stripAnnotationBlock(cleaned);
  const trimmed = bodyNoAnnotation.replace(/\s+$/, '');
  // Estructura del archivo: <fm>\n<trimmed>\n\n<block>
  // El "text" sobre el que se calcula hash es: <fm>\n<trimmed> (sin último newline).
  const prefix = `${fm}\n`;
  const text = `${prefix}${trimmed}`;
  const bodyStart = countGraphemes(prefix);
  const bodyLength = countGraphemes(trimmed);

  // Determinar los rangos a persistir.
  let effectiveBodyAuthors;
  if (bodyAuthors === null) {
    // Sin info previa: todo el cuerpo se atribuye a Claude.
    effectiveBodyAuthors = bodyLength > 0
      ? [{ ...CLAUDE_AUTHOR, ranges: [{ start: 0, length: bodyLength }] }]
      : [];
  } else {
    // Limpiar los rangos pasados: clamp a [0, bodyLength], descartar vacíos.
    effectiveBodyAuthors = bodyAuthors
      .map((a) => ({
        ...a,
        ranges: a.ranges
          .map((r) => {
            const start = Math.max(0, r.start);
            const end = Math.min(bodyLength, r.start + r.length);
            return { start, length: end - start };
          })
          .filter((r) => r.length > 0),
      }))
      .filter((a) => a.ranges.length > 0);
    effectiveBodyAuthors = mergeAdjacentRanges(effectiveBodyAuthors);
  }

  // Convertir a rangos archivo-relativos para el bloque.
  const fileAuthors = effectiveBodyAuthors.map((a) => ({ ...a, ranges: toFileRanges(a.ranges, bodyStart) }));
  const block = computeAnnotationBlock(text, fileAuthors);
  fs.writeFileSync(filePath, `${text}\n\n${block}`, 'utf8');
}

// Localiza una sección markdown por su título (sin los `#`).
// Devuelve { startLine, endLine, level, headingLine } o null si no existe.
// La sección termina cuando aparece otro título del mismo nivel o superior, o el final del archivo.
function findSection(body, title) {
  const lines = body.split('\n');
  const targetTitle = title.trim();
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    if (m[2].trim() === targetTitle) {
      const level = m[1].length;
      // Buscar fin de sección
      let end = lines.length;
      let inFence2 = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^```/.test(lines[j])) inFence2 = !inFence2;
        if (inFence2) continue;
        const m2 = lines[j].match(/^(#{1,6})\s+/);
        if (m2 && m2[1].length <= level) {
          end = j;
          break;
        }
      }
      return { startLine: i, endLine: end, level, headingLine: line };
    }
  }
  return null;
}

// ─── Servidor MCP ──────────────────────────────────────────────────────────

const server = new Server(
  // Nombre con el que el servidor se anuncia. Por defecto 'bovedia'; se puede
  // fijar con KB_SERVER_NAME para conservar un identificador propio en una
  // instalación ya existente sin cambiar nada del flujo de trabajo diario.
  { name: process.env.KB_SERVER_NAME || 'bovedia', version: '2.3.0' },
  { capabilities: { tools: {} } }
);

const ALL_TOOLS = [
    // ── Bloque base: lectura ──────────────────────────────────────────────
    {
      name: 'read_note',
      description: 'Leer el contenido completo de una nota. Busca en todas las categorías.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'search_notes',
      description: 'Buscar notas por texto libre. Con múltiples palabras busca notas que contengan TODAS (lógica AND). Busca en títulos, contenido y etiquetas, y no distingue mayúsculas ni acentos: "piramide" y "pirámide" devuelven lo mismo. Los resultados se ordenan por relevancia (título y etiquetas antes que cuerpo) y vienen limitados; usa limit o category para acotar.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Término de búsqueda' },
          category: { type: 'string', description: 'Acotar la búsqueda a una categoría y sus subcarpetas (opcional)' },
          limit: { type: 'number', description: 'Máximo de resultados. Por defecto 20' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_notes',
      description: 'Listar notas con sus metadatos, filtradas opcionalmente por categoría y/o tag. El filtro de categoría es RECURSIVO: incluye la categoría indicada y todas sus subcarpetas. Por ejemplo, category "conocimiento" devuelve las notas sueltas en su raíz Y todas las de subcarpetas como "conocimiento/problemas-resueltos". Para ver la estructura completa de carpetas, usa get_index.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Categoría para filtrar (recursiva): devuelve las notas de esa categoría y de todas sus subcarpetas. Usa la categoría raíz (p. ej. "conocimiento") para todo el árbol, o una subcategoría completa (p. ej. "conocimiento/problemas-resueltos") para acotar a una subcarpeta.' },
          tag: { type: 'string', description: 'Etiqueta opcional para filtrar. Busca tanto en los hashtags del cuerpo (#tipo_proceso) como en los tags del frontmatter YAML de las notas antiguas. Se puede escribir con o sin almohadilla.' },
        },
      },
    },
    {
      name: 'get_index',
      description: 'Obtener el mapa de categorías de la base de conocimiento con el número de notas de cada una. Devuelve solo el árbol, que es barato; el listado nota a nota (caro en bóvedas grandes) hay que pedirlo con full:true y conviene acotarlo con category.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Acotar a una categoría y sus subcarpetas (opcional)' },
          full: { type: 'boolean', description: 'Si true, lista además cada nota con sus tags y backlinks. Puede ser muy largo: úsalo junto a category. Por defecto false.' },
        },
      },
    },

    // ── Bloque base: escritura ────────────────────────────────────────────
    {
      name: 'write_note',
      description: 'Crear, guardar, anotar, añadir o actualizar una nota en la base de conocimiento (la bóveda). Operación de escritura — úsala cuando quieras guardar contenido nuevo o sobrescribir uno existente, incluyendo notas en la carpeta bandeja-de-entrada. Si la nota ya existe, la actualiza completa (sobrescribe el cuerpo entero). Para retoques puntuales sin reenviar todo, prefiere edit_note, append_to_note, prepend_to_note, update_section o insert_after_section. Usa "name" para actualizar una nota existente por su slug real (útil cuando el título nuevo difiere del nombre de archivo).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título de la nota' },
          content: { type: 'string', description: 'Contenido en Markdown, sin incluir frontmatter ni el título h1' },
          category: {
            type: 'string',
            description: 'Subcarpeta donde guardar la nota (p. ej. "proyectos", "clientes/nombre-cliente" o "conocimiento/problemas-resueltos"). La estructura de carpetas es libre: usa las categorías que tu trabajo pida. Para ver las que ya existen, usa get_index.',
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Lista de tags para clasificar la nota' },
          name: { type: 'string', description: 'Slug del archivo existente a actualizar (sin extensión .md). Úsalo cuando el título no coincide con el nombre de archivo actual. Si se omite, el slug se genera automáticamente desde el título.' },
        },
        required: ['title', 'content', 'category'],
      },
    },
    {
      name: 'delete_note',
      description: 'Eliminar, borrar o quitar una nota de la base de conocimiento. Avisa si otras notas la referencian con wikilinks.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'create_category',
      description: 'Crear una nueva subcarpeta o categoría en la base de conocimiento. Úsala antes de guardar la primera nota en una categoría que aún no exista.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nueva categoría' } },
        required: ['name'],
      },
    },
    {
      name: 'move_note',
      description: 'Mover, renombrar o reubicar una nota — cambiarla de categoría y/o cambiarle el título. Actualiza automáticamente los wikilinks de otras notas que la referencien.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre actual de la nota (sin extensión .md)' },
          new_category: { type: 'string', description: 'Nueva categoría/carpeta destino (opcional)' },
          new_title: { type: 'string', description: 'Nuevo título para la nota, si se quiere renombrar (opcional)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'delete_category',
      description: 'Eliminar o borrar una categoría/subcarpeta vacía. Solo funciona si la carpeta no tiene notas dentro.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la categoría a eliminar' } },
        required: ['name'],
      },
    },

    // ── Bloque 1: edición puntual ────────────────────────────────────────
    {
      name: 'edit_note',
      description: 'Editar, modificar, retocar o cambiar una porción concreta de una nota mediante find/replace exacto. Reemplaza old_text por new_text dentro del cuerpo de la nota sin reenviar el archivo entero. Falla si old_text no aparece o aparece más de una vez (ambigüedad). Es la operación más eficiente para correcciones puntuales: una palabra, una línea, una entrada de tabla. Para añadir contenido al final usa append_to_note; para reemplazar una sección entera usa update_section.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          old_text: { type: 'string', description: 'Texto exacto a reemplazar. Debe ser único en la nota — incluye contexto suficiente si la cadena corta podría aparecer varias veces' },
          new_text: { type: 'string', description: 'Texto nuevo que sustituye a old_text' },
          replace_all: { type: 'boolean', description: 'Si es true, reemplaza todas las ocurrencias en lugar de fallar por ambigüedad. Por defecto false' },
        },
        required: ['name', 'old_text', 'new_text'],
      },
    },
    {
      name: 'append_to_note',
      description: 'Añadir, agregar, anexar o concatenar contenido al final del cuerpo de una nota sin tocar el resto. Si la nota termina en una línea de hashtags `#snake_case`, el contenido se inserta antes de los hashtags (preservando la convención de la bóveda). Ideal para notas-bandeja, listas crecientes y logs.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          content: { type: 'string', description: 'Contenido Markdown a añadir al final' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'prepend_to_note',
      description: 'Añadir, insertar o anteponer contenido al principio del cuerpo de una nota (justo después del título h1, antes del resto del contenido). Útil para entradas tipo log invertido donde lo más nuevo va arriba.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          content: { type: 'string', description: 'Contenido Markdown a insertar al inicio' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'update_section',
      description: 'Reemplazar, sustituir o reescribir una sección Markdown entera de una nota, identificada por el título exacto de su encabezado (sin los `#`). La sección abarca desde su encabezado hasta el siguiente encabezado del mismo nivel o superior. Conserva el encabezado original, sustituye solo el contenido entre encabezados. Es markdown-aware: ideal para regenerar tablas grandes, listas o párrafos largos sin tocar el resto del documento.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          section_title: { type: 'string', description: 'Título exacto del encabezado, sin los # iniciales (ej. "Marketing y publicidad")' },
          new_content: { type: 'string', description: 'Nuevo contenido de la sección, sin incluir el encabezado (que se conserva)' },
        },
        required: ['name', 'section_title', 'new_content'],
      },
    },
    {
      name: 'insert_after_section',
      description: 'Insertar, añadir o intercalar una nueva sección Markdown justo después de otra sección existente, identificada por su título. La sección nueva incluye su propio encabezado dentro de new_content. Útil para añadir entradas en orden a un inventario sin reescribir todo el archivo.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          after_section_title: { type: 'string', description: 'Título exacto de la sección tras la cual se inserta el contenido nuevo' },
          new_content: { type: 'string', description: 'Bloque Markdown nuevo, normalmente empezando por su propio encabezado (ej. "### Adle\\n\\nDescripción...")' },
        },
        required: ['name', 'after_section_title', 'new_content'],
      },
    },

    // ── Bloque 2: wikilinks y tags ───────────────────────────────────────
    {
      name: 'list_broken_links',
      description: 'Listar todos los wikilinks rotos de la bóveda (referencias [[slug]] que apuntan a notas inexistentes), agrupados por la nota que los contiene. Operación de mantenimiento: úsala periódicamente para limpiar la bóveda.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'find_backlinks',
      description: 'Devolver únicamente los backlinks de una nota (qué notas la referencian), sin cargar su contenido. Más rápido y económico en tokens que read_note cuando solo se quieren los backlinks.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'find_orphans',
      description: 'Listar notas huérfanas: notas que no tienen backlinks ni outlinks (no enlazan a ninguna nota ni son enlazadas por nadie). Útil para auditar notas aisladas que probablemente deberían integrarse o eliminarse.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'rename_wikilink',
      description: 'Renombrar, cambiar o sustituir globalmente un wikilink en todas las notas que lo referencian. Útil cuando se ha consolidado un concepto y hay que redirigir todas las referencias [[old_slug]] a [[new_slug]] sin tocar las notas origen ni destino. No mueve archivos — usa move_note si lo que quieres es renombrar la propia nota.',
      inputSchema: {
        type: 'object',
        properties: {
          old_slug: { type: 'string', description: 'Wikilink antiguo a sustituir (sin los corchetes)' },
          new_slug: { type: 'string', description: 'Wikilink nuevo que lo reemplaza (sin los corchetes)' },
        },
        required: ['old_slug', 'new_slug'],
      },
    },
    {
      name: 'list_tags',
      description: 'Listar todos los hashtags `#snake_case` presentes en el cuerpo de las notas, con el número de notas en que aparece cada uno. Útil para auditar la taxonomía, detectar variantes y mantener consistencia.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'update_frontmatter',
      description: 'Actualizar, modificar o cambiar campos concretos del frontmatter YAML de una nota (title, category, tags, created) sin tocar el cuerpo. El campo updated se renueva automáticamente. Para mover de categoría usa move_note (mantiene wikilinks); este tool solo edita el YAML in situ sin mover archivos.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          fields: {
            type: 'object',
            description: 'Objeto con los campos a actualizar. Claves válidas: title, category, tags (array), created. updated se ignora — siempre se pone a hoy.',
          },
        },
        required: ['name', 'fields'],
      },
    },

    // ── Bloque 3: lectura económica ──────────────────────────────────────
    {
      name: 'peek_note',
      description: 'Echar un vistazo rápido a una nota: devuelve solo frontmatter + primer párrafo del cuerpo. Ahorra tokens cuando solo se quiere comprobar la categoría, tags o de qué trata la nota antes de decidir si leerla entera.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'read_section',
      description: 'Leer únicamente una sección Markdown de una nota, identificada por el título exacto de su encabezado. Devuelve desde ese encabezado hasta el siguiente del mismo nivel o superior. Ideal para notas largas (inventarios, capturas) cuando solo interesa una parte.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la nota sin extensión .md' },
          section_title: { type: 'string', description: 'Título exacto del encabezado, sin los # iniciales' },
        },
        required: ['name', 'section_title'],
      },
    },
    {
      name: 'read_frontmatter',
      description: 'Leer únicamente el frontmatter YAML de una nota, sin el cuerpo. Útil para validaciones rápidas o cuando solo se necesitan los metadatos.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'read_authorship',
      description: 'Consultar, auditar o revisar la autoría del cuerpo de una nota: qué autores escribieron qué rangos del texto. Devuelve un resumen compacto con cada autor, sus rangos en grapheme indexes (relativos al cuerpo), el porcentaje del cuerpo que cubren y un extracto de cada rango. Útil para auditar quién escribió qué cuando la nota se ha ido editando a varias manos.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },

    // ── Bloque 4: mantenimiento ──────────────────────────────────────────
    {
      name: 'recently_updated',
      description: 'Listar notas modificadas recientemente, en los últimos N días (por defecto 7). Útil para retomar contexto de qué se ha tocado últimamente sin leer toda la bóveda.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Número de días hacia atrás. Por defecto 7' },
        },
      },
    },
    {
      name: 'move_category',
      description: 'Mover, renombrar o reubicar una categoría/carpeta entera con todas sus notas dentro. Actualiza el campo category del frontmatter de cada nota. Más eficiente que mover una a una. No actualiza wikilinks porque los slugs no cambian.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Categoría actual (puede ser anidada como "conocimiento/problemas-resueltos")' },
          new_name: { type: 'string', description: 'Nueva ruta de categoría' },
        },
        required: ['name', 'new_name'],
      },
    },
    {
      name: 'validate_note',
      description: 'Validar, comprobar o auditar la estructura de una nota según el protocolo de la bóveda: frontmatter completo (title, category, created, updated), presencia de sección "Ver también", presencia de hashtags `#snake_case` al final, y wikilinks no rotos. Devuelve un reporte con los problemas detectados.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'bulk_move',
      description: 'Mover, reubicar o desplazar varias notas a la vez a una misma categoría destino. Procesa el array de slugs en una sola llamada. Útil al procesar la bandeja de entrada cuando hay varias notas para la misma carpeta. No renombra — para renombrar usa move_note una a una.',
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Lista de slugs (sin extensión .md) a mover' },
          new_category: { type: 'string', description: 'Categoría destino para todas las notas' },
        },
        required: ['names', 'new_category'],
      },
    },
    {
      name: 'migrate_annotations',
      description: 'Operación one-shot: añadir, anotar o aplicar el bloque Markdown Annotations a TODAS las notas existentes que aún no lo tengan, atribuyendo todo el cuerpo a Claude. Las notas que ya tienen bloque se saltan (idempotencia). Preserva el campo updated de cada nota. Por defecto corre en modo dry_run para mostrar qué haría sin tocar nada; con dry_run=false ejecuta la migración real.',
      inputSchema: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', description: 'Si true (por defecto), no escribe nada y devuelve un informe de qué notas se migrarían. Si false, ejecuta la migración real.' },
        },
      },
    },

    // ── Bloque 5: rutina de la bóveda ────────────────────────────────────
    {
      name: 'due_notes',
      description: 'Revisar las notas programadas y devolver SOLO las que ya toca sacar hoy. Lee la fecha `> APARECER: AAAA-MM-DD` del principio de cada nota de la carpeta de programados y la compara con la fecha actual. Sustituye a mirar una por una: una sola llamada barata para la comprobación de arranque de sesión.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Carpeta de notas programadas. Por defecto "programado".' },
          include_upcoming: { type: 'boolean', description: 'Si true, incluye también las que aún no han vencido, con su fecha y los días que faltan. Por defecto false.' },
        },
      },
    },
    {
      name: 'list_sections',
      description: 'Listar el índice de secciones (los encabezados) de una nota, con su nivel y su tamaño en líneas, sin devolver el contenido. Sirve para orientarse en notas largas y decidir qué leer: después se lee solo lo necesario con read_section en vez de cargar la nota entera.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la nota sin extensión .md' } },
        required: ['name'],
      },
    },
    {
      name: 'migrate_yaml_tags',
      description: 'Migrar, trasladar o bajar al cuerpo los tags que quedan en el frontmatter YAML, convirtiéndolos en hashtags `#snake_case` al final de la nota, y dejar el frontmatter limpio. Los tags que ya existen como hashtag no se duplican. Operación one-shot e idempotente: conserva la fecha de modificación y la autoría. Por defecto corre en dry_run para ver qué haría sin tocar nada.',
      inputSchema: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', description: 'Si true (por defecto), no escribe nada y devuelve el informe de lo que haría. Con false ejecuta la migración real.' },
          category: { type: 'string', description: 'Acotar a una categoría y sus subcarpetas (opcional). Útil para migrar por partes.' },
          drop: { type: 'array', items: { type: 'string' }, description: 'Etiquetas que NO se rescatan al cuerpo: se descartan al vaciar el frontmatter. Útil para ruido genérico.' },
        },
      },
    },
    {
      name: 'audit_tags',
      description: 'Auditar, revisar o comprobar la salud de las etiquetas de la bóveda: hashtags mal formados con guión medio (que los editores no agrupan y el extractor trunca), variantes del mismo concepto, etiquetas usadas una sola vez y notas que aún conservan tags en el frontmatter YAML. Devuelve un informe para limpiar la taxonomía.',
      inputSchema: {
        type: 'object',
        properties: {
          fix_dashes: { type: 'boolean', description: 'Si true, corrige en las notas los hashtags con guión medio pasándolos a snake_case (#nano-banana → #nano_banana). Por defecto false: solo informa.' },
        },
      },
    },
];

// ─── Perfil de herramientas expuestas ───────────────────────────────────────
// El listado de tools se envía en CADA sesión y cuenta contra la ventana de
// contexto (las 32 completas rondan los 4.000 tokens). En un cliente con ventana
// corta eso es un peaje que se paga sin usarlo. Con KB_TOOLS=core se exponen
// solo las de uso diario; el valor por defecto (full) mantiene todas.
const TOOLS_PROFILE = (process.env.KB_TOOLS || 'full').toLowerCase();
const CORE_TOOLS = new Set([
  'read_note', 'search_notes', 'list_notes', 'peek_note', 'read_section', 'list_sections',
  'write_note', 'edit_note', 'append_to_note', 'update_section',
  'move_note', 'delete_note', 'due_notes', 'find_backlinks', 'recently_updated',
]);

function visibleTools() {
  let tools = ALL_TOOLS;
  // Las tools de anotaciones solo tienen sentido con la feature activada.
  if (!ANNOTATIONS_ENABLED) {
    tools = tools.filter((t) => t.name !== 'read_authorship' && t.name !== 'migrate_annotations');
  }
  if (TOOLS_PROFILE === 'core') {
    tools = tools.filter((t) => CORE_TOOLS.has(t.name));
  }
  return tools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));

// ─── Handler de llamadas ──────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // Normalizar a NFC todo argumento de texto: garantiza que las comparaciones
  // con el contenido de disco (también normalizado a NFC) casen siempre.
  normalizeArgs(args);

  try {
    // ── Validación de argumentos ────────────────────────────────────────
    // Si falta un parámetro obligatorio o llega con otro nombre (old_string en
    // vez de old_text, por ejemplo), hay que decirlo. Antes el argumento llegaba
    // como undefined y la tool seguía adelante: edit_note respondía "no se
    // encontró el texto a reemplazar", que manda a buscar el fallo en la nota
    // cuando el fallo estaba en la llamada.
    const definicion = ALL_TOOLS.find((t) => t.name === name);
    if (definicion?.inputSchema) {
      const esperados = Object.keys(definicion.inputSchema.properties || {});
      const requeridos = definicion.inputSchema.required || [];
      const faltan = requeridos.filter((p) => args?.[p] === undefined || args[p] === null || args[p] === '');
      const sobran = Object.keys(args || {}).filter((p) => !esperados.includes(p));
      if (faltan.length) {
        const pista = sobran.length ? ` Has enviado en su lugar: ${sobran.join(', ')}. Los parámetros de esta herramienta son: ${esperados.join(', ')}.` : '';
        return {
          content: [{ type: 'text', text: `Falta(n) parámetro(s) obligatorio(s) en ${name}: ${faltan.join(', ')}.${pista}` }],
          isError: true,
        };
      }
    }

    // ── Modo escritura-solo-bandeja — candado DURO para asistentes locales ──
    // Variable canónica: KB_WRITE_ONLY_INBOX ('1' o 'true'). Se mantiene la
    // compatibilidad con la antigua KB_INBOX_ONLY: si sigue definida, se trata
    // como equivalente para no romper instalaciones que la usen.
    //
    // Modelo (cuando la env está activa):
    //  - LECTURA: nunca se bloquea.
    //  - ESCRITURA: solo permitida en la categoría 'bandeja-de-entrada'. Si el
    //    destino (o la categoría actual de la nota) no es bandeja-de-entrada, se
    //    RECHAZA con un mensaje claro (NO se redirige silenciosamente).
    //  - ADMIN (crear/borrar/mover categorías, renombrar wikilinks globalmente,
    //    migrar anotaciones): siempre bloqueado bajo esta env.
    // Sin la env: comportamiento por defecto = acceso total (no entra aquí).
    const WRITE_ONLY_INBOX = (() => {
      const w = (process.env.KB_WRITE_ONLY_INBOX || '').toLowerCase();
      const legacy = (process.env.KB_INBOX_ONLY || '').toLowerCase();
      const on = (v) => v === '1' || v === 'true' || v === 'yes' || v === 'on';
      return on(w) || on(legacy);
    })();

    if (WRITE_ONLY_INBOX) {
      const INBOX = 'bandeja-de-entrada';

      // ADMIN: siempre bloqueado.
      const ADMIN = new Set(['create_category', 'delete_category', 'move_category', 'rename_wikilink', 'migrate_annotations']);
      if (ADMIN.has(name)) {
        return { content: [{ type: 'text', text: `Modo escritura-solo-bandeja activo: las operaciones de administración (${name}) están bloqueadas. Solo puedes leer notas y escribir en la carpeta ${INBOX}.` }], isError: true };
      }

      // write_note: solo si la categoría destino es la bandeja.
      if (name === 'write_note' && args.category !== INBOX) {
        return { content: [{ type: 'text', text: `Solo puedes escribir en ${INBOX}. La categoría indicada ("${args.category}") no está permitida en modo escritura-solo-bandeja.` }], isError: true };
      }

      // Escritura sobre una nota existente: rechazar si su categoría actual no es la bandeja.
      const WRITE_ON_EXISTING = new Set(['edit_note', 'append_to_note', 'prepend_to_note', 'update_section', 'insert_after_section', 'update_frontmatter', 'delete_note']);
      if (WRITE_ON_EXISTING.has(name)) {
        const existing = loadNote(args.name);
        if (!existing) {
          return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };
        }
        if (existing.frontmatter.category !== INBOX) {
          return { content: [{ type: 'text', text: `Modo escritura-solo-bandeja activo: la nota "${args.name}" está en "${existing.frontmatter.category || 'raiz'}", no en ${INBOX}. Solo puedes modificar notas que estén en la bandeja de entrada.` }], isError: true };
        }
      }

      // Mover notas: solo si el destino es la bandeja.
      if ((name === 'move_note' || name === 'bulk_move') && args.new_category !== INBOX) {
        return { content: [{ type: 'text', text: `Modo escritura-solo-bandeja activo: solo puedes mover notas a ${INBOX}. Destino indicado ("${args.new_category || 'ninguno'}") no permitido.` }], isError: true };
      }
    }
    // ── write_note ──────────────────────────────────────────────────────
    if (name === 'write_note') {
      const slug = args.name ? args.name : slugify(args.title);
      const existingPath = args.name ? findNote(args.name) : null;
      const categoryDir = safeJoin(args.category);

      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      const filePath = existingPath || path.join(categoryDir, `${slug}.md`);
      const exists = fs.existsSync(filePath);

      let created = today();
      if (exists) {
        const existing = readNoteFile(filePath);
        const { frontmatter } = parseFrontmatter(existing);
        created = frontmatter.created || today();

        // Auto-protección: si la nota existente tiene autoría humana (cualquier
        // autor con prefijo `@`), abortar la sobrescritura para no destruirla.
        // El usuario debe usar edit_note / update_section / append_to_note para
        // modificar notas en su destino final donde él haya escrito.
        const existingAuthors = extractBodyAuthorsFromRaw(existing);
        const humanAuthors = existingAuthors.filter((a) => a.prefix === '@');
        if (humanAuthors.length > 0) {
          const totalHumanChars = humanAuthors.reduce(
            (sum, a) => sum + a.ranges.reduce((s, r) => s + r.length, 0),
            0,
          );
          const who = humanAuthors.map((a) => `${a.prefix}${a.name}`).join(', ');
          return {
            content: [{
              type: 'text',
              text: `write_note BLOQUEADO: la nota "${slug}" contiene ${totalHumanChars} caracteres de autoría humana (${who}). Sobrescribir borraría esa atribución y se perdería la trazabilidad de qué escribió cada uno. Usa edit_note, append_to_note, prepend_to_note, update_section o insert_after_section para editar manteniendo la autoría.`,
            }],
            isError: true,
          };
        }
      }

      // Limpieza defensiva: el servidor ya añade el frontmatter y el H1 del
      // título. Si el content recibido incluye su propio frontmatter o un H1
      // al inicio (algunos asistentes lo añaden siguiendo plantillas antiguas),
      // se eliminan para no duplicarlos en el cuerpo. Así todos los clientes
      // (claude.ai, IA local, etc.) producen la misma estructura.
      const stripLeadingMeta = (raw) => {
        let c = (raw || '').replace(/^﻿/, '').replace(/^\s+/, '');
        // Quitar un bloque frontmatter YAML inicial (--- ... ---)
        if (c.startsWith('---')) {
          const end = c.indexOf('\n---', 3);
          if (end !== -1) {
            const after = c.indexOf('\n', end + 1);
            c = (after !== -1 ? c.slice(after + 1) : '').replace(/^\s+/, '');
          }
        }
        // Quitar un único H1 inicial (# ...)
        if (c.startsWith('# ')) {
          const nl = c.indexOf('\n');
          c = (nl !== -1 ? c.slice(nl + 1) : '').replace(/^\s+/, '');
        }
        return c;
      };

      const body = `# ${args.title}\n\n${stripLeadingMeta(args.content)}\n`;
      // bodyAuthors=null → todo el cuerpo se atribuye a Claude.
      persistNote(
        filePath,
        { title: args.title, category: safeCategory(args.category), tags: args.tags || [], created },
        body,
      );

      const RESERVED_LINKS = new Set(['HOME', 'home']);
      const broken = extractLinkTargets(body).filter((link) => !RESERVED_LINKS.has(link) && !noteExists(link));

      let msg = `Nota "${args.title}" ${exists ? 'actualizada' : 'creada'} → ${args.category}/${slug}.md`;
      if (broken.length) {
        msg += `\n\nAVISO — Wikilinks que apuntan a notas inexistentes: ${broken.map((b) => `[[${b}]]`).join(', ')}`;
      }

      invalidateCache();
      return { content: [{ type: 'text', text: msg }] };
    }

    // ── read_note ───────────────────────────────────────────────────────
    if (name === 'read_note') {
      const reservedNames = { HOME: 'HOME.md' };
      const reservedFile = reservedNames[args.name.toUpperCase()];
      const filePath = reservedFile
        ? path.join(MEMORY_ROOT, reservedFile)
        : findNote(args.name);

      if (!filePath || !fs.existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };
      }

      const content = readNoteFile(filePath);
      // Filtrar el bloque Markdown Annotations del output: es metadata interna del
      // MCP, no contenido relevante para el lector. La trazabilidad de autoría se
      // consulta con read_authorship.
      const { frontmatter, body: rawBody } = parseFrontmatter(content);
      const { cleanBody } = stripAnnotationBlock(rawBody);
      const filtered = `---\n${content.slice(4, content.indexOf('---\n', 4) + 4)}\n${cleanBody.replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
      const allNotes = getCachedAllNotes();
      const backlinks = getBacklinks(args.name, allNotes);
      const backlinkText = backlinks.length > 0 ? backlinks.map((b) => `[[${b}]]`).join(', ') : 'ninguna';

      return {
        content: [{ type: 'text', text: `${filtered}\n---\n**Backlinks (${backlinks.length}):** ${backlinkText}` }],
      };
    }

    // ── search_notes ────────────────────────────────────────────────────
    // Búsqueda AND sobre título, etiquetas y cuerpo. Tres decisiones de diseño:
    //  - Insensible a acentos y mayúsculas: en una bóveda en español, "pirámide"
    //    y "piramide" tienen que encontrarse la una a la otra.
    //  - Ordenada por relevancia: una coincidencia en el título o en una etiqueta
    //    vale más que una perdida en mitad del cuerpo.
    //  - Acotada: sin límite, una palabra frecuente devuelve decenas de notas con
    //    su extracto y se lleva por delante media ventana de contexto.
    if (name === 'search_notes') {
      const allNotes = getCachedAllNotes();
      const terms = foldText(args.query).split(/\s+/).filter(Boolean);
      if (!terms.length) {
        return { content: [{ type: 'text', text: 'Indica algún término de búsqueda.' }] };
      }
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
      const scoped = args.category
        ? allNotes.filter((n) => n.category === args.category || n.category.startsWith(args.category + '/'))
        : allNotes;

      const hits = [];
      for (const note of scoped) {
        // El cuerpo limpio: sin frontmatter y sin el bloque de anotaciones, que
        // es metadata interna y ensuciaba los extractos.
        const cleanBody = note.body || '';
        const cleanName = note.name.replace(/-/g, ' ');
        const title = note.frontmatter?.title || cleanName;
        const foldedBody = foldText(cleanBody);
        const foldedName = foldText(`${cleanName} ${title}`);
        const foldedTags = foldText([...allTagsOf(note)].join(' '));

        let score = 0;
        const matchesAll = terms.every((term) => {
          const inName = foldedName.includes(term);
          const inTags = foldedTags.includes(term);
          const inBody = foldedBody.includes(term);
          if (inName) score += 10;
          if (inTags) score += 4;
          if (inBody) score += 1;
          return inName || inTags || inBody;
        });
        if (!matchesAll) continue;

        const idx = foldedBody.indexOf(terms[0]);
        const snippet = idx >= 0
          ? '...' + cleanBody.slice(Math.max(0, idx - 60), Math.min(cleanBody.length, idx + 120)).replace(/\s+/g, ' ').trim() + '...'
          : '';
        hits.push({ note, score, snippet });
      }

      if (!hits.length) {
        const scope = args.category ? ` en "${args.category}"` : '';
        return { content: [{ type: 'text', text: `Sin resultados para "${args.query}"${scope}.` }] };
      }

      hits.sort((a, b) => b.score - a.score || a.note.name.localeCompare(b.note.name));
      const shown = hits.slice(0, limit);
      const lines = shown.map((h) => `**${h.note.name}** (${h.note.category})\n${h.snippet}`);
      const extra = hits.length > shown.length
        ? `\n\n_Mostrando ${shown.length} de ${hits.length}. Afina la búsqueda, acota con category o sube limit._`
        : '';
      return { content: [{ type: 'text', text: `${hits.length} resultado(s) para "${args.query}":\n\n${lines.join('\n\n')}${extra}` }] };
    }

    // ── list_notes ──────────────────────────────────────────────────────
    if (name === 'list_notes') {
      const allNotes = getCachedAllNotes();
      // El filtro por etiqueta mira las dos convenciones que conviven en la
      // bóveda: los hashtags del cuerpo (la vigente) y los tags del frontmatter
      // YAML de las notas antiguas. Antes solo leía el YAML, así que filtrar por
      // una etiqueta escrita en el cuerpo devolvía cero notas.
      const wantedTag = args.tag ? args.tag.trim().replace(/^#/, '').replace(/-/g, '_').toLowerCase() : null;
      const filtered = allNotes.filter((n) => {
        const matchCategory = !args.category || n.category === args.category || n.category.startsWith(args.category + '/');
        const matchTag = !wantedTag || [...allTagsOf(n)].some((t) => t.toLowerCase() === wantedTag);
        return matchCategory && matchTag;
      });

      if (!filtered.length) {
        const context = [];
        if (args.category) context.push(`categoría "${args.category}"`);
        if (args.tag) context.push(`tag "${args.tag}"`);
        const filterDesc = context.length ? ` con ${context.join(' y ')}` : '';
        return { content: [{ type: 'text', text: !args.category && !args.tag ? 'La base de conocimiento está vacía.' : `No hay notas${filterDesc}.` }] };
      }

      const { backlinks: backlinkMap } = getMaps();
      const backlinksCount = {};
      for (const note of allNotes) {
        backlinksCount[note.name] = (backlinkMap.get(note.name) || new Set()).size;
      }

      const lines = filtered
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        .map((note) => {
          const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.join(', ') : note.frontmatter.tags || '';
          const updated = note.frontmatter.updated || '?';
          const bl = backlinksCount[note.name] || 0;
          return `- **${note.name}** (${note.category}) — tags: ${tags || 'sin tags'} — actualizada: ${updated} — ${bl} backlinks`;
        });

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── delete_note ─────────────────────────────────────────────────────
    if (name === 'delete_note') {
      const filePath = findNote(args.name);
      if (!filePath) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const allNotes = getAllNotes();
      const backlinks = getBacklinks(args.name, allNotes);
      fs.unlinkSync(filePath);
      cleanupEmptyAncestors(path.dirname(filePath));

      let msg = `Nota "${args.name}" eliminada.`;
      if (backlinks.length) {
        msg += `\n\nAVISO — Las siguientes notas tenían wikilinks apuntando a ella: ${backlinks.map((b) => `[[${b}]]`).join(', ')}. Revísalas para actualizar o eliminar esos enlaces.`;
      }
      invalidateCache();
      return { content: [{ type: 'text', text: msg }] };
    }

    // ── get_index ───────────────────────────────────────────────────────
    if (name === 'get_index') {
      const allNotes = getCachedAllNotes();
      const content = buildIndex(allNotes, { full: args?.full === true, category: args?.category || null });
      return { content: [{ type: 'text', text: content }] };
    }

    // ── create_category ─────────────────────────────────────────────────
    // Se slugifica CADA segmento de la ruta, no la ruta entera: así una categoría
    // anidada ("conocimiento/problemas-resueltos") se crea como carpetas anidadas
    // de verdad. Antes la slugificación se comía las barras y
    // "problemas-resueltos/mcp" acababa siendo una sola carpeta llamada
    // "problemas-resueltosmcp". De paso, los segmentos vacíos o ".." se
    // descartan, así que la ruta nunca puede salirse de la bóveda.
    if (name === 'create_category') {
      const slug = String(args.name)
        .split('/')
        .map((seg) => slugify(seg))
        .filter(Boolean)
        .join('/');
      if (!slug) {
        return { content: [{ type: 'text', text: `Nombre de categoría no válido: "${args.name}".` }], isError: true };
      }
      const dir = safeJoin(slug);
      if (fs.existsSync(dir)) {
        return { content: [{ type: 'text', text: `La categoría "${slug}" ya existe.` }] };
      }
      fs.mkdirSync(dir, { recursive: true });
      invalidateCache();
      return { content: [{ type: 'text', text: `Categoría "${slug}" creada.` }] };
    }

    // ── move_note ───────────────────────────────────────────────────────
    if (name === 'move_note') {
      const srcPath = findNote(args.name);
      if (!srcPath) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const existing = readNoteFile(srcPath);
      const { frontmatter, body } = parseFrontmatter(existing);
      const newTitle = args.new_title || frontmatter.title || args.name;
      const newSlug = slugify(newTitle);
      const newCategory = safeCategory(args.new_category || frontmatter.category || path.relative(MEMORY_ROOT, path.dirname(srcPath)));

      const destDir = safeJoin(newCategory);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const destPath = path.join(destDir, `${newSlug}.md`);
      if (destPath === srcPath) {
        return { content: [{ type: 'text', text: 'La nota ya está en esa ubicación con ese nombre.' }] };
      }

      const { cleanBody: bodyWithoutAnnotation } = stripAnnotationBlock(body);
      const sourceBodyTrim = bodyWithoutAnnotation.replace(/^\s+/, '').replace(/\s+$/, '');
      const sourceBodyAuthors = extractBodyAuthorsFromRaw(existing);

      // Si hay nuevo título, aplicar edit del h1 atribuido a Claude (decisión nuestra).
      let newBody = sourceBodyTrim;
      let newBodyAuthors = sourceBodyAuthors;
      if (args.new_title) {
        const h1Match = sourceBodyTrim.match(/^# .+$/m);
        if (h1Match) {
          const oldH1 = h1Match[0];
          const newH1 = `# ${newTitle}`;
          const h1Start = utf16PosToGraphemePos(sourceBodyTrim, h1Match.index);
          const oldH1Len = countGraphemes(oldH1);
          const newH1Len = countGraphemes(newH1);
          newBody = sourceBodyTrim.replace(oldH1, newH1);
          newBodyAuthors = applyEditToAuthors(sourceBodyAuthors, h1Start, oldH1Len, newH1Len);
        }
      }

      persistNote(
        destPath,
        {
          title: newTitle,
          category: newCategory,
          tags: frontmatter.tags,
          created: frontmatter.created || today(),
        },
        newBody,
        newBodyAuthors,
      );
      fs.unlinkSync(srcPath);
      cleanupEmptyAncestors(path.dirname(srcPath));

      const oldSlug = path.basename(srcPath, '.md');
      const allNotes = getAllNotes();
      let updatedNotes = 0;

      if (oldSlug !== newSlug) {
        const oldLink = `[[${oldSlug}]]`;
        const newLink = `[[${newSlug}]]`;
        const oldLinkLen = countGraphemes(oldLink);
        const newLinkLen = countGraphemes(newLink);
        for (const note of allNotes) {
          if (note.name === newSlug) continue;
          const raw = readNoteFile(note.path);
          if (!raw.includes(oldLink)) continue;
          const { frontmatter: fm, body: noteBody } = parseFrontmatter(raw);
          const { cleanBody } = stripAnnotationBlock(noteBody);
          const bodyTrim = cleanBody.replace(/^\s+/, '').replace(/\s+$/, '');
          if (!bodyTrim.includes(oldLink)) continue;

          const parts = bodyTrim.split(oldLink);
          const offsets = [];
          let cumulative = 0;
          for (let i = 0; i < parts.length - 1; i++) {
            cumulative += countGraphemes(parts[i]);
            offsets.push(cumulative);
            cumulative += oldLinkLen;
          }
          const updatedBody = parts.join(newLink);

          // Cambio MECÁNICO de slug: preservar autor original.
          let bodyAuthors = extractBodyAuthorsFromRaw(raw);
          for (let i = offsets.length - 1; i >= 0; i--) {
            const orig = uniqueAuthorOfSegment(bodyAuthors, offsets[i], oldLinkLen);
            const author = orig || CLAUDE_AUTHOR;
            bodyAuthors = applyEditToAuthors(bodyAuthors, offsets[i], oldLinkLen, newLinkLen, author);
          }
          persistNote(note.path, fm, updatedBody, bodyAuthors);
          updatedNotes++;
        }
      }

      let msg = `Nota movida/renombrada:\n- Antes: ${path.relative(MEMORY_ROOT, srcPath)}\n- Ahora:  ${newCategory}/${newSlug}.md`;
      if (oldSlug !== newSlug) {
        msg += updatedNotes > 0
          ? `\n\n${updatedNotes} nota(s) con wikilinks a [[${oldSlug}]] actualizadas a [[${newSlug}]].`
          : `\n\n(No había notas con wikilinks a [[${oldSlug}]])`;
      }
      invalidateCache();
      return { content: [{ type: 'text', text: msg }] };
    }

    // ── delete_category ─────────────────────────────────────────────────
    if (name === 'delete_category') {
      const slug = slugify(args.name);
      const dir = safeJoin(slug);
      if (!fs.existsSync(dir)) return { content: [{ type: 'text', text: `La categoría "${slug}" no existe.` }] };

      const notes = getAllNotes().filter((n) => n.category === slug || n.category.startsWith(`${slug}/`));
      if (notes.length > 0) {
        return { content: [{ type: 'text', text: `No se puede eliminar "${slug}": contiene ${notes.length} nota(s). Mueve o elimina las notas primero.` }] };
      }
      fs.rmSync(dir, { recursive: true });
      invalidateCache();
      return { content: [{ type: 'text', text: `Categoría "${slug}" eliminada.` }] };
    }

    // ── edit_note ───────────────────────────────────────────────────────
    if (name === 'edit_note') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const occurrences = note.body.split(args.old_text).length - 1;
      if (occurrences === 0) {
        return { content: [{ type: 'text', text: `No se encontró el texto a reemplazar en la nota "${args.name}". Verifica que old_text coincide exactamente (incluidos espacios y saltos de línea).` }] };
      }
      if (occurrences > 1 && !args.replace_all) {
        return { content: [{ type: 'text', text: `El texto aparece ${occurrences} veces en la nota — ambigüedad. Incluye más contexto en old_text para hacerlo único, o usa replace_all: true para sustituir todas las ocurrencias.` }] };
      }

      // Aplicar el reemplazo al texto
      const newBody = args.replace_all
        ? note.body.split(args.old_text).join(args.new_text)
        : note.body.replace(args.old_text, args.new_text);

      let bodyAuthors = note.bodyAuthors;

      if (!args.replace_all) {
        // Una única ocurrencia: usar computeBodyDiff sobre todo el cuerpo. Esto
        // detecta automáticamente prefijos y sufijos compartidos entre old_text y
        // new_text, así que si old_text contiene un trozo que se repite literal en
        // new_text (ej. un hashtag preservado), su autoría humana no se pierde.
        const diff = computeBodyDiff(note.body, newBody);
        bodyAuthors = applyEditToAuthors(bodyAuthors, diff.editStart, diff.oldLength, diff.newLength);
      } else {
        // replace_all con múltiples ocurrencias no contiguas: computeBodyDiff las
        // fusionaría en un único bloque grande, destruyendo autoría intermedia. Por
        // eso aplicamos cada edit individual en orden inverso. Aquí el reemplazo
        // ES íntegro y la autoría humana dentro de cada old_text sí se pierde.
        const oldLen = countGraphemes(args.old_text);
        const newLen = countGraphemes(args.new_text);
        const editsBodyOffsets = [];
        const parts = note.body.split(args.old_text);
        let cumulative = 0;
        for (let i = 0; i < parts.length - 1; i++) {
          cumulative += countGraphemes(parts[i]);
          editsBodyOffsets.push(cumulative);
          cumulative += oldLen;
        }
        for (let i = editsBodyOffsets.length - 1; i >= 0; i--) {
          bodyAuthors = applyEditToAuthors(bodyAuthors, editsBodyOffsets[i], oldLen, newLen);
        }
      }

      persistNote(note.filePath, note.frontmatter, newBody, bodyAuthors);
      invalidateCache();
      return { content: [{ type: 'text', text: `Nota "${args.name}" editada (${occurrences} ${occurrences === 1 ? 'ocurrencia reemplazada' : 'ocurrencias reemplazadas'}).` }] };
    }

    // ── append_to_note ──────────────────────────────────────────────────
    if (name === 'append_to_note') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const { mainBody, trailing } = splitBodyAndTrailing(note.body);
      const trimmedNew = args.content.trim();
      const newBody = trailing
        ? `${mainBody.replace(/\s+$/, '')}\n\n${trimmedNew}\n\n${trailing}`
        : `${note.body.replace(/\s+$/, '')}\n\n${trimmedNew}`;

      // El "diff" entre cuerpo viejo y nuevo nos da la inserción real (incluyendo
      // los separadores \n\n que se añaden). Atribuimos todo el diff a Claude.
      const diff = computeBodyDiff(note.body, newBody);
      const newBodyAuthors = applyEditToAuthors(note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength);

      persistNote(note.filePath, note.frontmatter, newBody, newBodyAuthors);
      invalidateCache();
      return { content: [{ type: 'text', text: `Contenido añadido al final de "${args.name}"${trailing ? ' (antes del bloque de hashtags).' : '.'}` }] };
    }

    // ── prepend_to_note ─────────────────────────────────────────────────
    if (name === 'prepend_to_note') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      // Detectar h1 al inicio y conservarlo arriba
      const h1Match = note.body.match(/^(\s*#\s+.+\n+)/);
      const trimmedNew = args.content.trim();
      let newBody;
      if (h1Match) {
        const h1 = h1Match[1];
        const rest = note.body.slice(h1.length);
        newBody = `${h1}\n${trimmedNew}\n\n${rest}`;
      } else {
        newBody = `${trimmedNew}\n\n${note.body}`;
      }

      const diff = computeBodyDiff(note.body, newBody);
      const newBodyAuthors = applyEditToAuthors(note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength);

      persistNote(note.filePath, note.frontmatter, newBody, newBodyAuthors);
      invalidateCache();
      return { content: [{ type: 'text', text: `Contenido insertado al inicio de "${args.name}".` }] };
    }

    // ── update_section ──────────────────────────────────────────────────
    if (name === 'update_section') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const sec = findSection(note.body, args.section_title);
      if (!sec) {
        return { content: [{ type: 'text', text: `No se encontró la sección "${args.section_title}" en la nota "${args.name}".` }] };
      }

      const lines = note.body.split('\n');
      const before = lines.slice(0, sec.startLine + 1); // incluye el encabezado
      const after = lines.slice(sec.endLine);
      const newSection = args.new_content.endsWith('\n') ? args.new_content : args.new_content + '\n';
      const newBody = [...before, '', newSection.trimEnd(), '', ...after].join('\n').replace(/\n{3,}/g, '\n\n');

      const diff = computeBodyDiff(note.body, newBody);
      const newBodyAuthors = applyEditToAuthors(note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength);

      persistNote(note.filePath, note.frontmatter, newBody, newBodyAuthors);
      invalidateCache();
      return { content: [{ type: 'text', text: `Sección "${args.section_title}" actualizada en "${args.name}".` }] };
    }

    // ── insert_after_section ────────────────────────────────────────────
    if (name === 'insert_after_section') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const sec = findSection(note.body, args.after_section_title);
      if (!sec) {
        return { content: [{ type: 'text', text: `No se encontró la sección "${args.after_section_title}" en la nota "${args.name}".` }] };
      }

      const lines = note.body.split('\n');
      const before = lines.slice(0, sec.endLine);
      const after = lines.slice(sec.endLine);
      const newBlock = args.new_content.trim();
      const newBody = [...before, '', newBlock, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n');

      const diff = computeBodyDiff(note.body, newBody);
      const newBodyAuthors = applyEditToAuthors(note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength);

      persistNote(note.filePath, note.frontmatter, newBody, newBodyAuthors);
      invalidateCache();
      return { content: [{ type: 'text', text: `Bloque insertado después de la sección "${args.after_section_title}" en "${args.name}".` }] };
    }

    // ── list_broken_links ───────────────────────────────────────────────
    if (name === 'list_broken_links') {
      const allNotes = getCachedAllNotes();
      const RESERVED_LINKS = new Set(['HOME', 'home']);
      const broken = [];

      for (const note of allNotes) {
        // note.wikilinks ya trae los destinos resueltos (sin alias ni anclas) y
        // noteExists los busca en el índice en memoria. Antes se comparaba el
        // texto crudo del enlace y se escaneaba el disco por cada uno: los
        // enlaces con alias salían como rotos aunque la nota existiera, y listar
        // los rotos costaba ~90.000 lecturas de directorio.
        const bad = note.wikilinks.filter((link) => !RESERVED_LINKS.has(link) && !noteExists(link));
        if (bad.length) broken.push({ note: note.name, links: [...new Set(bad)] });
      }

      if (!broken.length) return { content: [{ type: 'text', text: 'No hay wikilinks rotos en la bóveda.' }] };

      const lines = broken.map((b) => `- **${b.note}** → ${b.links.map((l) => `[[${l}]]`).join(', ')}`);
      return { content: [{ type: 'text', text: `${broken.length} nota(s) con wikilinks rotos:\n\n${lines.join('\n')}` }] };
    }

    // ── find_backlinks ──────────────────────────────────────────────────
    if (name === 'find_backlinks') {
      const allNotes = getCachedAllNotes();
      const backlinks = getBacklinks(args.name, allNotes);
      if (!backlinks.length) return { content: [{ type: 'text', text: `Ninguna nota referencia a "${args.name}".` }] };
      return { content: [{ type: 'text', text: `Backlinks de "${args.name}" (${backlinks.length}):\n${backlinks.map((b) => `- [[${b}]]`).join('\n')}` }] };
    }

    // ── find_orphans ────────────────────────────────────────────────────
    if (name === 'find_orphans') {
      const allNotes = getCachedAllNotes();
      const orphans = [];
      for (const note of allNotes) {
        const hasOutlinks = note.wikilinks.length > 0;
        const hasBacklinks = getBacklinks(note.name, allNotes).length > 0;
        if (!hasOutlinks && !hasBacklinks) orphans.push(note);
      }

      if (!orphans.length) return { content: [{ type: 'text', text: 'No hay notas huérfanas.' }] };

      const lines = orphans
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        .map((n) => `- **${n.name}** (${n.category})`);
      return { content: [{ type: 'text', text: `${orphans.length} nota(s) huérfana(s):\n\n${lines.join('\n')}` }] };
    }

    // ── rename_wikilink ─────────────────────────────────────────────────
    if (name === 'rename_wikilink') {
      const allNotes = getAllNotes();
      const oldLink = `[[${args.old_slug}]]`;
      const newLink = `[[${args.new_slug}]]`;
      const oldLinkLen = countGraphemes(oldLink);
      const newLinkLen = countGraphemes(newLink);
      let updated = 0;

      for (const note of allNotes) {
        const raw = readNoteFile(note.path);
        if (!raw.includes(oldLink)) continue;
        const { frontmatter, body: rawBody } = parseFrontmatter(raw);
        const { cleanBody } = stripAnnotationBlock(rawBody);
        const bodyTrim = cleanBody.replace(/^\s+/, '').replace(/\s+$/, '');
        if (!bodyTrim.includes(oldLink)) continue;

        // Localizar todas las ocurrencias en graphemes sobre el cuerpo trimmed
        const parts = bodyTrim.split(oldLink);
        const offsets = [];
        let cumulative = 0;
        for (let i = 0; i < parts.length - 1; i++) {
          cumulative += countGraphemes(parts[i]);
          offsets.push(cumulative);
          cumulative += oldLinkLen;
        }

        // Aplicar el reemplazo de texto
        const newBody = parts.join(newLink);

        // Cambio MECÁNICO de slug: preservar el autor original de cada wikilink renombrado.
        let bodyAuthors = extractBodyAuthorsFromRaw(raw);
        for (let i = offsets.length - 1; i >= 0; i--) {
          const orig = uniqueAuthorOfSegment(bodyAuthors, offsets[i], oldLinkLen);
          const author = orig || CLAUDE_AUTHOR;
          bodyAuthors = applyEditToAuthors(bodyAuthors, offsets[i], oldLinkLen, newLinkLen, author);
        }

        persistNote(note.path, frontmatter, newBody, bodyAuthors);
        updated++;
      }

      if (!updated) return { content: [{ type: 'text', text: `Ninguna nota referenciaba [[${args.old_slug}]].` }] };
      invalidateCache();
      return { content: [{ type: 'text', text: `${updated} nota(s) actualizadas: [[${args.old_slug}]] → [[${args.new_slug}]].` }] };
    }

    // ── list_tags ───────────────────────────────────────────────────────
    if (name === 'list_tags') {
      const allNotes = getCachedAllNotes();
      const tagCount = {};

      for (const note of allNotes) {
        const content = readNoteFile(note.path);
        const { body } = parseFrontmatter(content);
        const tags = extractHashtags(body);
        for (const t of tags) tagCount[t] = (tagCount[t] || 0) + 1;
      }

      const entries = Object.entries(tagCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!entries.length) return { content: [{ type: 'text', text: 'No hay hashtags en el cuerpo de las notas.' }] };

      const lines = entries.map(([t, c]) => `- ${t} — ${c} ${c === 1 ? 'nota' : 'notas'}`);
      return { content: [{ type: 'text', text: `${entries.length} hashtag(s) en uso:\n\n${lines.join('\n')}` }] };
    }

    // ── update_frontmatter ──────────────────────────────────────────────
    if (name === 'update_frontmatter') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const allowed = ['title', 'category', 'tags', 'created'];
      const fields = args.fields || {};
      const newFm = { ...note.frontmatter };
      for (const k of allowed) {
        if (k in fields) newFm[k] = fields[k];
      }

      // Si cambia category, mover archivo físicamente
      let destPath = note.filePath;
      if (fields.category && fields.category !== note.frontmatter.category) {
        fields.category = safeCategory(fields.category);
        const destDir = safeJoin(fields.category);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        destPath = path.join(destDir, path.basename(note.filePath));
      }

      // El cuerpo no cambia. Preservamos los rangos de autoría existentes.
      persistNote(destPath, newFm, note.body, note.bodyAuthors);
      if (destPath !== note.filePath) {
        fs.unlinkSync(note.filePath);
        cleanupEmptyAncestors(path.dirname(note.filePath));
      }

      invalidateCache();
      return { content: [{ type: 'text', text: `Frontmatter de "${args.name}" actualizado.` }] };
    }

    // ── peek_note ───────────────────────────────────────────────────────
    if (name === 'peek_note') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const fmText = note.content.match(/^---\n[\s\S]*?\n---\n?/)?.[0] || '';
      const bodyAfterH1 = note.body.replace(/^\s*#\s+.+\n+/, '');
      const firstParagraph = bodyAfterH1.split(/\n\s*\n/)[0]?.trim() || '';

      return { content: [{ type: 'text', text: `${fmText}\n${firstParagraph}` }] };
    }

    // ── read_section ────────────────────────────────────────────────────
    if (name === 'read_section') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const sec = findSection(note.body, args.section_title);
      if (!sec) return { content: [{ type: 'text', text: `No se encontró la sección "${args.section_title}" en "${args.name}".` }] };

      const lines = note.body.split('\n');
      return { content: [{ type: 'text', text: lines.slice(sec.startLine, sec.endLine).join('\n') }] };
    }

    // ── read_frontmatter ────────────────────────────────────────────────
    if (name === 'read_frontmatter') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };
      const fmText = note.content.match(/^---\n[\s\S]*?\n---\n?/)?.[0] || '(sin frontmatter)';
      return { content: [{ type: 'text', text: fmText }] };
    }

    // ── read_authorship ─────────────────────────────────────────────────
    if (name === 'read_authorship') {
      if (!ANNOTATIONS_ENABLED) {
        return { content: [{ type: 'text', text: 'Las anotaciones Markdown Annotations están desactivadas. Para activarlas, arranca el MCP con la variable de entorno KB_ENABLE_ANNOTATIONS=1.' }] };
      }
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const bodyLength = countGraphemes(note.body);
      if (!note.bodyAuthors.length) {
        return { content: [{ type: 'text', text: `Nota "${args.name}" — cuerpo de ${bodyLength} graphemes, sin bloque de anotaciones (no migrada o sin trazabilidad).` }] };
      }

      const lines = [`Nota "${args.name}" — cuerpo de ${bodyLength} graphemes.`];
      let attributedTotal = 0;
      for (const a of note.bodyAuthors) {
        const authorTotal = a.ranges.reduce((s, r) => s + r.length, 0);
        attributedTotal += authorTotal;
        const pct = bodyLength > 0 ? ((authorTotal / bodyLength) * 100).toFixed(1) : '0';
        const id = a.identifier ? ` <${a.identifier}>` : '';
        lines.push(`\n${a.prefix}${a.name}${id}: ${authorTotal} graphemes en ${a.ranges.length} rango(s) (${pct}%)`);
        for (const r of a.ranges) {
          const snippet = graphemeSlice(note.body, r.start, r.start + r.length);
          const short = snippet.length > 60 ? snippet.slice(0, 40).replace(/\n/g, '⏎') + '…' + snippet.slice(-15).replace(/\n/g, '⏎') : snippet.replace(/\n/g, '⏎');
          lines.push(`  [${r.start}..${r.start + r.length - 1}] "${short}"`);
        }
      }
      const unattributed = bodyLength - attributedTotal;
      if (unattributed > 0) {
        const pct = ((unattributed / bodyLength) * 100).toFixed(1);
        lines.push(`\nSin atribuir (renderizado como humano por defecto en iA Writer): ${unattributed} graphemes (${pct}%)`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── recently_updated ────────────────────────────────────────────────
    if (name === 'recently_updated') {
      const days = typeof args.days === 'number' ? args.days : 7;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split('T')[0];

      const allNotes = getCachedAllNotes();
      const recent = allNotes
        .filter((n) => (n.frontmatter.updated || '') >= cutoffStr)
        .sort((a, b) => (b.frontmatter.updated || '').localeCompare(a.frontmatter.updated || ''));

      if (!recent.length) return { content: [{ type: 'text', text: `Ninguna nota modificada en los últimos ${days} días.` }] };

      const lines = recent.map((n) => `- **${n.name}** (${n.category}) — ${n.frontmatter.updated}`);
      return { content: [{ type: 'text', text: `${recent.length} nota(s) modificadas en los últimos ${days} días:\n\n${lines.join('\n')}` }] };
    }

    // ── move_category ───────────────────────────────────────────────────
    if (name === 'move_category') {
      const srcDir = safeJoin(args.name);
      const destDir = safeJoin(args.new_name);

      if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: `La categoría "${args.name}" no existe.` }] };
      if (fs.existsSync(destDir)) return { content: [{ type: 'text', text: `La categoría destino "${args.new_name}" ya existe.` }] };

      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(srcDir, destDir);

      // Actualizar campo category del frontmatter de cada nota afectada
      const allNotes = getAllNotes();
      let updated = 0;
      for (const note of allNotes) {
        if (note.category === args.new_name || note.category.startsWith(`${args.new_name}/`)) {
          const oldCat = note.category.replace(args.new_name, args.name);
          if (note.frontmatter.category === oldCat || note.frontmatter.category === args.name) {
            const newCat = note.frontmatter.category === args.name
              ? args.new_name
              : note.frontmatter.category.replace(`${args.name}/`, `${args.new_name}/`);
            const raw = readNoteFile(note.path);
            const { frontmatter, body: rawBody } = parseFrontmatter(raw);
            const { cleanBody } = stripAnnotationBlock(rawBody);
            const bodyAuthors = extractBodyAuthorsFromRaw(raw);
            persistNote(note.path, { ...frontmatter, category: newCat }, cleanBody, bodyAuthors);
            updated++;
          }
        }
      }

      invalidateCache();
      return { content: [{ type: 'text', text: `Categoría "${args.name}" → "${args.new_name}". ${updated} nota(s) con frontmatter actualizado.` }] };
    }

    // ── validate_note ───────────────────────────────────────────────────
    if (name === 'validate_note') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const issues = [];
      const required = ['title', 'category', 'created', 'updated'];
      for (const f of required) {
        if (!note.frontmatter[f]) issues.push(`Falta campo "${f}" en el frontmatter`);
      }

      if (!findSection(note.body, 'Ver también')) {
        issues.push('Falta sección "## Ver también" al final');
      }

      const tags = extractHashtags(note.body);
      if (!tags.length) issues.push('No hay hashtags `#snake_case` en el cuerpo');

      const RESERVED_LINKS = new Set(['HOME', 'home']);
      const broken = [...new Set(extractLinkTargets(note.body).filter((l) => !RESERVED_LINKS.has(l) && !noteExists(l)))];
      if (broken.length) issues.push(`Wikilinks rotos: ${broken.map((b) => `[[${b}]]`).join(', ')}`);

      const dashed = extractDashedHashtags(note.body);
      if (dashed.length) {
        issues.push(`Hashtags con guión medio (los editores no los agrupan y el extractor los trunca): ${dashed.join(', ')} → usa ${dashed.map((d) => d.replace(/-/g, '_')).join(', ')}`);
      }

      if (!issues.length) return { content: [{ type: 'text', text: `Nota "${args.name}" válida. Sin problemas detectados.` }] };
      return { content: [{ type: 'text', text: `Nota "${args.name}" — ${issues.length} problema(s):\n${issues.map((i) => `- ${i}`).join('\n')}` }] };
    }

    // ── bulk_move ───────────────────────────────────────────────────────
    if (name === 'bulk_move') {
      const destDir = safeJoin(args.new_category);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const results = [];
      for (const noteName of args.names) {
        const srcPath = findNote(noteName);
        if (!srcPath) {
          results.push(`- ${noteName}: no encontrada`);
          continue;
        }
        const raw = readNoteFile(srcPath);
        const { frontmatter, body } = parseFrontmatter(raw);
        const destPath = path.join(destDir, path.basename(srcPath));
        if (destPath === srcPath) {
          results.push(`- ${noteName}: ya estaba en ${args.new_category}`);
          continue;
        }
        // El cuerpo se preserva. Extraemos los rangos de autoría existentes para mantenerlos.
        const { cleanBody } = stripAnnotationBlock(body);
        const bodyAuthors = extractBodyAuthorsFromRaw(raw);
        persistNote(
          destPath,
          {
            title: frontmatter.title || noteName,
            category: args.new_category,
            tags: frontmatter.tags,
            created: frontmatter.created || today(),
          },
          cleanBody,
          bodyAuthors,
        );
        fs.unlinkSync(srcPath);
        cleanupEmptyAncestors(path.dirname(srcPath));
        results.push(`- ${noteName}: movida a ${args.new_category}`);
      }

      invalidateCache();
      return { content: [{ type: 'text', text: `bulk_move completado:\n${results.join('\n')}` }] };
    }

    // ── migrate_annotations ─────────────────────────────────────────────
    if (name === 'migrate_annotations') {
      if (!ANNOTATIONS_ENABLED) {
        return { content: [{ type: 'text', text: 'Las anotaciones Markdown Annotations están desactivadas. Para activarlas, arranca el MCP con la variable de entorno KB_ENABLE_ANNOTATIONS=1.' }] };
      }
      const dryRun = args.dry_run !== false; // por defecto true

      // Recopilar todas las notas, incluida HOME.md (que getAllNotes excluye).
      const noteRefs = [];
      const homeFile = path.join(MEMORY_ROOT, 'HOME.md');
      if (fs.existsSync(homeFile)) noteRefs.push({ path: homeFile, name: 'HOME' });
      for (const n of getAllNotes()) noteRefs.push({ path: n.path, name: n.name });

      const toMigrate = [];
      const alreadyAnnotated = [];
      for (const nf of noteRefs) {
        try {
          const raw = readNoteFile(nf.path);
          const existing = extractBodyAuthorsFromRaw(raw);
          if (existing.length > 0) alreadyAnnotated.push(nf.name);
          else toMigrate.push(nf);
        } catch (e) {
          // archivo ilegible: lo saltamos
        }
      }

      if (dryRun) {
        const sample = toMigrate.slice(0, 15).map((n) => `  - ${n.name}`).join('\n');
        return {
          content: [{
            type: 'text',
            text: `DRY RUN — nada se ha escrito.\n\n` +
              `Notas a migrar (todo el cuerpo atribuido a &Claude): ${toMigrate.length}\n` +
              `Notas saltadas (ya tienen bloque): ${alreadyAnnotated.length}\n\n` +
              (toMigrate.length > 0 ? `Primeras 15 a migrar:\n${sample}\n\n` : '') +
              `Para ejecutar la migración real, llama de nuevo con dry_run: false.`,
          }],
        };
      }

      // Ejecución real
      let migrated = 0;
      const errors = [];
      for (const nf of toMigrate) {
        try {
          const raw = readNoteFile(nf.path);
          const { frontmatter, body: rawBody } = parseFrontmatter(raw);
          const { cleanBody } = stripAnnotationBlock(rawBody);
          const body = cleanBody.replace(/^\s+/, '').replace(/\s+$/, '');
          // bodyAuthors=null → todo el cuerpo a Claude. preserveUpdated=true → mantiene
          // el campo updated original.
          persistNote(nf.path, frontmatter, body, null, { preserveUpdated: true });
          migrated++;
        } catch (e) {
          errors.push({ name: nf.name, error: e.message });
        }
      }

      const errorText = errors.length
        ? `\n\nErrores (${errors.length}):\n${errors.map((e) => `  - ${e.name}: ${e.error}`).join('\n')}`
        : '';
      invalidateCache();
      return {
        content: [{
          type: 'text',
          text: `Migración completada.\n\n` +
            `Notas migradas: ${migrated}\n` +
            `Notas saltadas (ya tenían bloque): ${alreadyAnnotated.length}\n` +
            `Errores: ${errors.length}${errorText}`,
        }],
      };
    }

    // ── due_notes ───────────────────────────────────────────────────────
    // Comprobación de arranque de sesión: qué notas programadas vencen hoy.
    // Antes había que abrir una por una para leer su fecha; esto lo resuelve en
    // una sola llamada y, el día que no toca nada, la respuesta es una línea.
    if (name === 'due_notes') {
      const category = args?.category || 'programado';
      const allNotes = getCachedAllNotes();
      const scoped = allNotes.filter((n) => n.category === category || n.category.startsWith(category + '/'));

      if (!scoped.length) {
        return { content: [{ type: 'text', text: `No hay notas en "${category}".` }] };
      }

      const hoy = today();
      const due = [];
      const upcoming = [];
      const sinFecha = [];
      for (const note of scoped) {
        const fecha = parseAparecer(note.body || '');
        if (!fecha) { sinFecha.push(note.name); continue; }
        const item = { name: note.name, fecha, title: note.frontmatter?.title || note.name };
        if (fecha <= hoy) due.push(item); else upcoming.push(item);
      }
      due.sort((a, b) => a.fecha.localeCompare(b.fecha));
      upcoming.sort((a, b) => a.fecha.localeCompare(b.fecha));

      const partes = [];
      if (due.length) {
        partes.push(`${due.length} nota(s) programada(s) para hoy o antes (${hoy}):\n` +
          due.map((d) => `- **${d.name}** — APARECER: ${d.fecha}${d.fecha < hoy ? ' (vencida)' : ''}\n  ${d.title}`).join('\n'));
      } else {
        partes.push(`Nada programado para hoy (${hoy}). ${scoped.length} nota(s) en "${category}", todas con fecha posterior.`);
      }
      if (args?.include_upcoming && upcoming.length) {
        const dias = (f) => Math.round((new Date(f) - new Date(hoy)) / 86400000);
        partes.push(`Próximas:\n` + upcoming.map((u) => `- ${u.name} — ${u.fecha} (en ${dias(u.fecha)} día(s))`).join('\n'));
      }
      if (sinFecha.length) {
        partes.push(`Sin línea APARECER (revisar): ${sinFecha.join(', ')}`);
      }
      return { content: [{ type: 'text', text: partes.join('\n\n') }] };
    }

    // ── list_sections ───────────────────────────────────────────────────
    if (name === 'list_sections') {
      const note = loadNote(args.name);
      if (!note) return { content: [{ type: 'text', text: `Nota "${args.name}" no encontrada.` }] };

      const outline = outlineOf(note.body);
      if (!outline.length) {
        return { content: [{ type: 'text', text: `La nota "${args.name}" no tiene encabezados.` }] };
      }
      const totalLines = note.body.split('\n').length;
      const lines = outline.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.title} (nivel ${h.level}, ${h.lines} líneas)`);
      return {
        content: [{
          type: 'text',
          text: `Secciones de "${args.name}" — ${outline.length} encabezado(s), ${totalLines} líneas en total:\n\n${lines.join('\n')}\n\nLee solo lo que necesites con read_section.`,
        }],
      };
    }

    // ── migrate_yaml_tags ───────────────────────────────────────────────
    // Una bóveda que clasifica con hashtags en el cuerpo no gana nada
    // arrastrando además tags en el frontmatter: los editores que agrupan por
    // etiqueta no leen el YAML, así que esas notas figuran como sin clasificar.
    // Esta operación baja al cuerpo lo que solo estaba arriba y deja el
    // frontmatter limpio, sin perder ninguna etiqueta por el camino.
    if (name === 'migrate_yaml_tags') {
      const dryRun = args?.dry_run !== false;
      const descartar = new Set((args?.drop || []).map((t) => normalizeTagName(t)));
      const allNotes = getCachedAllNotes();
      const scoped = args?.category
        ? allNotes.filter((n) => n.category === args.category || n.category.startsWith(args.category + '/'))
        : allNotes;

      const plan = [];
      for (const note of scoped) {
        const yaml = note.frontmatter?.tags;
        const lista = Array.isArray(yaml) ? yaml : (yaml ? [yaml] : []);
        const limpios = lista.map((t) => normalizeTagName(t)).filter(Boolean);
        if (!limpios.length) continue;

        const enCuerpo = new Set(extractHashtags(note.body || '').map((h) => normalizeTagName(h)));
        const rescatar = [];
        for (const tag of limpios) {
          if (enCuerpo.has(tag) || descartar.has(tag) || rescatar.includes(tag)) continue;
          rescatar.push(tag);
        }
        plan.push({ note, rescatar, descartados: limpios.filter((t) => descartar.has(t)) });
      }

      if (!plan.length) {
        return { content: [{ type: 'text', text: 'No queda ninguna nota con tags en el frontmatter. Nada que migrar.' }] };
      }

      const totalRescatados = plan.reduce((s, p) => s + p.rescatar.length, 0);
      const soloVaciar = plan.filter((p) => !p.rescatar.length).length;

      if (dryRun) {
        const ejemplos = plan
          .filter((p) => p.rescatar.length)
          .slice(0, 25)
          .map((p) => `- **${p.note.name}** (${p.note.category}) → ${p.rescatar.map((t) => '#' + t).join(' ')}`);
        return {
          content: [{
            type: 'text',
            text: `SIMULACIÓN (no se ha escrito nada).\n\n` +
              `- Notas con tags en el frontmatter: **${plan.length}**\n` +
              `- Etiquetas que bajarían al cuerpo: **${totalRescatados}**\n` +
              `- Notas en las que solo hay que vaciar el frontmatter (sus tags ya estaban en el cuerpo): **${soloVaciar}**\n` +
              (descartar.size ? `- Etiquetas descartadas por petición: ${[...descartar].join(', ')}\n` : '') +
              `\nPrimeras notas afectadas:\n${ejemplos.join('\n')}\n` +
              (plan.filter((p) => p.rescatar.length).length > 25 ? `… y ${plan.filter((p) => p.rescatar.length).length - 25} más.\n` : '') +
              `\nPara ejecutarla de verdad: \`migrate_yaml_tags(dry_run: false)\`.`,
          }],
        };
      }

      let migradas = 0;
      let bajadas = 0;
      const errores = [];
      for (const { note: indexed, rescatar } of plan) {
        try {
          const note = loadNote(indexed.name);
          if (!note) { errores.push(`${indexed.name}: no encontrada`); continue; }

          let newBody = note.body;
          if (rescatar.length) {
            const nuevos = rescatar.map((t) => '#' + t).join(' ');
            const lineas = newBody.split('\n');
            // ¿La nota termina ya con una línea de hashtags? Entonces se amplía;
            // si no, se crea una nueva al final del cuerpo.
            let idx = -1;
            for (let i = lineas.length - 1; i >= 0 && i >= lineas.length - 4; i--) {
              if (!lineas[i].trim()) continue;
              if (/^(#[a-z][a-z0-9_]*)(\s+#[a-z][a-z0-9_]*)*\s*$/.test(lineas[i].trim())) idx = i;
              break;
            }
            if (idx >= 0) {
              lineas[idx] = `${lineas[idx].trimEnd()} ${nuevos}`;
              newBody = lineas.join('\n');
            } else {
              newBody = `${newBody.replace(/\s+$/, '')}\n\n${nuevos}`;
            }
            bajadas += rescatar.length;
          }

          // La autoría del fragmento se conserva: es un cambio mecánico de
          // etiquetas, no contenido nuevo de nadie.
          let authors = note.bodyAuthors;
          if (newBody !== note.body) {
            const diff = computeBodyDiff(note.body, newBody);
            const original = uniqueAuthorOfSegment(note.bodyAuthors, diff.editStart, diff.oldLength);
            authors = applyEditToAuthors(note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength, original || CLAUDE_AUTHOR);
          }

          persistNote(
            note.filePath,
            { ...note.frontmatter, tags: [] },
            newBody,
            authors,
            { preserveUpdated: true },
          );
          migradas++;
        } catch (e) {
          errores.push(`${indexed.name}: ${e.message}`);
        }
      }
      invalidateCache();

      return {
        content: [{
          type: 'text',
          text: `Migración completada.\n\n` +
            `- Notas con el frontmatter ya limpio: **${migradas}**\n` +
            `- Etiquetas bajadas al cuerpo: **${bajadas}**\n` +
            `- Fecha de modificación y autoría: preservadas\n` +
            (errores.length ? `\nErrores (${errores.length}):\n- ${errores.join('\n- ')}` : '- Errores: ninguno'),
        }],
      };
    }

    // ── audit_tags ──────────────────────────────────────────────────────
    if (name === 'audit_tags') {
      const allNotes = getCachedAllNotes();
      const conteo = new Map();
      const conGuion = [];
      const conYaml = [];

      for (const note of allNotes) {
        for (const h of extractHashtags(note.body || '')) {
          conteo.set(h, (conteo.get(h) || 0) + 1);
        }
        const dashed = extractDashedHashtags(note.body || '');
        if (dashed.length) conGuion.push({ note: note.name, tags: dashed });
        const yaml = note.frontmatter?.tags;
        const list = Array.isArray(yaml) ? yaml : (yaml ? [yaml] : []);
        if (list.length) conYaml.push(note.name);
      }

      // Corrección opcional de los hashtags con guión medio.
      let corregidas = 0;
      const errores = [];
      if (args?.fix_dashes && conGuion.length) {
        for (const { note: noteName, tags } of conGuion) {
          try {
            const note = loadNote(noteName);
            if (!note) { errores.push(`${noteName}: no encontrada`); continue; }
            let newBody = note.body;
            for (const tag of tags) {
              const fixed = tag.replace(/-/g, '_');
              newBody = newBody.split(tag).join(fixed);
            }
            if (newBody === note.body) continue;
            const diff = computeBodyDiff(note.body, newBody);
            // Cambio MECÁNICO de etiqueta: se conserva la autoría del fragmento.
            const original = uniqueAuthorOfSegment(note.bodyAuthors, diff.editStart, diff.oldLength);
            const newAuthors = applyEditToAuthors(
              note.bodyAuthors, diff.editStart, diff.oldLength, diff.newLength, original || CLAUDE_AUTHOR,
            );
            persistNote(note.filePath, note.frontmatter, newBody, newAuthors, { preserveUpdated: true });
            corregidas++;
          } catch (e) {
            errores.push(`${noteName}: ${e.message}`);
          }
        }
        invalidateCache();
      }

      const usadasUnaVez = [...conteo.entries()].filter(([, n]) => n === 1).map(([t]) => t);
      const tipos = [...conteo.keys()].filter((t) => t.startsWith('#tipo_')).sort();

      const partes = [
        `Auditoría de etiquetas — ${conteo.size} hashtags distintos en ${allNotes.length} notas.`,
        conGuion.length
          ? `**Con guión medio (${conGuion.length} nota(s)):** los editores no los agrupan y el extractor los trunca en el guión.\n` +
            conGuion.map((c) => `- ${c.note}: ${c.tags.join(', ')} → ${c.tags.map((t) => t.replace(/-/g, '_')).join(', ')}`).join('\n')
          : 'Sin hashtags con guión medio.',
        `**Variantes de tipo en uso (${tipos.length}):** ${tipos.join(' ') || 'ninguna'}`,
        `**Usadas una sola vez (${usadasUnaVez.length}):** ${usadasUnaVez.slice(0, 40).join(' ')}${usadasUnaVez.length > 40 ? ' …' : ''}`,
        `**Notas con tags en el frontmatter YAML (${conYaml.length}):** la doctrina las quiere en el cuerpo; el filtro de list_notes ya mira las dos.`,
      ];
      if (args?.fix_dashes) {
        partes.push(`**Corrección aplicada:** ${corregidas} nota(s) actualizadas${errores.length ? `, ${errores.length} error(es):\n- ${errores.join('\n- ')}` : '.'}`);
      } else if (conGuion.length) {
        partes.push('_Para corregir los guiones automáticamente: `audit_tags(fix_dashes: true)`._');
      }

      return { content: [{ type: 'text', text: partes.join('\n\n') }] };
    }

    return { content: [{ type: 'text', text: `Herramienta desconocida: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

// ─── Arranque ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
