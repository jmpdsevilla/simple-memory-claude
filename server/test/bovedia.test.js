// Pruebas de BovedIA — se ejecutan con `npm test` (node --test, sin dependencias).
//
// Cada prueba levanta el servidor MCP real por stdio contra una bóveda temporal
// creada al vuelo, y habla con él en JSON-RPC igual que lo haría Claude. Así se
// prueba el comportamiento de verdad (el que ve el cliente), no funciones sueltas.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

// ─── Cliente MCP mínimo por stdio ───────────────────────────────────────────
class Cliente {
  constructor(root, env = {}) {
    this.proc = spawn('node', [SERVER], {
      env: { ...process.env, KB_MEMORY_ROOT: root, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pendientes = new Map();
    this.id = 0;
    this.buffer = '';
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const linea = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!linea) continue;
        try {
          const msg = JSON.parse(linea);
          const resolver = this.pendientes.get(msg.id);
          if (resolver) { this.pendientes.delete(msg.id); resolver(msg); }
        } catch { /* línea no JSON: ignorar */ }
      }
    });
  }

  enviar(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout en ${method}`)), 10000);
      this.pendientes.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async iniciar() {
    await this.enviar('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    return this;
  }

  async tools() {
    const r = await this.enviar('tools/list');
    return r.result.tools;
  }

  // Devuelve el texto de la respuesta de una tool.
  async llamar(name, args = {}) {
    const r = await this.enviar('tools/call', { name, arguments: args });
    const texto = r.result?.content?.[0]?.text ?? '';
    return { texto, error: r.result?.isError === true };
  }

  cerrar() { this.proc.kill(); }
}

function bovedaTemporal(nombre) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bovedia-test-${nombre}-`));
}

