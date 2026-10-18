'use strict';
/* Control de Inventario — Fase 1
 * App instalable que funciona sin internet con los últimos datos descargados.
 * Servidor: Google Apps Script (API) + Google Sheets (base de datos). */

const CFG = Object.assign({ NOMBRE: 'Control de Inventario', SYNC_MINUTOS: 15, API_URL: '' }, window.APP_CONFIG || {});
const VERSION_APP = '1.1.0';

const ROL_TXT = {
  ADMIN_GENERAL: 'Administrador general',
  ADMIN_SUCURSAL: 'Administrador de sucursal',
  INVENTARIOS: 'Control de inventarios',
  CAJERO: 'Cajero',
  CLIENTE: 'Cliente'
};
const TIPO_TXT = {
  ENTRADA: 'Entrada', SALIDA: 'Salida', AJUSTE: 'Ajuste por conteo', TRASPASO: 'Traspaso',
  TRASPASO_SALIDA: 'Traspaso (sale)', TRASPASO_ENTRADA: 'Traspaso (llega)'
};
const AYUDA_TIPO = {
  ENTRADA: 'Suma existencias: compras, devoluciones o carga inicial de inventario.',
  SALIDA: 'Resta existencias: merma, caducidad, consumo interno.',
  AJUSTE: 'Captura lo que contaste físicamente; el sistema calcula la diferencia.',
  TRASPASO: 'Mueve mercancía de este almacén a otro (por ejemplo, de bodega a sucursal).'
};

const S = {
  usuario: null, token: '',
  catalogo: { productos: [], categorias: [], almacenes: [] },
  existencias: [], version: 0, rolCatalogo: '', ultimaSync: 0,
  online: navigator.onLine, outbox: [], vista: 'inicio',
  sincronizando: false, otraVez: false, idx: { prod: {}, cat: {}, alm: {}, barras: {}, codigo: {} },
  refrescar: null
};
const F = {}; // filtros que se recuerdan entre vistas
let promptInstalar = null;

/* ---------------- Base local (IndexedDB) ---------------- */
const DB = {
  db: null,
  abrir() {
    return new Promise((ok, mal) => {
      const r = indexedDB.open('inventario-local', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv');
        d.createObjectStore('outbox', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => mal(r.error);
    });
  },
  _op(store, modo, fn) {
    return new Promise((ok, mal) => {
      const t = this.db.transaction(store, modo);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req ? req.result : undefined);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error);
    });
  },
  get(k) { return this._op('kv', 'readonly', s => s.get(k)); },
  set(k, v) { return this._op('kv', 'readwrite', s => s.put(v, k)); },
  del(k) { return this._op('kv', 'readwrite', s => s.delete(k)); },
  pendientes() { return this._op('outbox', 'readonly', s => s.getAll()); },
  guardarMov(m) { return this._op('outbox', 'readwrite', s => s.put(m)); },
  borrarMov(id) { return this._op('outbox', 'readwrite', s => s.delete(id)); }
};

/* ---------------- Utilidades ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtDinero = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const fmtNum = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 });
const dinero = n => fmtDinero.format(Number(n) || 0);
const numero = n => fmtNum.format(Number(n) || 0);
function fechaHora(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? '—' : d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}
function hace(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
  return fechaHora(ms);
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}
const normal = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const esActivo = v => v === true || v === 'TRUE' || v === 'true';
const porNombre = (a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es');
function coincide(p, q) {
  return normal(p.nombre).includes(q) || normal(p.codigo).includes(q) || String(p.codigo_barras || '').includes(q);
}
function upsert(lista, obj) {
  const i = lista.findIndex(x => x.id === obj.id);
  if (i >= 0) lista[i] = obj; else lista.push(obj);
}

function toast(msg, tipo = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + tipo;
  t.textContent = msg;
  const cont = $('#toasts');
  cont.appendChild(t);
  while (cont.children.length > 3) cont.firstElementChild.remove();
  setTimeout(() => t.classList.add('fuera'), 4200);
  setTimeout(() => t.remove(), 4700);
}

function abrirModal(titulo, html) {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog" class="dlg-cab"><h2>${esc(titulo)}</h2><button class="icono" aria-label="Cerrar">✕</button></form><div class="dlg-cuerpo">${html}</div>`;
  if (!d.open) d.showModal();
  return d;
}
const cerrarModal = () => { const d = $('#dlg'); if (d.open) d.close(); };

/* ---------------- Contraseña local (para entrar sin internet) ---------------- */
function aleatorioB64(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a));
}
async function derivar(pass, saltB64) {
  const sal = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const clave = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: sal, iterations: 150000, hash: 'SHA-256' }, clave, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
async function guardarCredencial(usuario, password, publico, token) {
  const salt = aleatorioB64(16);
  await DB.set('cred:' + usuario, { salt, hash: await derivar(password, salt), usuario: publico, token });
}

/* ---------------- Servidor ---------------- */
async function api(accion, datos = {}) {
  if (!/^https?:\/\//.test(CFG.API_URL)) throw Object.assign(new Error('Falta configurar API_URL en config.js.'), { config: true });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  let resp;
  try {
    resp = await fetch(CFG.API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: accion, token: S.token, data: datos }),
      signal: ctrl.signal
    });
  } catch (e) {
    marcarConexion(false);
    throw Object.assign(new Error('Sin conexión con el servidor.'), { red: true });
  } finally {
    clearTimeout(t);
  }
  let j;
  try { j = await resp.json(); } catch (e) {
    throw Object.assign(new Error('El servidor respondió algo inesperado. Revisa que la implementación tenga acceso "Cualquier usuario".'), { config: true });
  }
  marcarConexion(true);
  if (!j.ok) throw Object.assign(new Error(j.error || 'Error del servidor.'), { servidor: true, sesion: j.codigo === 'SESION' });
  return j.data;
}

function marcarConexion(v) {
  if (S.online !== v) { S.online = v; actualizarBarra(); }
}

/* ---------------- Datos y permisos ---------------- */
function indexar() {
  const idx = { prod: {}, cat: {}, alm: {}, barras: {}, codigo: {} };
  S.catalogo.productos.forEach(p => {
    idx.prod[p.id] = p;
    if (p.codigo_barras) idx.barras[String(p.codigo_barras)] = p;
    if (p.codigo) idx.codigo[normal(p.codigo)] = p;
  });
  S.catalogo.categorias.forEach(c => { idx.cat[c.id] = c; });
  S.catalogo.almacenes.forEach(a => { idx.alm[a.id] = a; });
  S.idx = idx;
}

const rol = () => (S.usuario ? S.usuario.rol : '');
const esGeneral = () => rol() === 'ADMIN_GENERAL';
const puedeCatalogo = () => ['ADMIN_GENERAL', 'INVENTARIOS'].includes(rol());
const veCostos = () => ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS'].includes(rol());

function almacenesVisibles() {
  if (esGeneral()) return S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre);
  return S.catalogo.almacenes.filter(a => a.id === S.usuario.almacen_id);
}

function misPendientes() {
  return S.outbox.filter(o => S.usuario && o.usuario === S.usuario.usuario);
}

// Existencias del servidor + movimientos que aún no se envían
function mapaExistencias() {
  const m = {};
  S.existencias.forEach(e => { m[e.almacen_id + '|' + e.producto_id] = Number(e.cantidad) || 0; });
  misPendientes()
    .filter(o => o.estado === 'pendiente')
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    .forEach(o => {
      const k = o.almacen_id + '|' + o.producto_id;
      const c = Number(o.cantidad) || 0;
      if (o.tipo === 'ENTRADA') m[k] = (m[k] || 0) + c;
      else if (o.tipo === 'SALIDA') m[k] = (m[k] || 0) - c;
      else if (o.tipo === 'AJUSTE') m[k] = c;
      else if (o.tipo === 'TRASPASO') {
        m[k] = (m[k] || 0) - c;
        const kd = o.destino_id + '|' + o.producto_id;
        m[kd] = (m[kd] || 0) + c;
      }
    });
  return m;
}

/* ---------------- Sesión ---------------- */
async function cargarSesion(ses) {
  S.token = ses.token;
  S.usuario = ses.usuario;
  const [cat, ex, ver, rolCat, ult, out] = await Promise.all([
    DB.get('catalogo'), DB.get('existencias'), DB.get('version'), DB.get('rolCatalogo'), DB.get('ultimaSync'), DB.pendientes()
  ]);
  S.catalogo = cat || { productos: [], categorias: [], almacenes: [] };
  S.existencias = ex || [];
  S.version = ver || 0;
  S.rolCatalogo = rolCat || '';
  S.ultimaSync = ult || 0;
  S.outbox = out || [];
  indexar();
}

