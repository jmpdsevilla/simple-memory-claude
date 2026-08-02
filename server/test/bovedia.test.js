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
// Todos los clientes lanzados, para cerrarlos pase lo que pase al terminar:
// si un test falla antes de su limpieza, el proceso hijo quedaría vivo y la
// suite no terminaría nunca.
const clientesVivos = [];
process.on('exit', () => { for (const c of clientesVivos) { try { c.kill(); } catch {} } });

class Cliente {
  constructor(root, env = {}) {
    this.proc = spawn('node', [SERVER], {
      env: {
        ...process.env,
        KB_MEMORY_ROOT: root,
        // Nunca dejar que las pruebas escriban copias en la carpeta real del
        // usuario: por defecto van junto a la bóveda temporal de cada prueba.
        KB_BACKUP_ROOT: path.join(root, '.copias-de-prueba'),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.unref();
    clientesVivos.push(this.proc);
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
      // Se escribe el archivo directamente en disco: por el MCP ya no pueden
      // entrar (la higiene automática los corrige al escribir). El caso real es
      // una nota editada a mano en el editor.
      fs.writeFileSync(
        path.join(root, 'conocimiento', 'con-guiones.md'),
        '---\ntitle: Con guiones\ncategory: conocimiento\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Con guiones\n\nCuerpo.\n\n#nano-banana #tipo_referencia\n',
      );
      await kb.llamar('write_note', { title: 'Toque guiones', content: 'x', category: 'conocimiento' });
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

  describe('higiene automática al escribir', () => {
    test('normaliza la forma de las etiquetas sin que nadie lo pida', async () => {
      await kb.llamar('write_note', {
        title: 'Etiquetas sucias',
        content: 'Cuerpo.\n\n#Nano-Banana #DISEÑO #tipo_referencia',
        category: 'conocimiento',
      });
      const { texto } = await kb.llamar('read_note', { name: 'etiquetas-sucias' });
      assert.match(texto, /#nano_banana #diseno #tipo_referencia/);
    });

    test('devuelve la línea de etiquetas al final si queda contenido detrás', async () => {
      await kb.llamar('write_note', {
        title: 'Etiquetas a media nota',
        content: 'Primera parte.\n\n#tipo_referencia #smc\n\n## Ver también\n\n- [[la-piramide]]',
        category: 'conocimiento',
      });
      const { texto } = await kb.llamar('read_note', { name: 'etiquetas-a-media-nota' });
      const cuerpo = texto.split('**Backlinks')[0].replace(/\s*-{3,}\s*$/, '').trimEnd();
      assert.ok(cuerpo.endsWith('#tipo_referencia #smc'), `terminaba en: ${cuerpo.slice(-60)}`);
      assert.match(cuerpo, /## Ver también/);
    });

    test('append_to_note deja la línea de etiquetas al fondo', async () => {
      await kb.llamar('append_to_note', { name: 'etiquetas-a-media-nota', content: '## Sección nueva\n\nTexto añadido.' });
      const { texto } = await kb.llamar('read_note', { name: 'etiquetas-a-media-nota' });
      const cuerpo = texto.split('**Backlinks')[0].replace(/\s*-{3,}\s*$/, '').trimEnd();
      assert.ok(cuerpo.endsWith('#tipo_referencia #smc'));
      assert.match(cuerpo, /Texto añadido/);
    });
  });

  describe('red de seguridad', () => {
    // Cada prueba usa su propia bóveda y su propia carpeta de copias, para no
    // mezclarse con las del resto ni con las de la instalación real.
    const porLimpiar = [];
    after(() => {
      for (const { cli, raiz, copias } of porLimpiar) {
        try { cli.cerrar(); } catch {}
        fs.rmSync(raiz, { recursive: true, force: true });
        fs.rmSync(copias, { recursive: true, force: true });
      }
    });

    async function conRed(nombre) {
      const raiz = bovedaTemporal(nombre);
      const copias = bovedaTemporal(`${nombre}-copias`);
      const cli = await new Cliente(raiz, { KB_BACKUP_ROOT: copias, KB_ENABLE_ANNOTATIONS: '1' }).iniciar();
      // La limpieza se registra ya: si el test falla a mitad, igual se limpia.
      porLimpiar.push({ cli, raiz, copias });
      return { raiz, copias, cli, limpiar: () => {} };
    }

    test('borrar manda la nota a la papelera, no al vacío', async () => {
      const { raiz, copias, cli, limpiar } = await conRed('papelera');
      await cli.llamar('write_note', { title: 'Prescindible', content: 'Contenido que no quiero perder del todo.', category: 'conocimiento' });
      const { texto } = await cli.llamar('delete_note', { name: 'prescindible' });
      assert.match(texto, /papelera/i);
      assert.equal(fs.existsSync(path.join(raiz, 'conocimiento', 'prescindible.md')), false);
      const enPapelera = fs.readdirSync(path.join(copias, 'papelera'));
      const recuperada = fs.readFileSync(path.join(copias, 'papelera', enPapelera[0], 'prescindible.md'), 'utf8');
      assert.match(recuperada, /no quiero perder/);
      limpiar();
    });

    test('con permanent:true no pasa por la papelera', async () => {
      const { copias, cli, limpiar } = await conRed('permanente');
      await cli.llamar('write_note', { title: 'Fuera', content: 'x', category: 'conocimiento' });
      const { texto } = await cli.llamar('delete_note', { name: 'fuera', permanent: true });
      assert.match(texto, /definitivamente/);
      assert.equal(fs.existsSync(path.join(copias, 'papelera')), false);
      limpiar();
    });

    test('una operación masiva guarda copia antes de tocar nada', async () => {
      const { cli, limpiar } = await conRed('copia-masiva');
      await cli.llamar('write_note', { title: 'Recargada', content: 'Cuerpo.\n\n#tipo_referencia #smc #a #b #c #d #e #f', category: 'conocimiento' });
      const { texto } = await cli.llamar('prune_tags', { dry_run: false, max: 4, keep: ['smc'] });
      assert.match(texto, /Copia de seguridad previa/);
      const copias = await cli.llamar('list_snapshots');
      assert.match(copias.texto, /antes-de-podar-etiquetas/);
      limpiar();
    });

    test('restaurar devuelve las notas a su estado anterior', async () => {
      const { cli, limpiar } = await conRed('restaurar');
      await cli.llamar('write_note', { title: 'Importante', content: 'VERSION ORIGINAL', category: 'conocimiento' });
      const copia = await cli.llamar('create_snapshot', { reason: 'antes del destrozo' });
      const nombre = copia.texto.match(/\*\*(.+?)\*\*/)[1];

      await cli.llamar('write_note', { title: 'Importante', content: 'VERSION DESTROZADA', category: 'conocimiento' });
      await cli.llamar('write_note', { title: 'Posterior', content: 'Creada después de la copia.', category: 'conocimiento' });

      const simulacion = await cli.llamar('restore_snapshot', { name: nombre });
      assert.match(simulacion.texto, /SIMULACIÓN/);
      const sigueDestrozada = await cli.llamar('read_note', { name: 'importante' });
      assert.match(sigueDestrozada.texto, /DESTROZADA/);

      await cli.llamar('restore_snapshot', { name: nombre, dry_run: false });
      const recuperada = await cli.llamar('read_note', { name: 'importante' });
      assert.match(recuperada.texto, /VERSION ORIGINAL/);
      // Lo creado después de la copia no se pierde al restaurar.
      const posterior = await cli.llamar('read_note', { name: 'posterior' });
      assert.match(posterior.texto, /Creada después/);
      limpiar();
    });

    test('una edición humana bloquea la sobrescritura completa de la nota', async () => {
      // Esta es la protección real frente a "el editor y la IA tocando lo
      // mismo": con las anotaciones activadas, si la nota tiene texto escrito
      // por una persona, write_note (que reescribe el cuerpo entero) se niega.
      const { raiz, cli, limpiar } = await conRed('autoria');
      await cli.llamar('write_note', { title: 'Compartida', content: 'Texto de la IA.', category: 'conocimiento' });

      // Se simula la edición desde el editor: un rango atribuido a una persona.
      const ruta = path.join(raiz, 'conocimiento', 'compartida.md');
      const actual = fs.readFileSync(ruta, 'utf8');
      // Se cambia solo el autor, conservando los rangos (que son relativos al
      // archivo: inventarlos los dejaría dentro del frontmatter y no contarían).
      fs.writeFileSync(ruta, actual.replace('&Claude <noreply@anthropic.com>', '@José <jose@ejemplo.com>'));

      const { texto, error } = await cli.llamar('write_note', {
        title: 'Compartida', content: 'La IA lo reescribe entero.', category: 'conocimiento',
      });
      assert.equal(error, true);
      assert.match(texto, /autoría humana/i);
      limpiar();
    });
  });

  describe('vault_health', () => {
    test('da el parte con lo que hay que corregir y con qué herramienta', async () => {
      const { texto } = await kb.llamar('vault_health');
      assert.match(texto, /Bóveda/);
      assert.match(texto, /wikilinks rotos/);
      assert.match(texto, /prune_tags|más de 6 etiquetas/);
    });

    test('detecta una nota sin etiquetar', async () => {
      await kb.llamar('write_note', { title: 'Nota pelada', content: 'Sin etiquetas de ningún tipo.', category: 'conocimiento' });
      const { texto } = await kb.llamar('vault_health', { detail: true });
      assert.match(texto, /nota-pelada/);
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

// ─── Cierre de tareas programadas: una tarea, un registro ───────────────────
// Regresión del fallo del 30-jul-2026: una sesión hacía el trabajo de madrugada,
// documentaba las notas del tema y dejaba viva la nota de `programado/`, así que
// al día siguiente la tarea volvía a salir como pendiente. El estado vivía en
// dos sitios sin nada que los sincronizara.
describe('cierre de tareas programadas', () => {
  let root;
  let kb;
  const dia = (offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().split('T')[0];
  };
  const HOY = dia(0);
  const AYER = dia(-1);
  const ANTIGUO = dia(-30);

  // Se escriben a mano para controlar la fecha `updated`, que es la señal que
  // distingue una tarea ya trabajada de una que sigue pendiente de verdad.
  const escribir = (categoria, slug, { title, updated, cuerpo }) => {
    const dir = path.join(root, categoria);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${slug}.md`),
      `---\ntitle: ${title}\ncategory: ${categoria}\ncreated: ${ANTIGUO}\nupdated: ${updated}\n---\n\n# ${title}\n\n${cuerpo}\n`,
    );
  };

  before(async () => {
    root = bovedaTemporal('programados');

    // Trabajo tocado hoy: las notas del tema se modificaron.
    escribir('proyectos', 'asistente-del-cliente', { title: 'Asistente del cliente', updated: HOY, cuerpo: 'Montado y probado.' });
    escribir('proyectos', 'captura-de-leads', { title: 'Captura de leads', updated: HOY, cuerpo: 'Webhook conectado.' });
    // Trabajo intacto: nadie lo ha tocado desde hace un mes.
    escribir('sistema', 'permisos-del-agente', { title: 'Permisos del agente', updated: ANTIGUO, cuerpo: 'Sin tocar.' });

    // Tarea CUMPLIDA que se quedó viva: vencía ayer y sus notas son de hoy.
    escribir('programado', 'probar-el-asistente', {
      title: 'Probar el asistente', updated: AYER,
      cuerpo: `> APARECER: ${AYER}\n\nProbar [[asistente-del-cliente]] y cerrar [[captura-de-leads]].`,
    });
    // Tarea REALMENTE pendiente: vence hoy y su nota no se ha tocado.
    escribir('programado', 'limpiar-los-permisos', {
      title: 'Limpiar los permisos', updated: AYER,
      cuerpo: `> APARECER: ${HOY}\n\nAuditar [[permisos-del-agente]].`,
    });
    // Tarea posterior que ABSORBE a la primera: comparte sus dos enlaces.
    escribir('programado', 'sesion-agrupada-de-asistentes', {
      title: 'Sesión agrupada de asistentes', updated: HOY,
      cuerpo: `> APARECER: ${dia(2)}\n\nProbar [[asistente-del-cliente]] y revisar [[captura-de-leads]].`,
    });

    kb = await new Cliente(root).iniciar();
  });

  after(() => {
    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('due_notes señala la tarea cuyo trabajo ya se tocó', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, /probar-el-asistente/);
    assert.match(texto, /COMPROBAR ANTES DE SACARLA/);
    assert.match(texto, /asistente-del-cliente/);
  });

  test('due_notes detecta que otra tarea posterior la absorbió', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, /POSIBLE DUPLICADO/);
    assert.match(texto, /sesion-agrupada-de-asistentes/);
  });

  test('due_notes NO señala la tarea que sigue pendiente de verdad', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    const bloque = texto.split('limpiar-los-permisos')[1]?.split('- **')[0] ?? '';
    assert.doesNotMatch(bloque, /COMPROBAR ANTES DE SACARLA|POSIBLE DUPLICADO/);
  });

  test('due_notes muestra la fecha de modificación de cada tarea', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, new RegExp(`modificada: ${AYER}`));
  });

  test('due_notes NO sirve el cuerpo de la tarea vencida — solo la lista', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, /limpiar-los-permisos/);                        // el nombre, sí
    assert.doesNotMatch(texto, /Auditar \[\[permisos-del-agente\]\]/);  // el cuerpo, no
  });

  test('due_notes NO sirve el contenido de las notas que la tarea enlaza', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.doesNotMatch(texto, /Sin tocar\./);
  });

  test('due_notes dice que la tarea se lee al elegirla, y solo esa', async () => {
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, /ESTO ES SOLO LA LISTA/);
    assert.match(texto, /CUANDO ELIJA UNA/);
    assert.match(texto, /SOLO las de esa tarea/);
  });

  test('due_notes avisa de los enlaces que no tienen nota', async () => {
    await kb.llamar('write_note', {
      title: 'Tarea con enlace roto',
      content: `> APARECER: ${AYER}\n\nMirar [[ficha-que-no-existe]].`,
      category: 'programado',
    });
    const { texto } = await kb.llamar('due_notes', {});
    assert.match(texto, /Enlaces sin nota \(revisar\): .*ficha-que-no-existe/);
    await kb.llamar('delete_note', { name: 'tarea-con-enlace-roto' });
  });

  test('sin tareas vencidas no se dice nada de leer ni de elegir', async () => {
    const { texto } = await kb.llamar('due_notes', { category: 'sistema' });
    assert.doesNotMatch(texto, /ESTO ES SOLO LA LISTA/);
  });

  test('editar una nota que una tarea vencida enlaza avisa de cerrarla', async () => {
    const { texto } = await kb.llamar('append_to_note', {
      name: 'asistente-del-cliente', content: 'Probado con el cliente.',
    });
    assert.match(texto, /TAREA PROGRAMADA SIN CERRAR/);
    assert.match(texto, /probar-el-asistente/);
    assert.match(texto, /Una tarea, un registro/);
  });

  test('editar una nota que ninguna tarea enlaza no dice nada', async () => {
    await kb.llamar('write_note', { title: 'Nota suelta', content: 'x', category: 'conocimiento' });
    const { texto } = await kb.llamar('append_to_note', { name: 'nota-suelta', content: 'y' });
    assert.doesNotMatch(texto, /TAREA PROGRAMADA/);
  });

  test('crear una tarea nueva recuerda la regla y lista las abiertas', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Repasar los dos asistentes',
      content: `> APARECER: ${dia(5)}\n\nRepasar [[asistente-del-cliente]] y [[captura-de-leads]].`,
      category: 'programado',
    });
    assert.match(texto, /UNA TAREA, UN REGISTRO/);
    assert.match(texto, /Tratan de lo mismo/);
    assert.match(texto, /probar-el-asistente/);
    assert.match(texto, /Tareas que ya tocaban y siguen abiertas/);
  });

  test('escribir fuera de programado no dispara el recordatorio de registro único', async () => {
    const { texto } = await kb.llamar('write_note', { title: 'Apunte técnico', content: 'z', category: 'conocimiento' });
    assert.doesNotMatch(texto, /UNA TAREA, UN REGISTRO/);
  });
});