// ─── Suite principal ────────────────────────────────────────────────────────
describe('BovedIA', () => {
  let root;
  let kb;

  before(async () => {
    root = bovedaTemporal('main');
    kb = await new Cliente(root, { KB_ENABLE_ANNOTATIONS: '1' }).iniciar();
  });

  after(() => {
    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('seguridad de rutas', () => {
    test('write_note rechaza una categoría que se sale de la bóveda', async () => {
      const { texto, error } = await kb.llamar('write_note', {
        title: 'Escape', content: 'nada', category: '../../escapada',
      });
      assert.equal(error, true);
      assert.match(texto, /fuera de la bóveda/i);
      assert.equal(fs.existsSync(path.join(root, '..', '..', 'escapada')), false);
    });

    test('bulk_move rechaza un destino fuera de la bóveda', async () => {
      const bulk = await kb.llamar('bulk_move', { names: ['x'], new_category: '../fuera' });
      assert.equal(bulk.error, true);
    });

    test('create_category neutraliza el "..": crea dentro, nunca fuera', async () => {
      const { error } = await kb.llamar('create_category', { name: '../fuera' });
      assert.equal(error, false);
      assert.ok(fs.existsSync(path.join(root, 'fuera')));
      assert.equal(fs.existsSync(path.join(root, '..', 'fuera')), false);
    });

    test('create_category crea rutas anidadas de verdad', async () => {
      await kb.llamar('create_category', { name: 'conocimiento/problemas-resueltos/mcp' });
      assert.ok(fs.existsSync(path.join(root, 'conocimiento', 'problemas-resueltos', 'mcp')));
    });

    test('una categoría anidada normal sí funciona', async () => {
      const { error } = await kb.llamar('write_note', {
        title: 'Nota anidada', content: 'contenido', category: 'conocimiento/problemas-resueltos',
      });
      assert.equal(error, false);
      assert.ok(fs.existsSync(path.join(root, 'conocimiento', 'problemas-resueltos', 'nota-anidada.md')));
    });
  });

  describe('escritura y lectura', () => {
    test('write_note crea la nota y read_note la devuelve', async () => {
      await kb.llamar('write_note', { title: 'La Pirámide', content: 'Regla madre del sistema.', category: 'sistema' });
      const { texto } = await kb.llamar('read_note', { name: 'la-piramide' });
      assert.match(texto, /Regla madre del sistema/);
      assert.match(texto, /title: La Pirámide/);
    });

    test('read_note no muestra el bloque de anotaciones', async () => {
      const { texto } = await kb.llamar('read_note', { name: 'la-piramide' });
      assert.doesNotMatch(texto, /SHA-256/);
    });

    test('edit_note encuentra texto acentuado (normalización NFC)', async () => {
      await kb.llamar('write_note', { title: 'Versión', content: 'La versión está aquí.', category: 'sistema' });
      const { error } = await kb.llamar('edit_note', {
        name: 'version', old_text: 'La versión está aquí.', new_text: 'La versión ya no está.',
      });
      assert.equal(error, false);
      const { texto } = await kb.llamar('read_note', { name: 'version' });
      assert.match(texto, /ya no está/);
    });
  });

  describe('validación de argumentos', () => {
    test('avisa del parámetro que falta y del que sobra, en vez de mentir', async () => {
      const { texto, error } = await kb.llamar('edit_note', {
        name: 'la-piramide', old_string: 'a', new_string: 'b',
      });
      assert.equal(error, true);
      assert.match(texto, /Falta.*old_text/);
      assert.match(texto, /old_string/);
      assert.doesNotMatch(texto, /no se encontró el texto/i);
    });

    test('la cadena vacía es un valor válido: borrar es reemplazar por ""', async () => {
      await kb.llamar('write_note', { title: 'Para borrar', content: 'Linea uno.\nSOBRA ESTA LINEA\nLinea tres.', category: 'sistema' });
      const { error } = await kb.llamar('edit_note', {
        name: 'para-borrar', old_text: 'SOBRA ESTA LINEA\n', new_text: '',
      });
      assert.equal(error, false);
      const { texto } = await kb.llamar('read_note', { name: 'para-borrar' });
      assert.doesNotMatch(texto, /SOBRA/);
      assert.match(texto, /Linea tres/);
    });

    test('una llamada correcta sigue funcionando', async () => {
      const { error } = await kb.llamar('edit_note', {
        name: 'la-piramide', old_text: 'Regla madre', new_text: 'Regla maestra',
      });
      assert.equal(error, false);
    });
  });

  describe('búsqueda', () => {
    before(async () => {
      await kb.llamar('write_note', { title: 'Nota con tilde', content: 'Aquí hablamos de la pirámide del sistema.', category: 'conocimiento' });
      await kb.llamar('write_note', { title: 'Nota sin tilde', content: 'Aqui hablamos de la piramide tambien.', category: 'conocimiento' });
    });

    test('encuentra lo mismo con y sin acentos', async () => {
      const con = await kb.llamar('search_notes', { query: 'pirámide' });
      const sin = await kb.llamar('search_notes', { query: 'piramide' });
      for (const r of [con, sin]) {
        assert.match(r.texto, /nota-con-tilde/);
        assert.match(r.texto, /nota-sin-tilde/);
      }
    });

    test('no distingue mayúsculas', async () => {
      const { texto } = await kb.llamar('search_notes', { query: 'PIRÁMIDE' });
      assert.match(texto, /nota-con-tilde/);
    });

    test('los extractos no incluyen el bloque de anotaciones', async () => {
      const { texto } = await kb.llamar('search_notes', { query: 'piramide' });
      assert.doesNotMatch(texto, /SHA-256/);
      assert.doesNotMatch(texto, /Annotations:/);
    });

    test('respeta el límite y avisa de cuántos quedan', async () => {
      const { texto } = await kb.llamar('search_notes', { query: 'hablamos', limit: 1 });
      assert.match(texto, /Mostrando 1 de 2/);
    });

    test('acota por categoría', async () => {
      const { texto } = await kb.llamar('search_notes', { query: 'piramide', category: 'sistema' });
      assert.doesNotMatch(texto, /nota-con-tilde/);
    });

    test('prioriza la coincidencia en el título sobre la del cuerpo', async () => {
      await kb.llamar('write_note', { title: 'Traefik', content: 'Ficha del proxy.', category: 'sistema' });
      await kb.llamar('write_note', { title: 'Otra cosa', content: 'Aquí se menciona traefik de pasada.', category: 'sistema' });
      const { texto } = await kb.llamar('search_notes', { query: 'traefik' });
      assert.ok(texto.indexOf('**traefik**') < texto.indexOf('**otra-cosa**'));
    });
  });

  describe('wikilinks', () => {
    before(async () => {
      await kb.llamar('write_note', { title: 'Destino', content: 'Soy el destino.', category: 'sistema' });
      await kb.llamar('write_note', {
        title: 'Origen',
        content: 'Enlace normal [[destino]], con alias [[destino|el destino]], a sección [[destino#Ver también]], ancla propia [[#Mi sección]] y roto [[no-existe]].',
        category: 'sistema',
      });
    });

    test('los enlaces con alias y con ancla no cuentan como rotos', async () => {
      const { texto } = await kb.llamar('list_broken_links');
      assert.match(texto, /no-existe/);
      assert.doesNotMatch(texto, /destino\|/);
      assert.doesNotMatch(texto, /#Mi sección/);
    });

    test('el backlink se registra aunque el enlace lleve alias', async () => {
      const { texto } = await kb.llamar('find_backlinks', { name: 'destino' });
      assert.match(texto, /origen/);
    });

    test('validate_note señala solo el enlace realmente roto', async () => {
      const { texto } = await kb.llamar('validate_note', { name: 'origen' });
      assert.match(texto, /\[\[no-existe\]\]/);
      assert.doesNotMatch(texto, /\[\[destino\]\]/);
    });
  });

  describe('list_sections', () => {
    test('devuelve los encabezados con su nivel', async () => {
      await kb.llamar('write_note', {
        title: 'Nota larga',
        content: '## Primera\ntexto\n\n### Anidada\nmás texto\n\n## Segunda\nfinal',
        category: 'conocimiento',
      });
      const { texto } = await kb.llamar('list_sections', { name: 'nota-larga' });
      assert.match(texto, /Primera/);
      assert.match(texto, /Anidada.*nivel 3/);
      assert.match(texto, /Segunda/);
    });

    test('ignora los encabezados dentro de bloques de código', async () => {
      await kb.llamar('write_note', {
        title: 'Con codigo',
        content: '## Real\n\n```\n## Falso\n```\n',
        category: 'conocimiento',
      });
      const { texto } = await kb.llamar('list_sections', { name: 'con-codigo' });
      assert.match(texto, /Real/);
      assert.doesNotMatch(texto, /Falso/);
    });
  });

  describe('due_notes', () => {
    test('devuelve las vencidas y calla las futuras', async () => {
      const ayer = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const dentroDeUnAno = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
      await kb.llamar('write_note', { title: 'Toca ya', content: `> **APARECER: ${ayer}** — vencida`, category: 'programado' });
      await kb.llamar('write_note', { title: 'Toca luego', content: `> APARECER: ${dentroDeUnAno}`, category: 'programado' });

      const { texto } = await kb.llamar('due_notes');
      assert.match(texto, /toca-ya/);
      assert.doesNotMatch(texto, /toca-luego/);
    });

    test('con include_upcoming lista también las futuras', async () => {
      const { texto } = await kb.llamar('due_notes', { include_upcoming: true });
      assert.match(texto, /toca-luego/);
    });

    test('avisa de las notas programadas sin fecha', async () => {
      await kb.llamar('write_note', { title: 'Sin fecha', content: 'me falta la línea', category: 'programado' });
      const { texto } = await kb.llamar('due_notes');
      assert.match(texto, /Sin línea APARECER.*sin-fecha/s);
    });
  });

  describe('etiquetas', () => {
    test('audit_tags detecta los hashtags con guión medio', async () => {
      await kb.llamar('write_note', { title: 'Con guiones', content: 'Cuerpo.\n\n#nano-banana #tipo_referencia', category: 'conocimiento' });
      const { texto } = await kb.llamar('audit_tags');
      assert.match(texto, /#nano-banana → #nano_banana/);
    });

    test('fix_dashes los corrige en la nota', async () => {
      await kb.llamar('audit_tags', { fix_dashes: true });
      const { texto } = await kb.llamar('read_note', { name: 'con-guiones' });
      assert.match(texto, /#nano_banana/);
      assert.doesNotMatch(texto, /#nano-banana/);
    });

    test('reconoce hashtags que empiezan por dígito (#2fa) pero no los numéricos', async () => {
      await kb.llamar('write_note', {
        title: 'Codigos de recuperacion',
        content: 'Cuerpo con el año #2026 suelto en el texto.\n\n#tipo_referencia #smc #2fa #seguridad',
        category: 'sistema',
      });
      const filtro = await kb.llamar('list_notes', { tag: '2fa' });
      assert.match(filtro.texto, /codigos-de-recuperacion/);
      const auditoria = await kb.llamar('audit_tags');
      assert.match(auditoria.texto, /#2fa/);
      assert.doesNotMatch(auditoria.texto, /#2026/);
    });

    test('list_notes filtra por hashtag del cuerpo, no solo por YAML', async () => {
      const { texto } = await kb.llamar('list_notes', { tag: 'tipo_referencia' });
      assert.match(texto, /con-guiones/);
    });
  });

  describe('migrate_yaml_tags', () => {
    // Se monta una bóveda aparte: la migración toca todas las notas.
    let raiz;
    let mig;

    before(async () => {
      raiz = bovedaTemporal('migracion');
      mig = await new Cliente(raiz, { KB_ENABLE_ANNOTATIONS: '1' }).iniciar();
      // (a) tags YAML que no están en el cuerpo, y la nota ya tiene hashtags
      await mig.llamar('write_note', {
        title: 'Con hashtags', content: 'Cuerpo.\n\n#tipo_referencia', category: 'conocimiento',
        tags: ['GSC', 'Diseño Web', 'autor-claude'],
      });
      // (b) tags YAML y ningún hashtag en el cuerpo
      await mig.llamar('write_note', {
        title: 'Sin hashtags', content: 'Solo cuerpo, sin etiquetas.', category: 'conocimiento',
        tags: ['supabase', 'postgres'],
      });
      // (c) tags YAML ya duplicados en el cuerpo
      await mig.llamar('write_note', {
        title: 'Duplicada', content: 'Cuerpo.\n\n#vercel #deploy', category: 'conocimiento',
        tags: ['vercel', 'deploy'],
      });
    });

    after(() => {
      mig.cerrar();
      fs.rmSync(raiz, { recursive: true, force: true });
    });

    test('dry_run informa y no escribe nada', async () => {
      const { texto } = await mig.llamar('migrate_yaml_tags');
      assert.match(texto, /SIMULACIÓN/);
      assert.match(texto, /Notas con tags en el frontmatter: \*\*3\*\*/);
      const nota = await mig.llamar('read_note', { name: 'sin-hashtags' });
      assert.match(nota.texto, /tags: \[supabase, postgres\]/);
    });

    test('baja las etiquetas al cuerpo en forma snake_case y sin acentos', async () => {
      await mig.llamar('migrate_yaml_tags', { dry_run: false });
      const { texto } = await mig.llamar('read_note', { name: 'con-hashtags' });
      assert.match(texto, /#tipo_referencia #gsc #diseno_web #autor_claude/);
    });

    test('crea la línea de hashtags si la nota no tenía', async () => {
      const { texto } = await mig.llamar('read_note', { name: 'sin-hashtags' });
      assert.match(texto, /#supabase #postgres/);
    });

    test('no duplica las que ya estaban en el cuerpo', async () => {
      const { texto } = await mig.llamar('read_note', { name: 'duplicada' });
      assert.equal((texto.match(/#vercel/g) || []).length, 1);
    });

    test('deja el frontmatter sin el campo tags', async () => {
      for (const n of ['con-hashtags', 'sin-hashtags', 'duplicada']) {
        const { texto } = await mig.llamar('read_frontmatter', { name: n });
        assert.doesNotMatch(texto, /tags:/);
      }
    });

    test('conserva la fecha de modificación original', async () => {
      const { texto } = await mig.llamar('read_frontmatter', { name: 'duplicada' });
      const hoy = new Date().toISOString().split('T')[0];
      assert.match(texto, new RegExp(`updated: ${hoy}`)); // creadas hoy en el test
      assert.match(texto, /created:/);
    });

    test('también limpia las notas que solo tenían "tags: []" vacío', async () => {
      // Una nota heredada de una versión anterior: campo presente, sin valores.
      const ruta = path.join(raiz, 'conocimiento', 'heredada.md');
      fs.writeFileSync(ruta, '---\ntitle: Heredada\ncategory: conocimiento\ntags: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Heredada\n\nCuerpo.\n\n#tipo_referencia\n');
      // El archivo se ha creado por fuera del MCP: una escritura cualquiera
      // invalida la caché del índice y la nota entra en el siguiente barrido.
      await mig.llamar('write_note', { title: 'Toque', content: 'x', category: 'conocimiento' });

      const previo = await mig.llamar('migrate_yaml_tags');
      assert.match(previo.texto, /Notas con tags en el frontmatter: \*\*1\*\*/);

      await mig.llamar('migrate_yaml_tags', { dry_run: false });
      const contenido = fs.readFileSync(ruta, 'utf8');
      assert.doesNotMatch(contenido, /tags:/);
      assert.match(contenido, /updated: 2026-01-01/); // la fecha no se toca
      assert.match(contenido, /#tipo_referencia/);
    });

    test('es idempotente: una segunda pasada no encuentra nada', async () => {
      const { texto } = await mig.llamar('migrate_yaml_tags', { dry_run: false });
      assert.match(texto, /Nada que migrar/);
    });

    test('las etiquetas migradas quedan buscables y filtrables', async () => {
      const busqueda = await mig.llamar('search_notes', { query: 'postgres' });
      assert.match(busqueda.texto, /sin-hashtags/);
      const filtro = await mig.llamar('list_notes', { tag: 'diseno_web' });
      assert.match(filtro.texto, /con-hashtags/);
    });

    test('drop descarta las etiquetas indicadas en vez de bajarlas', async () => {
      const otra = bovedaTemporal('migracion-drop');
      const kb2 = await new Cliente(otra).iniciar();
      await kb2.llamar('write_note', { title: 'Ruido', content: 'Cuerpo.', category: 'x', tags: ['proyecto', 'supabase'] });
      await kb2.llamar('migrate_yaml_tags', { dry_run: false, drop: ['proyecto'] });
      const { texto } = await kb2.llamar('read_note', { name: 'ruido' });
      assert.match(texto, /#supabase/);
      assert.doesNotMatch(texto, /#proyecto/);
      kb2.cerrar();
      fs.rmSync(otra, { recursive: true, force: true });
    });
  });

  describe('prune_tags', () => {
    let raiz;
    let pr;

    before(async () => {
      raiz = bovedaTemporal('poda');
      pr = await new Cliente(raiz, { KB_ENABLE_ANNOTATIONS: '1' }).iniciar();
      // #comun sale en las tres notas; #raro1/#raro2/#raro3 solo en una cada una.
      await pr.llamar('write_note', {
        title: 'Sobrecargada',
        content: 'Cuerpo.\n\n#tipo_filosofia #smc #comun #otro_comun #raro1 #raro2 #raro3 #autor_claude',
        category: 'conocimiento',
      });
      await pr.llamar('write_note', {
        title: 'Justa', content: 'Cuerpo.\n\n#tipo_referencia #smc #comun #otro_comun', category: 'conocimiento',
      });
      await pr.llamar('write_note', {
        title: 'Con variante', content: 'Cuerpo.\n\n#tipo_runbook #smc #comun #otro_comun', category: 'conocimiento',
      });
    });

    after(() => {
      pr.cerrar();
      fs.rmSync(raiz, { recursive: true, force: true });
    });

    const OPCIONES = {
      merge: { tipo_filosofia: 'tipo_doctrina', tipo_runbook: 'tipo_proceso' },
      keep: ['smc', 'autor_claude'],
      max: 6,
    };

    test('la simulación no escribe', async () => {
      const { texto } = await pr.llamar('prune_tags', OPCIONES);
      assert.match(texto, /SIMULACIÓN/);
      const nota = await pr.llamar('read_note', { name: 'sobrecargada' });
      assert.match(nota.texto, /#raro3/);
    });

    test('fusiona las variantes indicadas', async () => {
      await pr.llamar('prune_tags', { ...OPCIONES, dry_run: false });
      const doctrina = await pr.llamar('read_note', { name: 'sobrecargada' });
      assert.match(doctrina.texto, /#tipo_doctrina/);
      assert.doesNotMatch(doctrina.texto, /#tipo_filosofia/);
      const proceso = await pr.llamar('read_note', { name: 'con-variante' });
      assert.match(proceso.texto, /#tipo_proceso/);
    });

    test('recorta al máximo conservando tipo, keep y las que más agrupan', async () => {
      const { texto } = await pr.llamar('read_note', { name: 'sobrecargada' });
      const etiquetas = texto.match(/#[a-z][a-z0-9_]*/g).filter((t) => t !== '#Backlinks');
      assert.ok(etiquetas.length <= 6, `quedaron ${etiquetas.length}`);
      assert.match(texto, /#tipo_doctrina/);   // el tipo se conserva
      assert.match(texto, /#smc/);             // keep
      assert.match(texto, /#autor_claude/);    // keep
      assert.match(texto, /#comun/);           // la que agrupa en 3 notas
      assert.doesNotMatch(texto, /#raro3/);    // uso único: fuera
    });

    test('conserva la etiqueta que da identidad a la nota aunque sea de uso único', async () => {
      await pr.llamar('write_note', {
        title: 'Hyperframes fabricación de vídeo',
        content: 'Cuerpo.\n\n#tipo_referencia #smc #comun #otro_comun #hyperframes #autor_claude',
        category: 'conocimiento',
      });
      await pr.llamar('prune_tags', { ...OPCIONES, dry_run: false, max: 5 });
      const { texto } = await pr.llamar('read_note', { name: 'hyperframes-fabricacion-de-video' });
      // #hyperframes está en el título: se queda por delante de las genéricas.
      assert.match(texto, /#hyperframes/);
    });

    test('no toca las notas que ya cumplen', async () => {
      const antes = await pr.llamar('read_frontmatter', { name: 'justa' });
      await pr.llamar('prune_tags', { ...OPCIONES, dry_run: false });
      const despues = await pr.llamar('read_frontmatter', { name: 'justa' });
      assert.equal(antes.texto, despues.texto);
    });

    test('preserva la fecha de modificación', async () => {
      const ruta = path.join(raiz, 'conocimiento', 'vieja.md');
      fs.writeFileSync(ruta, '---\ntitle: Vieja\ncategory: conocimiento\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Vieja\n\nCuerpo.\n\n#tipo_runbook #smc #comun #raro9 #raro8 #raro7 #raro6 #autor_claude\n');
      await pr.llamar('write_note', { title: 'Toque poda', content: 'x', category: 'conocimiento' });
      await pr.llamar('prune_tags', { ...OPCIONES, dry_run: false });
      const contenido = fs.readFileSync(ruta, 'utf8');
      assert.match(contenido, /updated: 2026-01-01/);
      assert.match(contenido, /#tipo_proceso/);
    });

    test('es idempotente', async () => {
      const { texto } = await pr.llamar('prune_tags', OPCIONES);
      assert.match(texto, /No hay nada que podar/);
    });
  });

  describe('get_index', () => {
    test('por defecto devuelve solo el árbol de categorías', async () => {
      const { texto } = await kb.llamar('get_index');
      assert.match(texto, /## sistema/);
      assert.doesNotMatch(texto, /\[\[la-piramide\]\]/);
    });

    test('con full:true lista las notas', async () => {
      const { texto } = await kb.llamar('get_index', { full: true, category: 'sistema' });
      assert.match(texto, /\[\[la-piramide\]\]/);
    });
  });

  describe('HOME es una nota como las demás', () => {
    before(async () => {
      fs.writeFileSync(
        path.join(root, 'HOME.md'),
        '---\ntitle: HOME\ncategory: .\ntags: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# HOME\n\nMapa de la bóveda: [[la-piramide]] y [[no-existe-esta]].\n\n#mapa\n',
      );
      await kb.llamar('write_note', { title: 'Toque HOME', content: 'x', category: 'sistema' });
    });

    test('read_note("HOME") sigue funcionando', async () => {
      const { texto } = await kb.llamar('read_note', { name: 'HOME' });
      assert.match(texto, /Mapa de la bóveda/);
    });

    test('aparece en el índice', async () => {
      const { texto } = await kb.llamar('get_index', { full: true, category: '.' });
      assert.match(texto, /HOME/);
    });

    test('sus wikilinks rotos se detectan', async () => {
      const { texto } = await kb.llamar('list_broken_links');
      assert.match(texto, /no-existe-esta/);
    });

    test('registra backlinks hacia otras notas', async () => {
      const { texto } = await kb.llamar('find_backlinks', { name: 'la-piramide' });
      assert.match(texto, /HOME/);
    });

    test('la raíz se puede filtrar como "." (la forma que se guarda)', async () => {
      const porPunto = await kb.llamar('list_notes', { category: '.' });
      assert.match(porPunto.texto, /HOME/);
      const porNombre = await kb.llamar('list_notes', { category: 'raiz' });
      assert.match(porNombre.texto, /HOME/);
      // Filtrar por la raíz no debe arrastrar las notas de las subcarpetas.
      assert.doesNotMatch(porPunto.texto, /la-piramide/);
    });

    test('la migración de etiquetas también la alcanza', async () => {
      await kb.llamar('migrate_yaml_tags', { dry_run: false });
      const contenido = fs.readFileSync(path.join(root, 'HOME.md'), 'utf8');
      assert.doesNotMatch(contenido, /tags:/);
      assert.match(contenido, /updated: 2026-01-01/);
    });
  });

  describe('mantenimiento', () => {
    test('move_note actualiza los wikilinks que apuntaban a la nota', async () => {
      await kb.llamar('move_note', { name: 'destino', new_title: 'Destino Nuevo' });
      const { texto } = await kb.llamar('read_note', { name: 'origen' });
      assert.match(texto, /destino-nuevo/);
    });

    test('find_orphans no cuenta como huérfana una nota enlazada', async () => {
      const { texto } = await kb.llamar('find_orphans');
      assert.doesNotMatch(texto, /destino-nuevo/);
    });
  });
});

// ─── Perfiles de herramientas ───────────────────────────────────────────────
describe('perfiles de herramientas', () => {
  test('sin anotaciones no se exponen las tools de autoría', async () => {
    const root = bovedaTemporal('perfil-off');
    const kb = await new Cliente(root).iniciar();
    const nombres = (await kb.tools()).map((t) => t.name);
    assert.ok(!nombres.includes('read_authorship'));
    assert.ok(!nombres.includes('migrate_annotations'));
    assert.ok(nombres.includes('read_note'));
    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('KB_TOOLS=core expone un juego reducido y más barato', async () => {
    const root = bovedaTemporal('perfil-core');
    const kb = await new Cliente(root, { KB_TOOLS: 'core' }).iniciar();
    const tools = await kb.tools();
    const nombres = tools.map((t) => t.name);
    assert.ok(nombres.includes('read_note'));
    assert.ok(nombres.includes('due_notes'));
    assert.ok(!nombres.includes('migrate_annotations'));
    assert.ok(!nombres.includes('move_category'));
    assert.ok(JSON.stringify(tools).length < 12000, 'el perfil core debe pesar bastante menos que el completo');
    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ─── Candado de escritura solo en bandeja ───────────────────────────────────
describe('candado escritura-solo-bandeja', () => {
  test('deja leer, deja escribir en la bandeja y bloquea el resto', async () => {
    const root = bovedaTemporal('candado');
    const previo = await new Cliente(root).iniciar();
    await previo.llamar('write_note', { title: 'Fuera', content: 'x', category: 'sistema' });
    previo.cerrar();

    const kb = await new Cliente(root, { KB_WRITE_ONLY_INBOX: '1' }).iniciar();
    const lectura = await kb.llamar('read_note', { name: 'fuera' });
    assert.equal(lectura.error, false);

    const permitida = await kb.llamar('write_note', { title: 'Dentro', content: 'x', category: 'bandeja-de-entrada' });
    assert.equal(permitida.error, false);

    const denegada = await kb.llamar('write_note', { title: 'Otra', content: 'x', category: 'sistema' });
    assert.equal(denegada.error, true);

    const admin = await kb.llamar('create_category', { name: 'nueva' });
    assert.equal(admin.error, true);

    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