async function onLogin(ev) {
  ev.preventDefault();
  const f = ev.target;
  const usuario = f.usuario.value.trim().toLowerCase();
  const password = f.password.value;
  const msg = $('#login-msg');
  const btn = f.querySelector('button');
  msg.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    let ses;
    try {
      S.token = '';
      const r = await api('login', { usuario, password });
      ses = { token: r.token, usuario: r.usuario, offline: false };
      await guardarCredencial(usuario, password, r.usuario, r.token);
    } catch (e) {
      if (!e.red) throw e;
      const cred = await DB.get('cred:' + usuario);
      if (!cred) throw new Error('Sin conexión. Este usuario nunca ha entrado en este equipo; la primera vez necesita internet.');
      if (await derivar(password, cred.salt) !== cred.hash) throw new Error('Usuario o contraseña incorrectos.');
      ses = { token: cred.token, usuario: cred.usuario, offline: true };
      toast('Entraste sin conexión con los datos guardados en este equipo.', 'aviso');
    }
    await DB.set('sesion', ses);
    f.password.value = '';
    await cargarSesion(ses);
    S.vista = 'inicio';
    mostrarApp();
    if (!ses.offline) {
      await sincronizar();
      if (S.usuario && S.usuario.debe_cambiar_password) dlgCambiarPassword(true);
    }
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function sesionVencida(msg) {
  const u = S.usuario ? S.usuario.usuario : '';
  const pend = misPendientes().length;
  await DB.del('sesion');
  if (u) await DB.del('cred:' + u);
  S.usuario = null;
  S.token = '';
  mostrarLogin(u, msg + (pend ? ' Tus movimientos sin enviar siguen guardados en este equipo.' : ''));
}

async function cerrarSesion() {
  const pend = misPendientes().filter(o => o.estado === 'pendiente').length;
  if (pend && !confirm(`Hay ${pend} movimiento(s) sin enviar. Se quedan guardados y se enviarán cuando ${S.usuario.usuario} vuelva a entrar con internet. ¿Cerrar sesión?`)) return;
  if (S.online) api('logout').catch(() => {});
  await DB.del('sesion');
  const u = S.usuario.usuario;
  S.usuario = null;
  S.token = '';
  cerrarModal();
  mostrarLogin(u);
}

/* ---------------- Sincronización ---------------- */
async function enviarPendientes() {
  const pend = misPendientes().filter(o => o.estado === 'pendiente');
  const avisos = [];
  let rechazados = 0;
  for (let i = 0; i < pend.length; i += 50) {
    const lote = pend.slice(i, i + 50);
    const r = await api('registrarMovimientos', { movimientos: lote });
    for (const res of r.resultados) {
      const o = S.outbox.find(x => x.id === res.id);
      if (!o) continue;
      if (res.estado === 'rechazado') {
        o.estado = 'rechazado';
        o.error = res.error;
        rechazados++;
        await DB.guardarMov(o);
      } else {
        S.outbox = S.outbox.filter(x => x.id !== res.id);
        await DB.borrarMov(res.id);
        if (res.aviso) avisos.push(res.aviso);
      }
    }
  }
  avisos.forEach(a => toast(a, 'aviso'));
  if (rechazados) toast(`${rechazados} movimiento(s) rechazados. Revísalos en Movimientos.`, 'error');
}

async function sincronizar(manual = false) {
  if (!S.usuario) return;
  if (S.sincronizando) { S.otraVez = true; return; }
  S.sincronizando = true;
  actualizarBarra();
  try {
    await enviarPendientes();
    const d = await api('sync', { version: S.version, rol: S.rolCatalogo });
    if (d.catalogo) {
      S.catalogo = d.catalogo;
      S.version = d.version;
      S.rolCatalogo = d.usuario.rol;
      await DB.set('catalogo', S.catalogo);
      await DB.set('version', S.version);
      await DB.set('rolCatalogo', S.rolCatalogo);
    }
    S.existencias = d.existencias || [];
    await DB.set('existencias', S.existencias);
    S.usuario = d.usuario;
    const ses = await DB.get('sesion');
    if (ses) { ses.usuario = d.usuario; ses.offline = false; await DB.set('sesion', ses); }
    S.ultimaSync = Date.now();
    await DB.set('ultimaSync', S.ultimaSync);
    indexar();
    pintarMenu();
    if (S.refrescar) S.refrescar(); else pintarVista();
    if (manual) toast('Datos actualizados.', 'ok');
  } catch (e) {
    if (e.sesion) { S.sincronizando = false; await sesionVencida(e.message); return; }
    if (manual || !e.red) toast(e.message, 'error');
  } finally {
    S.sincronizando = false;
    actualizarBarra();
    if (S.otraVez) { S.otraVez = false; setTimeout(() => sincronizar(), 300); }
  }
}

/* ---------------- Pantallas ---------------- */
const VISTAS = {
  inicio: { titulo: 'Inicio', roles: null, render: vInicio },
  productos: { titulo: 'Productos', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vProductos },
  inventario: { titulo: 'Inventario', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vInventario },
  movimientos: { titulo: 'Movimientos', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS'], render: vMovimientos },
  almacenes: { titulo: 'Almacenes', roles: ['ADMIN_GENERAL'], render: vAlmacenes },
  usuarios: { titulo: 'Usuarios', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'], render: vUsuarios },
  cuenta: { titulo: 'Mi cuenta', roles: null, render: vCuenta }
};
const puedeVer = k => !VISTAS[k].roles || VISTAS[k].roles.includes(rol());

function mostrarLogin(usuario = '', msg = '') {
  $('#pantalla-app').hidden = true;
  $('#pantalla-login').hidden = false;
  const f = $('#form-login');
  if (usuario) f.usuario.value = usuario;
  $('#login-msg').textContent = msg;
  $('#login-estado').textContent = navigator.onLine ? '' : 'Sin conexión: solo pueden entrar usuarios que ya usaron este equipo.';
  (usuario ? f.password : f.usuario).focus();
}

function mostrarApp() {
  $('#pantalla-login').hidden = true;
  $('#pantalla-app').hidden = false;
  pintarMenu();
  pintarVista();
  actualizarBarra();
}

function pintarMenu() {
  $('#menu').innerHTML = Object.keys(VISTAS).filter(puedeVer)
    .map(k => `<button type="button" data-v="${k}" class="${S.vista === k ? 'activo' : ''}">${VISTAS[k].titulo}</button>`).join('');
}

function irA(k) {
  S.vista = k;
  pintarMenu();
  pintarVista();
  window.scrollTo(0, 0);
}

function pintarVista() {
  if (!S.usuario) return;
  if (!puedeVer(S.vista)) S.vista = 'inicio';
  S.refrescar = null;
  VISTAS[S.vista].render($('#vista'));
}

function actualizarBarra() {
  const b = $('#estado');
  if (!b) return;
  const mios = misPendientes();
  const pend = mios.filter(o => o.estado === 'pendiente').length;
  const rech = mios.filter(o => o.estado === 'rechazado').length;
  const txt = S.sincronizando ? 'Sincronizando…' : (S.online ? 'En línea' : 'Sin conexión');
  b.className = 'estado ' + (S.sincronizando ? 'sync' : S.online ? 'on' : 'off');
  const det = [S.ultimaSync ? 'Act. ' + hace(S.ultimaSync) : 'Sin datos'];
  if (pend) det.push(pend + ' por enviar');
  if (rech) det.push(rech + ' con error');
  b.innerHTML = `<span class="punto"></span><span>${txt}</span><small>${esc(det.join(' · '))}</small>`;
}

/* ---- Inicio ---- */
function vInicio(el) {
  if (rol() === 'CLIENTE') {
    el.innerHTML = `<div class="panel"><h2>Hola, ${esc(S.usuario.nombre)}</h2><p>Tu portal de cliente (pedidos, entregas y estado de cuenta) estará disponible en una próxima fase.</p></div>`;
    return;
  }
  const alms = almacenesVisibles();
  const ex = mapaExistencias();
  const prods = S.catalogo.productos.filter(p => esActivo(p.activo));
  let bajos = 0, valor = 0;
  alms.forEach(a => prods.forEach(p => {
    const c = ex[a.id + '|' + p.id] || 0;
    if (Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo)) bajos++;
    valor += c * (Number(p.costo) || 0);
  }));
  const mios = misPendientes();
  const pend = mios.filter(o => o.estado === 'pendiente').length;
  const rech = mios.filter(o => o.estado === 'rechazado').length;
  const miAlm = S.idx.alm[S.usuario.almacen_id];
  el.innerHTML = `
    <div class="saludo"><h2>Hola, ${esc(S.usuario.nombre)}</h2><p>${esc(ROL_TXT[rol()] || rol())}${miAlm ? ' · ' + esc(miAlm.nombre) : ''}</p></div>
    <div class="tarjetas">
      <div class="tarjeta"><span>Productos activos</span><b>${numero(prods.length)}</b></div>
      <div class="tarjeta"><span>${esGeneral() ? 'Almacenes activos' : 'Almacén'}</span><b>${esGeneral() ? alms.length : esc(miAlm ? miAlm.nombre : '—')}</b></div>
      <button type="button" class="tarjeta ${bajos ? 'alerta' : ''}" id="t-bajos"><span>Bajo mínimo</span><b>${numero(bajos)}</b></button>
      ${veCostos() ? `<div class="tarjeta"><span>Valor del inventario (costo)</span><b>${dinero(valor)}</b></div>` : ''}
    </div>
    <div class="panel">
      <h3>Sincronización</h3>
      <p>${S.online ? 'Conectado al servidor.' : 'Sin conexión: trabajando con los datos guardados en este equipo.'}</p>
      <p>Última actualización: <b>${S.ultimaSync ? fechaHora(S.ultimaSync) : 'nunca'}</b></p>
      ${pend ? `<p>${pend} movimiento(s) esperando para enviarse.</p>` : ''}
      ${rech ? `<p class="txt-error">${rech} movimiento(s) rechazados por el servidor. Revísalos en Movimientos.</p>` : ''}
      <button type="button" class="btn" id="btn-sync">Sincronizar ahora</button>
    </div>`;
  $('#btn-sync', el).onclick = () => sincronizar(true);
  $('#t-bajos', el).onclick = () => { F.ibajo = true; irA('inventario'); };
  S.refrescar = () => vInicio(el);
}

/* ---- Productos ---- */
function vProductos(el) {
  const puede = puedeCatalogo();
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo)).sort(porNombre);
  el.innerHTML = `
    <div class="titulo"><h2>Productos</h2>${puede ? `<div class="acciones"><button type="button" class="btn sec" id="btn-cats">Categorías</button><button type="button" class="btn sec" id="btn-importar">Importar Excel</button><button type="button" class="btn" id="btn-nuevo">Nuevo producto</button></div>` : ''}</div>
    <div class="filtros">
      <input id="f-q" type="search" placeholder="Buscar por nombre, código o escanea el código de barras" value="${esc(F.pq || '')}" autocomplete="off">
      <select id="f-cat"><option value="">Todas las categorías</option>${cats.map(c => `<option value="${esc(c.id)}" ${F.pcat === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="f-inact" ${F.pinact ? 'checked' : ''}> Ver inactivos</label>
    </div>
    <div id="lista"></div>`;

  const pintar = () => {
    const q = normal(F.pq || '');
    const ex = mapaExistencias();
    const alms = almacenesVisibles();
    let lista = S.catalogo.productos
      .filter(p => (F.pinact || esActivo(p.activo)) && (!F.pcat || p.categoria_id === F.pcat) && (!q || coincide(p, q)))
      .sort(porNombre);
    const total = lista.length;
    lista = lista.slice(0, 300);
    $('#lista', el).innerHTML = total ? `
      <div class="tabla-cont"><table class="tabla">
        <thead><tr><th>Código</th><th>Producto</th><th>Categoría</th>${veCostos() ? '<th class="num">Costo</th>' : ''}<th class="num">Menudeo</th><th class="num">Mayoreo</th><th class="num">Existencia</th></tr></thead>
        <tbody>${lista.map(p => {
          const c = alms.reduce((s, a) => s + (ex[a.id + '|' + p.id] || 0), 0);
          const bajo = Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo);
          return `<tr data-id="${esc(p.id)}" class="clic ${esActivo(p.activo) ? '' : 'inactivo'}">
            <td>${esc(p.codigo)}${p.codigo_barras ? `<small>${esc(p.codigo_barras)}</small>` : ''}</td>
            <td>${esc(p.nombre)}</td>
            <td>${esc(S.idx.cat[p.categoria_id] ? S.idx.cat[p.categoria_id].nombre : '—')}</td>
            ${veCostos() ? `<td class="num">${dinero(p.costo)}</td>` : ''}
            <td class="num">${dinero(p.precio_menudeo)}</td>
            <td class="num">${dinero(p.precio_mayoreo)}</td>
            <td class="num ${bajo ? 'txt-error' : ''}">${numero(c)} ${esc(p.unidad || '')}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${total > 300 ? `<p class="nota">Mostrando 300 de ${total}. Afina la búsqueda.</p>` : ''}`
      : `<p class="vacio">${S.catalogo.productos.length ? 'Sin resultados.' : 'Aún no hay productos registrados.'}</p>`;
  };
  pintar();
  S.refrescar = pintar;

  const q = $('#f-q', el);
  q.oninput = () => { F.pq = q.value; pintar(); };
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const v = q.value.trim();
    const p = S.idx.barras[v] || S.idx.codigo[normal(v)];
    if (p) { dlgProducto(p); q.select(); }
    else if (puede && /^\d{6,}$/.test(v)) {
      if (confirm(`El código ${v} no está registrado. ¿Crear producto nuevo con ese código?`)) dlgProducto(null, v);
    }
  };
  $('#f-cat', el).onchange = e => { F.pcat = e.target.value; pintar(); };
  $('#f-inact', el).onchange = e => { F.pinact = e.target.checked; pintar(); };
  $('#lista', el).onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) dlgProducto(S.idx.prod[tr.dataset.id]);
  };
  if (puede) {
    $('#btn-nuevo', el).onclick = () => dlgProducto(null);
    $('#btn-cats', el).onclick = dlgCategorias;
    $('#btn-importar', el).onclick = dlgImportar;
  }
  if (!F.pq) q.focus();
}