// Que una tarea programada nazca bien escrita: enlazando las notas del tema y
// habiendo abierto las fichas que ya tratan de eso. Reproduce el fallo del
// 1-ago-2026 (un experimento sobre WeShop programado sin abrir la ficha de
// WeShop, con un planteamiento que la ficha desmentía).
describe('escribir bien una tarea programada', () => {
  let root;
  let kb;
  const dia = (offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().split('T')[0];
  };

  before(async () => {
    root = bovedaTemporal('programados-bien');
    const escribir = (categoria, slug, cuerpo) => {
      const dir = path.join(root, categoria);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${slug}.md`), `---\ntitle: ${slug}\ncategory: ${categoria}\n---\n\n${cuerpo}\n`);
    };

    // Fichas del tema, cada una con su etiqueta propia.
    escribir('ltd', 'ficha-weshop', 'Arsenal de WeShop.\n\n#weshop #imagenes #smc');
    escribir('procesos', 'workflow-nano-banana', 'Cómo se generan las imágenes.\n\n#nanobanana #imagenes #smc');
    // Relleno para que `#smc` pase de común y quede capada como ruido.
    for (let i = 1; i <= 5; i++) escribir('varios', `relleno-${i}`, `Nota de relleno.\n\n#smc`);
    // Etiqueta estructural: no dice de qué va nada, no debe usarse como señal.
    escribir('varios', 'ficha-estructural', 'Sin tema propio.\n\n#tipo_referencia');

    kb = await new Cliente(root).iniciar();
  });

  after(() => {
    kb.cerrar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('avisa de las fichas del tema que la tarea no enlaza', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Experimento de fotos',
      content: `> APARECER: ${dia(3)}\n\nComparar las dos vías.\n\n#weshop #smc`,
      category: 'programado',
    });
    assert.match(texto, /FICHAS DEL TEMA QUE NO ENLAZAS/);
    assert.match(texto, /ficha-weshop/);
    assert.match(texto, /plantea el ENCARGO, no la conclusión/);
  });

  test('las etiquetas demasiado comunes no generan ruido', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Otra tarea con etiqueta comodín',
      content: `> APARECER: ${dia(4)}\n\nAlgo general.\n\n#smc [[ficha-weshop]]`,
      category: 'programado',
    });
    assert.doesNotMatch(texto, /relleno-1/);
  });

  test('las etiquetas de tipo no cuentan como tema', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Tarea solo estructural',
      content: `> APARECER: ${dia(5)}\n\nRevisar algo.\n\n#tipo_proceso [[ficha-weshop]]`,
      category: 'programado',
    });
    assert.doesNotMatch(texto, /ficha-estructural/);
  });

  test('una tarea que enlaza su ficha no recibe el aviso', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Tarea bien escrita',
      content: `> APARECER: ${dia(6)}\n\nSeguir [[ficha-weshop]] y [[workflow-nano-banana]].\n\n#weshop #nanobanana`,
      category: 'programado',
    });
    assert.doesNotMatch(texto, /FICHAS DEL TEMA QUE NO ENLAZAS/);
  });

  test('una tarea sin ningún enlace se marca como ciega', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Tarea sin enlaces',
      content: `> APARECER: ${dia(7)}\n\nHacer una cosa que no dice cuál.`,
      category: 'programado',
    });
    assert.match(texto, /TAREA CIEGA/);
  });

  test('una tarea con enlaces no se marca como ciega', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Tarea con contexto',
      content: `> APARECER: ${dia(8)}\n\nRevisar [[ficha-weshop]].\n\n#weshop`,
      category: 'programado',
    });
    assert.doesNotMatch(texto, /TAREA CIEGA/);
  });

  test('escribir fuera de programado no dispara ninguno de estos avisos', async () => {
    const { texto } = await kb.llamar('write_note', {
      title: 'Apunte cualquiera', content: 'Nada especial.\n\n#weshop', category: 'conocimiento',
    });
    assert.doesNotMatch(texto, /TAREA CIEGA|FICHAS DEL TEMA/);
  });
});