function dlgProducto(p, codigoBarras = '') {
  const nuevo = !p;
  p = p || { activo: true, unidad: 'PZA', codigo_barras: codigoBarras };
  const puede = puedeCatalogo();
  const ro = puede ? '' : 'disabled';
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo) || c.id === p.categoria_id).sort(porNombre);
  const ex = mapaExistencias();
  const alms = almacenesVisibles();
  const val = v => (v === undefined || v === null || v === '' ? '' : esc(v));
  const d = abrirModal(nuevo ? 'Nuevo producto' : (puede ? 'Editar producto' : 'Producto'), `
    <form id="fp" class="form">
      <div class="fila2">
        <label>Código interno<input name="codigo" value="${val(p.codigo)}" placeholder="Automático" ${ro}></label>
        <label>Código de barras<input name="codigo_barras" value="${val(p.codigo_barras)}" inputmode="numeric" ${ro}></label>
      </div>
      <label>Nombre<input name="nombre" required value="${val(p.nombre)}" ${ro}></label>
      <div class="fila2">
        <label>Categoría<select name="categoria_id" ${ro}><option value="">Sin categoría</option>${cats.map(c => `<option value="${esc(c.id)}" ${c.id === p.categoria_id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
        <label>Unidad<input name="unidad" list="unidades" value="${val(p.unidad || 'PZA')}" ${ro}></label>
      </div>
      <datalist id="unidades"><option>PZA</option><option>KG</option><option>LT</option><option>CAJA</option><option>PAQ</option><option>BOLSA</option></datalist>
      <div class="fila3">
        ${veCostos() ? `<label>Costo<input name="costo" type="number" step="0.01" min="0" value="${val(p.costo)}" ${ro}></label>` : ''}
        <label>Precio menudeo<input name="precio_menudeo" type="number" step="0.01" min="0" value="${val(p.precio_menudeo)}" ${ro}></label>
        <label>Precio mayoreo<input name="precio_mayoreo" type="number" step="0.01" min="0" value="${val(p.precio_mayoreo)}" ${ro}></label>
      </div>
      <p class="nota" id="margen"></p>
      <div class="fila2">
        <label>Stock mínimo<input name="stock_minimo" type="number" step="any" min="0" value="${val(p.stock_minimo)}" ${ro}></label>
        <label class="chk"><input type="checkbox" name="activo" ${esActivo(p.activo) ? 'checked' : ''} ${ro}> Activo</label>
      </div>
      ${!nuevo && alms.length ? `<div class="existencias"><b>Existencias</b>${alms.map(a => `<span>${esc(a.nombre)}: <b>${numero(ex[a.id + '|' + p.id] || 0)}</b> ${esc(p.unidad || '')}</span>`).join('')}</div>` : ''}
      <p class="msg" id="fp-msg"></p>
      ${puede ? `<div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>` : ''}
    </form>`);
  const f = $('#fp', d);
  const margen = () => {
    if (!f.costo) return;
    const c = Number(f.costo.value), pm = Number(f.precio_menudeo.value), pM = Number(f.precio_mayoreo.value);
    const m = pv => (pv > 0 && c > 0 ? ((pv - c) / pv * 100).toFixed(1) + '%' : '—');
    $('#margen', d).textContent = c > 0 ? `Margen: menudeo ${m(pm)} · mayoreo ${m(pM)}` : '';
  };
  margen();
  f.oninput = margen;
  if (nuevo && puede) (codigoBarras ? f.nombre : f.codigo_barras).focus();
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!puede) return;
    const msg = $('#fp-msg', d);
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para editar el catálogo.'; return; }
    const btn = f.querySelector('button[type=submit]');
    const producto = {
      id: p.id || '',
      codigo: f.codigo.value.trim(),
      codigo_barras: f.codigo_barras.value.trim(),
      nombre: f.nombre.value.trim(),
      categoria_id: f.categoria_id.value,
      unidad: f.unidad.value.trim(),
      costo: f.costo ? f.costo.value : p.costo,
      precio_menudeo: f.precio_menudeo.value,
      precio_mayoreo: f.precio_mayoreo.value,
      stock_minimo: f.stock_minimo.value,
      activo: f.activo.checked
    };
    btn.disabled = true;
    msg.textContent = 'Guardando…';
    try {
      const r = await api('guardarProducto', { producto });
      upsert(S.catalogo.productos, r);
      await DB.set('catalogo', S.catalogo);
      indexar();
      cerrarModal();
      toast(nuevo ? 'Producto creado.' : 'Producto actualizado.', 'ok');
      if (S.refrescar) S.refrescar();
      sincronizar();
    } catch (e) {
      msg.textContent = e.message;
      if (e.sesion) { cerrarModal(); sesionVencida(e.message); }
    } finally {
      btn.disabled = false;
    }
  };
}

function dlgCategorias() {
  const d = abrirModal('Categorías', `
    <form id="fc" class="fila-form"><input name="nombre" placeholder="Nueva categoría" required><button class="btn">Agregar</button></form>
    <p class="msg" id="fc-msg"></p>
    <ul class="lista" id="lc"></ul>`);
  const msg = $('#fc-msg', d);
  const pintar = () => {
    const l = S.catalogo.categorias.slice().sort(porNombre);
    $('#lc', d).innerHTML = l.length ? l.map(c => `
      <li><span class="${esActivo(c.activo) ? '' : 'tachado'}">${esc(c.nombre)}</span>
      <span class="acciones"><button type="button" class="btn mini sec" data-ren="${esc(c.id)}">Renombrar</button>
      <button type="button" class="btn mini sec" data-tog="${esc(c.id)}">${esActivo(c.activo) ? 'Desactivar' : 'Activar'}</button></span></li>`).join('')
      : '<li class="vacio">Sin categorías.</li>';
  };
  const guardar = async cat => {
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para editar el catálogo.'; return false; }
    msg.textContent = 'Guardando…';
    try {
      const r = await api('guardarCategoria', { categoria: cat });
      upsert(S.catalogo.categorias, r);
      await DB.set('catalogo', S.catalogo);
      indexar();
      msg.textContent = '';
      pintar();
      sincronizar();
      return true;
    } catch (e) {
      msg.textContent = e.message;
      return false;
    }
  };
  pintar();
  $('#fc', d).onsubmit = async e => {
    e.preventDefault();
    if (await guardar({ nombre: e.target.nombre.value.trim() })) e.target.reset();
  };
  $('#lc', d).onclick = async e => {
    const ren = e.target.closest('[data-ren]');
    const tog = e.target.closest('[data-tog]');
    if (ren) {
      const c = S.idx.cat[ren.dataset.ren];
      const nombre = prompt('Nuevo nombre de la categoría:', c.nombre);
      if (nombre && nombre.trim()) guardar({ id: c.id, nombre: nombre.trim(), activo: esActivo(c.activo) });
    }
    if (tog) {
      const c = S.idx.cat[tog.dataset.tog];
      guardar({ id: c.id, nombre: c.nombre, activo: !esActivo(c.activo) });
    }
  };
}

/* ---- Importación desde Excel ---- */
const COLS_IMPORT = [
  { clave: 'codigo', titulo: 'Código interno', ancho: 15, texto: true, alias: ['codigo', 'codigo interno', 'sku', 'clave'] },
  { clave: 'codigo_barras', titulo: 'Código de barras', ancho: 18, texto: true, alias: ['codigo de barras', 'codigo barras', 'ean', 'upc', 'barras'] },
  { clave: 'nombre', titulo: 'Nombre *', ancho: 36, alias: ['nombre', 'producto', 'descripcion', 'articulo'] },
  { clave: 'categoria', titulo: 'Categoría', ancho: 18, alias: ['categoria', 'familia', 'departamento'] },
  { clave: 'unidad', titulo: 'Unidad', ancho: 9, alias: ['unidad', 'unidad de medida', 'um'] },
  { clave: 'costo', titulo: 'Costo', ancho: 10, num: true, alias: ['costo', 'costo unitario', 'precio compra', 'precio de compra'] },
  { clave: 'precio_menudeo', titulo: 'Precio menudeo', ancho: 15, num: true, alias: ['precio menudeo', 'menudeo', 'precio', 'precio venta', 'precio de venta', 'precio publico'] },
  { clave: 'precio_mayoreo', titulo: 'Precio mayoreo', ancho: 15, num: true, alias: ['precio mayoreo', 'mayoreo'] },
  { clave: 'stock_minimo', titulo: 'Stock mínimo', ancho: 13, num: true, alias: ['stock minimo', 'minimo', 'existencia minima'] },
  { clave: 'existencia', titulo: 'Existencia', ancho: 12, num: true, alias: ['existencia', 'cantidad', 'stock', 'inventario', 'existencias'] }
];
const INSTRUCCIONES_IMPORT = [
  ['Cómo llenar la hoja "Productos"'],
  [''],
  ['• Una fila por producto. Solo el Nombre es obligatorio.'],
  ['• Si el código de barras o el código interno ya existen, el producto se ACTUALIZA. Si no existen, se CREA.'],
  ['• Al actualizar, las celdas vacías conservan el dato que ya tiene el producto.'],
  ['• Código interno: si lo dejas vacío se asigna uno automático (00001, 00002...).'],
  ['• Categoría: escribe el nombre; si no existe se crea.'],
  ['• Unidad: PZA, KG, LT, CAJA, PAQ, etc. Si la dejas vacía queda PZA.'],
  ['• Costo y precios: solo números, sin signo de pesos. Ej. 32.50'],
  ['• Existencia: lo que hay ahora en el almacén. Al importar eliges el almacén y si se SUMA o se REEMPLAZA.'],
  ['• No cambies los títulos de la primera fila ni el nombre de la hoja.'],
  ['• Puedes guardar como .xlsx o .csv.'],
  [''],
  ['Ejemplo de filas:'],
  ['Código interno', 'Código de barras', 'Nombre *', 'Categoría', 'Unidad', 'Costo', 'Precio menudeo', 'Precio mayoreo', 'Stock mínimo', 'Existencia'],
  ['', '7501055300013', 'Arroz Morelos 1 kg', 'Abarrotes', 'PZA', 22, 32, 28, 30, 120],
  ['A-102', '', 'Queso fresco', 'Lácteos', 'KG', 85, 120, 110, 5, 12.5]
];

function descargarPlantilla(conCatalogo) {
  const filas = [COLS_IMPORT.map(c => c.titulo)];
  if (conCatalogo) {
    S.catalogo.productos.filter(p => esActivo(p.activo)).sort(porNombre).forEach(p => {
      filas.push([p.codigo || '', p.codigo_barras || '', p.nombre, (S.idx.cat[p.categoria_id] || {}).nombre || '', p.unidad || '',
        veCostos() ? Number(p.costo) || 0 : '', Number(p.precio_menudeo) || 0, Number(p.precio_mayoreo) || 0, Number(p.stock_minimo) || 0, '']);
    });
  }
  const blob = Excel.crearXlsx([
    { nombre: 'Productos', filas, encabezado: true, anchos: COLS_IMPORT.map(c => c.ancho), columnasTexto: [0, 1] },
    { nombre: 'Instrucciones', filas: INSTRUCCIONES_IMPORT, anchos: [16, 18, 36, 14, 9, 9, 15, 15, 13, 12], columnasTexto: [1] }
  ]);
  Excel.descargar(blob, conCatalogo ? `catalogo-productos-${new Date().toISOString().slice(0, 10)}.xlsx` : 'plantilla-productos.xlsx');
}

function textoCelda(v, esCodigo) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && esCodigo) return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v).trim();
}

function numeroCelda(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  let t = String(v).trim().replace(/[$\s]/g, '');
  if (t === '') return '';
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return isNaN(n) ? NaN : n;
}

// Convierte las filas del archivo en productos validados
function interpretarImportacion(filas) {
  const alias = {};
  COLS_IMPORT.forEach(c => c.alias.forEach(a => { alias[a] = c.clave; }));
  const limpiarTitulo = t => normal(t).replace(/\*/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let iEnc = -1, mapa = {};
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    const m = {};
    (filas[i] || []).forEach((t, j) => { const k = alias[limpiarTitulo(t)]; if (k && m[k] === undefined) m[k] = j; });
    if (m.nombre !== undefined) { iEnc = i; mapa = m; break; }
  }
  if (iEnc < 0) throw new Error('No encontré la columna "Nombre". Usa la plantilla de la app.');

  const vistos = { barras: {}, codigo: {} };
  const items = [];
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (!f.some(v => String(v).trim() !== '')) continue;
    const r = { fila: i + 1, errores: [] };
    COLS_IMPORT.forEach(c => {
      const v = mapa[c.clave] === undefined ? '' : f[mapa[c.clave]];
      if (c.num) {
        const n = numeroCelda(v);
        if (Number.isNaN(n)) r.errores.push(`${c.titulo.replace(' *', '')} no es un número`);
        else if (n !== '' && n < 0) r.errores.push(`${c.titulo.replace(' *', '')} no puede ser negativo`);
        r[c.clave] = Number.isNaN(n) ? '' : n;
      } else {
        r[c.clave] = textoCelda(v, c.texto);
      }
    });
    if (!r.nombre) r.errores.push('Falta el nombre');
    r.codigo_barras = r.codigo_barras.replace(/\s+/g, '');
    if (r.codigo_barras) {
      if (vistos.barras[r.codigo_barras]) r.errores.push(`Código de barras repetido en la fila ${vistos.barras[r.codigo_barras]}`);
      else vistos.barras[r.codigo_barras] = r.fila;
    }
    if (r.codigo) {
      const k = r.codigo.toLowerCase();
      if (vistos.codigo[k]) r.errores.push(`Código interno repetido en la fila ${vistos.codigo[k]}`);
      else vistos.codigo[k] = r.fila;
    }
    const pB = r.codigo_barras ? S.idx.barras[r.codigo_barras] : null;
    const pC = r.codigo ? S.idx.codigo[normal(r.codigo)] : null;
    if (pB && pC && pB.id !== pC.id) r.errores.push('El código de barras y el código interno son de productos distintos');
    r.existente = pB || pC || null;
    items.push(r);
  }
  return items;
}

function dlgImportar() {
  const alms = almacenesVisibles();
  const d = abrirModal('Importar productos desde Excel', `
    <div class="form">
      <div class="pasos">
        <div class="paso"><b>1. Descarga el formato</b>
          <p class="nota">Llena la hoja "Productos". La hoja "Instrucciones" explica cada columna.</p>
          <div class="acciones"><button type="button" class="btn sec" id="imp-plantilla">Plantilla vacía</button>
          ${S.catalogo.productos.length ? '<button type="button" class="btn sec" id="imp-catalogo">Catálogo actual</button>' : ''}</div>
          ${S.catalogo.productos.length ? '<p class="nota">"Catálogo actual" sirve para cambiar precios en bloque: edítalo y vuelve a subirlo.</p>' : ''}
        </div>
        <div class="paso"><b>2. Sube el archivo</b>
          <label class="archivo"><input type="file" id="imp-archivo" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"><span>Elegir archivo .xlsx o .csv</span></label>
        </div>
      </div>
      <p class="msg" id="imp-msg"></p>
      <div id="imp-vista"></div>
    </div>`);
  const msg = $('#imp-msg', d);
  $('#imp-plantilla', d).onclick = () => descargarPlantilla(false);
  const bc = $('#imp-catalogo', d);
  if (bc) bc.onclick = () => descargarPlantilla(true);

  $('#imp-archivo', d).onchange = async e => {
    const archivo = e.target.files[0];
    if (!archivo) return;
    $('.archivo span', d).textContent = archivo.name;
    msg.textContent = '';
    $('#imp-vista', d).innerHTML = '<p class="nota">Leyendo archivo…</p>';
    try {
      const filas = await Excel.leerArchivo(archivo, 'Productos');
      const items = interpretarImportacion(filas);
      if (items.length > 5000) throw new Error('El archivo tiene más de 5,000 productos. Divídelo en varios archivos.');
      if (!items.length) throw new Error('El archivo no tiene productos debajo de los títulos.');
      vistaPrevia(items);
    } catch (err) {
      $('#imp-vista', d).innerHTML = '';
      msg.textContent = err.message;
    }
  };

  function vistaPrevia(items) {
    const validos = items.filter(r => !r.errores.length);
    const errores = items.filter(r => r.errores.length);
    const nuevos = validos.filter(r => !r.existente).length;
    const conExist = validos.filter(r => r.existencia !== '').length;
    const v = $('#imp-vista', d);
    v.innerHTML = `
      <div class="tarjetas">
        <div class="tarjeta"><span>Nuevos</span><b>${numero(nuevos)}</b></div>
        <div class="tarjeta"><span>Se actualizan</span><b>${numero(validos.length - nuevos)}</b></div>
        <div class="tarjeta ${errores.length ? 'alerta' : ''}"><span>Con error (se omiten)</span><b>${numero(errores.length)}</b></div>
      </div>
      ${errores.length ? `<div class="tabla-cont errores-imp"><table class="tabla"><thead><tr><th>Fila</th><th>Producto</th><th>Problema</th></tr></thead><tbody>
        ${errores.slice(0, 100).map(r => `<tr><td>${r.fila}</td><td>${esc(r.nombre || '—')}</td><td class="txt-error">${esc(r.errores.join('; '))}</td></tr>`).join('')}
        </tbody></table></div>${errores.length > 100 ? `<p class="nota">y ${errores.length - 100} más…</p>` : ''}
        <p class="nota">Puedes importar los válidos ahora y corregir los demás en el archivo después.</p>` : ''}
      ${validos.length ? `
        <div class="tabla-cont vista-imp"><table class="tabla"><thead><tr><th>Fila</th><th></th><th>Nombre</th><th>Código de barras</th><th class="num">Precio</th><th class="num">Existencia</th></tr></thead><tbody>
          ${validos.slice(0, 8).map(r => `<tr><td>${r.fila}</td><td><span class="chip ${r.existente ? '' : 'chip-ok'}">${r.existente ? 'Actualiza' : 'Nuevo'}</span></td><td>${esc(r.nombre)}</td><td>${esc(r.codigo_barras)}</td><td class="num">${r.precio_menudeo === '' ? '' : dinero(r.precio_menudeo)}</td><td class="num">${r.existencia === '' ? '' : numero(r.existencia)}</td></tr>`).join('')}
        </tbody></table></div>${validos.length > 8 ? `<p class="nota">Vista previa de 8 de ${numero(validos.length)} productos.</p>` : ''}
        ${conExist ? `<div class="panel-sub">
          <b>Existencias (${numero(conExist)} productos traen cantidad)</b>
          <div class="fila2">
            <label>Cargar en<select id="imp-alm"><option value="">No cargar existencias</option>${alms.map(a => `<option value="${esc(a.id)}" ${alms.length === 1 ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
            <label>Referencia<input id="imp-ref" value="Inventario inicial"></label>
          </div>
          <label class="chk"><input type="radio" name="imp-modo" value="ENTRADA" checked> Sumar a lo que ya hay (entrada)</label>
          <label class="chk"><input type="radio" name="imp-modo" value="AJUSTE"> Reemplazar por la cantidad del archivo (conteo)</label>
        </div>` : '<p class="nota">El archivo no trae existencias; solo se actualiza el catálogo.</p>'}
        <progress id="imp-prog" max="${validos.length}" value="0" hidden></progress>
        <div id="imp-res"></div>
        <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button type="button" class="btn" id="imp-ok">Importar ${numero(validos.length)} productos</button></div>`
      : '<p class="txt-error">No hay filas válidas para importar.</p>'}`;
    const ok = $('#imp-ok', v);
    if (ok) ok.onclick = () => importar(validos);
  }

  async function importar(validos) {
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para importar.'; return; }
    const ok = $('#imp-ok', d), prog = $('#imp-prog', d), res = $('#imp-res', d);
    const almSel = $('#imp-alm', d);
    const almacen_id = almSel ? almSel.value : '';
    const modo = (d.querySelector('input[name=imp-modo]:checked') || {}).value || 'ENTRADA';
    const referencia = ($('#imp-ref', d) || {}).value || 'Importación';
    if (almacen_id && modo === 'AJUSTE' &&
        !confirm('Las existencias del archivo REEMPLAZARÁN las actuales de esos productos en el almacén elegido. ¿Continuar?')) return;
    validos.forEach(r => { if (!r.mov_id) r.mov_id = uuid(); });
    ok.disabled = true;
    msg.textContent = '';
    prog.hidden = false;
    const tot = { creado: 0, actualizado: 0, error: [], aviso: [], existencias: 0 };
    try {
      for (let i = 0; i < validos.length; i += 150) {
        const lote = validos.slice(i, i + 150).map(r => {
          const o = { fila: r.fila, mov_id: r.mov_id };
          COLS_IMPORT.forEach(c => { o[c.clave] = r[c.clave]; });
          return o;
        });
        ok.textContent = `Importando ${numero(Math.min(i + 150, validos.length))} de ${numero(validos.length)}…`;
        const r = await api('importarProductos', { filas: lote, almacen_id, modo, referencia });
        r.resultados.forEach(x => {
          if (x.estado === 'error') tot.error.push(x);
          else tot[x.estado]++;
          if (x.aviso) tot.aviso.push(x);
        });
        tot.existencias += r.existencias || 0;
        prog.value = Math.min(i + 150, validos.length);
      }
      res.innerHTML = `<div class="aviso-caja ok-caja"><b>Importación terminada.</b> ${numero(tot.creado)} nuevos, ${numero(tot.actualizado)} actualizados${almacen_id ? `, ${numero(tot.existencias)} existencias cargadas en ${esc((S.idx.alm[almacen_id] || {}).nombre || '')}` : ''}.</div>
        ${tot.error.length || tot.aviso.length ? `<ul class="lista">${tot.error.concat(tot.aviso).map(x => `<li><span>Fila ${x.fila}</span><span class="txt-error">${esc(x.error || x.aviso)}</span></li>`).join('')}</ul>` : ''}`;
      ok.textContent = 'Listo';
      $('[data-cerrar]', d).textContent = 'Cerrar';
      res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast('Importación terminada.', 'ok');
      await sincronizar();
    } catch (e) {
      ok.disabled = false;
      ok.textContent = 'Reintentar';
      msg.textContent = e.message + ' Puedes reintentar: los productos ya importados solo se actualizan y las existencias no se duplican.';
      if (e.sesion) { cerrarModal(); sesionVencida(e.message); }
    }
  }
}

/* ---- Inventario ---- */
function vInventario(el) {
  const alms = almacenesVisibles();
  if (!F.ialm || !alms.some(a => a.id === F.ialm)) F.ialm = alms[0] ? alms[0].id : '';
  el.innerHTML = `
    <div class="titulo"><h2>Inventario</h2><div class="acciones"><button type="button" class="btn sec" id="btn-csv">Exportar CSV</button></div></div>
    <div class="filtros">
      ${alms.length > 1
        ? `<select id="f-alm">${alms.map(a => `<option value="${esc(a.id)}" ${a.id === F.ialm ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select>`
        : `<span class="chip">${esc(alms[0] ? alms[0].nombre : 'Sin almacén asignado')}</span>`}
      <input id="f-q" type="search" placeholder="Buscar producto o escanear" value="${esc(F.iq || '')}" autocomplete="off">
      <label class="chk"><input type="checkbox" id="f-bajo" ${F.ibajo ? 'checked' : ''}> Solo bajo mínimo</label>
    </div>
    <div id="res" class="tarjetas"></div>
    <div id="lista"></div>`;

  const filas = () => {
    const ex = mapaExistencias();
    const q = normal(F.iq || '');
    return S.catalogo.productos
      .filter(p => esActivo(p.activo) && (!q || coincide(p, q)))
      .map(p => ({ p, c: ex[F.ialm + '|' + p.id] || 0 }))
      .filter(x => !F.ibajo || (Number(x.p.stock_minimo) > 0 && x.c < Number(x.p.stock_minimo)))
      .sort((a, b) => porNombre(a.p, b.p));
  };

  const pintar = () => {
    const l = filas();
    const costos = veCostos();
    const valor = l.reduce((s, x) => s + x.c * (Number(x.p.costo) || 0), 0);
    const bajos = l.filter(x => Number(x.p.stock_minimo) > 0 && x.c < Number(x.p.stock_minimo)).length;
    $('#res', el).innerHTML = `
      <div class="tarjeta"><span>Productos</span><b>${numero(l.length)}</b></div>
      <div class="tarjeta ${bajos ? 'alerta' : ''}"><span>Bajo mínimo</span><b>${numero(bajos)}</b></div>
      ${costos ? `<div class="tarjeta"><span>Valor a costo</span><b>${dinero(valor)}</b></div>` : ''}`;
    const vis = l.slice(0, 500);
    $('#lista', el).innerHTML = l.length ? `
      <div class="tabla-cont"><table class="tabla">
        <thead><tr><th>Producto</th><th>Código</th><th class="num">Existencia</th><th class="num">Mínimo</th>${costos ? '<th class="num">Costo</th><th class="num">Valor</th>' : ''}</tr></thead>
        <tbody>${vis.map(({ p, c }) => {
          const bajo = Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo);
          return `<tr class="${bajo ? 'fila-alerta' : ''}"><td>${esc(p.nombre)}</td><td>${esc(p.codigo)}</td>
            <td class="num ${c < 0 ? 'txt-error' : ''}"><b>${numero(c)}</b> ${esc(p.unidad || '')}</td>
            <td class="num">${numero(p.stock_minimo)}</td>
            ${costos ? `<td class="num">${dinero(p.costo)}</td><td class="num">${dinero(c * (Number(p.costo) || 0))}</td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>
      ${l.length > 500 ? `<p class="nota">Mostrando 500 de ${l.length}. Usa la búsqueda o exporta el CSV.</p>` : ''}`
      : '<p class="vacio">Sin productos para mostrar.</p>';
  };
  pintar();
  S.refrescar = pintar;

  const alm = $('#f-alm', el);
  if (alm) alm.onchange = () => { F.ialm = alm.value; pintar(); };
  const q = $('#f-q', el);
  q.oninput = () => { F.iq = q.value; pintar(); };
  $('#f-bajo', el).onchange = e => { F.ibajo = e.target.checked; pintar(); };
  $('#btn-csv', el).onclick = () => {
    const costos = veCostos();
    const enc = ['Producto', 'Codigo', 'Codigo de barras', 'Unidad', 'Existencia', 'Minimo'].concat(costos ? ['Costo', 'Valor'] : []);
    const csv = [enc].concat(filas().map(({ p, c }) => [p.nombre, p.codigo, p.codigo_barras || '', p.unidad || '', c, p.stock_minimo || 0]
      .concat(costos ? [p.costo || 0, c * (Number(p.costo) || 0)] : [])))
      .map(f => f.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    const nombreAlm = (S.idx.alm[F.ialm] || {}).nombre || 'almacen';
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `inventario-${nombreAlm.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

/* ---- Selector de producto (nombre, código o lector de código de barras) ---- */
function selectorProducto(cont, alElegir) {
  cont.innerHTML = `<div class="selector">
    <input type="search" class="sel-q" placeholder="Nombre, código o escanea el código de barras" autocomplete="off">
    <div class="sugerencias" hidden></div>
    <div class="elegido" hidden></div></div>`;
  const q = $('.sel-q', cont), sug = $('.sugerencias', cont), ele = $('.elegido', cont);
  const ctl = { elegido: null };
  let opciones = [];
  const elegir = p => {
    ctl.elegido = p;
    sug.hidden = true;
    q.value = '';
    q.hidden = !!p;
    ele.hidden = !p;
    ctl.actualizar();
    if (alElegir) alElegir(p);
  };
  ctl.actualizar = () => {
    const p = ctl.elegido;
    if (!p) return;
    ele.innerHTML = `<div><b>${esc(p.nombre)}</b><small>${esc(p.codigo)}${p.codigo_barras ? ' · ' + esc(p.codigo_barras) : ''} · ${esc(ctl.infoExtra ? ctl.infoExtra(p) : '')}</small></div><button type="button" class="btn mini sec">Cambiar</button>`;
    $('button', ele).onclick = () => { elegir(null); q.focus(); };
  };
  ctl.limpiar = () => elegir(null);
  q.oninput = () => {
    const v = normal(q.value.trim());
    if (!v) { sug.hidden = true; return; }
    opciones = S.catalogo.productos.filter(p => esActivo(p.activo) && coincide(p, v)).sort(porNombre).slice(0, 8);
    sug.innerHTML = opciones.length
      ? opciones.map((p, i) => `<button type="button" data-i="${i}"><b>${esc(p.nombre)}</b><small>${esc(p.codigo)} ${esc(p.codigo_barras || '')}</small></button>`).join('')
      : '<p class="nota">Sin coincidencias.</p>';
    sug.hidden = false;
  };
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = q.value.trim();
    const p = S.idx.barras[v] || S.idx.codigo[normal(v)] || (opciones.length === 1 ? opciones[0] : null);
    if (p) elegir(p);
    else if (v) toast('No se encontró un producto con ese código.', 'error');
  };
  sug.onclick = e => {
    const b = e.target.closest('[data-i]');
    if (b) elegir(opciones[Number(b.dataset.i)]);
  };
  return ctl;
}

/* ---- Movimientos ---- */
function vMovimientos(el) {
  const alms = almacenesVisibles();
  if (!alms.length) {
    el.innerHTML = '<div class="panel"><p>No tienes un almacén asignado. Pide al administrador que te asigne uno.</p></div>';
    return;
  }
  const M = F.mov || (F.mov = { tipo: 'ENTRADA', almacen_id: alms[0].id, referencia: '' });
  if (!alms.some(a => a.id === M.almacen_id)) M.almacen_id = alms[0].id;

  el.innerHTML = `
    <div class="titulo"><h2>Movimientos</h2></div>
    <form id="fm" class="panel form" autocomplete="off">
      <div class="segmentos" id="tipos">${['ENTRADA', 'SALIDA', 'AJUSTE', 'TRASPASO'].map(t => `<button type="button" data-t="${t}">${TIPO_TXT[t]}</button>`).join('')}</div>
      <p class="nota" id="ayuda"></p>
      <div class="fila2">
        <label>Almacén<select name="almacen_id">${alms.map(a => `<option value="${esc(a.id)}" ${a.id === M.almacen_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        <label id="lbl-dest">Destino<select name="destino_id"></select></label>
      </div>
      <div class="campo"><span>Producto</span><div id="selector"></div></div>
      <div class="fila3">
        <label><span id="txt-cant">Cantidad</span><input name="cantidad" type="number" step="any" min="0" inputmode="decimal"></label>
        <label id="lbl-costo">Costo unitario<input name="costo_unitario" type="number" step="0.01" min="0" placeholder="Costo actual"></label>
        <label>Referencia<input name="referencia" value="${esc(M.referencia || '')}" placeholder="Factura, remisión, folio…"></label>
      </div>
      <label>Notas<input name="notas"></label>
      <p class="msg" id="fm-msg"></p>
      <div class="pie"><button class="btn" type="submit">Registrar</button></div>
    </form>
    <div id="pend"></div>
    <div class="panel">
      <div class="titulo"><h3>Historial</h3><button type="button" class="btn sec" id="btn-hist">Cargar del servidor</button></div>
      <div id="hist"><p class="nota">Muestra los últimos 100 movimientos del almacén elegido. Requiere conexión.</p></div>
    </div>`;

  const fm = $('#fm', el);
  const msg = $('#fm-msg', el);
  const sel = selectorProducto($('#selector', el), () => fm.cantidad.focus());
  sel.infoExtra = p => `Existencia: ${numero(mapaExistencias()[M.almacen_id + '|' + p.id] || 0)} ${p.unidad || ''}`;

  const pintarDestinos = () => {
    const todos = S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.id !== M.almacen_id).sort(porNombre);
    fm.destino_id.innerHTML = '<option value="">Elige destino</option>' + todos.map(a => `<option value="${esc(a.id)}">${esc(a.nombre)}</option>`).join('');
  };
  const pintarTipo = () => {
    $$('#tipos button', el).forEach(b => b.classList.toggle('activo', b.dataset.t === M.tipo));
    $('#ayuda', el).textContent = AYUDA_TIPO[M.tipo];
    $('#lbl-dest', el).hidden = M.tipo !== 'TRASPASO';
    $('#lbl-costo', el).hidden = M.tipo !== 'ENTRADA' || !veCostos();
    $('#txt-cant', el).textContent = M.tipo === 'AJUSTE' ? 'Existencia contada' : 'Cantidad';
  };
  const pintarPend = () => {
    const l = misPendientes().sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    $('#pend', el).innerHTML = l.length ? `<div class="panel"><h3>Por enviar / con error</h3><ul class="lista">${l.map(o => {
      const prod = S.idx.prod[o.producto_id];
      const cant = o.tipo === 'AJUSTE' ? 'Conteo: ' + numero(o.cantidad) : numero(o.cantidad);
      return `<li><div><b>${esc(TIPO_TXT[o.tipo])}</b> · ${esc(prod ? prod.nombre : o.producto_id)} · ${cant}
        <small>${esc((S.idx.alm[o.almacen_id] || {}).nombre || '')}${o.tipo === 'TRASPASO' ? ' → ' + esc((S.idx.alm[o.destino_id] || {}).nombre || '') : ''} · ${fechaHora(o.fecha)}${o.origen === 'offline' ? ' · capturado sin conexión' : ''}</small>
        ${o.estado === 'rechazado' ? `<small class="txt-error">${esc(o.error)}</small>` : ''}</div>
        ${o.estado === 'rechazado'
          ? `<span class="acciones"><button type="button" class="btn mini sec" data-reint="${esc(o.id)}">Reintentar</button><button type="button" class="btn mini peligro" data-desc="${esc(o.id)}">Descartar</button></span>`
          : '<span class="chip">Pendiente</span>'}</li>`;
    }).join('')}</ul></div>` : '';
  };

  pintarDestinos();
  pintarTipo();
  pintarPend();
  S.refrescar = () => { pintarPend(); sel.actualizar(); };

  $('#tipos', el).onclick = e => {
    const b = e.target.closest('[data-t]');
    if (b) { M.tipo = b.dataset.t; pintarTipo(); msg.textContent = ''; }
  };
  fm.almacen_id.onchange = () => { M.almacen_id = fm.almacen_id.value; pintarDestinos(); sel.actualizar(); };

  fm.onsubmit = async ev => {
    ev.preventDefault();
    msg.textContent = '';
    const prod = sel.elegido;
    const cantTxt = fm.cantidad.value.trim();
    const cant = Number(cantTxt);
    if (!prod) { msg.textContent = 'Elige un producto.'; return; }
    if (cantTxt === '' || !isFinite(cant) || cant < 0 || (M.tipo !== 'AJUSTE' && cant === 0)) { msg.textContent = 'Captura una cantidad válida.'; return; }
    if (M.tipo === 'TRASPASO' && !fm.destino_id.value) { msg.textContent = 'Elige el almacén destino.'; return; }
    const enLinea = navigator.onLine && S.online;
    const ex = mapaExistencias()[M.almacen_id + '|' + prod.id] || 0;
    if ((M.tipo === 'SALIDA' || M.tipo === 'TRASPASO') && cant > ex) {
      if (enLinea) { msg.textContent = `Existencia insuficiente: hay ${numero(ex)} ${prod.unidad || ''}.`; return; }
      if (!confirm(`Según los últimos datos solo hay ${numero(ex)}. ¿Registrar de todos modos?`)) return;
    }
    const mov = {
      id: uuid(),
      fecha: new Date().toISOString(),
      tipo: M.tipo,
      almacen_id: M.almacen_id,
      destino_id: M.tipo === 'TRASPASO' ? fm.destino_id.value : '',
      producto_id: prod.id,
      cantidad: cant,
      costo_unitario: M.tipo === 'ENTRADA' && fm.costo_unitario.value !== '' ? Number(fm.costo_unitario.value) : '',
      referencia: fm.referencia.value.trim(),
      notas: fm.notas.value.trim(),
      origen: enLinea ? 'online' : 'offline',
      estado: 'pendiente',
      usuario: S.usuario.usuario
    };
    await DB.guardarMov(mov);
    S.outbox.push(mov);
    M.referencia = mov.referencia;
    fm.cantidad.value = '';
    fm.costo_unitario.value = '';
    fm.notas.value = '';
    sel.limpiar();
    $('.sel-q', el).focus();
    toast(enLinea ? 'Movimiento registrado.' : 'Guardado sin conexión; se enviará al volver el internet.', 'ok');
    pintarPend();
    actualizarBarra();
    if (enLinea) sincronizar();
  };

  $('#pend', el).onclick = async e => {
    const re = e.target.closest('[data-reint]');
    const de = e.target.closest('[data-desc]');
    if (re) {
      const o = S.outbox.find(x => x.id === re.dataset.reint);
      o.estado = 'pendiente';
      delete o.error;
      await DB.guardarMov(o);
      pintarPend();
      sincronizar(true);
    }
    if (de && confirm('¿Descartar este movimiento? No se aplicará al inventario.')) {
      S.outbox = S.outbox.filter(x => x.id !== de.dataset.desc);
      await DB.borrarMov(de.dataset.desc);
      pintarPend();
      actualizarBarra();
    }
  };

  $('#btn-hist', el).onclick = async () => {
    const h = $('#hist', el);
    h.innerHTML = '<p class="nota">Cargando…</p>';
    try {
      const r = await api('listarMovimientos', { almacen_id: M.almacen_id, limite: 100 });
      h.innerHTML = r.length ? `<div class="tabla-cont"><table class="tabla">
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Producto</th><th class="num">Cantidad</th><th>Referencia</th><th>Usuario</th></tr></thead>
        <tbody>${r.map(m => `<tr><td>${fechaHora(m.fecha)}${m.origen === 'offline' ? '<small>sin conexión</small>' : ''}</td>
          <td>${esc(TIPO_TXT[m.tipo] || m.tipo)}</td><td>${esc(m.producto)}</td>
          <td class="num ${Number(m.cantidad) < 0 ? 'txt-error' : 'txt-ok'}">${Number(m.cantidad) > 0 ? '+' : ''}${numero(m.cantidad)}</td>
          <td>${esc(m.referencia)}${m.notas ? `<small>${esc(m.notas)}</small>` : ''}</td><td>${esc(m.usuario)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="vacio">Sin movimientos.</p>';
    } catch (e) {
      h.innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
      if (e.sesion) sesionVencida(e.message);
    }
  };
}

/* ---- Almacenes ---- */
function vAlmacenes(el) {
  el.innerHTML = `<div class="titulo"><h2>Almacenes y sucursales</h2><div class="acciones"><button type="button" class="btn" id="btn-nuevo">Nuevo almacén</button></div></div><div id="lista" class="tarjetas grandes"></div>`;
  const pintar = () => {
    const ex = mapaExistencias();
    const l = S.catalogo.almacenes.slice().sort((a, b) => (a.tipo === b.tipo ? porNombre(a, b) : a.tipo === 'BODEGA' ? -1 : 1));
    $('#lista', el).innerHTML = l.map(a => {
      let prods = 0, valor = 0;
      S.catalogo.productos.forEach(p => {
        const c = ex[a.id + '|' + p.id] || 0;
        if (c) { prods++; valor += c * (Number(p.costo) || 0); }
      });
      return `<button type="button" class="tarjeta almacen ${esActivo(a.activo) ? '' : 'inactivo'}" data-id="${esc(a.id)}">
        <span class="chip ${a.tipo === 'BODEGA' ? 'chip-bodega' : ''}">${a.tipo === 'BODEGA' ? 'Bodega' : 'Sucursal'}${esActivo(a.activo) ? '' : ' · inactivo'}</span>
        <b>${esc(a.nombre)}</b>
        <small>${esc(a.direccion || 'Sin dirección')}</small>
        <small>${esc(a.responsable || '')}${a.telefono ? ' · ' + esc(a.telefono) : ''}</small>
        <small>${numero(prods)} productos con existencia · ${dinero(valor)}</small></button>`;
    }).join('') || '<p class="vacio">Sin almacenes.</p>';
  };
  pintar();
  S.refrescar = pintar;
  $('#btn-nuevo', el).onclick = () => dlgAlmacen(null);
  $('#lista', el).onclick = e => {
    const b = e.target.closest('[data-id]');
    if (b) dlgAlmacen(S.idx.alm[b.dataset.id]);
  };
}

function dlgAlmacen(a) {
  const nuevo = !a;
  a = a || { tipo: 'SUCURSAL', activo: true };
  const d = abrirModal(nuevo ? 'Nuevo almacén' : 'Editar almacén', `
    <form id="fa" class="form">
      <div class="fila2">
        <label>Nombre<input name="nombre" required value="${esc(a.nombre || '')}"></label>
        <label>Tipo<select name="tipo"><option value="BODEGA" ${a.tipo === 'BODEGA' ? 'selected' : ''}>Bodega</option><option value="SUCURSAL" ${a.tipo === 'SUCURSAL' ? 'selected' : ''}>Sucursal / punto de venta</option></select></label>
      </div>
      <label>Dirección<input name="direccion" value="${esc(a.direccion || '')}"></label>
      <div class="fila2">
        <label>Responsable<input name="responsable" value="${esc(a.responsable || '')}"></label>
        <label>Teléfono<input name="telefono" type="tel" value="${esc(a.telefono || '')}"></label>
      </div>
      <label class="chk"><input type="checkbox" name="activo" ${esActivo(a.activo) ? 'checked' : ''}> Activo</label>
      <p class="msg" id="fa-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fa', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fa-msg', d);
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para guardar.'; return; }
    msg.textContent = 'Guardando…';
    try {
      const r = await api('guardarAlmacen', { almacen: {
        id: a.id || '', nombre: f.nombre.value, tipo: f.tipo.value, direccion: f.direccion.value,
        responsable: f.responsable.value, telefono: f.telefono.value, activo: f.activo.checked
      } });
      upsert(S.catalogo.almacenes, r);
      await DB.set('catalogo', S.catalogo);
      indexar();
      cerrarModal();
      toast('Almacén guardado.', 'ok');
      if (S.refrescar) S.refrescar();
      sincronizar();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
}

/* ---- Usuarios ---- */
function vUsuarios(el) {
  el.innerHTML = `<div class="titulo"><h2>Usuarios</h2><div class="acciones"><button type="button" class="btn" id="btn-nuevo">Nuevo usuario</button></div></div><div id="lista"><p class="nota">Cargando…</p></div>`;
  let lista = [];
  const pintar = () => {
    $('#lista', el).innerHTML = lista.length ? `<div class="tabla-cont"><table class="tabla">
      <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Almacén</th><th>Último acceso</th><th>Estado</th></tr></thead>
      <tbody>${lista.slice().sort(porNombre).map(u => `<tr class="clic ${u.activo ? '' : 'inactivo'}" data-id="${esc(u.id)}">
        <td>${esc(u.usuario)}</td><td>${esc(u.nombre)}</td><td>${esc(ROL_TXT[u.rol] || u.rol)}</td>
        <td>${esc((S.idx.alm[u.almacen_id] || {}).nombre || '—')}</td><td>${fechaHora(u.ultimo_acceso)}</td>
        <td>${u.activo ? '<span class="chip chip-ok">Activo</span>' : '<span class="chip">Inactivo</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="vacio">Sin usuarios.</p>';
  };
  const cargar = async () => {
    if (!navigator.onLine) { $('#lista', el).innerHTML = '<p class="nota">La administración de usuarios requiere conexión.</p>'; return; }
    try {
      lista = await api('listarUsuarios');
      pintar();
    } catch (e) {
      $('#lista', el).innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
      if (e.sesion) sesionVencida(e.message);
    }
  };
  cargar();
  $('#btn-nuevo', el).onclick = () => dlgUsuario(null, cargar);
  $('#lista', el).onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) dlgUsuario(lista.find(u => u.id === tr.dataset.id), cargar);
  };
}

function dlgUsuario(u, alGuardar) {
  const nuevo = !u;
  u = u || { rol: 'CAJERO', activo: true, almacen_id: esGeneral() ? '' : S.usuario.almacen_id };
  const roles = esGeneral() ? Object.keys(ROL_TXT) : ['CAJERO', 'INVENTARIOS'];
  const alms = esGeneral() ? S.catalogo.almacenes.filter(a => esActivo(a.activo) || a.id === u.almacen_id).sort(porNombre) : almacenesVisibles();
  const d = abrirModal(nuevo ? 'Nuevo usuario' : 'Editar usuario', `
    <form id="fu" class="form" autocomplete="off">
      <div class="fila2">
        <label>Usuario<input name="usuario" required value="${esc(u.usuario || '')}" autocapitalize="none" placeholder="ej. caja.centro"></label>
        <label>Nombre<input name="nombre" required value="${esc(u.nombre || '')}"></label>
      </div>
      <div class="fila2">
        <label>Rol<select name="rol">${roles.map(r => `<option value="${r}" ${r === u.rol ? 'selected' : ''}>${ROL_TXT[r]}</option>`).join('')}</select></label>
        <label id="lbl-alm">Almacén / sucursal<select name="almacen_id"><option value="">Elige…</option>${alms.map(a => `<option value="${esc(a.id)}" ${a.id === u.almacen_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
      </div>
      <label>${nuevo ? 'Contraseña inicial' : 'Nueva contraseña (déjala vacía para no cambiarla)'}<input name="password" type="text" ${nuevo ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
      <p class="nota">Al entrar por primera vez se le pedirá cambiarla.</p>
      ${nuevo ? '' : `<label class="chk"><input type="checkbox" name="activo" ${u.activo ? 'checked' : ''}> Activo</label>`}
      <p class="msg" id="fu-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fu', d);
  const pintarAlm = () => { $('#lbl-alm', d).hidden = ['ADMIN_GENERAL', 'CLIENTE'].includes(f.rol.value); };
  pintarAlm();
  f.rol.onchange = pintarAlm;
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fu-msg', d);
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para guardar.'; return; }
    msg.textContent = 'Guardando…';
    try {
      await api('guardarUsuario', { usuario: {
        id: u.id || '', usuario: f.usuario.value.trim(), nombre: f.nombre.value.trim(), rol: f.rol.value,
        almacen_id: f.almacen_id.value, password: f.password.value, activo: nuevo ? true : f.activo.checked
      } });
      cerrarModal();
      toast('Usuario guardado.', 'ok');
      alGuardar();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
}

/* ---- Mi cuenta ---- */
function vCuenta(el) {
  const a = S.idx.alm[S.usuario.almacen_id];
  el.innerHTML = `
    <div class="titulo"><h2>Mi cuenta</h2></div>
    <div class="panel"><p><b>${esc(S.usuario.nombre)}</b> (${esc(S.usuario.usuario)})</p><p>${esc(ROL_TXT[rol()] || rol())}${a ? ' · ' + esc(a.nombre) : ''}</p></div>
    <div class="panel">
      <h3>Este equipo</h3>
      <p>Datos guardados: ${numero(S.catalogo.productos.length)} productos, ${numero(S.catalogo.almacenes.length)} almacenes.</p>
      <p>Última actualización: <b>${S.ultimaSync ? fechaHora(S.ultimaSync) : 'nunca'}</b></p>
      <p class="nota" id="persist"></p>
      <div class="acciones"><button type="button" class="btn" id="b-sync">Sincronizar ahora</button><button type="button" class="btn sec" id="b-inst" ${promptInstalar ? '' : 'hidden'}>Instalar en este equipo</button></div>
    </div>
    <div class="panel"><h3>Contraseña</h3><button type="button" class="btn sec" id="b-pass">Cambiar contraseña</button></div>
    <div class="panel"><button type="button" class="btn peligro" id="b-salir">Cerrar sesión</button></div>
    <p class="nota">Versión ${VERSION_APP}</p>`;
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(p => {
      $('#persist', el).textContent = p
        ? 'Almacenamiento protegido: el navegador no borrará los datos de este equipo.'
        : 'Instala la app para proteger los datos guardados en este equipo.';
    });
  }
  $('#b-sync', el).onclick = () => sincronizar(true);
  $('#b-pass', el).onclick = () => dlgCambiarPassword(false);
  $('#b-salir', el).onclick = cerrarSesion;
  $('#b-inst', el).onclick = async () => {
    if (!promptInstalar) return;
    promptInstalar.prompt();
    await promptInstalar.userChoice;
    promptInstalar = null;
    $('#b-inst', el).hidden = true;
  };
}

function dlgCambiarPassword(obligatorio) {
  const d = abrirModal('Cambiar contraseña', `
    <form id="fpw" class="form">
      ${obligatorio ? '<p class="aviso-caja">Por seguridad, cambia la contraseña que te asignaron.</p>' : ''}
      <label>Contraseña actual<input name="actual" type="password" required autocomplete="current-password"></label>
      <label>Nueva contraseña<input name="nueva" type="password" required minlength="6" autocomplete="new-password"></label>
      <label>Confirmar nueva contraseña<input name="conf" type="password" required minlength="6" autocomplete="new-password"></label>
      <p class="msg" id="fpw-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>${obligatorio ? 'Después' : 'Cancelar'}</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fpw', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fpw-msg', d);
    if (f.nueva.value !== f.conf.value) { msg.textContent = 'Las contraseñas nuevas no coinciden.'; return; }
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para cambiar la contraseña.'; return; }
    msg.textContent = 'Guardando…';
    try {
      const pub = await api('cambiarPassword', { actual: f.actual.value, nueva: f.nueva.value });
      S.usuario = pub;
      const ses = await DB.get('sesion');
      if (ses) { ses.usuario = pub; await DB.set('sesion', ses); }
      await guardarCredencial(pub.usuario, f.nueva.value, pub, S.token);
      cerrarModal();
      toast('Contraseña actualizada.', 'ok');
    } catch (e) {
      msg.textContent = e.message;
    }
  };
}

/* ---------------- Arranque ---------------- */
async function iniciar() {
  document.title = CFG.NOMBRE;
  $('#login-titulo').textContent = CFG.NOMBRE;
  $('#app-nombre').textContent = CFG.NOMBRE;

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    await DB.abrir();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:2rem">Este navegador no permite guardar datos en el equipo. Usa Chrome o Edge actualizados.</p>';
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  $('#form-login').addEventListener('submit', onLogin);
  $('#menu').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) irA(b.dataset.v); });
  $('#estado').addEventListener('click', () => sincronizar(true));
  $('#dlg').addEventListener('click', e => { if (e.target.closest('[data-cerrar]')) cerrarModal(); });

  window.addEventListener('online', () => { S.online = true; actualizarBarra(); sincronizar(); });
  window.addEventListener('offline', () => { S.online = false; actualizarBarra(); });
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    promptInstalar = e;
    const b = $('#b-inst');
    if (b) b.hidden = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.usuario && navigator.onLine &&
        Date.now() - S.ultimaSync > CFG.SYNC_MINUTOS * 60000) sincronizar();
  });

  const ses = await DB.get('sesion');
  if (ses && ses.usuario) {
    await cargarSesion(ses);
    mostrarApp();
    if (navigator.onLine) sincronizar();
  } else {
    mostrarLogin('', /^https?:\/\//.test(CFG.API_URL) ? '' : 'Falta configurar API_URL en config.js.');
  }

  setInterval(() => { if (S.usuario && navigator.onLine) sincronizar(); }, Math.max(1, Number(CFG.SYNC_MINUTOS) || 15) * 60000);
  setInterval(actualizarBarra, 30000);
}

document.addEventListener('DOMContentLoaded', iniciar);
