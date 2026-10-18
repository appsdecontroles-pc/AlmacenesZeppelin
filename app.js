'use strict';
/* Control de Inventario — Fase 1
 * App instalable que funciona sin internet con los últimos datos descargados.
 * Servidor: Google Apps Script (API) + Google Sheets (base de datos). */

const CFG = Object.assign({ NOMBRE: 'Control de Inventario', SYNC_MINUTOS: 15, API_URL: '' }, window.APP_CONFIG || {});
const VERSION_APP = '5.2.0';

const ROL_TXT = {
  ADMIN_GENERAL: 'Administrador general',
  ADMIN_SUCURSAL: 'Administrador de sucursal',
  INVENTARIOS: 'Control de inventarios',
  CAJERO: 'Cajero',
  CLIENTE: 'Cliente'
};
const TIPO_TXT = {
  ENTRADA: 'Entrada', SALIDA: 'Salida', AJUSTE: 'Ajuste por conteo', TRASPASO: 'Traspaso',
  TRASPASO_SALIDA: 'Traspaso (sale)', TRASPASO_ENTRADA: 'Traspaso (llega)',
  VENTA: 'Venta', CANCELACION: 'Cancelación de venta', SURTIDO: 'Surtido de pedido', DEVOLUCION: 'Regreso a bodega', RECEPCION: 'Recepción de pedido'
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
  refrescar: null,
  alertas: null,
  clientes: [],
  precios: [],
  cliente: null,
  avisos: null
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

// Reemplaza el contenido quitando antes el foco de un campo interno (evita un segundo repintado al perder el foco)
function ponerHTML(cont, html) {
  const a = document.activeElement;
  if (a && cont.contains(a)) a.blur();
  cont.innerHTML = html;
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

function abrirModal(titulo, html, ancho = false) {
  const d = $('#dlg');
  d.classList.toggle('ancho', ancho);
  d.onclick = null;
  d.innerHTML = `<form method="dialog" class="dlg-cab"><h2>${esc(titulo)}</h2><button class="icono" aria-label="Cerrar">✕</button></form><div class="dlg-cuerpo">${html}</div>`;
  if (!d.open) d.showModal();
  return d;
}
const cerrarModal = () => { const d = $('#dlg'); if (d.open) d.close(); };

// Pantalla de espera con la animación de la marca
let cargasActivas = 0;
function mostrarCarga(texto = 'Cargando…') {
  cargasActivas++;
  $('#carga-txt').textContent = texto;
  $('#carga').classList.remove('oculta');
  $('#carga').hidden = false;
}
function ocultarCarga(forzar = false) {
  cargasActivas = forzar ? 0 : Math.max(0, cargasActivas - 1);
  if (cargasActivas) return;
  $('#carga').classList.add('oculta');
  setTimeout(() => { if (!cargasActivas) $('#carga').hidden = true; }, 260);
}
// Ejecuta una tarea larga mostrando la animación
async function conCarga(texto, fn) {
  mostrarCarga(texto);
  try { return await fn(); } finally { ocultarCarga(); }
}

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
      } else if (o.clase === 'VENTA') {
        o.lineas.forEach(l => { const kv = o.almacen_id + '|' + l.producto_id; m[kv] = (m[kv] || 0) - Number(l.cantidad); });
      }
    });
  return m;
}

/* ---------------- Sesión ---------------- */
async function cargarSesion(ses) {
  if (!S.usuario || S.usuario.usuario !== ses.usuario.usuario) { CMP.datos = null; CPP.datos = null; CJ.estado = null; VT.cli = null; VT.ventas = null; PD.datos = null; PT.datos = null; PT.carrito = null; }
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
  S.alertas = esGeneral() ? (await DB.get('alertas')) || null : null;
  S.clientes = (await DB.get('clientes')) || [];
  S.precios = (await DB.get('precios')) || [];
  S.cliente = rol() === 'CLIENTE' ? (await DB.get('cliente')) || null : null;
  S.avisos = (await DB.get('avisos')) || null;
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
  mostrarCarga('Entrando…');
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
    S.vista = rol() === 'CAJERO' ? 'caja' : 'inicio';
    mostrarApp();
    if (!ses.offline) {
      await sincronizar();
      if (S.usuario && S.usuario.debe_cambiar_password) dlgCambiarPassword(true);
    }
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    ocultarCarga();
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
  if (CJ.estado && CJ.estado.corte && !confirm('Tu caja sigue abierta. Al volver a entrar la encontrarás igual. ¿Cerrar sesión?')) return;
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
  const todos = misPendientes().filter(o => o.estado === 'pendiente');
  const pend = todos.filter(o => !o.clase);
  const ops = todos.filter(o => o.clase).sort((a, b) => a.seq - b.seq);
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
  for (let i = 0; i < ops.length; i += 25) {
    const lote = ops.slice(i, i + 25);
    const r = await api('registrarCaja', { operaciones: lote });
    for (const res of r.resultados) {
      const o = lote.find(x => x.id === res.id);
      if (!o) continue;
      if (res.estado === 'rechazado') {
        o.estado = 'rechazado';
        o.error = res.error;
        rechazados++;
        await DB.guardarMov(o);
      } else {
        S.outbox = S.outbox.filter(x => x !== o);
        await DB.borrarMov(o.id);
        if (res.aviso) avisos.push(res.aviso);
      }
      resultadoCaja(o, res);
    }
  }
  avisos.forEach(a => toast(a, 'aviso'));
  if (rechazados) toast(`${plural(rechazados, 'operación')} rechazada(s). Revísalas en Movimientos o en Caja.`, 'error');
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
    S.alertas = d.alertas || null;
    await DB.set('alertas', S.alertas);
    S.avisos = d.avisos || null;
    await DB.set('avisos', S.avisos);
    if (d.cliente) { S.cliente = d.cliente; await DB.set('cliente', S.cliente); }
    if (d.clientes) {
      // Conserva el saldo local de lo que aún no se envía (ventas a crédito y abonos en cola)
      const ajuste = {};
      misPendientes().filter(o => o.estado === 'pendiente').forEach(o => {
        if (o.clase === 'VENTA' && o.cliente_id && Number(o.pagos.credito) > 0) ajuste[o.cliente_id] = (ajuste[o.cliente_id] || 0) + Number(o.pagos.credito);
        if (o.clase === 'ABONO') ajuste[o.cliente_id] = (ajuste[o.cliente_id] || 0) - Number(o.monto);
      });
      S.clientes = d.clientes.map(c => (ajuste[c.id] ? Object.assign(c, { saldo: Math.max(0, Number(c.saldo) + ajuste[c.id]) }) : c));
      S.precios = d.precios || [];
      await DB.set('clientes', S.clientes);
      await DB.set('precios', S.precios);
    }
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
  caja: { titulo: 'Caja', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'CAJERO'], render: vCaja },
  productos: { titulo: 'Productos', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vProductos },
  inventario: { titulo: 'Inventario', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vInventario },
  movimientos: { titulo: 'Movimientos', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS'], render: vMovimientos },
  compras: { titulo: 'Compras', roles: ['ADMIN_GENERAL', 'INVENTARIOS'], render: vCompras },
  pedidos: { titulo: 'Pedidos', roles: ['ADMIN_GENERAL', 'INVENTARIOS', 'ADMIN_SUCURSAL'], render: vPedidos },
  pagar: { titulo: 'Por pagar', roles: ['ADMIN_GENERAL'], render: vPagar },
  ventas: { titulo: 'Ventas', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'], render: vVentas },
  almacenes: { titulo: 'Almacenes', roles: ['ADMIN_GENERAL'], render: vAlmacenes },
  usuarios: { titulo: 'Usuarios', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'], render: vUsuarios },
  tienda: { titulo: 'Hacer pedido', roles: ['CLIENTE'], render: vTienda },
  mispedidos: { titulo: 'Mis pedidos', roles: ['CLIENTE'], render: vMisPedidos },
  estado: { titulo: 'Estado de cuenta', roles: ['CLIENTE'], render: vEstadoCuenta },
  cuenta: { titulo: 'Mi cuenta', roles: null, render: vCuenta }
};
const puedeVer = k => !VISTAS[k].roles || VISTAS[k].roles.includes(rol());

function mostrarLogin(usuario = '', msg = '') {
  $('#toasts').innerHTML = '';
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
    .map(k => {
      const n = k === 'pagar' && S.alertas ? S.alertas.vencidas + S.alertas.por_vencer
        : k === 'pedidos' && S.avisos ? S.avisos.solicitados + S.avisos.por_surtir + (rol() === 'ADMIN_SUCURSAL' ? S.avisos.en_ruta : 0) : 0;
      return `<button type="button" data-v="${k}" class="${S.vista === k ? 'activo' : ''}">${VISTAS[k].titulo}${n ? `<span class="burbuja ${k === 'pagar' && S.alertas.vencidas ? 'roja' : ''}">${n}</span>` : ''}</button>`;
    }).join('');
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
  if (rol() === 'CLIENTE') return vInicioPortal(el);
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
  const enCaja = VISTAS.caja.roles.includes(rol());
  el.innerHTML = `
    ${enCaja ? `<button type="button" class="ir-caja" id="t-caja"><b>${CJ.estado && CJ.estado.corte ? 'Ir a la caja' : 'Abrir caja'}</b><span>Punto de venta</span></button>` : ''}
    <div class="saludo"><h2>Hola, ${esc(S.usuario.nombre)}</h2><p>${esc(ROL_TXT[rol()] || rol())}${miAlm ? ' · ' + esc(miAlm.nombre) : ''}</p></div>
    <div class="tarjetas">
      <div class="tarjeta"><span>Productos activos</span><b>${numero(prods.length)}</b></div>
      <div class="tarjeta"><span>${esGeneral() ? 'Almacenes activos' : 'Almacén'}</span><b>${esGeneral() ? alms.length : esc(miAlm ? miAlm.nombre : '—')}</b></div>
      <button type="button" class="tarjeta ${bajos ? 'alerta' : ''}" id="t-bajos"><span>Bajo mínimo</span><b>${numero(bajos)}</b></button>
      ${veCostos() ? `<div class="tarjeta"><span>Valor del inventario (costo)</span><b>${dinero(valor)}</b></div>` : ''}
      ${S.avisos && (S.avisos.solicitados || S.avisos.por_surtir || S.avisos.en_ruta) ? `
        <button type="button" class="tarjeta ${S.avisos.solicitados ? 'alerta' : ''}" data-ir-ped="1"><span>Pedidos por atender</span><b>${S.avisos.solicitados + S.avisos.por_surtir}</b><small>${plural(S.avisos.solicitados, 'solicitud')} · ${S.avisos.por_surtir} por surtir hoy</small></button>
        <button type="button" class="tarjeta" data-ir-ped="1"><span>Envíos en ruta</span><b>${S.avisos.en_ruta}</b></button>` : ''}
      ${esGeneral() && S.avisos && S.avisos.cobrar_vencido_n ? `<button type="button" class="tarjeta alerta-roja" data-ir-cob="1"><span>Cobranza vencida</span><b>${dinero(S.avisos.cobrar_vencido)}</b><small>${plural(S.avisos.cobrar_vencido_n, 'cuenta')}</small></button>` : ''}
      ${esGeneral() && S.alertas ? `
        <button type="button" class="tarjeta ${S.alertas.vencidas ? 'alerta-roja' : ''}" data-pagos="vencidas"><span>Pagos vencidos</span><b>${dinero(S.alertas.monto_vencido)}</b><small>${plural(S.alertas.vencidas, 'cuenta')}</small></button>
        <button type="button" class="tarjeta ${S.alertas.por_vencer ? 'alerta' : ''}" data-pagos="por_vencer"><span>Pagos que vencen en ${S.alertas.dias} días</span><b>${dinero(S.alertas.monto_por_vencer)}</b><small>${plural(S.alertas.por_vencer, 'cuenta')}</small></button>` : ''}
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
  const tc = $('#t-caja', el);
  if (tc) tc.onclick = () => irA('caja');
  $$('[data-pagos]', el).forEach(b => { b.onclick = () => { CPP.filtro = b.dataset.pagos; irA('pagar'); }; });
  $$('[data-ir-ped]', el).forEach(b => { b.onclick = () => irA('pedidos'); });
  $$('[data-ir-cob]', el).forEach(b => { b.onclick = () => { VT.pestana = 'cobrar'; irA('ventas'); }; });
  S.refrescar = () => vInicio(el);
}

/* ---- Productos ---- */
function vProductos(el) {
  const puede = puedeCatalogo();
  const borra = esGeneral();
  F.psel = F.psel || new Set();
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo)).sort(porNombre);
  el.innerHTML = `
    <div class="titulo"><h2>Productos</h2>${puede ? `<div class="acciones"><button type="button" class="btn sec" id="btn-cats">Categorías</button><button type="button" class="btn sec" id="btn-importar">Importar Excel</button><button type="button" class="btn" id="btn-nuevo">Nuevo producto</button></div>` : ''}</div>
    <div class="filtros">
      <input id="f-q" type="search" placeholder="Buscar por nombre, código o escanea el código de barras" value="${esc(F.pq || '')}" autocomplete="off">
      <select id="f-cat"><option value="">Todas las categorías</option>${cats.map(c => `<option value="${esc(c.id)}" ${F.pcat === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="f-inact" ${F.pinact ? 'checked' : ''}> Ver inactivos</label>
    </div>
    ${borra ? '<div class="barra-sel" id="p-sel" hidden></div>' : ''}
    <div id="lista"></div>`;

  let filtrados = [];
  const pintarSel = () => {
    if (!borra) return;
    S.catalogo.productos.length && [...F.psel].forEach(id => { if (!S.idx.prod[id]) F.psel.delete(id); });
    const n = F.psel.size, b = $('#p-sel', el);
    const fuera = filtrados.filter(p => !F.psel.has(p.id)).length;
    b.hidden = !n && !F.pcat;
    b.innerHTML = n ? `<b>${plural(n, 'producto')} ${n === 1 ? 'seleccionado' : 'seleccionados'}</b>
      ${fuera ? `<button type="button" class="btn mini sec" id="ps-todos">Seleccionar los ${numero(filtrados.length)} de la lista</button>` : ''}
      <button type="button" class="btn mini sec" id="ps-quitar">Quitar selección</button>
      <button type="button" class="btn mini peligro" id="ps-borrar">Eliminar seleccionados</button>`
      : F.pcat && filtrados.length ? `<span>Categoría <b>${esc((S.idx.cat[F.pcat] || {}).nombre || '')}</b>: ${plural(filtrados.length, 'producto')}</span>
      <button type="button" class="btn mini sec" id="ps-todos">Seleccionar toda la categoría</button>` : '';
    const chkTodos = $('#ps-pag', el);
    if (chkTodos) {
      const vis = $$('[data-sel]', el);
      chkTodos.checked = vis.length > 0 && vis.every(c => c.checked);
      chkTodos.indeterminate = !chkTodos.checked && vis.some(c => c.checked);
    }
  };
  const pintar = () => {
    const q = normal(F.pq || '');
    const ex = mapaExistencias();
    const alms = almacenesVisibles();
    let lista = S.catalogo.productos
      .filter(p => (F.pinact || esActivo(p.activo)) && (!F.pcat || p.categoria_id === F.pcat) && (!q || coincide(p, q)))
      .sort(porNombre);
    filtrados = lista;
    const total = lista.length;
    lista = lista.slice(0, 300);
    $('#lista', el).innerHTML = total ? `
      <div class="tabla-cont"><table class="tabla">
        <thead><tr>${borra ? '<th class="col-sel"><input type="checkbox" id="ps-pag" title="Seleccionar los de esta página"></th>' : ''}<th>Código</th><th>Producto</th><th>Categoría</th>${veCostos() ? '<th class="num">Costo</th>' : ''}<th class="num">Menudeo</th><th class="num">Mayoreo</th><th class="num">Existencia</th></tr></thead>
        <tbody>${lista.map(p => {
          const c = alms.reduce((s, a) => s + (ex[a.id + '|' + p.id] || 0), 0);
          const bajo = Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo);
          return `<tr data-id="${esc(p.id)}" class="clic ${esActivo(p.activo) ? '' : 'inactivo'} ${F.psel.has(p.id) ? 'sel' : ''}">
            ${borra ? `<td class="col-sel"><input type="checkbox" data-sel="${esc(p.id)}" ${F.psel.has(p.id) ? 'checked' : ''}></td>` : ''}
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
    pintarSel();
  };
  pintar();
  S.refrescar = pintar;
  if (borra) {
    $('#p-sel', el).onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'ps-todos') filtrados.forEach(p => F.psel.add(p.id));
      if (b.id === 'ps-quitar') F.psel.clear();
      if (b.id === 'ps-borrar') return dlgEliminarProductos([...F.psel], () => { F.psel.clear(); pintar(); });
      pintar();
    };
  }

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
    if (e.target.closest('.col-sel')) {
      const c = e.target.closest('.col-sel').querySelector('input');
      if (e.target !== c) c.checked = !c.checked;
      if (c.id === 'ps-pag') $$('[data-sel]', el).forEach(x => { x.checked = c.checked; });
      $$('[data-sel]', el).forEach(x => {
        F.psel[x.checked ? 'add' : 'delete'](x.dataset.sel);
        x.closest('tr').classList.toggle('sel', x.checked);
      });
      pintarSel();
      return;
    }
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

function dlgEliminarProductos(ids, alTerminar) {
  if (!ids.length) return;
  if (!navigator.onLine) { toast('Necesitas conexión para eliminar productos.', 'error'); return; }
  const ex = mapaExistencias();
  const conExist = ids.filter(id => Object.keys(ex).some(k => k.endsWith('|' + id) && ex[k] !== 0)).length;
  const nombres = ids.slice(0, 8).map(id => esc((S.idx.prod[id] || {}).nombre || '')).join(', ') + (ids.length > 8 ? ` y ${numero(ids.length - 8)} más` : '');
  const d = abrirModal('Eliminar productos', `
    <form id="fdel" class="form">
      <p>Vas a eliminar <b>${plural(ids.length, 'producto')}</b>: ${nombres}.</p>
      ${conExist ? `<p class="aviso-caja">${plural(conExist, 'producto')} todavía ${conExist === 1 ? 'tiene' : 'tienen'} existencia en algún almacén.</p>` : ''}
      <p class="nota">Los productos que ya tienen ventas, compras o pedidos no se borran: se desactivan para no perder el historial. Dejan de aparecer en la lista y en la caja, y puedes verlos con "Ver inactivos".</p>
      <label class="chk"><input type="checkbox" name="hist"> Borrar también sus entradas, salidas y existencias (solo para productos capturados por error)</label>
      <label>Para confirmar escribe <b>ELIMINAR</b><input name="conf" autocomplete="off" required></label>
      <p class="msg" id="fdel-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn peligro" type="submit">Eliminar</button></div>
    </form>`);
  const f = $('#fdel', d);
  f.conf.focus();
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (f.conf.value.trim().toUpperCase() !== 'ELIMINAR') { $('#fdel-msg', d).textContent = 'Escribe ELIMINAR para confirmar.'; return; }
    try {
      const r = await conCarga('Eliminando productos…', () => api('eliminarProductos', { ids, borrarHistorial: f.hist.checked }));
      cerrarModal();
      const partes = [];
      if (r.eliminados) partes.push(`${plural(r.eliminados, 'producto')} ${r.eliminados === 1 ? 'eliminado' : 'eliminados'}`);
      if (r.desactivados) partes.push(`${plural(r.desactivados, 'producto')} con historial ${r.desactivados === 1 ? 'desactivado' : 'desactivados'}`);
      toast(partes.join(' · ') + '.', 'ok');
      await sincronizar();
      alTerminar && alTerminar();
    } catch (e) { $('#fdel-msg', d).textContent = e.message; }
  };
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
      ${puede ? `<div class="pie">${!nuevo && esGeneral() ? '<button type="button" class="btn peligro izq" id="fp-del">Eliminar</button>' : ''}<button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>` : ''}
    </form>`);
  const f = $('#fp', d);
  const bdel = $('#fp-del', d);
  if (bdel) bdel.onclick = () => dlgEliminarProductos([p.id], () => { if (F.psel) F.psel.delete(p.id); S.refrescar && S.refrescar(); });
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
    const l = misPendientes().filter(o => !o.clase).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
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

/* ---- Compras (fase 2) ---- */
const EST_TXT = {
  BORRADOR: 'Borrador', ENVIADA: 'Enviada', CONFIRMADA: 'Confirmada', PARCIAL: 'Recibida parcial',
  RECIBIDA: 'Recibida', CANCELADA: 'Cancelada', ATRASADA: 'Atrasada'
};
const FREC_TXT = { SEMANAL: 'Cada semana', QUINCENAL: 'Cada 15 días', MENSUAL: 'Cada mes' };
const CMP = { datos: null, cargado: 0, offline: false, pestana: 'tablero', filtroEst: '', q: '' };

function hoyLocal(diasMas = 0) {
  const d = new Date();
  d.setDate(d.getDate() + diasMas);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fechaCorta(ymd) {
  if (!ymd) return '—';
  const s = String(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fechaHora(ymd);
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a.slice(2)}`;
}
const chipEstado = e => `<span class="est est-${e}">${EST_TXT[e] || e}</span>`;
const nombreProv = id => ((CMP.datos && CMP.datos.proveedores.find(p => p.id === id)) || {}).nombre || '—';
const atrasada = o => ['ENVIADA', 'CONFIRMADA', 'PARCIAL'].includes(o.estado) && o.fecha_entrega && o.fecha_entrega < hoyLocal();

async function cargarCompras() {
  if (!navigator.onLine) {
    const snap = await DB.get('compras');
    if (!snap || snap.usuario !== S.usuario.usuario) throw new Error('Sin conexión y sin datos guardados de compras en este equipo.');
    CMP.datos = snap.datos;
    CMP.cargado = snap.fecha;
    CMP.offline = true;
    return;
  }
  CMP.datos = await api('compras');
  CMP.cargado = Date.now();
  CMP.offline = false;
  await DB.set('compras', { datos: CMP.datos, fecha: CMP.cargado, usuario: S.usuario.usuario });
}
async function guardarSnapshotCompras() {
  try { await DB.set('compras', { datos: CMP.datos, fecha: CMP.cargado, usuario: S.usuario.usuario }); } catch (e) { /* sin importancia */ }
}
function actualizarOrdenLocal(o) {
  upsert(CMP.datos.ordenes, o);
  guardarSnapshotCompras();
}

function vCompras(el) {
  el.innerHTML = `
    <div class="titulo"><h2>Compras</h2><div class="acciones">
      <button type="button" class="btn sec" id="c-recargar">Actualizar</button>
      <button type="button" class="btn" id="c-nueva">Nueva orden</button></div></div>
    <div class="segmentos" id="c-tabs">
      ${[['tablero', 'Tablero'], ['ordenes', 'Órdenes'], ['programadas', 'Programadas'], ['proveedores', 'Proveedores']]
        .map(([k, t]) => `<button type="button" data-t="${k}">${t}</button>`).join('')}
    </div>
    <div id="c-aviso"></div>
    <div id="c-cuerpo"><p class="nota">Cargando…</p></div>`;
  const cuerpo = $('#c-cuerpo', el);

  const pintar = () => {
    $$('#c-tabs button', el).forEach(b => b.classList.toggle('activo', b.dataset.t === CMP.pestana));
    $('#c-aviso', el).innerHTML = CMP.offline
      ? `<p class="aviso-offline">Sin conexión: mostrando los datos de compras de ${hace(CMP.cargado)}. Solo consulta.</p>` : '';
    if (!CMP.datos) return;
    ({ tablero: pintarTablero, ordenes: pintarOrdenes, programadas: pintarProgramadas, proveedores: pintarProveedores })[CMP.pestana](cuerpo);
  };
  const recargar = async (conAnimacion) => {
    try {
      if (conAnimacion) await conCarga('Cargando compras…', cargarCompras);
      else await cargarCompras();
      pintar();
    } catch (e) {
      cuerpo.innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
      if (e.sesion) sesionVencida(e.message);
    }
  };
  S.refrescar = pintar;
  CMP.repintar = pintar;
  $('#c-tabs', el).onclick = e => {
    const b = e.target.closest('[data-t]');
    if (b) { CMP.pestana = b.dataset.t; pintar(); }
  };
  $('#c-recargar', el).onclick = () => recargar(true);
  $('#c-nueva', el).onclick = () => CMP.datos && dlgEditorOrden(null);
  if (CMP.datos) pintar();
  if (!CMP.datos || Date.now() - CMP.cargado > 60000 || (CMP.offline && navigator.onLine)) recargar(!CMP.datos);
}

function tarjetaOrden(o) {
  const tarde = atrasada(o);
  return `<button type="button" class="oc ${tarde ? 'atrasada' : ''}" data-oc="${esc(o.id)}">
    <span class="fila-oc"><span class="folio">${esc(o.folio)}</span>${tarde ? chipEstado('ATRASADA') : chipEstado(o.estado)}</span>
    <span>${esc(nombreProv(o.proveedor_id))}</span>
    <span class="fila-oc"><small>${o.fecha_entrega ? 'Entrega ' + fechaCorta(o.fecha_entrega) : 'Sin fecha de entrega'}</small><b>${dinero(o.total)}</b></span>
  </button>`;
}

function pintarTablero(c) {
  const D = CMP.datos;
  const hoy = hoyLocal(), en7 = hoyLocal(7), mes = hoy.slice(0, 7);
  const borradores = D.ordenes.filter(o => o.estado === 'BORRADOR');
  const proximas = D.programadas.filter(p => esActivo(p.activo) && p.proxima <= en7).sort((a, b) => (a.proxima < b.proxima ? -1 : 1));
  const enviadas = D.ordenes.filter(o => o.estado === 'ENVIADA');
  const recibir = D.ordenes.filter(o => ['CONFIRMADA', 'PARCIAL'].includes(o.estado))
    .sort((a, b) => String(a.fecha_entrega || '9').localeCompare(String(b.fecha_entrega || '9')));
  const recibidas = D.ordenes.filter(o => o.estado === 'RECIBIDA' && String(o.recibida).slice(0, 7) >= mes)
    .sort((a, b) => (String(a.recibida) < String(b.recibida) ? 1 : -1));
  const suma = l => dinero(l.reduce((s, o) => s + (Number(o.total) || 0), 0));
  const col = (clase, titulo, lista, html, vacio) => `<section class="columna ${clase}">
    <header><b>${titulo} (${lista.length})</b><small>${suma(lista.filter(x => x.folio))}</small></header>
    ${html || `<p class="nota">${vacio}</p>`}</section>`;
  c.innerHTML = `<div class="tablero">
    ${col('c-proximas', 'Próximas', borradores, borradores.map(tarjetaOrden).join('') + proximas.map(p => `
      <button type="button" class="oc programada" data-prg="${esc(p.id)}">
        <span class="fila-oc"><span class="folio">${esc(p.nombre)}</span><span class="est est-BORRADOR">Programada</span></span>
        <span>${esc(nombreProv(p.proveedor_id))}</span>
        <span class="fila-oc"><small>${p.proxima <= hoy ? 'Hoy' : fechaCorta(p.proxima)} · ${p.accion === 'ENVIAR' ? 'se envía sola' : 'se crea borrador'}</small></span>
      </button>`).join(''), 'Sin borradores ni pedidos programados esta semana.')}
    ${col('c-enviadas', 'Enviadas', enviadas, enviadas.map(tarjetaOrden).join(''), 'Esperando confirmación del proveedor.')}
    ${col('c-recibir', 'Por recibir', recibir, recibir.map(tarjetaOrden).join(''), 'Nada pendiente de recibir.')}
    ${col('c-recibidas', 'Recibidas este mes', recibidas, recibidas.map(tarjetaOrden).join(''), 'Aún no hay recepciones este mes.')}
  </div>`;
  c.onclick = e => {
    const b = e.target.closest('[data-oc]');
    const p = e.target.closest('[data-prg]');
    if (b) dlgOrden(D.ordenes.find(o => o.id === b.dataset.oc));
    if (p) dlgEditorOrden(D.programadas.find(x => x.id === p.dataset.prg), 'programada');
  };
}

function pintarOrdenes(c) {
  const D = CMP.datos;
  const q = normal(CMP.q);
  const l = D.ordenes
    .filter(o => (!CMP.filtroEst || o.estado === CMP.filtroEst) && (!q || normal(o.folio + ' ' + nombreProv(o.proveedor_id)).includes(q)))
    .sort((a, b) => (String(a.folio) < String(b.folio) ? 1 : -1));
  c.innerHTML = `<div class="filtros">
      <input id="c-q" type="search" placeholder="Buscar folio o proveedor" value="${esc(CMP.q)}">
      <select id="c-est"><option value="">Todos los estados</option>${Object.keys(EST_TXT).filter(k => k !== 'ATRASADA')
        .map(k => `<option value="${k}" ${CMP.filtroEst === k ? 'selected' : ''}>${EST_TXT[k]}</option>`).join('')}</select>
    </div>
    ${l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Folio</th><th>Proveedor</th><th>Estado</th><th>Fecha</th><th>Entrega</th><th class="num">Total</th></tr></thead>
      <tbody>${l.map(o => `<tr class="clic" data-oc="${esc(o.id)}"><td><b>${esc(o.folio)}</b></td><td>${esc(nombreProv(o.proveedor_id))}</td>
        <td>${atrasada(o) ? chipEstado('ATRASADA') : chipEstado(o.estado)}</td><td>${fechaCorta(o.fecha)}</td><td>${fechaCorta(o.fecha_entrega)}</td>
        <td class="num">${dinero(o.total)}</td></tr>`).join('')}</tbody></table></div>
      <p class="nota">Se muestran las órdenes abiertas y las cerradas de los últimos 4 meses.</p>`
      : '<p class="vacio">No hay órdenes con esos filtros.</p>'}`;
  const qi = $('#c-q', c);
  qi.oninput = () => { CMP.q = qi.value; const pos = qi.selectionStart; pintarOrdenes(c); const n = $('#c-q', c); n.focus(); n.setSelectionRange(pos, pos); };
  $('#c-est', c).onchange = e => { CMP.filtroEst = e.target.value; pintarOrdenes(c); };
  c.onclick = e => {
    const tr = e.target.closest('[data-oc]');
    if (tr) dlgOrden(D.ordenes.find(o => o.id === tr.dataset.oc));
  };
}

function pintarProgramadas(c) {
  const D = CMP.datos;
  c.innerHTML = `<div class="titulo"><p class="nota">Cada mañana se generan solas las órdenes de los pedidos cuya fecha llegó.</p>
      <button type="button" class="btn sec" id="c-nprg">Nuevo pedido programado</button></div>
    ${D.programadas.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Nombre</th><th>Proveedor</th><th>Frecuencia</th><th>Siguiente</th><th>Al llegar la fecha</th><th class="num">Total aprox.</th><th></th></tr></thead>
      <tbody>${D.programadas.map(p => {
        const t = (p.lineas || []).reduce((s, l) => s + l.cantidad * l.costo, 0) * (1 + (Number(p.iva_tasa) || 0) / 100);
        return `<tr class="clic ${esActivo(p.activo) ? '' : 'inactivo'}" data-prg="${esc(p.id)}"><td><b>${esc(p.nombre)}</b></td>
          <td>${esc(nombreProv(p.proveedor_id))}</td><td>${FREC_TXT[p.frecuencia] || p.frecuencia}</td><td>${esActivo(p.activo) ? fechaCorta(p.proxima) : 'Pausado'}</td>
          <td>${p.accion === 'ENVIAR' ? 'Crear y enviar por correo' : 'Crear borrador'}</td><td class="num">${dinero(t)}</td>
          <td><button type="button" class="btn mini sec" data-ahora="${esc(p.id)}">Crear ahora</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="vacio">No hay pedidos programados.</p>'}`;
  $('#c-nprg', c).onclick = () => dlgEditorOrden(null, 'programada');
  c.onclick = async e => {
    const ahora = e.target.closest('[data-ahora]');
    if (ahora) {
      e.stopPropagation();
      try {
        const o = await conCarga('Creando orden…', () => api('generarProgramada', { id: ahora.dataset.ahora }));
        actualizarOrdenLocal(o);
        toast(`Orden ${o.folio} creada en borrador.`, 'ok');
        dlgOrden(o);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const tr = e.target.closest('[data-prg]');
    if (tr) dlgEditorOrden(D.programadas.find(p => p.id === tr.dataset.prg), 'programada');
  };
}

function pintarProveedores(c) {
  const D = CMP.datos;
  c.innerHTML = `<div class="titulo"><span></span><button type="button" class="btn sec" id="c-nprov">Nuevo proveedor</button></div>
    ${D.proveedores.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Proveedor</th><th>Contacto</th><th>Teléfono</th><th>Correo</th><th class="num">Crédito</th></tr></thead>
      <tbody>${D.proveedores.slice().sort(porNombre).map(p => `<tr class="clic ${esActivo(p.activo) ? '' : 'inactivo'}" data-prov="${esc(p.id)}">
        <td><b>${esc(p.nombre)}</b>${p.rfc ? `<small>${esc(p.rfc)}</small>` : ''}</td><td>${esc(p.contacto || '—')}</td><td>${esc(p.telefono || '—')}</td>
        <td>${esc(p.email || '—')}</td><td class="num">${Number(p.dias_credito) ? p.dias_credito + ' días' : 'Contado'}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="vacio">Registra tu primer proveedor para crear órdenes de compra.</p>'}`;
  $('#c-nprov', c).onclick = () => dlgProveedor(null);
  c.onclick = e => {
    const tr = e.target.closest('[data-prov]');
    if (tr) dlgProveedor(D.proveedores.find(p => p.id === tr.dataset.prov));
  };
}

function dlgProveedor(p, alGuardar) {
  const nuevo = !p;
  p = p || { activo: true, dias_credito: 0 };
  const d = abrirModal(nuevo ? 'Nuevo proveedor' : 'Editar proveedor', `
    <form id="fprov" class="form">
      <div class="fila2"><label>Nombre o razón social<input name="nombre" required value="${esc(p.nombre || '')}"></label>
        <label>RFC<input name="rfc" value="${esc(p.rfc || '')}" autocapitalize="characters"></label></div>
      <div class="fila3"><label>Contacto<input name="contacto" value="${esc(p.contacto || '')}"></label>
        <label>Teléfono<input name="telefono" type="tel" value="${esc(p.telefono || '')}"></label>
        <label>Correo (para enviar órdenes)<input name="email" type="email" value="${esc(p.email || '')}"></label></div>
      <div class="fila2"><label>Días de crédito (0 = contado)<input name="dias_credito" type="number" min="0" step="1" value="${esc(p.dias_credito || 0)}"></label>
        <label class="chk"><input type="checkbox" name="activo" ${esActivo(p.activo) ? 'checked' : ''}> Activo</label></div>
      <label>Notas<input name="notas" value="${esc(p.notas || '')}"></label>
      <p class="msg" id="fprov-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fprov', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fprov-msg', d);
    msg.textContent = 'Guardando…';
    try {
      const r = await api('guardarProveedor', { proveedor: {
        id: p.id || '', nombre: f.nombre.value, rfc: f.rfc.value, contacto: f.contacto.value, telefono: f.telefono.value,
        email: f.email.value, dias_credito: f.dias_credito.value, notas: f.notas.value, activo: f.activo.checked
      } });
      upsert(CMP.datos.proveedores, r);
      guardarSnapshotCompras();
      cerrarModal();
      toast('Proveedor guardado.', 'ok');
      if (alGuardar) alGuardar(r); else if (CMP.repintar) CMP.repintar();
    } catch (e) { msg.textContent = e.message; }
  };
}

// Editor de orden de compra o de pedido programado
function dlgEditorOrden(base, modo = 'orden') {
  const esProg = modo === 'programada';
  const nuevo = !base;
  const D = CMP.datos;
  const almsDestino = almacenesVisibles();
  const almDef = (almsDestino.find(a => a.tipo === 'BODEGA') || almsDestino[0] || {}).id || '';
  const o = base ? JSON.parse(JSON.stringify(base)) : {
    proveedor_id: '', almacen_id: almDef, iva_tasa: 16, fecha_entrega: esProg ? '' : hoyLocal(3), notas: '', lineas: [],
    frecuencia: 'SEMANAL', proxima: hoyLocal(7), accion: 'BORRADOR', activo: true, nombre: ''
  };
  const lineas = (o.lineas || []).map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad), costo: Number(l.costo) }));
  const provs = D.proveedores.filter(p => esActivo(p.activo) || p.id === o.proveedor_id).sort(porNombre);
  const titulo = esProg ? (nuevo ? 'Nuevo pedido programado' : 'Pedido programado') : (nuevo ? 'Nueva orden de compra' : `Editar ${o.folio}`);
  const d = abrirModal(titulo, `
    <form id="feo" class="form" autocomplete="off">
      ${esProg ? `<div class="fila3">
        <label>Nombre del pedido<input name="nombre" required value="${esc(o.nombre || '')}" placeholder="Ej. Abarrotes semanal"></label>
        <label>Frecuencia<select name="frecuencia">${Object.keys(FREC_TXT).map(k => `<option value="${k}" ${o.frecuencia === k ? 'selected' : ''}>${FREC_TXT[k]}</option>`).join('')}</select></label>
        <label>Siguiente pedido<input name="proxima" type="date" required value="${esc(o.proxima || '')}"></label></div>
        <div class="fila2"><label>Al llegar la fecha<select name="accion">
          <option value="BORRADOR" ${o.accion !== 'ENVIAR' ? 'selected' : ''}>Crear la orden en borrador para revisarla</option>
          <option value="ENVIAR" ${o.accion === 'ENVIAR' ? 'selected' : ''}>Crearla y enviarla por correo al proveedor</option></select></label>
          <label class="chk"><input type="checkbox" name="activo" ${esActivo(o.activo) ? 'checked' : ''}> Activo</label></div>` : ''}
      <div class="fila3">
        <label>Proveedor<span class="fila-form"><select name="proveedor_id" required><option value="">Elige…</option>${provs.map(p => `<option value="${esc(p.id)}" ${p.id === o.proveedor_id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>
          <button type="button" class="btn sec mini" id="feo-nprov" title="Nuevo proveedor">+</button></span></label>
        <label>Recibe en<select name="almacen_id">${almsDestino.map(a => `<option value="${esc(a.id)}" ${a.id === o.almacen_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        ${esProg ? '' : `<label>Fecha de entrega<input name="fecha_entrega" type="date" value="${esc(o.fecha_entrega || '')}"></label>`}
      </div>
      <div class="campo"><span>Agregar producto</span><div id="feo-sel"></div></div>
      <div class="acciones"><button type="button" class="btn sec mini" id="feo-sugerir">Agregar productos bajo mínimo</button></div>
      <div id="feo-lineas"></div>
      <div class="fila2"><label>IVA<select name="iva_tasa">${[0, 8, 16].map(t => `<option value="${t}" ${Number(o.iva_tasa) === t ? 'selected' : ''}>${t}%</option>`).join('')}</select></label>
        <label>Notas para el proveedor<input name="notas" value="${esc(o.notas || '')}"></label></div>
      <div class="totales" id="feo-tot"></div>
      <p class="msg" id="feo-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button>
        ${esProg ? '<button class="btn" type="submit" data-accion="guardar">Guardar pedido programado</button>'
          : `<button class="btn sec" type="submit" data-accion="guardar">Guardar borrador</button><button class="btn" type="submit" data-accion="enviar">Guardar y enviar…</button>`}</div>
    </form>`, true);
  const f = $('#feo', d);
  const msg = $('#feo-msg', d);

  const pintarLineas = () => {
    const ex = mapaExistencias();
    $('#feo-lineas', d).innerHTML = lineas.length ? `<div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr>
        <th>Producto</th><th class="num">Existencia</th><th class="num">Cantidad</th><th class="num">Costo unit.</th><th class="num">Importe</th><th></th></tr></thead>
      <tbody>${lineas.map((l, i) => {
        const p = S.idx.prod[l.producto_id] || {};
        return `<tr><td>${esc(p.nombre || 'Producto no disponible')}<small>${esc(p.codigo || '')} · ${esc(p.unidad || '')}</small></td>
          <td class="num">${numero(ex[f.almacen_id.value + '|' + l.producto_id] || 0)}</td>
          <td class="num"><input type="number" min="0" step="any" data-i="${i}" data-k="cantidad" value="${l.cantidad}"></td>
          <td class="num"><input type="number" min="0" step="0.01" data-i="${i}" data-k="costo" value="${l.costo}"></td>
          <td class="num">${dinero(l.cantidad * l.costo)}</td>
          <td><button type="button" class="btn mini peligro" data-quitar="${i}" title="Quitar">✕</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="nota">Aún no hay productos en la orden.</p>';
    pintarTotales();
  };
  const pintarTotales = () => {
    const sub = lineas.reduce((s, l) => s + (Number(l.cantidad) || 0) * (Number(l.costo) || 0), 0);
    const tasa = Number(f.iva_tasa.value) || 0;
    const iva = Math.round(sub * tasa) / 100;
    $('#feo-tot', d).innerHTML = `<span>Subtotal</span><span class="num">${dinero(sub)}</span><span>IVA ${tasa}%</span><span>${dinero(iva)}</span>
      <span class="g">Total</span><span class="g">${dinero(sub + iva)}</span>`;
  };
  const agregar = (p, cantidad = 1) => {
    const ya = lineas.find(l => l.producto_id === p.id);
    if (ya) ya.cantidad += cantidad;
    else lineas.push({ producto_id: p.id, cantidad, costo: Number(p.costo) || 0 });
    pintarLineas();
  };
  const sel = selectorProducto($('#feo-sel', d), p => {
    if (!p) return;
    agregar(p);
    sel.limpiar();
    const inp = d.querySelector(`[data-i="${lineas.findIndex(l => l.producto_id === p.id)}"][data-k="cantidad"]`);
    if (inp) { inp.focus(); inp.select(); }
  });
  pintarLineas();

  $('#feo-lineas', d).oninput = e => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    lineas[i][e.target.dataset.k] = Number(e.target.value) || 0;
    const fila = e.target.closest('tr');
    fila.cells[4].textContent = dinero(lineas[i].cantidad * lineas[i].costo);
    pintarTotales();
  };
  $('#feo-lineas', d).onclick = e => {
    const q = e.target.closest('[data-quitar]');
    if (q) { lineas.splice(Number(q.dataset.quitar), 1); pintarLineas(); }
  };
  f.iva_tasa.onchange = pintarTotales;
  f.almacen_id.onchange = pintarLineas;
  $('#feo-sugerir', d).onclick = () => {
    const ex = mapaExistencias();
    let n = 0;
    S.catalogo.productos.filter(p => esActivo(p.activo) && Number(p.stock_minimo) > 0).forEach(p => {
      const c = ex[f.almacen_id.value + '|' + p.id] || 0;
      const min = Number(p.stock_minimo);
      if (c < min && !lineas.some(l => l.producto_id === p.id)) {
        lineas.push({ producto_id: p.id, cantidad: Math.ceil(Math.max(min * 2 - c, min)), costo: Number(p.costo) || 0 });
        n++;
      }
    });
    pintarLineas();
    toast(n ? `Se agregaron ${n} productos bajo mínimo (cantidad para llegar al doble del mínimo).` : 'No hay productos bajo mínimo en ese almacén.', n ? 'ok' : '');
  };
  $('#feo-nprov', d).onclick = () => {
    // Guarda lo capturado, abre el alta de proveedor y regresa a esta orden
    const copia = Object.assign({}, o, leerForm(), { lineas: lineas.slice() });
    dlgProveedor(null, prov => dlgEditorOrden(Object.assign(copia, { proveedor_id: prov.id }), modo));
  };
  function leerForm() {
    const r = {
      proveedor_id: f.proveedor_id.value, almacen_id: f.almacen_id.value, iva_tasa: Number(f.iva_tasa.value),
      notas: f.notas.value.trim(), fecha_entrega: f.fecha_entrega ? f.fecha_entrega.value : ''
    };
    if (esProg) Object.assign(r, { nombre: f.nombre.value.trim(), frecuencia: f.frecuencia.value, proxima: f.proxima.value, accion: f.accion.value, activo: f.activo.checked });
    return r;
  }

  f.onsubmit = async ev => {
    ev.preventDefault();
    const accion = (ev.submitter && ev.submitter.dataset.accion) || 'guardar';
    const datos = Object.assign(leerForm(), { lineas: lineas.filter(l => l.cantidad > 0) });
    if (!datos.proveedor_id) { msg.textContent = 'Elige un proveedor.'; return; }
    if (!datos.lineas.length) { msg.textContent = 'Agrega al menos un producto con cantidad.'; return; }
    msg.textContent = '';
    try {
      if (esProg) {
        datos.id = o.id || '';
        const r = await conCarga('Guardando…', () => api('guardarProgramada', { programada: datos }));
        upsert(D.programadas, r);
        guardarSnapshotCompras();
        cerrarModal();
        toast('Pedido programado guardado.', 'ok');
      } else {
        if (nuevo && !o.id) o.id = uuid();
        datos.id = o.id;
        datos.nuevo = nuevo;
        const r = await conCarga('Guardando orden…', () => api('guardarOrden', { orden: datos }));
        actualizarOrdenLocal(r);
        cerrarModal();
        toast(`Orden ${r.folio} guardada.`, 'ok');
        if (accion === 'enviar') dlgEnviar(r);
      }
      if (CMP.repintar) CMP.repintar();
    } catch (e) {
      msg.textContent = e.message;
      if (e.sesion) { cerrarModal(); sesionVencida(e.message); }
    }
  };
}

function dlgOrden(o) {
  if (!o) return;
  const D = CMP.datos;
  const prov = D.proveedores.find(p => p.id === o.proveedor_id) || {};
  const alm = S.idx.alm[o.almacen_id] || {};
  const tarde = atrasada(o);
  const botones = [];
  if (o.estado === 'BORRADOR') botones.push(['editar', 'Editar', 'sec'], ['enviar', 'Enviar al proveedor…', '']);
  if (o.estado === 'ENVIADA') botones.push(['confirmar', 'Proveedor confirmó', 'sec']);
  if (['ENVIADA', 'CONFIRMADA', 'PARCIAL'].includes(o.estado)) botones.push(['recibir', o.estado === 'PARCIAL' ? 'Recibir lo pendiente' : 'Recibir mercancía', '']);
  if (['ENVIADA', 'CONFIRMADA'].includes(o.estado)) botones.push(['reenviar', 'Reenviar…', 'sec'], ['borrador', 'Volver a borrador', 'sec']);
  botones.push(['pdf', 'Descargar PDF', 'sec']);
  if (['BORRADOR', 'ENVIADA', 'CONFIRMADA'].includes(o.estado)) botones.push(['cancelar', 'Cancelar orden', 'peligro']);
  const d = abrirModal(`Orden ${o.folio}`, `
    <div class="form">
      <div class="titulo"><span>${tarde ? chipEstado('ATRASADA') + ' ' : ''}${chipEstado(o.estado)}</span><b>${dinero(o.total)}</b></div>
      <div class="info-oc">
        <div><h4>Proveedor</h4><b>${esc(prov.nombre || '—')}</b><br>${esc(prov.contacto || '')}${prov.email ? '<br>' + esc(prov.email) : ''}${prov.telefono ? '<br>' + esc(prov.telefono) : ''}</div>
        <div><h4>Recibe</h4><b>${esc(alm.nombre || '—')}</b><br>Entrega: ${fechaCorta(o.fecha_entrega)}${prov.dias_credito ? `<br>Crédito: ${prov.dias_credito} días` : ''}</div>
        <div><h4>Seguimiento</h4>Creada: ${fechaHora(o.fecha)}${o.enviada ? '<br>Enviada: ' + fechaHora(o.enviada) : ''}${o.confirmada ? '<br>Confirmada: ' + fechaHora(o.confirmada) : ''}${o.recibida ? '<br>Recibida: ' + fechaHora(o.recibida) : ''}${o.cancelada ? '<br>Cancelada: ' + fechaHora(o.cancelada) : ''}</div>
      </div>
      <div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Costo</th><th class="num">Importe</th></tr></thead>
        <tbody>${o.lineas.map(l => {
          const p = S.idx.prod[l.producto_id] || {};
          const falta = Number(l.recibido) < Number(l.cantidad) && ['PARCIAL', 'CONFIRMADA', 'ENVIADA'].includes(o.estado);
          return `<tr><td>${esc(p.nombre || '—')}<small>${esc(p.codigo || '')}</small></td><td class="num">${numero(l.cantidad)} ${esc(p.unidad || '')}</td>
            <td class="num ${falta && Number(l.recibido) > 0 ? 'txt-error' : ''}">${numero(l.recibido)}</td><td class="num">${dinero(l.costo)}</td>
            <td class="num">${dinero(l.cantidad * l.costo)}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="totales"><span>Subtotal</span><span>${dinero(o.subtotal)}</span><span>IVA ${Number(o.iva_tasa)}%</span><span>${dinero(o.iva)}</span>
        <span class="g">Total</span><span class="g">${dinero(o.total)}</span></div>
      ${o.notas ? `<p><b>Notas:</b> ${esc(o.notas)}</p>` : ''}
      <div class="acciones" id="oc-acc">${botones.map(([k, t, c]) => `<button type="button" class="btn ${c}" data-a="${k}">${t}</button>`).join('')}</div>
    </div>`, true);

  $('#oc-acc', d).onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'editar') return dlgEditorOrden(o);
      if (a === 'enviar' || a === 'reenviar') return dlgEnviar(o);
      if (a === 'recibir') return dlgRecibir(o);
      if (a === 'pdf') return descargarPdfOrden(o);
      const estado = { confirmar: 'CONFIRMADA', borrador: 'BORRADOR', cancelar: 'CANCELADA' }[a];
      if (a === 'cancelar' && !confirm(`¿Cancelar la orden ${o.folio}?`)) return;
      const r = await conCarga('Actualizando…', () => api('estadoOrden', { id: o.id, estado }));
      actualizarOrdenLocal(r);
      toast(`Orden ${r.folio}: ${EST_TXT[r.estado].toLowerCase()}.`, 'ok');
      if (CMP.repintar) CMP.repintar();
      dlgOrden(r);
    } catch (err) {
      toast(err.message, 'error');
      if (err.sesion) { cerrarModal(); sesionVencida(err.message); }
    }
  };
}

async function descargarPdfOrden(o) {
  try {
    const r = await conCarga('Generando PDF…', () => api('pdfOrden', { id: o.id }));
    const bytes = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
    Excel.descargar(new Blob([bytes], { type: 'application/pdf' }), r.nombre);
  } catch (e) { toast(e.message, 'error'); }
}

function dlgEnviar(o) {
  const prov = CMP.datos.proveedores.find(p => p.id === o.proveedor_id) || {};
  const d = abrirModal(`Enviar ${o.folio}`, `
    <form id="fenv" class="form">
      <p>Se genera el PDF de la orden y queda guardado en la carpeta "Órdenes de compra" de tu Google Drive.</p>
      <label class="chk"><input type="checkbox" name="correo" ${prov.email ? 'checked' : ''}> Enviar por correo al proveedor</label>
      <label>Correo<input name="para" type="email" value="${esc(prov.email || '')}" placeholder="correo@proveedor.com"></label>
      <label class="chk"><input type="checkbox" name="descargar" ${prov.email ? '' : 'checked'}> Descargar el PDF en este equipo (para mandarlo por WhatsApp u otro medio)</label>
      <p class="msg" id="fenv-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Enviar</button></div>
    </form>`);
  const f = $('#fenv', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fenv-msg', d);
    if (f.correo.checked && !f.para.value.trim()) { msg.textContent = 'Escribe el correo del proveedor.'; return; }
    msg.textContent = '';
    try {
      const r = await conCarga(f.correo.checked ? 'Generando y enviando…' : 'Generando PDF…',
        () => api('enviarOrden', { id: o.id, correo: f.correo.checked, para: f.para.value.trim() }));
      actualizarOrdenLocal(r.orden);
      cerrarModal();
      toast(r.correo ? `Orden ${r.orden.folio} enviada a ${r.correo}.` : `Orden ${r.orden.folio} marcada como enviada.`, 'ok');
      if (f.descargar.checked) await descargarPdfOrden(r.orden);
      if (CMP.repintar) CMP.repintar();
    } catch (e) {
      msg.textContent = e.message;
      if (e.sesion) { cerrarModal(); sesionVencida(e.message); }
    }
  };
}

function dlgRecibir(o) {
  const recepcionId = uuid();
  const pendientes = o.lineas.map(l => ({ l, pend: Math.max(0, Number(l.cantidad) - Number(l.recibido || 0)) }));
  const d = abrirModal(`Recibir ${o.folio}`, `
    <form id="frec" class="form" autocomplete="off">
      <p class="nota">Captura lo que llegó físicamente. Si falta algo, la orden queda como "Recibida parcial" para recibir el resto después.</p>
      <div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr><th>Producto</th><th class="num">Pendiente</th><th class="num">Llegó</th><th class="num">Costo unit.</th></tr></thead>
        <tbody>${pendientes.map(({ l, pend }, i) => {
          const p = S.idx.prod[l.producto_id] || {};
          return `<tr><td>${esc(p.nombre || '—')}<small>${esc(p.codigo || '')}</small></td><td class="num">${numero(pend)} ${esc(p.unidad || '')}</td>
            <td class="num"><input type="number" min="0" step="any" data-i="${i}" data-k="cantidad" value="${pend}"></td>
            <td class="num"><input type="number" min="0" step="0.01" data-i="${i}" data-k="costo" value="${l.costo}"></td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="fila2"><label>Folio de factura o remisión<input name="factura"></label><label>Notas<input name="notas"></label></div>
      <label class="archivo"><input type="file" name="archivos" multiple accept=".pdf,.xml,.jpg,.jpeg,.png"><span>Adjuntar factura (PDF, XML o foto) — opcional</span></label>
      <label class="chk"><input type="checkbox" name="actualizar" checked> Actualizar el costo de los productos con el costo recibido</label>
      <p class="msg" id="frec-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Registrar recepción</button></div>
    </form>`, true);
  const f = $('#frec', d);
  f.archivos.onchange = () => {
    $('.archivo span', d).textContent = Array.from(f.archivos.files).map(a => a.name).join(', ') || 'Adjuntar factura (PDF, XML o foto) — opcional';
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#frec-msg', d);
    const lineas = pendientes.map(({ l, pend }, i) => ({
      linea_id: l.id, pend,
      cantidad: Number(f.querySelector(`[data-i="${i}"][data-k="cantidad"]`).value) || 0,
      costo: f.querySelector(`[data-i="${i}"][data-k="costo"]`).value
    })).filter(x => x.cantidad > 0);
    if (!lineas.length) { msg.textContent = 'Captura al menos una cantidad recibida.'; return; }
    const demas = lineas.filter(x => x.cantidad > x.pend);
    if (demas.length && !confirm('Algunas cantidades son mayores a lo pendiente. ¿Registrar de todos modos?')) return;
    msg.textContent = '';
    try {
      const r = await conCarga('Registrando recepción…', () => api('recibirOrden', {
        id: o.id, recepcion_id: recepcionId, factura: f.factura.value.trim(), notas: f.notas.value.trim(),
        actualizar_costo: f.actualizar.checked, lineas: lineas.map(({ linea_id, cantidad, costo }) => ({ linea_id, cantidad, costo }))
      }));
      actualizarOrdenLocal(r.orden);
      const archivos = Array.from(f.archivos.files);
      cerrarModal();
      toast(r.orden.estado === 'RECIBIDA' ? `${r.orden.folio} recibida completa. Inventario actualizado.` : `${r.orden.folio}: recepción parcial registrada.`, 'ok');
      if (archivos.length && r.cuenta_id) {
        try {
          await conCarga('Subiendo factura…', () => subirFacturas(r.cuenta_id, archivos, recepcionId));
          toast('Factura adjunta a la cuenta por pagar.', 'ok');
        } catch (err) { toast('La recepción quedó registrada, pero la factura no se subió: ' + err.message, 'error'); }
      }
      CPP.cargado = 0;
      if (CMP.repintar) CMP.repintar();
      sincronizar();
    } catch (e) {
      msg.textContent = e.message + (e.red ? ' Puedes volver a intentar: no se duplicará.' : '');
      if (e.sesion) { cerrarModal(); sesionVencida(e.message); }
    }
  };
}

/* ---- Datos de la empresa ---- */
async function dlgEmpresa() {
  let emp;
  try { emp = await conCarga('Cargando…', () => api('empresa')); } catch (e) { toast(e.message, 'error'); return; }
  let logo = emp.logo || '';
  const d = abrirModal('Datos de la empresa', `
    <form id="femp" class="form">
      <div class="fila2"><label>Nombre comercial<input name="nombre" value="${esc(emp.nombre)}" placeholder="Comercial Zeppelin"></label>
        <label>RFC<input name="rfc" value="${esc(emp.rfc)}"></label></div>
      <label>Dirección<input name="direccion" value="${esc(emp.direccion)}"></label>
      <div class="fila2"><label>Teléfono<input name="telefono" value="${esc(emp.telefono)}"></label>
        <label>Correo (los proveedores responden a este)<input name="email" type="email" value="${esc(emp.email)}"></label></div>
      <div class="campo"><span>Logo para las órdenes de compra</span>
        <div class="fila-form"><img id="emp-logo" class="logo-prev" alt="" ${logo ? `src="${logo}"` : 'hidden'}>
          <div class="acciones"><label class="btn sec">Elegir imagen<input type="file" accept="image/png,image/jpeg" id="emp-arch" hidden></label>
          <button type="button" class="btn sec" id="emp-app">Usar el ícono de la app</button>
          <button type="button" class="btn sec" id="emp-quitar" ${logo ? '' : 'hidden'}>Quitar</button></div></div></div>
      <p class="msg" id="femp-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#femp', d), img = $('#emp-logo', d), msg = $('#femp-msg', d);
  const ponerLogo = url => {
    logo = url;
    img.hidden = !url;
    if (url) img.src = url; else img.removeAttribute('src');
    $('#emp-quitar', d).hidden = !url;
  };
  // Reduce la imagen a 240 px para que quepa en la base de datos
  const reducir = src => new Promise((ok, mal) => {
    const im = new Image();
    im.onload = () => {
      const e = Math.min(1, 240 / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * e);
      c.height = Math.round(im.height * e);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0, c.width, c.height);
      let url = c.toDataURL('image/png');
      if (url.length > 44000) url = c.toDataURL('image/jpeg', 0.85);
      if (url.length > 44000) url = c.toDataURL('image/jpeg', 0.6);
      ok(url);
    };
    im.onerror = () => mal(new Error('No se pudo leer la imagen.'));
    im.src = src;
  });
  $('#emp-arch', d).onchange = async e => {
    const a = e.target.files[0];
    if (!a) return;
    try { ponerLogo(await reducir(URL.createObjectURL(a))); } catch (err) { msg.textContent = err.message; }
  };
  $('#emp-app', d).onclick = async () => {
    try { ponerLogo(await reducir('icons/icon-512.png')); } catch (err) { msg.textContent = err.message; }
  };
  $('#emp-quitar', d).onclick = () => ponerLogo('');
  f.onsubmit = async ev => {
    ev.preventDefault();
    msg.textContent = '';
    try {
      await conCarga('Guardando…', () => api('guardarEmpresa', { empresa: {
        nombre: f.nombre.value, rfc: f.rfc.value, direccion: f.direccion.value, telefono: f.telefono.value, email: f.email.value, logo
      } }));
      cerrarModal();
      toast('Datos de la empresa guardados.', 'ok');
    } catch (e) { msg.textContent = e.message; }
  };
}

/* ---- Cuentas por pagar (fase 3) ---- */
const CXP_TXT = { PENDIENTE: 'Pendiente', PARCIAL: 'Abonada', PAGADA: 'Pagada', VENCIDA: 'Vencida', POR_VENCER: 'Por vencer' };
const METODO_TXT = { TRANSFERENCIA: 'Transferencia', EFECTIVO: 'Efectivo', CHEQUE: 'Cheque', TARJETA: 'Tarjeta', OTRO: 'Otro' };
const CPP = { datos: null, cargado: 0, offline: false, mes: '', filtro: 'abiertas', prov: '', q: '' };
const DIAS_AVISO = 5;

function sumarDiasYmd(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
function estadoCuenta(c) {
  if (Number(c.saldo) <= 0.005) return 'PAGADA';
  const hoy = hoyLocal();
  if (String(c.vence) < hoy) return 'VENCIDA';
  if (String(c.vence) <= hoyLocal(DIAS_AVISO)) return 'POR_VENCER';
  return c.estado === 'PARCIAL' ? 'PARCIAL' : 'PENDIENTE';
}
const chipCuenta = c => { const e = estadoCuenta(c); return `<span class="est cxp-${e}">${CXP_TXT[e]}</span>`; };
const provCxp = id => ((CPP.datos && CPP.datos.proveedores.find(p => p.id === id)) || {});
const plural = (n, palabra) => `${n} ${n === 1 ? palabra : palabra.endsWith('ón') ? palabra.slice(0, -2) + 'ones' : /[aeiou]$/.test(palabra) ? palabra + 's' : palabra + 'es'}`;
const condicionTxt = c => (c.condicion === 'CREDITO' ? `Crédito ${Number(c.dias_credito) || 0} días` : 'Contado');

function leerBase64(archivo) {
  return new Promise((ok, mal) => {
    if (archivo.size > 10 * 1024 * 1024) { mal(new Error(`"${archivo.name}" pesa más de 10 MB.`)); return; }
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => mal(new Error(`No se pudo leer "${archivo.name}".`));
    r.readAsDataURL(archivo);
  });
}
// Sube las facturas elegidas a una cuenta. Devuelve la cuenta actualizada (o null).
async function subirFacturas(cuentaId, archivos, prefijo) {
  let cuenta = null;
  for (let i = 0; i < archivos.length; i++) {
    const a = archivos[i];
    const base64 = await leerBase64(a);
    cuenta = await api('subirArchivo', { cuenta_id: cuentaId, nombre: a.name, base64, subida_id: `${prefijo}-${i}` });
  }
  return cuenta;
}

async function cargarCuentas() {
  if (!navigator.onLine) {
    const snap = await DB.get('cuentas');
    if (!snap || snap.usuario !== S.usuario.usuario) throw new Error('Sin conexión y sin datos guardados de cuentas en este equipo.');
    Object.assign(CPP, { datos: snap.datos, cargado: snap.fecha, offline: true });
    return;
  }
  CPP.datos = await api('cuentas');
  CPP.cargado = Date.now();
  CPP.offline = false;
  guardarSnapshotCuentas();
}
function guardarSnapshotCuentas() {
  DB.set('cuentas', { datos: CPP.datos, fecha: CPP.cargado, usuario: S.usuario.usuario }).catch(() => {});
}
function aplicarDetalle(det) {
  upsert(CPP.datos.cuentas, det.cuenta || det);
  if (det.pagos) {
    const id = det.cuenta.id;
    CPP.datos.pagos = CPP.datos.pagos.filter(p => p.cuenta_id !== id).concat(det.pagos);
  }
  guardarSnapshotCuentas();
}

function vPagar(el) {
  if (!CPP.mes) CPP.mes = hoyLocal().slice(0, 7);
  el.innerHTML = `
    <div class="titulo"><h2>Cuentas por pagar</h2><div class="acciones">
      <button type="button" class="btn sec" id="p-exportar">Exportar mes a Excel</button>
      <button type="button" class="btn" id="p-nueva">Nueva cuenta</button></div></div>
    <div class="filtros">
      <label class="chk">Mes <input type="month" id="p-mes" value="${esc(CPP.mes)}"></label>
      <select id="p-filtro">
        ${[['abiertas', 'Con saldo pendiente'], ['vencidas', 'Vencidas'], ['por_vencer', `Vencen en ${DIAS_AVISO} días`],
          ['mes', 'Todas las del mes'], ['pagadas', 'Pagadas en el mes']].map(([k, t]) => `<option value="${k}" ${CPP.filtro === k ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <select id="p-prov"><option value="">Todos los proveedores</option></select>
      <input id="p-q" type="search" placeholder="Buscar factura u orden" value="${esc(CPP.q)}">
    </div>
    <div id="p-aviso"></div>
    <div id="p-res" class="tarjetas"></div>
    <div id="p-lista"><p class="nota">Cargando…</p></div>
    <div id="p-saldos"></div>`;

  const pintar = () => {
    if (!CPP.datos) return;
    const D = CPP.datos;
    const hoy = hoyLocal(), lim = hoyLocal(DIAS_AVISO), mes = CPP.mes;
    const selProv = $('#p-prov', el);
    if (selProv.options.length === 1) {
      selProv.innerHTML += D.proveedores.slice().sort(porNombre).map(p => `<option value="${esc(p.id)}" ${CPP.prov === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('');
    }
    $('#p-aviso', el).innerHTML = CPP.offline ? `<p class="aviso-offline">Sin conexión: mostrando los datos de ${hace(CPP.cargado)}. Solo consulta.</p>` : '';

    const abiertas = D.cuentas.filter(c => Number(c.saldo) > 0.005);
    const vencidas = abiertas.filter(c => String(c.vence) < hoy);
    const porVencer = abiertas.filter(c => String(c.vence) >= hoy && String(c.vence) <= lim);
    const delMes = D.cuentas.filter(c => String(c.fecha_cuenta).slice(0, 7) === mes);
    const pagosMes = D.pagos.filter(p => String(p.fecha_pago).slice(0, 7) === mes);
    const suma = (l, k) => l.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const [anio, m] = mes.split('-');
    const nombreMes = new Date(Number(anio), Number(m) - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
    $('#p-res', el).innerHTML = `
      <div class="tarjeta"><span>Compras de ${esc(nombreMes)}</span><b>${dinero(suma(delMes, 'monto'))}</b><small>${plural(delMes.length, 'factura')}</small></div>
      <div class="tarjeta"><span>Pagado en ${esc(nombreMes)}</span><b>${dinero(suma(pagosMes, 'monto'))}</b><small>${plural(pagosMes.length, 'pago')}</small></div>
      <div class="tarjeta"><span>Saldo pendiente total</span><b>${dinero(suma(abiertas, 'saldo'))}</b><small>${plural(abiertas.length, 'cuenta')}</small></div>
      <button type="button" class="tarjeta ${vencidas.length ? 'alerta-roja' : ''}" data-f="vencidas"><span>Vencido</span><b>${dinero(suma(vencidas, 'saldo'))}</b><small>${plural(vencidas.length, 'cuenta')}</small></button>
      <button type="button" class="tarjeta ${porVencer.length ? 'alerta' : ''}" data-f="por_vencer"><span>Vence en ${DIAS_AVISO} días</span><b>${dinero(suma(porVencer, 'saldo'))}</b><small>${plural(porVencer.length, 'cuenta')}</small></button>`;

    const idsPagadasMes = new Set(pagosMes.map(p => p.cuenta_id));
    let lista = {
      abiertas, vencidas, por_vencer: porVencer, mes: delMes,
      pagadas: D.cuentas.filter(c => Number(c.saldo) <= 0.005 && idsPagadasMes.has(c.id))
    }[CPP.filtro] || abiertas;
    const q = normal(CPP.q);
    lista = lista.filter(c => (!CPP.prov || c.proveedor_id === CPP.prov) && (!q || normal(`${c.factura} ${c.folio_oc}`).includes(q)));
    lista.sort((a, b) => (['abiertas', 'vencidas', 'por_vencer'].includes(CPP.filtro)
      ? String(a.vence).localeCompare(String(b.vence)) : String(b.fecha_cuenta).localeCompare(String(a.fecha_cuenta))));
    $('#p-lista', el).innerHTML = lista.length ? `<div class="tabla-cont"><table class="tabla">
      <thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th>Orden</th><th>Condición</th><th>Vence</th><th class="num">Total</th><th class="num">Saldo</th><th>Estado</th><th></th></tr></thead>
      <tbody>${lista.map(c => `<tr class="clic" data-c="${esc(c.id)}"><td>${fechaCorta(c.fecha_cuenta)}</td><td>${esc(provCxp(c.proveedor_id).nombre || '—')}</td>
        <td>${esc(c.factura || '—')}</td><td>${esc(c.folio_oc || 'Manual')}</td><td>${condicionTxt(c)}</td><td>${fechaCorta(c.vence)}</td>
        <td class="num">${dinero(c.monto)}</td><td class="num"><b>${dinero(c.saldo)}</b></td><td>${chipCuenta(c)}</td>
        <td>${c.archivos.length ? `<span title="Factura adjunta">📎${c.archivos.length > 1 ? c.archivos.length : ''}</span>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="6"><b>${plural(lista.length, 'cuenta')}</b></td><td class="num"><b>${dinero(suma(lista, 'monto'))}</b></td><td class="num"><b>${dinero(suma(lista, 'saldo'))}</b></td><td colspan="2"></td></tr></tfoot>
      </table></div>` : '<p class="vacio">No hay cuentas con esos filtros.</p>';

    // Saldos por proveedor
    const porProv = {};
    abiertas.forEach(c => {
      const k = c.proveedor_id;
      porProv[k] = porProv[k] || { saldo: 0, vencido: 0, n: 0 };
      porProv[k].saldo += Number(c.saldo);
      porProv[k].n++;
      if (String(c.vence) < hoy) porProv[k].vencido += Number(c.saldo);
    });
    const filas = Object.entries(porProv).sort((a, b) => b[1].saldo - a[1].saldo);
    $('#p-saldos', el).innerHTML = filas.length ? `<div class="panel"><h3>Saldos por proveedor</h3><div class="tabla-cont"><table class="tabla">
      <thead><tr><th>Proveedor</th><th class="num">Cuentas</th><th class="num">Vencido</th><th class="num">Saldo</th></tr></thead>
      <tbody>${filas.map(([id, v]) => `<tr class="clic" data-prov="${esc(id)}"><td>${esc(provCxp(id).nombre || '—')}</td><td class="num">${v.n}</td>
        <td class="num ${v.vencido ? 'txt-error' : ''}">${dinero(v.vencido)}</td><td class="num"><b>${dinero(v.saldo)}</b></td></tr>`).join('')}</tbody></table></div></div>` : '';
  };

  const recargar = async animar => {
    try {
      if (animar) await conCarga('Cargando cuentas…', cargarCuentas); else await cargarCuentas();
      pintar();
    } catch (e) {
      $('#p-lista', el).innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
      if (e.sesion) sesionVencida(e.message);
    }
  };
  S.refrescar = pintar;
  CPP.repintar = pintar;
  $('#p-mes', el).onchange = e => { CPP.mes = e.target.value || hoyLocal().slice(0, 7); pintar(); };
  $('#p-filtro', el).onchange = e => { CPP.filtro = e.target.value; pintar(); };
  $('#p-prov', el).onchange = e => { CPP.prov = e.target.value; pintar(); };
  $('#p-q', el).oninput = e => { CPP.q = e.target.value; pintar(); };
  $('#p-res', el).onclick = e => {
    const b = e.target.closest('[data-f]');
    if (b) { CPP.filtro = b.dataset.f; $('#p-filtro', el).value = CPP.filtro; pintar(); }
  };
  $('#p-lista', el).onclick = e => {
    const tr = e.target.closest('[data-c]');
    if (tr) dlgCuenta(CPP.datos.cuentas.find(c => c.id === tr.dataset.c));
  };
  $('#p-saldos', el).onclick = e => {
    const tr = e.target.closest('[data-prov]');
    if (tr) { CPP.prov = tr.dataset.prov; CPP.filtro = 'abiertas'; vPagar(el); }
  };
  $('#p-nueva', el).onclick = () => CPP.datos && dlgNuevaCuenta();
  $('#p-exportar', el).onclick = () => CPP.datos && exportarMes();
  if (CPP.datos) pintar();
  if (!CPP.datos || Date.now() - CPP.cargado > 60000 || (CPP.offline && navigator.onLine)) recargar(!CPP.datos);
}

function dlgCuenta(c) {
  if (!c) return;
  const prov = provCxp(c.proveedor_id);
  const pagos = CPP.datos.pagos.filter(p => p.cuenta_id === c.id).sort((a, b) => String(a.fecha_pago).localeCompare(String(b.fecha_pago)));
  const abierta = Number(c.saldo) > 0.005;
  const d = abrirModal(`Cuenta por pagar · ${prov.nombre || ''}`, `
    <div class="form">
      <div class="titulo"><span>${chipCuenta(c)} <span class="nota">${esc(condicionTxt(c))} · vence ${fechaCorta(c.vence)}</span></span>
        <span>Saldo <b class="saldo-grande">${dinero(c.saldo)}</b></span></div>
      <div class="info-oc">
        <div><h4>Proveedor</h4><b>${esc(prov.nombre || '—')}</b>${prov.rfc ? '<br>RFC: ' + esc(prov.rfc) : ''}${prov.email ? '<br>' + esc(prov.email) : ''}</div>
        <div><h4>Origen</h4>${c.folio_oc ? `Orden de compra <b>${esc(c.folio_oc)}</b><br>Monto: ${c.monto_manual ? 'capturado a mano' : 'lo recibido + IVA'}` : 'Captura manual'}<br>Fecha: ${fechaCorta(c.fecha_cuenta)}</div>
        <div><h4>Importes</h4>Total: <b>${dinero(c.monto)}</b><br>Pagado: ${dinero(c.pagado)}<br>Saldo: <b>${dinero(c.saldo)}</b></div>
      </div>

      ${abierta && !CPP.offline ? `<div class="panel-sub" id="cx-pago"><b>Registrar pago</b>
        <div class="fila3">
          <label>Monto<input name="monto" type="number" step="0.01" min="0.01" value="${Number(c.saldo).toFixed(2)}"></label>
          <label>Fecha de pago<input name="fecha" type="date" value="${hoyLocal()}"></label>
          <label>Método<select name="metodo">${Object.entries(METODO_TXT).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
        </div>
        <label>Referencia (folio de transferencia, número de cheque…)<input name="referencia"></label>
        <p class="msg" id="cx-pago-msg"></p>
        <div class="acciones"><button type="button" class="btn" id="cx-pagar">Registrar pago</button>
          <button type="button" class="btn sec" id="cx-liquidar">Liquidar saldo (${dinero(c.saldo)})</button></div></div>` : ''}

      <div><h3>Pagos</h3>${pagos.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Fecha</th><th>Método</th><th>Referencia</th><th class="num">Monto</th><th></th></tr></thead>
        <tbody>${pagos.map(p => `<tr><td>${fechaCorta(p.fecha_pago)}</td><td>${METODO_TXT[p.metodo] || p.metodo}</td><td>${esc(p.referencia || '—')}</td>
          <td class="num">${dinero(p.monto)}</td><td>${CPP.offline ? '' : `<button type="button" class="btn mini peligro" data-borrar-pago="${esc(p.id)}">Eliminar</button>`}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="nota">Sin pagos registrados.</p>'}</div>

      <div><h3>Factura</h3>
        ${c.archivos.length ? `<ul class="lista">${c.archivos.map(a => `<li><span>📄 ${esc(a.nombre)} <small>${fechaCorta(a.fecha)}</small></span>
          <span class="acciones"><button type="button" class="btn mini sec" data-bajar="${esc(a.id)}">Descargar</button>
          ${CPP.offline ? '' : `<button type="button" class="btn mini peligro" data-quitar-arch="${esc(a.id)}">Quitar</button>`}</span></li>`).join('')}</ul>` : '<p class="nota">Sin factura adjunta.</p>'}
        ${CPP.offline ? '' : `<label class="archivo"><input type="file" id="cx-arch" multiple accept=".pdf,.xml,.jpg,.jpeg,.png"><span>Adjuntar factura (PDF, XML o foto)</span></label>`}
      </div>

      ${CPP.offline ? '' : `<details class="panel-sub"><summary><b>Editar datos de la cuenta</b></summary>
        <form id="cx-edit" class="form">
          <div class="fila2"><label>Folio de factura<input name="factura" value="${esc(c.factura || '')}"></label>
            <label>Monto total<input name="monto" type="number" step="0.01" min="0.01" value="${Number(c.monto).toFixed(2)}"></label></div>
          ${c.folio_oc && c.monto_manual ? '<p class="nota">El monto se capturó a mano. <button type="button" class="btn mini sec" id="cx-recalc">Volver a calcular con lo recibido</button></p>' : ''}
          <div class="fila3"><label>Condición<select name="condicion"><option value="CONTADO" ${c.condicion !== 'CREDITO' ? 'selected' : ''}>Contado</option>
            <option value="CREDITO" ${c.condicion === 'CREDITO' ? 'selected' : ''}>Crédito</option></select></label>
            <label id="cx-dias">Días de crédito<input name="dias_credito" type="number" min="0" step="1" value="${Number(c.dias_credito) || 0}"></label>
            <label>Vence<input name="vence" type="date" value="${esc(c.vence)}"></label></div>
          <label>Notas<input name="notas" value="${esc(c.notas || '')}"></label>
          <p class="msg" id="cx-edit-msg"></p>
          <div class="pie"><button class="btn" type="submit">Guardar cambios</button></div>
        </form></details>`}
    </div>`, true);

  const reabrir = det => {
    aplicarDetalle(det);
    if (CPP.repintar) CPP.repintar();
    dlgCuenta(CPP.datos.cuentas.find(x => x.id === c.id));
  };

  const fp = $('#cx-pago', d);
  if (fp) {
    const pagar = async liquidar => {
      const msg = $('#cx-pago-msg', d);
      const monto = liquidar ? Number(c.saldo) : Number($('[name=monto]', fp).value);
      if (!(monto > 0)) { msg.textContent = 'Captura el monto del pago.'; return; }
      if (liquidar && !confirm(`¿Registrar un pago de ${dinero(monto)} para liquidar la cuenta?`)) return;
      msg.textContent = '';
      try {
        const det = await conCarga('Registrando pago…', () => api('registrarPago', { pago: {
          id: fp.dataset.pagoId || (fp.dataset.pagoId = uuid()), cuenta_id: c.id, monto, fecha_pago: $('[name=fecha]', fp).value,
          metodo: $('[name=metodo]', fp).value, referencia: $('[name=referencia]', fp).value.trim()
        } }));
        toast(det.cuenta.estado === 'PAGADA' ? 'Cuenta liquidada.' : `Pago registrado. Saldo: ${dinero(det.cuenta.saldo)}.`, 'ok');
        reabrir(det);
        actualizarAlertasLocales();
      } catch (e) { msg.textContent = e.message; }
    };
    $('#cx-pagar', d).onclick = () => pagar(false);
    $('#cx-liquidar', d).onclick = () => pagar(true);
  }

  d.onclick = async e => {
    const borrar = e.target.closest('[data-borrar-pago]');
    const bajar = e.target.closest('[data-bajar]');
    const quitar = e.target.closest('[data-quitar-arch]');
    try {
      if (borrar && confirm('¿Eliminar este pago? El saldo de la cuenta volverá a aumentar.')) {
        reabrir(await conCarga('Eliminando…', () => api('eliminarPago', { id: borrar.dataset.borrarPago })));
        actualizarAlertasLocales();
      }
      if (bajar) {
        const r = await conCarga('Descargando…', () => api('archivoCuenta', { cuenta_id: c.id, archivo_id: bajar.dataset.bajar }));
        Excel.descargar(new Blob([Uint8Array.from(atob(r.base64), x => x.charCodeAt(0))], { type: r.tipo }), r.nombre);
      }
      if (quitar && confirm('¿Quitar este archivo? Se enviará a la papelera de Drive.')) {
        const cu = await conCarga('Quitando…', () => api('quitarArchivo', { cuenta_id: c.id, archivo_id: quitar.dataset.quitarArch }));
        reabrir({ cuenta: cu });
      }
    } catch (err) { toast(err.message, 'error'); }
  };

  const arch = $('#cx-arch', d);
  if (arch) arch.onchange = async () => {
    if (!arch.files.length) return;
    try {
      const cu = await conCarga('Subiendo factura…', () => subirFacturas(c.id, Array.from(arch.files), uuid()));
      toast('Factura adjunta.', 'ok');
      reabrir({ cuenta: cu });
    } catch (e) { toast(e.message, 'error'); }
  };

  const fe = $('#cx-edit', d);
  if (fe) {
    const diasVis = () => { $('#cx-dias', d).hidden = fe.condicion.value !== 'CREDITO'; };
    const recalcVence = () => {
      const dias = fe.condicion.value === 'CREDITO' ? Number(fe.dias_credito.value) || 0 : 0;
      fe.vence.value = sumarDiasYmd(String(c.fecha_cuenta).slice(0, 10), dias);
    };
    diasVis();
    fe.condicion.onchange = () => { diasVis(); recalcVence(); };
    fe.dias_credito.oninput = recalcVence;
    const guardar = async recalcular => {
      const msg = $('#cx-edit-msg', d);
      msg.textContent = '';
      try {
        const cu = await conCarga('Guardando…', () => api('guardarCuenta', { cuenta: {
          id: c.id, factura: fe.factura.value.trim(), monto: recalcular ? '' : fe.monto.value, condicion: fe.condicion.value,
          dias_credito: fe.dias_credito.value, vence: fe.vence.value, notas: fe.notas.value.trim(), recalcular
        } }));
        toast('Cuenta actualizada.', 'ok');
        reabrir({ cuenta: cu });
        actualizarAlertasLocales();
      } catch (e) { msg.textContent = e.message; }
    };
    fe.onsubmit = ev => { ev.preventDefault(); guardar(false); };
    const rc = $('#cx-recalc', d);
    if (rc) rc.onclick = () => guardar(true);
  }
}

function dlgNuevaCuenta() {
  const provs = CPP.datos.proveedores.filter(p => esActivo(p.activo)).sort(porNombre);
  const nuevoId = uuid();
  const d = abrirModal('Nueva cuenta por pagar', `
    <form id="fnc" class="form">
      <p class="nota">Para facturas que no vienen de una orden de compra (servicios, fletes, gastos, compras de contado sin orden).</p>
      <div class="fila2"><label>Proveedor<select name="proveedor_id" required><option value="">Elige…</option>${provs.map(p => `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('')}</select></label>
        <label>Folio de factura<input name="factura"></label></div>
      <div class="fila3"><label>Fecha de la factura<input name="fecha" type="date" required value="${hoyLocal()}"></label>
        <label>Monto total (con IVA)<input name="monto" type="number" step="0.01" min="0.01" required></label>
        <label>Condición<select name="condicion"><option value="CONTADO">Contado</option><option value="CREDITO">Crédito</option></select></label></div>
      <div class="fila2"><label id="nc-dias" hidden>Días de crédito<input name="dias_credito" type="number" min="0" step="1" value="0"></label>
        <label>Vence<input name="vence" type="date" value="${hoyLocal()}"></label></div>
      <label>Notas<input name="notas"></label>
      <label class="archivo"><input type="file" name="archivos" multiple accept=".pdf,.xml,.jpg,.jpeg,.png"><span>Adjuntar factura (opcional)</span></label>
      <p class="msg" id="fnc-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fnc', d);
  const recalc = () => {
    $('#nc-dias', d).hidden = f.condicion.value !== 'CREDITO';
    const dias = f.condicion.value === 'CREDITO' ? Number(f.dias_credito.value) || 0 : 0;
    if (f.fecha.value) f.vence.value = sumarDiasYmd(f.fecha.value, dias);
  };
  f.proveedor_id.onchange = () => {
    const p = provCxp(f.proveedor_id.value);
    if (Number(p.dias_credito) > 0) { f.condicion.value = 'CREDITO'; f.dias_credito.value = p.dias_credito; } else f.condicion.value = 'CONTADO';
    recalc();
  };
  f.condicion.onchange = recalc;
  f.dias_credito.oninput = recalc;
  f.fecha.onchange = recalc;
  f.archivos.onchange = () => { $('.archivo span', d).textContent = Array.from(f.archivos.files).map(a => a.name).join(', ') || 'Adjuntar factura (opcional)'; };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = $('#fnc-msg', d);
    msg.textContent = '';
    try {
      const archivos = Array.from(f.archivos.files);
      const cu = await conCarga('Guardando…', async () => {
        const c = await api('guardarCuenta', { cuenta: {
          nuevo: true, id: nuevoId, proveedor_id: f.proveedor_id.value, factura: f.factura.value.trim(), fecha_cuenta: f.fecha.value,
          monto: f.monto.value, condicion: f.condicion.value, dias_credito: f.dias_credito.value, vence: f.vence.value, notas: f.notas.value.trim()
        } });
        return archivos.length ? await subirFacturas(c.id, archivos, nuevoId) : c;
      });
      aplicarDetalle({ cuenta: cu });
      cerrarModal();
      toast('Cuenta registrada.', 'ok');
      if (CPP.repintar) CPP.repintar();
      actualizarAlertasLocales();
    } catch (e) { msg.textContent = e.message; }
  };
}

// Recalcula los avisos de Inicio con los datos ya descargados
function actualizarAlertasLocales() {
  if (!CPP.datos) return;
  const hoy = hoyLocal(), lim = hoyLocal(DIAS_AVISO);
  const r = { por_vencer: 0, monto_por_vencer: 0, vencidas: 0, monto_vencido: 0, dias: DIAS_AVISO };
  CPP.datos.cuentas.filter(c => Number(c.saldo) > 0.005).forEach(c => {
    if (String(c.vence) < hoy) { r.vencidas++; r.monto_vencido += Number(c.saldo); }
    else if (String(c.vence) <= lim) { r.por_vencer++; r.monto_por_vencer += Number(c.saldo); }
  });
  S.alertas = r;
  pintarMenu();
}

function exportarMes() {
  const D = CPP.datos, mes = CPP.mes;
  const prov = id => provCxp(id);
  const cuentas = D.cuentas.filter(c => String(c.fecha_cuenta).slice(0, 7) === mes).sort((a, b) => String(a.fecha_cuenta).localeCompare(String(b.fecha_cuenta)));
  const pagos = D.pagos.filter(p => String(p.fecha_pago).slice(0, 7) === mes).sort((a, b) => String(a.fecha_pago).localeCompare(String(b.fecha_pago)));
  const porId = Object.fromEntries(D.cuentas.map(c => [c.id, c]));
  const n = v => Math.round((Number(v) || 0) * 100) / 100;
  const filasC = [['Fecha', 'Proveedor', 'RFC', 'Factura', 'Orden de compra', 'Condición', 'Vence', 'Total', 'Pagado', 'Saldo', 'Estado']]
    .concat(cuentas.map(c => [String(c.fecha_cuenta).slice(0, 10), prov(c.proveedor_id).nombre || '', prov(c.proveedor_id).rfc || '', c.factura || '',
      c.folio_oc || 'Manual', condicionTxt(c), String(c.vence), n(c.monto), n(c.pagado), n(c.saldo), CXP_TXT[estadoCuenta(c)]]));
  filasC.push(['', '', '', '', '', '', 'TOTAL', n(cuentas.reduce((s, c) => s + Number(c.monto), 0)),
    n(cuentas.reduce((s, c) => s + Number(c.pagado), 0)), n(cuentas.reduce((s, c) => s + Number(c.saldo), 0)), '']);
  const filasP = [['Fecha de pago', 'Proveedor', 'Factura', 'Orden de compra', 'Método', 'Referencia', 'Monto']]
    .concat(pagos.map(p => { const c = porId[p.cuenta_id] || {}; return [String(p.fecha_pago), prov(c.proveedor_id).nombre || '', c.factura || '', c.folio_oc || 'Manual', METODO_TXT[p.metodo] || p.metodo, p.referencia || '', n(p.monto)]; }));
  filasP.push(['', '', '', '', '', 'TOTAL', n(pagos.reduce((s, p) => s + Number(p.monto), 0))]);
  const saldos = {};
  D.cuentas.filter(c => Number(c.saldo) > 0.005).forEach(c => {
    saldos[c.proveedor_id] = saldos[c.proveedor_id] || [0, 0];
    saldos[c.proveedor_id][0] += Number(c.saldo);
    if (String(c.vence) < hoyLocal()) saldos[c.proveedor_id][1] += Number(c.saldo);
  });
  const filasS = [['Proveedor', 'RFC', 'Saldo vencido', 'Saldo total']]
    .concat(Object.entries(saldos).sort((a, b) => b[1][0] - a[1][0]).map(([id, v]) => [prov(id).nombre || '', prov(id).rfc || '', n(v[1]), n(v[0])]));
  const blob = Excel.crearXlsx([
    { nombre: 'Cuentas del mes', filas: filasC, encabezado: true, anchos: [12, 30, 15, 16, 14, 16, 12, 13, 13, 13, 12], columnasTexto: [2, 3] },
    { nombre: 'Pagos del mes', filas: filasP, encabezado: true, anchos: [13, 30, 16, 14, 15, 24, 13] },
    { nombre: 'Saldos al día', filas: filasS, encabezado: true, anchos: [30, 15, 15, 15] }
  ]);
  Excel.descargar(blob, `cuentas-por-pagar-${mes}.xlsx`);
}

/* ---- Punto de venta (fase 4) ---- */
const METODOS_CAJA = { EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia' };
const CJ = { estado: null, ticket: { cliente_id: '', lineas: [] }, cat: '', q: '' };
// Impresora de tickets: se configura por equipo (Mi cuenta o Caja > Impresora)
const IMP = { modo: 'sistema', ancho: 80, copias: 1, auto: true, logo: true, pie: '¡Gracias por su compra!', cajon: false, sinAcentos: false, usb: null, ble: null };
async function cargarImpresora() {
  const g = await DB.get('impresora');
  if (g) Object.assign(IMP, g);
  else { const viejo = await DB.get('caja:imprimir'); if (viejo === false) IMP.auto = false; }
}
let secuenciaOp = 0;

const esAdminCaja = () => ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'].includes(rol());
const clientePorId = id => (S.clientes || []).find(c => c.id === id) || null;
function precioCliente(p, cli) {
  if (cli) {
    const pe = (S.precios || []).find(x => x.cliente_id === cli.id && x.producto_id === p.id);
    if (pe) return Number(pe.precio);
    if (cli.tipo === 'MAYOREO' && Number(p.precio_mayoreo) > 0) return Number(p.precio_mayoreo);
  }
  return Number(p.precio_menudeo) || 0;
}
function creditoDisponible(cli) {
  if (!cli || !cli.credito) return 0;
  return Math.max(0, Math.round((Number(cli.limite_credito) - Number(cli.saldo || 0)) * 100) / 100);
}
const ticketCorto = id => String(id).replace(/-/g, '').slice(0, 8).toUpperCase();

async function cargarCaja() {
  CJ.estado = (await DB.get('caja:' + S.usuario.usuario)) || { corte: null, ventas: [], abonos: [], ultimoCorte: null };
}
const guardarCaja = () => DB.set('caja:' + S.usuario.usuario, CJ.estado);

// Encola una operación de caja (se envía en orden; funciona sin conexión)
async function encolarCaja(op) {
  op.seq = Date.now() * 1000 + (secuenciaOp++ % 1000);
  op.fecha = op.fecha || new Date().toISOString();
  op.estado = 'pendiente';
  op.usuario = S.usuario.usuario;
  op.origen = navigator.onLine && S.online ? 'online' : 'offline';
  await DB.guardarMov(op);
  S.outbox.push(op);
  actualizarBarra();
  if (navigator.onLine) sincronizar();
}

// Respuesta del servidor a una operación de caja
function resultadoCaja(op, res) {
  if (!CJ.estado) return;
  if (op.clase === 'VENTA') {
    const v = CJ.estado.ventas.find(x => x.id === op.id);
    if (v) {
      if (res.folio) v.folio = res.folio;
      v.sync = res.estado === 'rechazado' ? 'error' : 'enviada';
      v.error = res.error || '';
      if (res.aviso) v.aviso = res.aviso;
      if (v.correo && res.estado !== 'rechazado') enviarCorreoTicket(v, v.correo);
    }
  }
  if (op.clase === 'CORTE_CERRAR' && res.corte) CJ.estado.ultimoCorteServidor = res.corte;
  guardarCaja();
}

function vCaja(el) {
  S.refrescar = null;
  CJ.repintar = null;
  if (!CJ.estado) { el.innerHTML = '<p class="nota">Cargando caja…</p>'; cargarCaja().then(() => vCaja(el)); return; }
  const E = CJ.estado;
  const rechazadas = misPendientes().filter(o => o.clase && o.estado === 'rechazado');
  const avisoRech = rechazadas.length ? `<div class="aviso-offline">${plural(rechazadas.length, 'operación')} de caja fue rechazada por el servidor.
    <button type="button" class="btn mini sec" id="cj-rech">Ver</button></div>` : '';
  if (!E.corte) return pintarAbrirCaja(el, avisoRech);

  const alm = S.idx.alm[E.corte.almacen_id] || {};
  el.innerHTML = `
    ${avisoRech}
    <div class="caja-top">
      <div><b>Caja · ${esc(alm.nombre || '')}</b><small>Abierta ${fechaHora(E.corte.apertura)} · Fondo ${dinero(E.corte.fondo)} · ${plural(E.ventas.filter(v => !v.cancelada).length, 'venta')}</small></div>
      <div class="acciones"><button type="button" class="btn sec" id="cj-ticket">Imprimir ticket</button>
        <button type="button" class="btn sec" id="cj-ventas">Ventas del turno</button>
        <button type="button" class="btn sec" id="cj-abono">Cobrar abono</button>
        <button type="button" class="btn sec" id="cj-cerrar">Cerrar caja</button>
        ${IMP.modo === 'ble' && !impresoraBLELista() ? '<button type="button" class="btn" id="cj-ble">Conectar impresora</button>' : ''}
        ${modoDirecto() && IMP.cajon ? '<button type="button" class="btn sec" id="cj-cajon">Abrir cajón</button>' : ''}
        <button type="button" class="btn sec icono-txt" id="cj-imp" title="Configurar impresora">⚙ Impresora</button></div>
    </div>
    <div class="caja">
      <section class="caja-buscar">
        <input id="cj-q" type="search" placeholder="Escanea o busca: nombre, código. Usa 3*código para varias piezas" autocomplete="off" value="${esc(CJ.q)}">
        <div class="cats" id="cj-cats"></div>
        <div class="cj-res" id="cj-res"></div>
      </section>
      <aside class="caja-ticket">
        <button type="button" class="cj-cliente" id="cj-cliente"></button>
        <div class="cj-lineas" id="cj-lineas"></div>
        <div class="cj-total" id="cj-total"></div>
        <div class="acciones"><button type="button" class="btn cobrar" id="cj-cobrar">Cobrar <small>(F2)</small></button>
          <button type="button" class="btn sec" id="cj-vaciar">Vaciar</button></div>
      </aside>
    </div>
    <div class="cj-movil" id="cj-movil"><button type="button" class="cj-ver" id="cj-ver"></button><button type="button" class="btn cobrar" id="cj-cobrar2">Cobrar</button></div>`;

  const q = $('#cj-q', el);
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo)).sort(porNombre);
  $('#cj-cats', el).innerHTML = [['', 'Todas']].concat(cats.map(c => [c.id, c.nombre]))
    .map(([id, n]) => `<button type="button" data-cat="${esc(id)}" class="${CJ.cat === id ? 'activo' : ''}">${esc(n)}</button>`).join('');

  const pintarRes = () => {
    const ex = mapaExistencias();
    const cli = clientePorId(CJ.ticket.cliente_id);
    const t = normal(CJ.q.replace(/^\d+(\.\d+)?\*/, ''));
    const lista = S.catalogo.productos
      .filter(p => esActivo(p.activo) && (!CJ.cat || p.categoria_id === CJ.cat) && (!t || coincide(p, t)))
      .sort(porNombre).slice(0, 60);
    $('#cj-res', el).innerHTML = lista.length ? lista.map(p => {
      const c = ex[E.corte.almacen_id + '|' + p.id] || 0;
      return `<button type="button" class="prod" data-p="${esc(p.id)}"><b>${esc(p.nombre)}</b>
        <span class="fila-oc"><span class="precio">${dinero(precioCliente(p, cli))}</span><small class="${c <= 0 ? 'txt-error' : ''}">${numero(c)} ${esc(p.unidad || '')}</small></span></button>`;
    }).join('') : '<p class="nota">Sin productos que coincidan.</p>';
  };
  const pintarTicket = () => {
    const cli = clientePorId(CJ.ticket.cliente_id);
    $('#cj-cliente', el).innerHTML = cli
      ? `<span><b>${esc(cli.nombre)}</b> <span class="est ${cli.tipo === 'MAYOREO' ? 'est-ENVIADA' : 'est-BORRADOR'}">${cli.tipo === 'MAYOREO' ? 'Mayoreo' : 'Menudeo'}</span></span>
         <small>${cli.credito ? `Crédito disponible ${dinero(creditoDisponible(cli))}${Number(cli.vencido) > 0 ? ' · <span class="txt-error">saldo vencido</span>' : ''}` : 'Sin crédito'} · cambiar</small>`
      : '<span><b>Público en general</b></span><small>Toca para elegir cliente</small>';
    const L = CJ.ticket.lineas;
    ponerHTML($('#cj-lineas', el), L.length ? L.map((l, i) => {
      const p = S.idx.prod[l.producto_id] || {};
      return `<div class="cj-linea"><div class="cj-nombre">${esc(p.nombre || '—')}<small>${dinero(l.precio)} c/u</small></div>
        <div class="cj-cant"><button type="button" data-menos="${i}">−</button><input type="number" step="any" min="0" data-cant="${i}" value="${l.cantidad}"><button type="button" data-mas="${i}">+</button></div>
        ${esAdminCaja() ? `<input class="cj-precio" type="number" step="0.01" min="0" data-precio="${i}" value="${l.precio}" title="Precio">` : ''}
        <b class="cj-imp">${dinero(l.cantidad * l.precio)}</b><button type="button" class="icono" data-quitar="${i}" title="Quitar">✕</button></div>`;
    }).join('') : '<p class="nota cj-vacio">Escanea o toca un producto para agregarlo.</p>');
    const total = totalTicket();
    $('#cj-total', el).innerHTML = `<span>${plural(L.reduce((s, l) => s + Number(l.cantidad), 0), 'artículo')}</span><b>${dinero(total)}</b>`;
    $('#cj-cobrar', el).disabled = !L.length;
    $('#cj-cobrar2', el).disabled = !L.length;
    $('#cj-ver', el).innerHTML = `<small>${plural(L.reduce((s, l) => s + Number(l.cantidad), 0), 'artículo')} · ver ticket</small><b>${dinero(total)}</b>`;
  };
  const agregar = (p, cantidad = 1) => {
    const cli = clientePorId(CJ.ticket.cliente_id);
    const ya = CJ.ticket.lineas.find(l => l.producto_id === p.id);
    if (ya) ya.cantidad = Math.round((Number(ya.cantidad) + cantidad) * 1000) / 1000;
    else CJ.ticket.lineas.push({ producto_id: p.id, cantidad, precio: precioCliente(p, cli) });
    pintarTicket();
  };
  CJ.repintar = () => { pintarRes(); pintarTicket(); };
  S.refrescar = CJ.repintar;
  pintarRes();
  pintarTicket();
  q.focus();

  q.oninput = () => { CJ.q = q.value; pintarRes(); };
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    let v = q.value.trim(), cant = 1;
    const m = v.match(/^(\d+(?:\.\d+)?)\*(.+)$/);
    if (m) { cant = Number(m[1]); v = m[2].trim(); }
    const p = S.idx.barras[v] || S.idx.codigo[normal(v)];
    const t = normal(v);
    const unicos = p ? [p] : S.catalogo.productos.filter(x => esActivo(x.activo) && coincide(x, t));
    if (unicos.length === 1) {
      agregar(unicos[0], cant);
      q.value = ''; CJ.q = ''; pintarRes();
    } else if (v) toast(unicos.length ? 'Hay varios productos: tócalo en la lista.' : 'No se encontró el producto.', unicos.length ? '' : 'error');
  };
  $('#cj-cats', el).onclick = e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    CJ.cat = b.dataset.cat;
    $$('#cj-cats button', el).forEach(x => x.classList.toggle('activo', x === b));
    pintarRes();
  };
  $('#cj-res', el).onclick = e => {
    const b = e.target.closest('[data-p]');
    if (b) { agregar(S.idx.prod[b.dataset.p]); q.focus(); }
  };
  const lin = $('#cj-lineas', el);
  lin.onclick = e => {
    const t = e.target;
    const L = CJ.ticket.lineas;
    if (t.dataset.mas !== undefined) L[t.dataset.mas].cantidad = Number(L[t.dataset.mas].cantidad) + 1;
    else if (t.dataset.menos !== undefined) {
      const l = L[t.dataset.menos];
      l.cantidad = Number(l.cantidad) - 1;
      if (l.cantidad <= 0) L.splice(Number(t.dataset.menos), 1);
    } else if (t.closest('[data-quitar]')) L.splice(Number(t.closest('[data-quitar]').dataset.quitar), 1);
    else return;
    pintarTicket();
  };
  lin.onchange = e => {
    const t = e.target;
    const L = CJ.ticket.lineas;
    if (t.dataset.cant !== undefined) {
      const n = Number(t.value);
      if (n > 0) L[t.dataset.cant].cantidad = n; else L.splice(Number(t.dataset.cant), 1);
    }
    if (t.dataset.precio !== undefined) L[t.dataset.precio].precio = Math.max(0, Number(t.value) || 0);
    pintarTicket();
  };
  $('#cj-cliente', el).onclick = () => dlgElegirCliente(id => {
    CJ.ticket.cliente_id = id;
    const cli = clientePorId(id);
    CJ.ticket.lineas.forEach(l => { const p = S.idx.prod[l.producto_id]; if (p) l.precio = precioCliente(p, cli); });
    pintarTicket(); pintarRes();
  });
  $('#cj-vaciar', el).onclick = () => {
    if (CJ.ticket.lineas.length && !confirm('¿Vaciar el ticket?')) return;
    CJ.ticket = { cliente_id: '', lineas: [] };
    pintarTicket(); pintarRes();
  };
  $('#cj-cobrar', el).onclick = () => dlgCobrar(() => { CJ.ticket = { cliente_id: '', lineas: [] }; vCaja(el); });
  $('#cj-cobrar2', el).onclick = () => $('#cj-cobrar', el).click();
  $('#cj-ver', el).onclick = () => $('.caja-ticket', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#cj-ventas', el).onclick = () => dlgVentasTurno(() => vCaja(el));
  $('#cj-ticket', el).onclick = () => {
    const v = E.ventas.filter(x => !x.cancelada).slice(-1)[0];
    if (!v) { toast('Aún no hay ventas en este turno.', ''); return; }
    dlgTicket(v);
  };
  $('#cj-imp', el).onclick = () => dlgImpresora(() => vCaja(el));
  const bcj = $('#cj-cajon', el);
  if (bcj) bcj.onclick = abrirCajon;
  const bble = $('#cj-ble', el);
  if (bble) bble.onclick = async () => {
    try {
      await elegirBLE(true);
      toast('Impresora conectada.', 'ok');
      vCaja(el);
    } catch (e) { if (e.name !== 'NotFoundError') toast('No se pudo conectar la impresora: ' + e.message, 'error'); }
  };
  $('#cj-abono', el).onclick = () => dlgAbono(null, () => vCaja(el));
  $('#cj-cerrar', el).onclick = () => dlgCerrarCaja(() => vCaja(el));
  const rech = $('#cj-rech', el);
  if (rech) rech.onclick = () => dlgRechazadasCaja(() => vCaja(el));
}

function totalTicket() {
  return Math.round(CJ.ticket.lineas.reduce((s, l) => s + Number(l.cantidad) * Number(l.precio), 0) * 100) / 100;
}

function pintarAbrirCaja(el, avisoRech) {
  const alms = esGeneral() ? S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre) : almacenesVisibles();
  const E = CJ.estado;
  el.innerHTML = `${avisoRech}
    <div class="panel abrir-caja">
      <h2>Abrir caja</h2>
      ${alms.length ? `<form id="cj-abrir" class="form">
        <label>Sucursal<select name="almacen_id">${alms.map(a => `<option value="${esc(a.id)}" ${a.tipo === 'SUCURSAL' && !F.cajaAlm ? '' : ''}${F.cajaAlm === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        <label>Fondo inicial (efectivo para cambio)<input name="fondo" type="number" step="0.01" min="0" value="0" inputmode="decimal"></label>
        <button class="btn" type="submit">Abrir caja</button>
      </form>` : '<p class="txt-error">No tienes una sucursal asignada.</p>'}
      ${E.ultimoCorte ? `<p class="nota">Último corte: ${fechaHora(E.ultimoCorte.cierre)} · diferencia ${dinero(E.ultimoCorte.diferencia)}
        <button type="button" class="btn mini sec" id="cj-reimp-corte">Reimprimir corte</button></p>` : ''}
    </div>`;
  const f = $('#cj-abrir', el);
  if (f) {
    f.fondo.focus();
    f.fondo.select();
    f.onsubmit = async ev => {
      ev.preventDefault();
      F.cajaAlm = f.almacen_id.value;
      const op = { clase: 'CORTE_ABRIR', id: uuid(), almacen_id: f.almacen_id.value, fondo: Number(f.fondo.value) || 0 };
      E.corte = { id: op.id, almacen_id: op.almacen_id, fondo: op.fondo, apertura: new Date().toISOString() };
      E.ventas = [];
      E.abonos = [];
      await guardarCaja();
      await encolarCaja(op);
      toast('Caja abierta.', 'ok');
      vCaja(el);
    };
  }
  const re = $('#cj-reimp-corte', el);
  if (re) re.onclick = () => imprimirCorte(E.ultimoCorte);
  const rech = $('#cj-rech', el);
  if (rech) rech.onclick = () => dlgRechazadasCaja(() => vCaja(el));
}

function dlgElegirCliente(alElegir) {
  const d = abrirModal('Cliente de la venta', `
    <div class="form">
      <input id="ec-q" type="search" placeholder="Buscar por nombre o teléfono" autocomplete="off">
      <div id="ec-lista" class="lista-clientes"></div>
      <details class="panel-sub"><summary><b>Nuevo cliente</b></summary>
        <form id="ec-nuevo" class="form">
          <div class="fila2"><label>Nombre<input name="nombre" required></label><label>Teléfono<input name="telefono" type="tel"></label></div>
          ${esAdminCaja() ? '<p class="nota">Para mayoreo, crédito o precios especiales, edítalo después en Ventas › Clientes.</p>' : '<p class="nota">Se registra como cliente de menudeo. Un administrador puede asignarle mayoreo o crédito.</p>'}
          <p class="msg" id="ec-msg"></p>
          <button class="btn" type="submit">Registrar y elegir</button>
        </form></details>
    </div>`);
  const pintar = () => {
    const q = normal($('#ec-q', d).value);
    const l = (S.clientes || []).filter(c => c.activo !== false && (!q || normal(c.nombre + ' ' + (c.telefono || '')).includes(q))).sort(porNombre).slice(0, 50);
    $('#ec-lista', d).innerHTML = `<button type="button" data-cli=""><b>Público en general</b><small>Precio de menudeo</small></button>` +
      l.map(c => `<button type="button" data-cli="${esc(c.id)}"><b>${esc(c.nombre)}</b>
        <small>${c.tipo === 'MAYOREO' ? 'Mayoreo' : 'Menudeo'}${c.telefono ? ' · ' + esc(c.telefono) : ''}${c.credito ? ' · crédito disponible ' + dinero(creditoDisponible(c)) : ''}${Number(c.vencido) > 0 ? ' · <span class="txt-error">vencido ' + dinero(c.vencido) + '</span>' : ''}</small></button>`).join('');
  };
  pintar();
  $('#ec-q', d).oninput = pintar;
  $('#ec-q', d).focus();
  $('#ec-lista', d).onclick = e => {
    const b = e.target.closest('[data-cli]');
    if (b) { cerrarModal(); alElegir(b.dataset.cli); }
  };
  $('#ec-nuevo', d).onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target, msg = $('#ec-msg', d);
    if (!navigator.onLine) { msg.textContent = 'Sin conexión no se pueden registrar clientes. Vende como Público en general.'; return; }
    try {
      const c = await conCarga('Registrando…', () => api('guardarCliente', { cliente: { nuevo: true, id: uuid(), nombre: f.nombre.value.trim(), telefono: f.telefono.value.trim() } }));
      S.clientes = (S.clientes || []).concat([c]);
      DB.set('clientes', S.clientes);
      cerrarModal();
      toast('Cliente registrado.', 'ok');
      alElegir(c.id);
    } catch (e) { msg.textContent = e.message; }
  };
}

function dlgCobrar(alTerminar) {
  const total = totalTicket();
  const cli = clientePorId(CJ.ticket.cliente_id);
  const disp = creditoDisponible(cli);
  const vencido = cli && Number(cli.vencido) > 0;
  const d = abrirModal('Cobrar', `
    <form id="fcob" class="form" autocomplete="off">
      <div class="cobro-total"><span>Total a cobrar</span><b>${dinero(total)}</b><small>${esc(cli ? cli.nombre : 'Público en general')}</small></div>
      <label>Efectivo recibido<input name="recibido" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
      <div class="billetes">${['Exacto', 20, 50, 100, 200, 500, 1000].map(b => `<button type="button" data-b="${b}">${b === 'Exacto' ? b : '$' + b}</button>`).join('')}</div>
      <div class="fila3">
        <label>Tarjeta<input name="tarjeta" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
        <label>Transferencia<input name="transferencia" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
        ${cli && cli.credito ? `<label>Crédito <small>${vencido ? '<span class="txt-error">tiene saldo vencido</span>' : 'disponible ' + dinero(disp)}</small>
          <input name="credito" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>` : ''}
      </div>
      ${cli && cli.credito ? '<div class="acciones"><button type="button" class="btn mini sec" id="cob-credito">Todo a crédito</button></div>' : ''}
      <div class="cobro-res" id="cob-res"></div>
      <div class="fila2">
        <label>Ticket<select name="ticket"><option value="0">No imprimir</option><option value="1">Imprimir</option><option value="2">Imprimir doble</option></select></label>
        <label>Enviar ticket por correo <small>(opcional)</small><input name="correo" type="email" list="cob-mails" placeholder="correo@ejemplo.com" autocomplete="off"></label>
      </div>
      <datalist id="cob-mails">${cli && cli.email ? `<option value="${esc(cli.email)}">` : ''}</datalist>
      <p class="msg" id="cob-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Regresar</button><button class="btn" type="submit">Confirmar venta</button></div>
    </form>`);
  const f = $('#fcob', d), msg = $('#cob-msg', d);
  f.ticket.value = IMP.auto ? String(IMP.copias) : '0';
  const v = n => Math.round((Number(f[n] ? f[n].value : 0) || 0) * 100) / 100;
  const calcular = () => {
    const otros = Math.round((v('tarjeta') + v('transferencia') + v('credito')) * 100) / 100;
    const efectivo = Math.max(0, Math.round((total - otros) * 100) / 100);
    const recibido = v('recibido');
    const cambio = Math.round((recibido - efectivo) * 100) / 100;
    $('#cob-res', d).innerHTML = `<span>Efectivo a cobrar</span><b>${dinero(efectivo)}</b>
      <span>${cambio >= 0 ? 'Cambio' : 'Falta'}</span><b class="${cambio >= 0 ? 'cambio' : 'txt-error'}">${dinero(Math.abs(cambio))}</b>`;
    return { otros, efectivo, recibido, cambio };
  };
  calcular();
  f.oninput = calcular;
  f.recibido.focus();
  $('.billetes', d).onclick = e => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    const c = calcular();
    f.recibido.value = b.dataset.b === 'Exacto' ? c.efectivo.toFixed(2) : b.dataset.b;
    calcular();
  };
  const tc = $('#cob-credito', d);
  if (tc) tc.onclick = () => { f.credito.value = total.toFixed(2); f.tarjeta.value = ''; f.transferencia.value = ''; f.recibido.value = ''; calcular(); };

  f.onsubmit = async ev => {
    ev.preventDefault();
    const c = calcular();
    const credito = v('credito');
    if (c.otros > total + 0.01) { msg.textContent = 'Tarjeta, transferencia y crédito suman más que el total.'; return; }
    if (c.efectivo > 0 && c.recibido + 0.001 < c.efectivo) { msg.textContent = `Falta efectivo: recibe al menos ${dinero(c.efectivo)}.`; return; }
    if (credito > 0) {
      const enLinea = navigator.onLine && S.online;
      const problema = vencido ? 'El cliente tiene saldo vencido.' : (credito > disp + 0.01 ? `El crédito disponible es ${dinero(disp)}.` : '');
      if (problema) {
        if (enLinea) { msg.textContent = problema + ' No se puede vender a crédito.'; return; }
        if (!confirm(problema + ' Estás sin conexión. ¿Registrar la venta a crédito de todos modos?')) return;
      }
    }
    const correo = f.correo.value.trim().toLowerCase();
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { msg.textContent = 'El correo para el ticket no es válido.'; return; }
    const copias = Number(f.ticket.value);
    const E = CJ.estado;
    const op = {
      clase: 'VENTA', id: uuid(), corte_id: E.corte.id, almacen_id: E.corte.almacen_id, cliente_id: cli ? cli.id : '',
      lineas: CJ.ticket.lineas.map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad), precio: Number(l.precio) })),
      pagos: { efectivo: c.efectivo, tarjeta: v('tarjeta'), transferencia: v('transferencia'), credito }, recibido: c.efectivo > 0 ? c.recibido : 0
    };
    const local = Object.assign({}, op, {
      fecha: new Date().toISOString(), total, cambio: c.efectivo > 0 ? Math.max(0, c.cambio) : 0, sync: 'pendiente',
      cliente: cli ? cli.nombre : 'Público en general', correo: correo || undefined
    });
    E.ventas.push(local);
    if (credito > 0 && cli) { cli.saldo = Math.round((Number(cli.saldo || 0) + credito) * 100) / 100; DB.set('clientes', S.clientes); }
    await guardarCaja();
    await encolarCaja(op);
    cerrarModal();
    toast(c.efectivo > 0 && c.cambio > 0 ? `Venta registrada. Cambio: ${dinero(c.cambio)}` : 'Venta registrada.', 'ok');
    const cajon = c.efectivo > 0;
    if (copias) imprimirTicket(local, copias, cajon);
    else if (cajon) abrirCajon();
    if (correo && !(navigator.onLine && S.online)) toast(`El ticket se enviará a ${correo} al volver la conexión.`, '');
    alTerminar();
  };
}

/* ---------- Impresión ---------- */
// Los tickets se describen como una lista de renglones (doc) y se convierten a HTML (ventana de impresión)
// o a comandos ESC/POS (impresión directa por USB, Bluetooth o RawBT).

// Ventana de impresión del sistema. copias: cada tanto sale en su propia hoja (la térmica corta entre uno y otro)
function imprimirHTML(cuerpo, copias = 1) {
  const angosto = Number(IMP.ancho) === 58;
  const partes = typeof cuerpo === 'function' ? Array.from({ length: copias }, (_, i) => cuerpo(i)) : Array(copias).fill(cuerpo);
  const ifr = document.createElement('iframe');
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(ifr);
  const doc = ifr.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${angosto ? 58 : 80}mm auto; margin: ${angosto ? 2 : 3}mm; }
    body { font: ${angosto ? 11 : 12}px/1.35 "Courier New", monospace; width: ${angosto ? 50 : 72}mm; margin: 0; color: #000; }
    h1 { font-size: ${angosto ? 13 : 15}px; text-align: center; margin: 0 0 2px; } .c { text-align: center; } .r { text-align: right; }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; } table { width: 100%; border-collapse: collapse; }
    td { vertical-align: top; padding: 1px 0; } .t td { font-size: ${angosto ? 13 : 14}px; font-weight: bold; }
    img { display: block; margin: 0 auto 4px; width: ${angosto ? 70 : 90}px; }
    .copia { break-before: page; page-break-before: always; } .etq { text-align: center; font-weight: bold; border: 1px solid #000; margin-bottom: 4px; }
  </style></head><body>${partes.map((p, i) => `<div class="${i ? 'copia' : ''}">${p}</div>`).join('')}</body></html>`);
  doc.close();
  const imprimir = () => {
    try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) { /* sin impresora */ }
    setTimeout(() => ifr.remove(), 2000);
  };
  // espera a que cargue el logo para que salga impreso
  const imgs = [...doc.images].filter(im => !im.complete);
  if (!imgs.length) setTimeout(imprimir, 150);
  else Promise.all(imgs.map(im => new Promise(r => { im.onload = im.onerror = r; }))).then(() => setTimeout(imprimir, 50));
}

// Renglones de un doc → HTML
function htmlDoc(ops) {
  return ops.map(o => {
    switch (o.k) {
      case 'logo': return IMP.logo ? '<img src="icons/icon-192.png" alt="">' : '';
      case 'titulo': return `<h1>${esc(o.s)}</h1>`;
      case 'centro': return `<div class="c">${o.neg ? '<b>' : ''}${esc(o.s).replace(/\n/g, '<br>')}${o.neg ? '</b>' : ''}</div>`;
      case 'sep': return '<hr>';
      case 'txt': return `<div>${esc(o.s)}</div>`;
      case 'par': return `<table><tr class="${o.grande ? 't' : ''}"><td>${o.neg ? `<b>${esc(o.a)}</b>` : esc(o.a)}</td><td class="r">${o.neg ? `<b>${esc(o.b)}</b>` : esc(o.b)}</td></tr></table>`;
      case 'etq': return `<div class="etq">${esc(o.s)}</div>`;
      case 'firma': return `<br><br><div class="c">______________________<br>${esc(o.s)}</div>`;
      default: return '';
    }
  }).join('');
}

/* --- ESC/POS --- */
const CP850 = { 'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3, 'ñ': 0xA4, 'Ñ': 0xA5, 'ü': 0x81, 'Ü': 0x9A, '¡': 0xAD, '¿': 0xA8,
  'Á': 0xB5, 'É': 0x90, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9, '·': 0xFA, '°': 0xF8 };
const columnasTicket = () => (Number(IMP.ancho) === 58 ? 32 : 48);

function bytesTexto(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    if (c < 128) { out.push(c); continue; }
    if (!IMP.sinAcentos && CP850[ch]) { out.push(CP850[ch]); continue; }
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (base.length === 1 && base.charCodeAt(0) < 128) out.push(base.charCodeAt(0));
    else if (ch === '—' || ch === '–') out.push(45);
    else if (ch === '·') out.push(45);
    else if (ch !== '¡' && ch !== '¿') out.push(63);
  }
  return out;
}

// Parte un texto en renglones del ancho del papel
function partirTexto(s, cols) {
  const res = [];
  String(s).split('\n').forEach(linea => {
    let actual = '';
    linea.split(/\s+/).filter(Boolean).forEach(p => {
      while (p.length > cols) { if (actual) { res.push(actual); actual = ''; } res.push(p.slice(0, cols)); p = p.slice(cols); }
      if (!actual) actual = p;
      else if ((actual + ' ' + p).length <= cols) actual += ' ' + p;
      else { res.push(actual); actual = p; }
    });
    res.push(actual);
  });
  return res;
}

// Logo convertido a puntos blanco y negro (con tramado para que el amarillo no desaparezca)
const cacheLogo = {};
async function logoRaster(anchoPuntos) {
  if (cacheLogo[anchoPuntos]) return cacheLogo[anchoPuntos];
  const img = new Image();
  img.src = 'icons/icon-192.png';
  await img.decode();
  const w = anchoPuntos, h = Math.round(img.height * w / img.width);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, w, h);
  cx.drawImage(img, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data;
  const gris = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gris[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const bpr = w / 8;
  const datos = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const negro = gris[i] < 128;
      const err = gris[i] - (negro ? 0 : 255);
      if (negro) datos[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
      if (x + 1 < w) gris[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gris[i + w - 1] += err * 3 / 16;
        gris[i + w] += err * 5 / 16;
        if (x + 1 < w) gris[i + w + 1] += err / 16;
      }
    }
  }
  const r = [0x1D, 0x76, 0x30, 0x00, bpr & 0xff, bpr >> 8, h & 0xff, h >> 8, ...datos];
  cacheLogo[anchoPuntos] = r;
  return r;
}

const ESC_CAJON = [0x1B, 0x70, 0x00, 0x19, 0xFA];

// Convierte uno o varios docs (copias) a bytes ESC/POS, con corte de papel entre cada uno
async function escposDocs(docs, cajon = false) {
  const cols = columnasTicket();
  const b = [0x1B, 0x40, 0x1B, 0x74, 0x02];
  if (cajon) b.push(...ESC_CAJON);
  const lin = s => b.push(...bytesTexto(s), 0x0A);
  const centro = on => b.push(0x1B, 0x61, on ? 1 : 0);
  const negrita = on => b.push(0x1B, 0x45, on ? 1 : 0);
  for (const ops of docs) {
    for (const o of ops) {
      switch (o.k) {
        case 'logo':
          if (!IMP.logo) break;
          try { const r = await logoRaster(Number(IMP.ancho) === 58 ? 160 : 200); centro(true); b.push(...r, 0x0A); centro(false); } catch (e) { /* sin logo */ }
          break;
        case 'titulo':
          // letra doble de ancho y alto si cabe en un renglón; si no, solo doble de alto
          const ancho = String(o.s).length <= cols / 2;
          centro(true); negrita(true); b.push(0x1D, 0x21, ancho ? 0x11 : 0x01);
          partirTexto(o.s, ancho ? cols / 2 : cols).forEach(lin);
          b.push(0x1D, 0x21, 0x00); negrita(false); centro(false);
          break;
        case 'centro':
          centro(true); if (o.neg) negrita(true);
          partirTexto(o.s, cols).forEach(lin);
          if (o.neg) negrita(false); centro(false);
          break;
        case 'sep': lin('-'.repeat(cols)); break;
        case 'txt': partirTexto(o.s, cols).forEach(lin); break;
        case 'par': {
          if (o.neg) negrita(true);
          if (o.grande) b.push(0x1D, 0x21, 0x01);
          const a = String(o.a), d = String(o.b);
          if (a.length + d.length + 1 <= cols) lin(a + ' '.repeat(cols - a.length - d.length) + d);
          else { partirTexto(a, cols).forEach(lin); lin(' '.repeat(Math.max(0, cols - d.length)) + d); }
          if (o.grande) b.push(0x1D, 0x21, 0x00);
          if (o.neg) negrita(false);
          break;
        }
        case 'etq': centro(true); b.push(0x1D, 0x42, 1); lin(` ${o.s} `); b.push(0x1D, 0x42, 0); centro(false); break;
        case 'firma': b.push(0x0A, 0x0A, 0x0A); centro(true); lin('______________________'); lin(o.s); centro(false); break;
      }
    }
    b.push(0x1B, 0x64, 0x04, 0x1D, 0x56, 0x41, 0x03);
  }
  return new Uint8Array(b);
}

/* --- Conexiones directas --- */
const PRN = { usb: null, ble: null, bleCar: null };
const SERVICIOS_BLE = [0x18f0, 0xff00, 0xffe0, 0xfee7, 0xae30, 0xae00, 0xfff0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];
const MODOS_IMP = { sistema: 'Ventana de impresión', usb: 'USB directo', ble: 'Bluetooth directo', rawbt: 'App RawBT' };
const modoDirecto = () => IMP.modo && IMP.modo !== 'sistema';

async function puertoUSB(dev) {
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  for (const itf of dev.configuration.interfaces) {
    for (const alt of itf.alternates) {
      const ep = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
      if (ep) {
        if (!itf.claimed) await dev.claimInterface(itf.interfaceNumber);
        return ep.endpointNumber;
      }
    }
  }
  throw new Error('la impresora USB no tiene un canal de impresión compatible.');
}

async function enviarUSB(bytes) {
  if (!navigator.usb) throw new Error('este navegador no permite USB directo; usa Chrome.');
  let dev = PRN.usb;
  if (!dev) {
    const ds = await navigator.usb.getDevices();
    dev = ds.find(d => IMP.usb && d.vendorId === IMP.usb.vendorId && d.productId === IMP.usb.productId) || ds[0];
  }
  if (!dev) throw new Error('elige la impresora USB en ⚙ Impresora.');
  const ep = await puertoUSB(dev);
  for (let i = 0; i < bytes.length; i += 4096) await dev.transferOut(ep, bytes.slice(i, i + 4096));
  PRN.usb = dev;
}

async function caracteristicaBLE(dev) {
  const srv = await dev.gatt.connect();
  for (const s of await srv.getPrimaryServices()) {
    for (const c of await s.getCharacteristics()) {
      if (c.properties.writeWithoutResponse || c.properties.write) return c;
    }
  }
  throw new Error('la impresora Bluetooth no tiene un canal de impresión compatible.');
}

// Debe llamarse desde un clic (el navegador muestra la lista de dispositivos)
async function elegirBLE(soloGuardada = false) {
  if (!navigator.bluetooth) throw new Error('Este navegador no permite Bluetooth directo. Usa Chrome en Android.');
  const filtro = soloGuardada && IMP.ble && IMP.ble.nombre
    ? { filters: [{ name: IMP.ble.nombre }], optionalServices: SERVICIOS_BLE }
    : { acceptAllDevices: true, optionalServices: SERVICIOS_BLE };
  const dev = await navigator.bluetooth.requestDevice(filtro);
  PRN.bleCar = await caracteristicaBLE(dev);
  PRN.ble = dev;
  return { nombre: dev.name || 'Impresora Bluetooth' };
}

async function enviarBLE(bytes) {
  if (!PRN.ble && navigator.bluetooth && navigator.bluetooth.getDevices && IMP.ble) {
    const ds = await navigator.bluetooth.getDevices();
    PRN.ble = ds.find(d => d.name === IMP.ble.nombre) || null;
  }
  if (!PRN.ble) throw new Error('conecta la impresora con el botón "Conectar impresora" de la caja.');
  if (!PRN.bleCar || !PRN.ble.gatt.connected) PRN.bleCar = await caracteristicaBLE(PRN.ble);
  const c = PRN.bleCar;
  const sinResp = c.properties.writeWithoutResponse;
  const tam = sinResp ? 20 : 180;
  for (let i = 0; i < bytes.length; i += tam) {
    const parte = bytes.slice(i, i + tam);
    if (sinResp) await c.writeValueWithoutResponse(parte); else await c.writeValue(parte);
  }
}
const impresoraBLELista = () => !!(PRN.ble && PRN.ble.gatt && PRN.ble.gatt.connected);

// RawBT recibe el ticket ya armado y lo manda a la impresora que tenga configurada (Bluetooth, USB o red)
let abrirIntent = url => { location.href = url; };
function enviarRawBT(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  abrirIntent(`intent:base64,${btoa(bin)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`);
}

async function enviarDirecto(bytes) {
  if (IMP.modo === 'usb') return enviarUSB(bytes);
  if (IMP.modo === 'ble') return enviarBLE(bytes);
  if (IMP.modo === 'rawbt') return enviarRawBT(bytes);
  throw new Error('modo de impresión desconocido.');
}

// Imprime un doc: fabrica(i) devuelve los renglones de la copia i (0 = original)
async function imprimirDoc(fabrica, copias = 1, cajon = false) {
  copias = Math.max(1, Number(copias) || 1);
  if (!modoDirecto()) { imprimirHTML(i => htmlDoc(fabrica(i)), copias); return; }
  try {
    const docs = Array.from({ length: copias }, (_, i) => fabrica(i));
    await enviarDirecto(await escposDocs(docs, cajon && IMP.cajon));
  } catch (e) {
    toast(`No se pudo imprimir por ${MODOS_IMP[IMP.modo]}: ${e.message} Se abre la ventana de impresión.`, 'error');
    imprimirHTML(i => htmlDoc(fabrica(i)), copias);
  }
}

async function abrirCajon() {
  if (!modoDirecto() || !IMP.cajon) return;
  try { await enviarDirecto(new Uint8Array([0x1B, 0x40, ...ESC_CAJON])); } catch (e) { toast('No se pudo abrir el cajón: ' + e.message, 'error'); }
}

/* --- Documentos --- */
function docEncabezado(almacenId) {
  const a = S.idx.alm[almacenId] || {};
  return [{ k: 'logo' }, { k: 'titulo', s: CFG.NOMBRE },
    { k: 'centro', s: [a.nombre, a.direccion, a.telefono ? 'Tel. ' + a.telefono : ''].filter(Boolean).join('\n') }, { k: 'sep' }];
}

function docTicket(v, copia) {
  const pg = v.pagos || {};
  const o = copia ? [{ k: 'etq', s: 'COPIA' }] : [];
  o.push(...docEncabezado(v.almacen_id),
    { k: 'txt', s: `Ticket: ${ticketCorto(v.id)}${v.folio ? ' · ' + v.folio : ''}` }, { k: 'txt', s: fechaHora(v.fecha) },
    { k: 'txt', s: 'Atendió: ' + (v.cajero || S.usuario.nombre) }, { k: 'txt', s: 'Cliente: ' + (v.cliente || 'Público en general') }, { k: 'sep' });
  v.lineas.forEach(l => {
    const p = S.idx.prod[l.producto_id] || {};
    o.push({ k: 'txt', s: p.nombre || '' }, { k: 'par', a: `${numero(l.cantidad)} x ${dinero(l.precio)}`, b: dinero(l.cantidad * l.precio) });
  });
  o.push({ k: 'sep' }, { k: 'par', a: 'TOTAL', b: dinero(v.total), neg: true, grande: true });
  [['Efectivo', pg.efectivo], ['Tarjeta', pg.tarjeta], ['Transferencia', pg.transferencia], ['A crédito', pg.credito]]
    .forEach(([t, n]) => { if (Number(n) > 0) o.push({ k: 'par', a: t, b: dinero(n) }); });
  if (Number(pg.efectivo) > 0) o.push({ k: 'par', a: 'Recibido', b: dinero(v.recibido) }, { k: 'par', a: 'Cambio', b: dinero(v.cambio || 0) });
  if (Number(pg.credito) > 0) o.push({ k: 'firma', s: 'Firma del cliente' });
  if (v.cancelada) o.push({ k: 'sep' }, { k: 'centro', s: 'VENTA CANCELADA', neg: true });
  if (IMP.pie) o.push({ k: 'sep' }, { k: 'centro', s: IMP.pie });
  return o;
}

function imprimirTicket(v, copias = 1, cajon = false) {
  return imprimirDoc(i => docTicket(v, i > 0), copias, cajon);
}

function imprimirCorte(c) {
  const p = (a, n, neg) => ({ k: 'par', a, b: dinero(n), neg, grande: neg });
  return imprimirDoc(() => [...docEncabezado(c.almacen_id), { k: 'centro', s: 'CORTE DE CAJA', neg: true },
    { k: 'txt', s: 'Cajero: ' + (c.cajero || S.usuario.nombre) }, { k: 'txt', s: 'Apertura: ' + fechaHora(c.apertura) }, { k: 'txt', s: 'Cierre: ' + fechaHora(c.cierre) },
    { k: 'sep' }, { k: 'par', a: 'Ventas', b: String(c.ventas) }, p('Total vendido', c.total_ventas), p('Efectivo', c.efectivo), p('Tarjeta', c.tarjeta),
    p('Transferencia', c.transferencia), p('A crédito', c.credito), p('Abonos en efectivo', c.abonos_efectivo), p('Abonos otros medios', c.abonos_otros),
    { k: 'sep' }, p('Fondo inicial', c.fondo), p('Efectivo esperado', c.esperado), p('Efectivo contado', c.contado), p('Diferencia', c.diferencia, true),
    ...(c.notas ? [{ k: 'sep' }, { k: 'txt', s: 'Notas: ' + c.notas }] : []), { k: 'firma', s: 'Firma' }]);
}

function imprimirAbono(a, cajon = false) {
  return imprimirDoc(() => [...docEncabezado(a.almacen_id), { k: 'centro', s: 'COMPROBANTE DE ABONO', neg: true },
    { k: 'txt', s: fechaHora(a.fecha) }, { k: 'txt', s: 'Cliente: ' + a.cliente }, { k: 'txt', s: 'Recibió: ' + S.usuario.nombre }, { k: 'sep' },
    { k: 'par', a: 'Abono', b: dinero(a.monto), neg: true, grande: true }, { k: 'par', a: 'Forma de pago', b: METODOS_CAJA[a.metodo] || a.metodo },
    { k: 'par', a: 'Saldo restante', b: dinero(a.saldo_restante) }, { k: 'sep' }, { k: 'centro', s: '¡Gracias!' }], 1, cajon);
}

// Envía el ticket por correo (la venta debe estar ya en el servidor)
async function enviarCorreoTicket(v, email) {
  try {
    await api('enviarTicket', { venta_id: v.id, email, pie: IMP.pie });
    v.correoEnviado = email;
    delete v.correo;
    if (CJ.estado && CJ.estado.ventas.includes(v)) guardarCaja();
    toast(`Ticket enviado a ${email}.`, 'ok');
    return true;
  } catch (e) {
    toast(`No se pudo enviar el ticket a ${email}: ${e.message}`, 'error');
    return false;
  }
}

// Opciones de un ticket: imprimir, imprimir doble o enviar por correo
function dlgTicket(v) {
  const cli = clientePorId(v.cliente_id);
  const d = abrirModal(`Ticket ${v.folio || ticketCorto(v.id)}`, `
    <form id="ftk" class="form" autocomplete="off">
      <div class="cobro-total"><span>${fechaHora(v.fecha)}</span><b>${dinero(v.total)}</b><small>${esc(v.cliente || (cli ? cli.nombre : 'Público en general'))}</small></div>
      <div class="acciones grande"><button type="button" class="btn" data-copias="1">Imprimir ticket</button><button type="button" class="btn sec" data-copias="2">Imprimir doble</button></div>
      <label>Enviar por correo<input name="email" type="email" placeholder="correo@ejemplo.com" value="${esc(v.correoEnviado || (cli && cli.email) || '')}"></label>
      ${v.correoEnviado ? `<p class="nota">Ya se envió a ${esc(v.correoEnviado)}.</p>` : v.correo ? `<p class="nota">Pendiente de enviar a ${esc(v.correo)}.</p>` : ''}
      <p class="msg" id="ftk-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cerrar</button><button class="btn" type="submit">Enviar por correo</button></div>
    </form>`);
  const f = $('#ftk', d);
  $$('[data-copias]', d).forEach(b => { b.onclick = () => imprimirTicket(v, Number(b.dataset.copias)); });
  f.onsubmit = async ev => {
    ev.preventDefault();
    const email = f.email.value.trim().toLowerCase();
    const msg = $('#ftk-msg', d);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Escribe un correo válido.'; return; }
    if (v.sync === 'error') { msg.textContent = 'Esta venta fue rechazada por el servidor; no se puede enviar.'; return; }
    if (v.sync && v.sync !== 'enviada') {
      v.correo = email;
      guardarCaja();
      cerrarModal();
      toast(`El ticket se enviará a ${email} en cuanto la venta llegue al servidor.`, '');
      if (navigator.onLine) sincronizar();
      return;
    }
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para enviar el correo.'; return; }
    const ok = await conCarga('Enviando ticket…', () => enviarCorreoTicket(v, email));
    if (ok) cerrarModal();
  };
}

// Configuración de la impresora de tickets de este equipo
function dlgImpresora(alCerrar) {
  const sel = { usb: IMP.usb, ble: IMP.ble };
  const d = abrirModal('Impresora de tickets', `
    <form id="fimp" class="form">
      <p class="nota">Esta configuración se guarda en este equipo. Cada caja puede tener la suya.</p>
      <label>Cómo se conecta la impresora<select name="modo">
        <option value="sistema">Ventana de impresión (computadora o cualquier impresora)</option>
        <option value="usb">USB directo (tablet con hub o cable OTG)</option>
        <option value="ble">Bluetooth directo (impresoras Bluetooth BLE)</option>
        <option value="rawbt">App RawBT (Bluetooth clásico, USB o red)</option></select></label>
      <div class="imp-modo" data-m="usb">
        <p>Conecta la impresora al hub o cable de la tablet, enciéndela y elígela de la lista.</p>
        <div class="acciones"><button type="button" class="btn sec" id="imp-usb">Elegir impresora USB</button><span class="imp-dev" id="imp-usb-txt"></span></div>
      </div>
      <div class="imp-modo" data-m="ble">
        <p>Enciende la impresora y búscala. Si no aparece en la lista, tu impresora usa Bluetooth clásico: elige "App RawBT".</p>
        <div class="acciones"><button type="button" class="btn sec" id="imp-ble">Buscar impresora Bluetooth</button><span class="imp-dev" id="imp-ble-txt"></span></div>
        <p class="nota">Cada vez que se abre la app hay que tocar "Conectar impresora" en la caja; Android pide confirmarlo.</p>
      </div>
      <div class="imp-modo" data-m="rawbt">
        <ol class="pasos-imp">
          <li>Instala <a href="https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter" target="_blank" rel="noopener">RawBT</a> desde Play Store.</li>
          <li>En RawBT elige la conexión: Bluetooth, USB o red (escribe la IP de la impresora, puerto 9100). Imprime su página de prueba.</li>
          <li>Aquí presiona "Imprimir prueba". La primera vez Android pregunta con qué app abrir: elige RawBT y "Siempre".</li>
        </ol>
      </div>
      <div class="fila2">
        <label>Ancho del papel<select name="ancho"><option value="80">80 mm</option><option value="58">58 mm</option></select></label>
        <label>Al cobrar<select name="copias"><option value="0">No imprimir</option><option value="1">Imprimir ticket</option><option value="2">Imprimir ticket doble</option></select></label>
      </div>
      <label class="chk"><input type="checkbox" name="logo"> Imprimir el logo</label>
      <label>Mensaje al pie del ticket<input name="pie" maxlength="120"></label>
      <div class="imp-directo">
        <label class="chk"><input type="checkbox" name="cajon"> Abrir el cajón de dinero al cobrar en efectivo (cajón conectado a la impresora)</label>
        <label class="chk"><input type="checkbox" name="sinAcentos"> Quitar acentos (si la impresora imprime símbolos raros en lugar de á, é, ñ)</label>
      </div>
      <div class="acciones"><button type="button" class="btn sec" id="imp-prueba">Imprimir prueba</button><button type="button" class="btn sec imp-directo" id="imp-cajon">Probar cajón</button></div>
      <details class="ayuda imp-modo" data-m="sistema"><summary>¿Cómo imprimir directo desde una computadora, sin la ventana de impresión?</summary>
        <ol>
          <li>Conecta la impresora de tickets e instala su controlador.</li>
          <li>En Windows, ve a <b>Configuración &gt; Bluetooth y dispositivos &gt; Impresoras y escáneres</b>, elige la impresora de tickets y marca <b>Establecer como predeterminada</b>. Apaga "Permitir que Windows administre la impresora predeterminada".</li>
          <li>En el escritorio, clic derecho &gt; <b>Nuevo &gt; Acceso directo</b>, y pega:<br>
            <code id="imp-cmd">"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --app=${esc(location.href.split('#')[0])}</code>
            <button type="button" class="btn mini sec" id="imp-copiar">Copiar</button></li>
          <li>Llámalo "Caja" y ábrelo desde ahí. Chrome debe estar cerrado por completo antes de abrirlo (revisa que no quede en la bandeja junto al reloj).</li>
        </ol>
        <p class="nota">Así los tickets salen solos en la impresora predeterminada. Si usas Edge, cambia la ruta de Chrome por esta:</p>
        <code>"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"</code>
      </details>
      <p class="msg" id="fimp-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fimp', d), msg = $('#fimp-msg', d);
  f.modo.value = IMP.modo || 'sistema';
  f.ancho.value = String(IMP.ancho);
  f.copias.value = IMP.auto ? String(IMP.copias) : '0';
  f.logo.checked = IMP.logo;
  f.pie.value = IMP.pie;
  f.cajon.checked = !!IMP.cajon;
  f.sinAcentos.checked = !!IMP.sinAcentos;
  const pintar = () => {
    $$('.imp-modo', d).forEach(x => { x.hidden = x.dataset.m !== f.modo.value; });
    $$('.imp-directo', d).forEach(x => { x.hidden = f.modo.value === 'sistema'; });
    $('#imp-usb-txt', d).textContent = sel.usb ? 'Elegida: ' + sel.usb.nombre : 'Ninguna elegida';
    $('#imp-ble-txt', d).textContent = sel.ble ? (impresoraBLELista() ? 'Conectada: ' : 'Elegida: ') + sel.ble.nombre : 'Ninguna elegida';
  };
  pintar();
  f.modo.onchange = () => { msg.textContent = ''; pintar(); };
  const leer = () => {
    const c = Number(f.copias.value);
    return { modo: f.modo.value, ancho: Number(f.ancho.value), auto: c > 0, copias: c > 0 ? c : IMP.copias, logo: f.logo.checked, pie: f.pie.value.trim(),
      cajon: f.cajon.checked, sinAcentos: f.sinAcentos.checked, usb: sel.usb, ble: sel.ble };
  };
  $('#imp-usb', d).onclick = async () => {
    msg.textContent = '';
    if (!navigator.usb) { msg.textContent = 'Este navegador no permite USB directo. Usa Chrome en la tablet o computadora.'; return; }
    try {
      const dev = await navigator.usb.requestDevice({ filters: [] });
      sel.usb = { vendorId: dev.vendorId, productId: dev.productId, nombre: dev.productName || dev.manufacturerName || 'Impresora USB' };
      PRN.usb = dev;
      pintar();
    } catch (e) { if (e.name !== 'NotFoundError') msg.textContent = 'No se pudo usar la impresora USB: ' + e.message; }
  };
  $('#imp-ble', d).onclick = async () => {
    msg.textContent = '';
    try { sel.ble = await elegirBLE(); pintar(); } catch (e) { if (e.name !== 'NotFoundError') msg.textContent = 'No se pudo conectar: ' + e.message; }
  };
  const conPrueba = async fn => {
    const antes = Object.assign({}, IMP);
    Object.assign(IMP, leer());
    try { await fn(); } finally { Object.assign(IMP, antes); }
  };
  $('#imp-prueba', d).onclick = () => conPrueba(() => {
    const p = S.catalogo.productos.find(x => esActivo(x.activo)) || { id: '', nombre: 'Producto de prueba' };
    if (!p.id) S.idx.prod[''] = p;
    return imprimirTicket({ id: 'PRUEBA', folio: 'PRUEBA', fecha: new Date().toISOString(), almacen_id: S.usuario.almacen_id, cliente: 'Público en general',
      lineas: [{ producto_id: p.id, cantidad: 2, precio: 10 }], total: 20, pagos: { efectivo: 20 }, recibido: 50, cambio: 30 }, Math.max(1, Number(f.copias.value)));
  });
  $('#imp-cajon', d).onclick = () => conPrueba(() => { IMP.cajon = true; return abrirCajon(); });
  $('#imp-copiar', d).onclick = async () => {
    try { await navigator.clipboard.writeText($('#imp-cmd', d).textContent); toast('Copiado.', 'ok'); } catch (e) { toast('Selecciona el texto y cópialo con Ctrl+C.', ''); }
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const n = leer();
    if (n.modo === 'usb' && !n.usb) { msg.textContent = 'Elige la impresora USB.'; return; }
    if (n.modo === 'ble' && !n.ble) { msg.textContent = 'Busca y elige la impresora Bluetooth.'; return; }
    Object.assign(IMP, n);
    await DB.set('impresora', Object.assign({}, IMP));
    cerrarModal();
    toast('Impresora configurada en este equipo.', 'ok');
    if (typeof alCerrar === 'function') alCerrar();
  };
}

/* ---------- Ventas del turno, abonos y corte ---------- */
function dlgVentasTurno(alCerrar) {
  const E = CJ.estado;
  const vs = E.ventas.slice().reverse();
  const tot = vs.filter(v => !v.cancelada).reduce((s, v) => s + Number(v.total), 0);
  const d = abrirModal('Ventas del turno', `
    <div class="form">
      <p><b>${plural(vs.filter(v => !v.cancelada).length, 'venta')}</b> · ${dinero(tot)}</p>
      ${vs.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Ticket</th><th>Hora</th><th>Cliente</th><th class="num">Total</th><th>Pago</th><th>Estado</th><th></th></tr></thead>
        <tbody>${vs.map(v => {
          const pg = v.pagos;
          const formas = [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transf.'], ['credito', 'Crédito']].filter(([k]) => Number(pg[k]) > 0).map(x => x[1]).join(' + ');
          const est = v.cancelada ? chipEstado('CANCELADA') : v.sync === 'error' ? '<span class="est est-ATRASADA">Error</span>' : v.sync === 'enviada' ? '<span class="est est-RECIBIDA">Enviada</span>' : '<span class="est est-BORRADOR">Por enviar</span>';
          return `<tr><td><b>${ticketCorto(v.id)}</b>${v.folio ? `<small>${esc(v.folio)}</small>` : ''}</td><td>${new Date(v.fecha).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(v.cliente)}</td><td class="num">${dinero(v.total)}</td><td>${formas}</td><td>${est}${v.error ? `<small class="txt-error">${esc(v.error)}</small>` : ''}${v.aviso ? `<small>${esc(v.aviso)}</small>` : ''}</td>
            <td class="acciones"><button type="button" class="btn mini sec" data-reimp="${esc(v.id)}">Ticket</button>
            ${esAdminCaja() && !v.cancelada ? `<button type="button" class="btn mini peligro" data-canc="${esc(v.id)}">Cancelar</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="vacio">Aún no hay ventas en este turno.</p>'}
    </div>`, true);
  d.onclick = async e => {
    const r = e.target.closest('[data-reimp]');
    const c = e.target.closest('[data-canc]');
    if (r) dlgTicket(E.ventas.find(v => v.id === r.dataset.reimp));
    if (c) {
      const v = E.ventas.find(x => x.id === c.dataset.canc);
      if (v.sync !== 'enviada') { toast('Primero debe enviarse al servidor (necesita conexión).', 'error'); return; }
      const motivo = prompt('Motivo de la cancelación:');
      if (!motivo) return;
      try {
        await conCarga('Cancelando…', () => api('cancelarVenta', { id: v.id, motivo }));
        v.cancelada = new Date().toISOString();
        if (Number(v.pagos.credito) > 0) { const cli = clientePorId(v.cliente_id); if (cli) cli.saldo = Math.max(0, Number(cli.saldo) - Number(v.pagos.credito)); }
        await guardarCaja();
        toast('Venta cancelada. La mercancía regresó al inventario.', 'ok');
        sincronizar();
        dlgVentasTurno(alCerrar);
      } catch (err) { toast(err.message, 'error'); }
    }
  };
  d.addEventListener('close', () => alCerrar && alCerrar(), { once: true });
}

function dlgAbono(clienteId, alTerminar) {
  const E = CJ.estado;
  const conSaldo = (S.clientes || []).filter(c => Number(c.saldo) > 0.005).sort(porNombre);
  if (!conSaldo.length) { toast('Ningún cliente tiene saldo pendiente.', ''); return; }
  const d = abrirModal('Cobrar abono', `
    <form id="fab" class="form">
      <label>Cliente<select name="cliente_id">${conSaldo.map(c => `<option value="${esc(c.id)}" ${c.id === clienteId ? 'selected' : ''}>${esc(c.nombre)} — saldo ${dinero(c.saldo)}</option>`).join('')}</select></label>
      <div class="fila3"><label>Monto<input name="monto" type="number" step="0.01" min="0.01" required inputmode="decimal"></label>
        <label>Forma de pago<select name="metodo">${Object.entries(METODOS_CAJA).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
        <label>Referencia<input name="referencia"></label></div>
      <label class="chk"><input type="checkbox" name="imprimir" ${IMP.auto ? 'checked' : ''}> Imprimir comprobante</label>
      <p class="msg" id="fab-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Registrar abono</button></div>
    </form>`);
  const f = $('#fab', d);
  const ponerSaldo = () => { f.monto.value = Number(clientePorId(f.cliente_id.value).saldo).toFixed(2); };
  ponerSaldo();
  f.cliente_id.onchange = ponerSaldo;
  f.onsubmit = async ev => {
    ev.preventDefault();
    const cli = clientePorId(f.cliente_id.value);
    const monto = Math.round(Number(f.monto.value) * 100) / 100;
    if (!(monto > 0) || monto > Number(cli.saldo) + 0.01) { $('#fab-msg', d).textContent = `El abono debe ser entre $0.01 y ${dinero(cli.saldo)}.`; return; }
    const op = { clase: 'ABONO', id: uuid(), cliente_id: cli.id, monto, metodo: f.metodo.value, referencia: f.referencia.value.trim(),
      corte_id: E.corte ? E.corte.id : '', almacen_id: E.corte ? E.corte.almacen_id : (S.usuario.almacen_id || '') };
    cli.saldo = Math.max(0, Math.round((Number(cli.saldo) - monto) * 100) / 100);
    DB.set('clientes', S.clientes);
    const local = Object.assign({}, op, { fecha: new Date().toISOString(), cliente: cli.nombre, saldo_restante: cli.saldo });
    if (E.corte) E.abonos.push(local);
    await guardarCaja();
    await encolarCaja(op);
    cerrarModal();
    toast(`Abono registrado. Saldo de ${cli.nombre}: ${dinero(cli.saldo)}`, 'ok');
    if (f.imprimir.checked) imprimirAbono(local, local.metodo === 'EFECTIVO');
    else if (local.metodo === 'EFECTIVO') abrirCajon();
    if (alTerminar) alTerminar();
  };
}

function resumenCorteLocal() {
  const E = CJ.estado;
  const vs = E.ventas.filter(v => !v.cancelada);
  const s = (lista, f) => Math.round(lista.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;
  const r = {
    almacen_id: E.corte.almacen_id, apertura: E.corte.apertura, fondo: Number(E.corte.fondo) || 0, ventas: vs.length,
    total_ventas: s(vs, v => v.total), efectivo: s(vs, v => v.pagos.efectivo), tarjeta: s(vs, v => v.pagos.tarjeta),
    transferencia: s(vs, v => v.pagos.transferencia), credito: s(vs, v => v.pagos.credito),
    abonos_efectivo: s(E.abonos.filter(a => a.metodo === 'EFECTIVO'), a => a.monto), abonos_otros: s(E.abonos.filter(a => a.metodo !== 'EFECTIVO'), a => a.monto)
  };
  r.esperado = Math.round((r.fondo + r.efectivo + r.abonos_efectivo) * 100) / 100;
  return r;
}

function dlgCerrarCaja(alTerminar) {
  const r = resumenCorteLocal();
  const fila = (t, n) => `<span>${t}</span><span>${dinero(n)}</span>`;
  const d = abrirModal('Cerrar caja (corte)', `
    <form id="fcorte" class="form">
      <div class="corte-res">
        <span>Ventas</span><span>${r.ventas}</span>${fila('Total vendido', r.total_ventas)}${fila('Efectivo', r.efectivo)}${fila('Tarjeta', r.tarjeta)}
        ${fila('Transferencia', r.transferencia)}${fila('A crédito', r.credito)}${fila('Abonos en efectivo', r.abonos_efectivo)}${fila('Abonos otros medios', r.abonos_otros)}
        ${fila('Fondo inicial', r.fondo)}<b>Efectivo esperado en caja</b><b>${dinero(r.esperado)}</b>
      </div>
      <label>Efectivo contado<input name="contado" type="number" step="0.01" min="0" required inputmode="decimal"></label>
      <p id="fc-dif" class="cobro-res"></p>
      <label>Notas<input name="notas" placeholder="Retiros, faltantes, observaciones"></label>
      <label class="chk"><input type="checkbox" name="imprimir" ${IMP.auto ? 'checked' : ''}> Imprimir corte</label>
      ${misPendientes().filter(o => o.clase && o.estado === 'pendiente').length ? '<p class="aviso-offline">Hay operaciones por enviar. El corte se enviará después de ellas, en orden.</p>' : ''}
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Regresar</button><button class="btn" type="submit">Cerrar caja</button></div>
    </form>`);
  const f = $('#fcorte', d);
  f.contado.focus();
  f.contado.oninput = () => {
    const dif = Math.round(((Number(f.contado.value) || 0) - r.esperado) * 100) / 100;
    $('#fc-dif', d).innerHTML = `<span>Diferencia</span><b class="${dif === 0 ? 'cambio' : 'txt-error'}">${dif > 0 ? 'Sobran ' : dif < 0 ? 'Faltan ' : ''}${dinero(Math.abs(dif))}</b>`;
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const E = CJ.estado;
    const contado = Math.round(Number(f.contado.value) * 100) / 100;
    const op = { clase: 'CORTE_CERRAR', id: uuid(), corte_id: E.corte.id, contado, notas: f.notas.value.trim() };
    const corte = Object.assign({}, r, { contado, diferencia: Math.round((contado - r.esperado) * 100) / 100, cierre: new Date().toISOString(), notas: op.notas, cajero: S.usuario.nombre });
    await encolarCaja(op);
    E.ultimoCorte = corte;
    E.corte = null;
    E.ventas = [];
    E.abonos = [];
    await guardarCaja();
    cerrarModal();
    toast('Caja cerrada.', 'ok');
    if (f.imprimir.checked) imprimirCorte(corte);
    alTerminar();
  };
}

function dlgRechazadasCaja(alCerrar) {
  const l = misPendientes().filter(o => o.clase && o.estado === 'rechazado');
  const nombre = { VENTA: 'Venta', ABONO: 'Abono', CORTE_ABRIR: 'Apertura de caja', CORTE_CERRAR: 'Cierre de caja' };
  const d = abrirModal('Operaciones rechazadas', `
    <p class="nota">El servidor no aceptó estas operaciones. Revisa el motivo; puedes reintentarlas (por ejemplo, después de corregir un dato) o descartarlas.</p>
    <ul class="lista">${l.map(o => `<li><div><b>${nombre[o.clase]}</b> · ${fechaHora(o.fecha)}${o.clase === 'VENTA' ? ' · ' + dinero(o.lineas.reduce((s, x) => s + x.cantidad * x.precio, 0)) : ''}
      <small class="txt-error">${esc(o.error)}</small></div><span class="acciones"><button type="button" class="btn mini sec" data-reint="${esc(o.id)}">Reintentar</button>
      <button type="button" class="btn mini peligro" data-desc="${esc(o.id)}">Descartar</button></span></li>`).join('')}</ul>`);
  d.onclick = async e => {
    const re = e.target.closest('[data-reint]'), de = e.target.closest('[data-desc]');
    if (re) {
      const o = S.outbox.find(x => x.id === re.dataset.reint && x.clase);
      o.estado = 'pendiente'; delete o.error;
      await DB.guardarMov(o);
      cerrarModal();
      sincronizar(true);
    }
    if (de && confirm('¿Descartar esta operación? No llegará al servidor.')) {
      const o = S.outbox.find(x => x.id === de.dataset.desc && x.clase);
      S.outbox = S.outbox.filter(x => x !== o);
      await DB.borrarMov(o.id);
      cerrarModal();
      actualizarBarra();
    }
  };
  d.addEventListener('close', () => alCerrar && alCerrar(), { once: true });
}

/* ---------- Ventas, cortes, clientes y por cobrar (administradores) ---------- */
const VT = { pestana: 'ventas', desde: '', hasta: '', alm: '', ventas: null, cortes: null, cli: null, q: '' };

function vVentas(el) {
  if (!VT.desde) { VT.desde = hoyLocal(); VT.hasta = hoyLocal(); }
  el.innerHTML = `<div class="titulo"><h2>Ventas y clientes</h2></div>
    <div class="segmentos" id="vt-tabs">${[['ventas', 'Ventas'], ['cortes', 'Cortes de caja'], ['clientes', 'Clientes'], ['cobrar', 'Por cobrar']]
      .map(([k, t]) => `<button type="button" data-t="${k}" class="${VT.pestana === k ? 'activo' : ''}">${t}</button>`).join('')}</div>
    <div id="vt-cuerpo"></div>`;
  const c = $('#vt-cuerpo', el);
  const pintar = () => ({ ventas: pintarVentasRep, cortes: pintarCortes, clientes: pintarClientes, cobrar: pintarCobrar })[VT.pestana](c);
  $('#vt-tabs', el).onclick = e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    VT.pestana = b.dataset.t;
    $$('#vt-tabs button', el).forEach(x => x.classList.toggle('activo', x === b));
    pintar();
  };
  VT.repintar = pintar;
  S.refrescar = null;
  pintar();
}

async function pedir(c, texto, fn) {
  if (!navigator.onLine) { c.innerHTML = '<p class="aviso-offline">Esta sección necesita conexión.</p>'; return null; }
  try { return await conCarga(texto, fn); } catch (e) {
    c.innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
    if (e.sesion) sesionVencida(e.message);
    return null;
  }
}

async function pintarVentasRep(c) {
  const alms = esGeneral() ? S.catalogo.almacenes.slice().sort(porNombre) : [];
  c.innerHTML = `<div class="filtros">
      <label class="chk">Desde <input type="date" id="vt-desde" value="${VT.desde}"></label>
      <label class="chk">Hasta <input type="date" id="vt-hasta" value="${VT.hasta}"></label>
      ${alms.length ? `<select id="vt-alm"><option value="">Todas las sucursales</option>${alms.map(a => `<option value="${esc(a.id)}" ${VT.alm === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select>` : ''}
      <button type="button" class="btn sec" id="vt-buscar">Consultar</button><button type="button" class="btn sec" id="vt-xls">Exportar a Excel</button>
    </div><div id="vt-res" class="tarjetas"></div><div id="vt-lista"></div>`;
  const cargar = async () => {
    VT.desde = $('#vt-desde', c).value; VT.hasta = $('#vt-hasta', c).value; VT.alm = ($('#vt-alm', c) || {}).value || '';
    const r = await pedir($('#vt-lista', c), 'Consultando ventas…', () => api('ventas', { desde: VT.desde, hasta: VT.hasta, almacen_id: VT.alm }));
    if (!r) return;
    VT.ventas = r;
    mostrar();
  };
  const mostrar = () => {
    const vs = VT.ventas || [];
    const ok = vs.filter(v => !v.cancelada);
    const s = k => ok.reduce((t, v) => t + (Number(v[k]) || 0), 0);
    $('#vt-res', c).innerHTML = `<div class="tarjeta"><span>Ventas</span><b>${ok.length}</b><small>${plural(vs.length - ok.length, 'cancelada')}</small></div>
      <div class="tarjeta"><span>Total vendido</span><b>${dinero(s('total'))}</b></div>
      <div class="tarjeta"><span>Utilidad bruta</span><b>${dinero(s('total') - s('costo_total'))}</b><small>${s('total') ? Math.round((1 - s('costo_total') / s('total')) * 1000) / 10 : 0}% sobre venta</small></div>
      <div class="tarjeta"><span>Efectivo / Tarjeta</span><b>${dinero(s('efectivo'))}</b><small>${dinero(s('tarjeta'))} tarjeta</small></div>
      <div class="tarjeta"><span>Transferencia / Crédito</span><b>${dinero(s('transferencia'))}</b><small>${dinero(s('credito'))} a crédito</small></div>`;
    $('#vt-lista', c).innerHTML = vs.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Folio</th><th>Fecha</th><th>Sucursal</th><th>Cajero</th><th>Cliente</th><th class="num">Total</th><th>Estado</th></tr></thead>
      <tbody>${vs.slice().reverse().map(v => `<tr class="clic ${v.cancelada ? 'inactivo' : ''}" data-v="${esc(v.id)}"><td><b>${esc(v.folio)}</b><small>${ticketCorto(v.id)}</small></td><td>${fechaHora(v.fecha)}</td>
        <td>${esc((S.idx.alm[v.almacen_id] || {}).nombre || '')}</td><td>${esc(v.cajero)}</td><td>${esc(clienteNombre(v.cliente_id))}</td><td class="num">${dinero(v.total)}</td>
        <td>${v.cancelada ? chipEstado('CANCELADA') : v.estado === 'CREDITO' ? '<span class="est est-PARCIAL">Crédito</span>' : '<span class="est est-RECIBIDA">Pagada</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="vacio">Sin ventas en ese periodo.</p>';
  };
  $('#vt-buscar', c).onclick = cargar;
  $('#vt-xls', c).onclick = () => exportarVentas();
  $('#vt-lista', c).onclick = e => {
    const tr = e.target.closest('[data-v]');
    if (tr) dlgVentaDetalle(VT.ventas.find(v => v.id === tr.dataset.v), () => cargar());
  };
  if (VT.ventas) mostrar(); else cargar();
}

const clienteNombre = id => (id ? ((VT.cli && VT.cli.clientes.find(c => c.id === id)) || clientePorId(id) || {}).nombre || 'Cliente' : 'Público en general');

function dlgVentaDetalle(v, alCambiar) {
  const d = abrirModal(`Venta ${v.folio}`, `<div class="form">
    <div class="titulo"><span>${v.cancelada ? chipEstado('CANCELADA') : ''} ${fechaHora(v.fecha)} · ${esc(v.cajero)}</span><b>${dinero(v.total)}</b></div>
    <p>Cliente: <b>${esc(clienteNombre(v.cliente_id))}</b> · Sucursal: ${esc((S.idx.alm[v.almacen_id] || {}).nombre || '')}</p>
    <div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th><th class="num">Costo</th></tr></thead>
      <tbody>${v.lineas.map(l => `<tr><td>${esc((S.idx.prod[l.producto_id] || {}).nombre || '')}</td><td class="num">${numero(l.cantidad)}</td><td class="num">${dinero(l.precio)}</td>
        <td class="num">${dinero(l.importe)}</td><td class="num">${dinero(Number(l.costo) * Number(l.cantidad))}</td></tr>`).join('')}</tbody></table></div>
    <p>Pagos: ${[['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia'], ['credito', 'Crédito']].filter(([k]) => Number(v[k]) > 0).map(([k, t]) => `${t} ${dinero(v[k])}`).join(' · ')}</p>
    ${v.notas ? `<p class="nota">${esc(v.notas)}</p>` : ''}${v.cancelo ? `<p class="txt-error">Cancelada: ${esc(v.cancelo)}</p>` : ''}
    <div class="acciones"><button type="button" class="btn sec" id="vd-imp">Imprimir o enviar ticket</button>${v.cancelada ? '' : '<button type="button" class="btn peligro" id="vd-canc">Cancelar venta</button>'}</div></div>`, true);
  $('#vd-imp', d).onclick = () => dlgTicket({ id: v.id, folio: v.folio, fecha: v.fecha, almacen_id: v.almacen_id, cliente: clienteNombre(v.cliente_id), cliente_id: v.cliente_id, cajero: v.cajero,
    lineas: v.lineas, total: v.total, pagos: { efectivo: v.efectivo, tarjeta: v.tarjeta, transferencia: v.transferencia, credito: v.credito },
    recibido: v.recibido, cambio: v.cambio, cancelada: v.cancelada });
  const cb = $('#vd-canc', d);
  if (cb) cb.onclick = async () => {
    const motivo = prompt('Motivo de la cancelación:');
    if (!motivo) return;
    try {
      await conCarga('Cancelando…', () => api('cancelarVenta', { id: v.id, motivo }));
      toast(`Venta ${v.folio} cancelada.`, 'ok');
      cerrarModal();
      sincronizar();
      alCambiar();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function exportarVentas() {
  const vs = VT.ventas || [];
  if (!vs.length) { toast('Primero consulta un periodo con ventas.', ''); return; }
  const n = x => Math.round((Number(x) || 0) * 100) / 100;
  const filas = [['Folio', 'Ticket', 'Fecha', 'Sucursal', 'Cajero', 'Cliente', 'Total', 'Costo', 'Utilidad', 'Efectivo', 'Tarjeta', 'Transferencia', 'Crédito', 'Estado']]
    .concat(vs.map(v => [v.folio, ticketCorto(v.id), fechaHora(v.fecha), (S.idx.alm[v.almacen_id] || {}).nombre || '', v.cajero, clienteNombre(v.cliente_id),
      n(v.total), n(v.costo_total), n(v.total - v.costo_total), n(v.efectivo), n(v.tarjeta), n(v.transferencia), n(v.credito), v.cancelada ? 'Cancelada' : v.estado === 'CREDITO' ? 'Crédito' : 'Pagada']));
  const det = [['Folio', 'Fecha', 'Código', 'Producto', 'Cantidad', 'Precio', 'Importe', 'Costo unitario']];
  vs.filter(v => !v.cancelada).forEach(v => v.lineas.forEach(l => {
    const p = S.idx.prod[l.producto_id] || {};
    det.push([v.folio, fechaHora(v.fecha), p.codigo || '', p.nombre || '', Number(l.cantidad), n(l.precio), n(l.importe), n(l.costo)]);
  }));
  Excel.descargar(Excel.crearXlsx([
    { nombre: 'Ventas', filas, encabezado: true, anchos: [11, 10, 16, 18, 16, 24, 11, 11, 11, 11, 11, 13, 11, 10] },
    { nombre: 'Detalle', filas: det, encabezado: true, anchos: [11, 16, 10, 30, 9, 10, 11, 12], columnasTexto: [2] }
  ]), `ventas-${VT.desde}-a-${VT.hasta}.xlsx`);
}

async function pintarCortes(c) {
  c.innerHTML = '<div id="ct-lista"></div>';
  const r = await pedir(c, 'Consultando cortes…', () => api('cortes', {}));
  if (!r) return;
  VT.cortes = r;
  c.innerHTML = r.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Apertura</th><th>Cierre</th><th>Sucursal</th><th>Cajero</th><th class="num">Ventas</th>
    <th class="num">Total</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th><th></th></tr></thead>
    <tbody>${r.map(k => `<tr><td>${fechaHora(k.apertura)}</td><td>${k.estado === 'CERRADO' ? fechaHora(k.cierre) : '<span class="est est-ENVIADA">Abierta</span>'}</td>
      <td>${esc((S.idx.alm[k.almacen_id] || {}).nombre || '')}</td><td>${esc(k.cajero)}</td><td class="num">${k.estado === 'CERRADO' ? k.ventas : ''}</td>
      <td class="num">${k.estado === 'CERRADO' ? dinero(k.total_ventas) : ''}</td><td class="num">${k.estado === 'CERRADO' ? dinero(k.esperado) : ''}</td>
      <td class="num">${k.estado === 'CERRADO' ? dinero(k.contado) : ''}</td><td class="num ${Number(k.diferencia) ? 'txt-error' : ''}">${k.estado === 'CERRADO' ? dinero(k.diferencia) : ''}</td>
      <td>${k.estado === 'CERRADO' ? `<button type="button" class="btn mini sec" data-imp="${esc(k.id)}">Imprimir</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="nota">Cortes de los últimos 31 días.</p>` : '<p class="vacio">Sin cortes de caja.</p>';
  c.onclick = e => {
    const b = e.target.closest('[data-imp]');
    if (b) imprimirCorte(VT.cortes.find(k => k.id === b.dataset.imp));
  };
}

async function cargarClientesAdm(c) {
  const r = await pedir(c, 'Cargando clientes…', () => api('clientes'));
  if (r) VT.cli = r;
  return r;
}

async function pintarClientes(c) {
  if (!VT.cli && !(await cargarClientesAdm(c))) return;
  const D = VT.cli;
  const q = normal(VT.q);
  const l = D.clientes.filter(x => !q || normal(x.nombre + ' ' + (x.telefono || '') + ' ' + (x.rfc || '')).includes(q)).sort(porNombre);
  c.innerHTML = `<div class="filtros"><input id="cl-q" type="search" placeholder="Buscar cliente" value="${esc(VT.q)}"><button type="button" class="btn" id="cl-nuevo">Nuevo cliente</button></div>
    ${l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Cliente</th><th>Tipo</th><th>Teléfono</th><th>Crédito</th><th class="num">Saldo</th><th class="num">Vencido</th></tr></thead>
      <tbody>${l.map(x => `<tr class="clic ${x.activo ? '' : 'inactivo'}" data-cl="${esc(x.id)}"><td><b>${esc(x.nombre)}</b>${x.rfc ? `<small>${esc(x.rfc)}</small>` : ''}</td>
        <td>${x.tipo === 'MAYOREO' ? 'Mayoreo' : 'Menudeo'}</td><td>${esc(x.telefono || '—')}</td>
        <td>${x.credito ? `${dinero(x.limite_credito)} · ${x.dias_credito} días` : '—'}</td><td class="num">${dinero(x.saldo)}</td>
        <td class="num ${x.vencido > 0 ? 'txt-error' : ''}">${dinero(x.vencido)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="vacio">Sin clientes.</p>'}`;
  const qi = $('#cl-q', c);
  qi.oninput = () => { VT.q = qi.value; const p = qi.selectionStart; pintarClientes(c).then(() => { const n = $('#cl-q', c); n.focus(); n.setSelectionRange(p, p); }); };
  $('#cl-nuevo', c).onclick = () => dlgCliente(null, () => pintarClientes(c));
  c.onclick = e => {
    const tr = e.target.closest('[data-cl]');
    if (tr) dlgCliente(D.clientes.find(x => x.id === tr.dataset.cl), () => pintarClientes(c));
  };
}

function dlgCliente(cl, alGuardar) {
  const nuevo = !cl;
  cl = cl || { tipo: 'MENUDEO', credito: false, activo: true, limite_credito: 0, dias_credito: 15 };
  const precios = nuevo ? [] : VT.cli.precios.filter(p => p.cliente_id === cl.id);
  const d = abrirModal(nuevo ? 'Nuevo cliente' : cl.nombre, `
    <form id="fcl" class="form">
      <div class="fila2"><label>Nombre<input name="nombre" required value="${esc(cl.nombre || '')}"></label>
        <label>Tipo de precio<select name="tipo"><option value="MENUDEO" ${cl.tipo !== 'MAYOREO' ? 'selected' : ''}>Menudeo</option><option value="MAYOREO" ${cl.tipo === 'MAYOREO' ? 'selected' : ''}>Mayoreo</option></select></label></div>
      <div class="fila3"><label>Teléfono<input name="telefono" type="tel" value="${esc(cl.telefono || '')}"></label>
        <label>Correo<input name="email" type="email" value="${esc(cl.email || '')}"></label><label>RFC<input name="rfc" value="${esc(cl.rfc || '')}"></label></div>
      <label>Dirección<input name="direccion" value="${esc(cl.direccion || '')}"></label>
      <label class="chk"><input type="checkbox" name="credito" ${cl.credito ? 'checked' : ''}> Tiene crédito autorizado</label>
      <div class="fila2" id="cl-cred"><label>Límite de crédito<input name="limite_credito" type="number" step="0.01" min="0" value="${cl.limite_credito || 0}"></label>
        <label>Días para pagar<input name="dias_credito" type="number" step="1" min="0" value="${cl.dias_credito || 0}"></label></div>
      <div class="fila2"><label>Notas<input name="notas" value="${esc(cl.notas || '')}"></label><label class="chk"><input type="checkbox" name="activo" ${cl.activo !== false ? 'checked' : ''}> Activo</label></div>
      <p class="msg" id="fcl-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>
    ${nuevo ? '<p class="nota">Después de guardarlo podrás asignarle precios especiales.</p>' : `<div class="panel-sub"><b>Precios especiales</b>
      <p class="nota">Tienen prioridad sobre el precio de menudeo y mayoreo para este cliente.</p>
      <div id="pe-sel"></div><div class="fila-form"><input id="pe-precio" type="number" step="0.01" min="0" placeholder="Precio especial"><button type="button" class="btn sec" id="pe-add">Asignar</button></div>
      <ul class="lista" id="pe-lista"></ul></div>`}`, true);
  const f = $('#fcl', d);
  const cred = () => { $('#cl-cred', d).hidden = !f.credito.checked; };
  cred();
  f.credito.onchange = cred;
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      const r = await conCarga('Guardando…', () => api('guardarCliente', { cliente: {
        id: cl.id || uuid(), nuevo, nombre: f.nombre.value.trim(), tipo: f.tipo.value, telefono: f.telefono.value.trim(), email: f.email.value.trim(),
        rfc: f.rfc.value.trim(), direccion: f.direccion.value.trim(), credito: f.credito.checked, limite_credito: f.limite_credito.value,
        dias_credito: f.dias_credito.value, notas: f.notas.value.trim(), activo: f.activo.checked
      } }));
      upsert(VT.cli.clientes, r);
      upsert(S.clientes = S.clientes || [], r);
      DB.set('clientes', S.clientes);
      cerrarModal();
      toast('Cliente guardado.', 'ok');
      alGuardar();
    } catch (e) { $('#fcl-msg', d).textContent = e.message; }
  };
  if (nuevo) return;
  const pintarPE = () => {
    $('#pe-lista', d).innerHTML = precios.length ? precios.map(p => {
      const pr = S.idx.prod[p.producto_id] || {};
      return `<li><span>${esc(pr.nombre || '—')} <small>Menudeo ${dinero(pr.precio_menudeo)} · Mayoreo ${dinero(pr.precio_mayoreo)}</small></span>
        <span class="acciones"><b>${dinero(p.precio)}</b><button type="button" class="btn mini peligro" data-qpe="${esc(p.producto_id)}">Quitar</button></span></li>`;
    }).join('') : '<li class="nota">Sin precios especiales.</li>';
  };
  pintarPE();
  const sel = selectorProducto($('#pe-sel', d), p => { if (p) $('#pe-precio', d).focus(); });
  const guardarPE = async (productoId, precio) => {
    try {
      const r = await conCarga('Guardando…', () => api('guardarPrecioEspecial', { cliente_id: cl.id, producto_id: productoId, precio }));
      VT.cli.precios = VT.cli.precios.filter(p => p.cliente_id !== cl.id).concat(r);
      precios.length = 0; r.forEach(x => precios.push(x));
      S.precios = (S.precios || []).filter(p => p.cliente_id !== cl.id).concat(r);
      DB.set('precios', S.precios);
      pintarPE();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#pe-add', d).onclick = () => {
    const p = sel.elegido, precio = $('#pe-precio', d).value;
    if (!p || precio === '') { toast('Elige un producto y escribe el precio.', 'error'); return; }
    guardarPE(p.id, precio).then(() => { sel.limpiar(); $('#pe-precio', d).value = ''; });
  };
  $('#pe-lista', d).onclick = e => {
    const b = e.target.closest('[data-qpe]');
    if (b) guardarPE(b.dataset.qpe, '');
  };
}

async function pintarCobrar(c) {
  if (!(await cargarClientesAdm(c))) return;
  const D = VT.cli, hoy = hoyLocal();
  const abiertas = D.cuentas.filter(x => Number(x.saldo) > 0.005 && x.estado !== 'CANCELADA')
    .sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
  const tot = abiertas.reduce((s, x) => s + Number(x.saldo), 0);
  const venc = abiertas.filter(x => String(x.vence) < hoy).reduce((s, x) => s + Number(x.saldo), 0);
  c.innerHTML = `<div class="tarjetas"><div class="tarjeta"><span>Por cobrar</span><b>${dinero(tot)}</b><small>${plural(abiertas.length, 'cuenta')}</small></div>
      <div class="tarjeta ${venc ? 'alerta-roja' : ''}"><span>Vencido</span><b>${dinero(venc)}</b></div></div>
    ${abiertas.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Cliente</th><th>Venta</th><th>Fecha</th><th>Vence</th><th class="num">Monto</th><th class="num">Saldo</th><th>Estado</th><th></th></tr></thead>
      <tbody>${abiertas.map(x => `<tr><td><b>${esc(clienteNombre(x.cliente_id))}</b></td><td>${esc(x.folio)}</td><td>${fechaCorta(x.fecha_cuenta)}</td><td>${fechaCorta(x.vence)}</td>
        <td class="num">${dinero(x.monto)}</td><td class="num"><b>${dinero(x.saldo)}</b></td>
        <td>${String(x.vence) < hoy ? '<span class="est cxp-VENCIDA">Vencida</span>' : x.estado === 'PARCIAL' ? '<span class="est cxp-PARCIAL">Abonada</span>' : '<span class="est cxp-PENDIENTE">Pendiente</span>'}</td>
        <td><button type="button" class="btn mini sec" data-abonar="${esc(x.cliente_id)}">Abonar</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="vacio">No hay cuentas por cobrar.</p>'}`;
  c.onclick = e => {
    const b = e.target.closest('[data-abonar]');
    if (!b) return;
    const cli = D.clientes.find(x => x.id === b.dataset.abonar);
    const dd = abrirModal(`Abono de ${cli.nombre}`, `<form id="aba" class="form">
      <p>Saldo: <b>${dinero(cli.saldo)}</b>. El abono se aplica a las cuentas más antiguas primero.</p>
      <div class="fila3"><label>Monto<input name="monto" type="number" step="0.01" min="0.01" value="${Number(cli.saldo).toFixed(2)}"></label>
        <label>Forma de pago<select name="metodo">${['TRANSFERENCIA', 'EFECTIVO', 'TARJETA', 'CHEQUE', 'OTRO'].map(m => `<option value="${m}">${METODO_TXT[m]}</option>`).join('')}</select></label>
        <label>Referencia<input name="referencia"></label></div>
      <p class="msg" id="aba-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Registrar abono</button></div></form>`);
    $('#aba', dd).onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const r = await conCarga('Registrando…', () => api('registrarCaja', { operaciones: [{ clase: 'ABONO', id: uuid(), cliente_id: cli.id, monto: f.monto.value, metodo: f.metodo.value, referencia: f.referencia.value.trim() }] }));
        const res = r.resultados[0];
        if (res.estado === 'rechazado') throw new Error(res.error);
        cerrarModal();
        toast('Abono registrado.', 'ok');
        VT.cli = null;
        sincronizar();
        pintarCobrar(c);
      } catch (err) { $('#aba-msg', dd).textContent = err.message; }
    };
  };
}

/* ---- Pedidos y surtido (fase 5) ---- */
const PED_TXT = { SOLICITADO: 'Solicitado', PROGRAMADO: 'Programado', EN_PROCESO: 'En proceso', ENTREGADO: 'Entregado', CANCELADO: 'Cancelado' };
const ENV_TXT = { EN_RUTA: 'En ruta', ENTREGADO: 'Entregado', CANCELADO: 'Cancelado' };
const PD = { datos: null, cargado: 0, offline: false, pestana: 'tablero', q: '' };
const chipPed = e => `<span class="est ped-${e}">${PED_TXT[e] || e}</span>`;
const chipEnv = e => `<span class="est env-${e}">${ENV_TXT[e] || e}</span>`;
const esBodegaRol = () => ['ADMIN_GENERAL', 'INVENTARIOS'].includes(rol());
const destinoPedido = p => (p.tipo === 'EXTERNO'
  ? ((clientePorId(p.cliente_id) || {}).nombre || (S.cliente && S.cliente.id === p.cliente_id ? S.cliente.nombre : 'Cliente'))
  : ((S.idx.alm[p.destino_id] || {}).nombre || 'Sucursal'));
const pendienteLinea = l => Math.max(0, Number(l.cantidad) - Number(l.entregado));
const porSurtirLinea = l => Math.max(0, Number(l.cantidad) - Number(l.surtido));
function avancePedido(p) {
  const tot = p.lineas.reduce((s, l) => s + Number(l.cantidad), 0);
  return tot ? Math.round(p.lineas.reduce((s, l) => s + Math.min(Number(l.entregado), Number(l.cantidad)), 0) / tot * 100) : 0;
}

async function cargarPedidos() {
  if (!navigator.onLine) {
    const snap = await DB.get('pedidos');
    if (!snap || snap.usuario !== S.usuario.usuario) throw new Error('Sin conexión y sin datos guardados de pedidos en este equipo.');
    Object.assign(PD, { datos: snap.datos, cargado: snap.fecha, offline: true });
    return;
  }
  PD.datos = await api('pedidos');
  PD.cargado = Date.now();
  PD.offline = false;
  guardarSnapshotPedidos();
}
const guardarSnapshotPedidos = () => DB.set('pedidos', { datos: PD.datos, fecha: PD.cargado, usuario: S.usuario.usuario }).catch(() => {});
function actualizarPedidoLocal(p) {
  upsert(PD.datos, p);
  guardarSnapshotPedidos();
  if (PD.repintar) PD.repintar();
}

function vPedidos(el) {
  el.innerHTML = `
    <div class="titulo"><h2>Pedidos</h2><div class="acciones">
      <button type="button" class="btn sec" id="pd-recargar">Actualizar</button>
      <button type="button" class="btn" id="pd-nuevo">${rol() === 'ADMIN_SUCURSAL' ? 'Solicitar mercancía' : 'Nuevo pedido'}</button></div></div>
    <div class="segmentos" id="pd-tabs">${[['tablero', 'Tablero'], ['lista', 'Todos']].map(([k, t]) => `<button type="button" data-t="${k}">${t}</button>`).join('')}</div>
    <div id="pd-aviso"></div><div id="pd-cuerpo"><p class="nota">Cargando…</p></div>`;
  const cuerpo = $('#pd-cuerpo', el);
  const pintar = () => {
    $$('#pd-tabs button', el).forEach(b => b.classList.toggle('activo', b.dataset.t === PD.pestana));
    $('#pd-aviso', el).innerHTML = PD.offline ? `<p class="aviso-offline">Sin conexión: datos de ${hace(PD.cargado)}. Solo consulta.</p>` : '';
    if (PD.datos) (PD.pestana === 'tablero' ? pintarTableroPedidos : pintarListaPedidos)(cuerpo);
  };
  const recargar = async animar => {
    try {
      if (animar) await conCarga('Cargando pedidos…', cargarPedidos); else await cargarPedidos();
      pintar();
    } catch (e) {
      cuerpo.innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
      if (e.sesion) sesionVencida(e.message);
    }
  };
  PD.repintar = pintar;
  S.refrescar = pintar;
  $('#pd-tabs', el).onclick = e => { const b = e.target.closest('[data-t]'); if (b) { PD.pestana = b.dataset.t; pintar(); } };
  $('#pd-recargar', el).onclick = () => recargar(true);
  $('#pd-nuevo', el).onclick = () => dlgEditorPedido(null);
  cuerpo.onclick = e => {
    const b = e.target.closest('[data-pd]');
    if (b) dlgPedido(PD.datos.find(p => p.id === b.dataset.pd));
  };
  if (PD.datos) pintar();
  if (!PD.datos || Date.now() - PD.cargado > 60000 || (PD.offline && navigator.onLine)) recargar(!PD.datos);
}

function tarjetaPedido(p) {
  const hoy = hoyLocal();
  const atrasado = ['PROGRAMADO', 'EN_PROCESO'].includes(p.estado) && p.fecha_entrega && p.fecha_entrega < hoy;
  const enRuta = p.envios.filter(e => e.estado === 'EN_RUTA').length;
  const av = avancePedido(p);
  return `<button type="button" class="oc ${atrasado ? 'atrasada' : ''}" data-pd="${esc(p.id)}">
    <span class="fila-oc"><span class="folio">${esc(p.folio)}</span><span class="est ${p.tipo === 'EXTERNO' ? 'est-ENVIADA' : 'est-BORRADOR'}">${p.tipo === 'EXTERNO' ? 'Cliente' : 'Sucursal'}</span></span>
    <span>${esc(destinoPedido(p))}</span>
    <span class="fila-oc"><small>${p.fecha_entrega ? (p.fecha_entrega === hoy ? '<b>Hoy</b>' : (atrasado ? '<b class="txt-error">Atrasado ' : '') + fechaCorta(p.fecha_entrega) + (atrasado ? '</b>' : '')) : 'Sin fecha'}${enRuta ? ` · ${enRuta} en ruta` : ''}</small><b>${dinero(p.total)}</b></span>
    ${p.estado === 'EN_PROCESO' ? `<span class="barra-avance"><span style="width:${av}%"></span></span>` : ''}
  </button>`;
}

function pintarTableroPedidos(c) {
  const D = PD.datos, mes = sumarDiasYmd(hoyLocal(), -30);
  const col = (clase, titulo, lista, vacio) => `<section class="columna ${clase}"><header><b>${titulo} (${lista.length})</b>
    <small>${dinero(lista.reduce((s, p) => s + Number(p.total), 0))}</small></header>${lista.map(tarjetaPedido).join('') || `<p class="nota">${vacio}</p>`}</section>`;
  const porFecha = (a, b) => String(a.fecha_entrega || '9').localeCompare(String(b.fecha_entrega || '9'));
  c.innerHTML = `<div class="tablero">
    ${col('c-proximas', 'Solicitados', D.filter(p => p.estado === 'SOLICITADO').sort(porFecha), 'Sin solicitudes nuevas.')}
    ${col('c-enviadas', 'Programados', D.filter(p => p.estado === 'PROGRAMADO').sort(porFecha), 'Nada programado.')}
    ${col('c-recibir', 'En proceso', D.filter(p => p.estado === 'EN_PROCESO').sort(porFecha), 'Sin pedidos en surtido.')}
    ${col('c-recibidas', 'Entregados (30 días)', D.filter(p => p.estado === 'ENTREGADO' && String(p.cerrado).slice(0, 10) >= mes)
      .sort((a, b) => String(b.cerrado).localeCompare(String(a.cerrado))), 'Sin entregas recientes.')}
  </div>`;
}

function pintarListaPedidos(c) {
  const q = normal(PD.q);
  const l = PD.datos.filter(p => !q || normal(p.folio + ' ' + destinoPedido(p)).includes(q)).sort((a, b) => String(b.folio).localeCompare(String(a.folio)));
  c.innerHTML = `<div class="filtros"><input id="pd-q" type="search" placeholder="Buscar folio, cliente o sucursal" value="${esc(PD.q)}"></div>
    ${l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Folio</th><th>Para</th><th>Tipo</th><th>Entrega</th><th>Avance</th><th class="num">Total</th><th>Estado</th></tr></thead>
    <tbody>${l.map(p => `<tr class="clic" data-pd="${esc(p.id)}"><td><b>${esc(p.folio)}</b></td><td>${esc(destinoPedido(p))}</td><td>${p.tipo === 'EXTERNO' ? 'Cliente' : 'Sucursal'}${p.solicito === 'PORTAL' ? ' · portal' : ''}</td>
      <td>${fechaCorta(p.fecha_entrega)}</td><td>${avancePedido(p)}%</td><td class="num">${dinero(p.total)}</td><td>${chipPed(p.estado)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="vacio">Sin pedidos.</p>'}`;
  const qi = $('#pd-q', c);
  qi.oninput = () => { PD.q = qi.value; const pos = qi.selectionStart; pintarListaPedidos(c); const n = $('#pd-q', c); n.focus(); n.setSelectionRange(pos, pos); };
}

function dlgEditorPedido(base) {
  const nuevo = !base;
  const esSuc = rol() === 'ADMIN_SUCURSAL';
  const bodegas = S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.tipo === 'BODEGA').sort(porNombre);
  const origenes = rol() === 'INVENTARIOS' ? S.catalogo.almacenes.filter(a => a.id === S.usuario.almacen_id) : bodegas;
  const sucursales = S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.tipo === 'SUCURSAL').sort(porNombre);
  const p = base ? JSON.parse(JSON.stringify(base)) : {
    tipo: esSuc ? 'INTERNO' : 'EXTERNO', origen_id: (origenes[0] || {}).id || '', cliente_id: '', destino_id: esSuc ? S.usuario.almacen_id : '',
    condicion: 'CONTADO', iva_tasa: 0, fecha_entrega: hoyLocal(1), notas: '', lineas: []
  };
  const lineas = p.lineas.map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad), precio: Number(l.precio) }));
  const clientes = (S.clientes || []).filter(c => c.activo !== false).sort(porNombre);
  const d = abrirModal(nuevo ? (esSuc ? 'Solicitar mercancía a bodega' : 'Nuevo pedido') : `Editar ${p.folio}`, `
    <form id="fped" class="form" autocomplete="off">
      ${esSuc ? `<p class="nota">La solicitud llega a la bodega para que la programe y la surta a ${esc((S.idx.alm[S.usuario.almacen_id] || {}).nombre || 'tu sucursal')}.</p>` : `
      <div class="segmentos" id="fp-tipo"><button type="button" data-tipo="EXTERNO">Cliente externo</button><button type="button" data-tipo="INTERNO">Sucursal</button></div>`}
      <div class="fila3">
        ${esSuc ? '' : `<label id="fp-cli">Cliente<select name="cliente_id"><option value="">Elige…</option>${clientes.map(c => `<option value="${esc(c.id)}" ${c.id === p.cliente_id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
        <label id="fp-suc">Sucursal que recibe<select name="destino_id"><option value="">Elige…</option>${sucursales.map(a => `<option value="${esc(a.id)}" ${a.id === p.destino_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>`}
        <label>Surte<select name="origen_id">${origenes.map(a => `<option value="${esc(a.id)}" ${a.id === p.origen_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        <label>${esSuc ? 'Fecha deseada' : 'Fecha de surtido y entrega'}<input name="fecha_entrega" type="date" value="${esc(p.fecha_entrega || '')}"></label>
      </div>
      <div class="fila2" id="fp-cond"><label>Condición<select name="condicion"><option value="CONTADO">Contado</option><option value="CREDITO" ${p.condicion === 'CREDITO' ? 'selected' : ''}>Crédito</option></select></label>
        <label>IVA<select name="iva_tasa">${[0, 8, 16].map(t => `<option value="${t}" ${Number(p.iva_tasa) === t ? 'selected' : ''}>${t}%</option>`).join('')}</select></label></div>
      <p class="nota" id="fp-credito"></p>
      <div class="campo"><span>Agregar producto</span><div id="fp-sel"></div></div>
      <div id="fp-lineas"></div>
      <label>Notas<input name="notas" value="${esc(p.notas || '')}"></label>
      <div class="totales" id="fp-tot"></div>
      <p class="msg" id="fp-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">${esSuc ? 'Enviar solicitud' : 'Guardar pedido'}</button></div>
    </form>`, true);
  const f = $('#fped', d), msg = $('#fp-msg', d);
  const cliente = () => (p.tipo === 'EXTERNO' && f.cliente_id ? clientePorId(f.cliente_id.value) : null);
  const precioDe = prod => (p.tipo === 'INTERNO' ? Number(prod.costo) || 0 : precioCliente(prod, cliente()));
  const pintarTipo = () => {
    if (esSuc) { $('#fp-cond', d).hidden = true; return; }
    $$('#fp-tipo button', d).forEach(b => b.classList.toggle('activo', b.dataset.tipo === p.tipo));
    $('#fp-cli', d).hidden = p.tipo !== 'EXTERNO';
    $('#fp-suc', d).hidden = p.tipo !== 'INTERNO';
    $('#fp-cond', d).hidden = p.tipo !== 'EXTERNO';
  };
  const pintarCredito = () => {
    const c = cliente();
    $('#fp-credito', d).innerHTML = c ? (c.credito ? `Crédito: límite ${dinero(c.limite_credito)} · saldo ${dinero(c.saldo)} · disponible <b>${dinero(creditoDisponible(c))}</b>${Number(c.vencido) > 0 ? ' · <span class="txt-error">saldo vencido ' + dinero(c.vencido) + '</span>' : ''}`
      : 'Este cliente no tiene crédito: el pedido será de contado.') : '';
    if (c && !c.credito) f.condicion.value = 'CONTADO';
  };
  const pintarLineas = () => {
    const ex = mapaExistencias();
    $('#fp-lineas', d).innerHTML = lineas.length ? `<div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr><th>Producto</th><th class="num">En ${esc((S.idx.alm[f.origen_id.value] || {}).nombre || 'bodega')}</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead>
      <tbody>${lineas.map((l, i) => { const pr = S.idx.prod[l.producto_id] || {}; const e = ex[f.origen_id.value + '|' + l.producto_id] || 0;
        return `<tr><td>${esc(pr.nombre || '—')}<small>${esc(pr.codigo || '')} · ${esc(pr.unidad || '')}</small></td><td class="num ${e < l.cantidad ? 'txt-error' : ''}">${numero(e)}</td>
          <td class="num"><input type="number" min="0" step="any" data-i="${i}" data-k="cantidad" value="${l.cantidad}"></td>
          <td class="num">${esBodegaRol() && p.tipo === 'EXTERNO' ? `<input type="number" min="0" step="0.01" data-i="${i}" data-k="precio" value="${l.precio}">` : dinero(l.precio)}</td>
          <td class="num">${dinero(l.cantidad * l.precio)}</td><td><button type="button" class="btn mini peligro" data-quitar="${i}">✕</button></td></tr>`; }).join('')}</tbody></table></div>`
      : '<p class="nota">Agrega los productos del pedido.</p>';
    pintarTot();
  };
  const pintarTot = () => {
    const sub = lineas.reduce((s, l) => s + l.cantidad * l.precio, 0);
    const tasa = p.tipo === 'EXTERNO' ? Number(f.iva_tasa.value) || 0 : 0;
    const iva = Math.round(sub * tasa) / 100;
    $('#fp-tot', d).innerHTML = `<span>Subtotal${p.tipo === 'INTERNO' ? ' (a costo)' : ''}</span><span>${dinero(sub)}</span>${tasa ? `<span>IVA ${tasa}%</span><span>${dinero(iva)}</span>` : ''}<span class="g">Total</span><span class="g">${dinero(sub + iva)}</span>`;
  };
  const repreciar = () => { lineas.forEach(l => { const pr = S.idx.prod[l.producto_id]; if (pr) l.precio = precioDe(pr); }); pintarLineas(); };
  pintarTipo(); pintarCredito(); pintarLineas();
  const sel = selectorProducto($('#fp-sel', d), pr => {
    if (!pr) return;
    const ya = lineas.find(l => l.producto_id === pr.id);
    if (ya) ya.cantidad += 1; else lineas.push({ producto_id: pr.id, cantidad: 1, precio: precioDe(pr) });
    sel.limpiar();
    pintarLineas();
    const inp = d.querySelector(`[data-i="${lineas.findIndex(l => l.producto_id === pr.id)}"][data-k="cantidad"]`);
    if (inp) { inp.focus(); inp.select(); }
  });
  if (!esSuc) {
    $('#fp-tipo', d).onclick = e => { const b = e.target.closest('[data-tipo]'); if (b) { p.tipo = b.dataset.tipo; pintarTipo(); repreciar(); } };
    f.cliente_id.onchange = () => { pintarCredito(); repreciar(); };
  }
  f.origen_id.onchange = pintarLineas;
  f.iva_tasa.onchange = pintarTot;
  $('#fp-lineas', d).oninput = e => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    lineas[i][e.target.dataset.k] = Number(e.target.value) || 0;
    e.target.closest('tr').cells[4].textContent = dinero(lineas[i].cantidad * lineas[i].precio);
    pintarTot();
  };
  $('#fp-lineas', d).onclick = e => { const q = e.target.closest('[data-quitar]'); if (q) { lineas.splice(Number(q.dataset.quitar), 1); pintarLineas(); } };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para guardar pedidos.'; return; }
    const ls = lineas.filter(l => l.cantidad > 0);
    if (!ls.length) { msg.textContent = 'Agrega al menos un producto.'; return; }
    if (p.tipo === 'EXTERNO' && !esSuc && !f.cliente_id.value) { msg.textContent = 'Elige el cliente.'; return; }
    if (p.tipo === 'INTERNO' && !esSuc && !f.destino_id.value) { msg.textContent = 'Elige la sucursal.'; return; }
    if (nuevo && !p.id) p.id = uuid();
    try {
      const r = await conCarga('Guardando pedido…', () => api('guardarPedido', { pedido: {
        nuevo, id: p.id, tipo: p.tipo, origen_id: f.origen_id.value, cliente_id: f.cliente_id ? f.cliente_id.value : '', destino_id: f.destino_id ? f.destino_id.value : '',
        condicion: f.condicion.value, iva_tasa: f.iva_tasa.value, fecha_entrega: f.fecha_entrega.value, notas: f.notas.value.trim(), lineas: ls
      } }));
      cerrarModal();
      toast(`Pedido ${r.pedido.folio} guardado.`, 'ok');
      if (r.aviso) toast('Atención: ' + r.aviso, 'aviso');
      if (PD.datos) actualizarPedidoLocal(r.pedido);
      dlgPedido(r.pedido);
    } catch (e) { msg.textContent = e.message; }
  };
}

function dlgPedido(p) {
  if (!p) return;
  const bodega = esBodegaRol();
  const enRuta = p.envios.filter(e => e.estado === 'EN_RUTA');
  const hayPend = p.lineas.some(l => porSurtirLinea(l) > 0);
  const tieneEnvios = p.envios.some(e => e.estado !== 'CANCELADO');
  const acciones = [];
  if (bodega && ['SOLICITADO', 'PROGRAMADO', 'EN_PROCESO'].includes(p.estado)) acciones.push(['programar', p.estado === 'SOLICITADO' ? 'Aceptar y programar' : 'Reprogramar', 'sec']);
  if (bodega && ['SOLICITADO', 'PROGRAMADO', 'EN_PROCESO'].includes(p.estado) && hayPend) acciones.push(['surtir', 'Lotear / surtir', '']);
  if (['SOLICITADO', 'PROGRAMADO'].includes(p.estado) && !tieneEnvios && (bodega || p.estado === 'SOLICITADO')) acciones.push(['editar', 'Editar', 'sec']);
  if (bodega && p.estado === 'EN_PROCESO' && !enRuta.length) acciones.push(['cerrar', 'Cerrar con faltante', 'sec']);
  if (['SOLICITADO', 'PROGRAMADO'].includes(p.estado) && !tieneEnvios && (bodega || p.estado === 'SOLICITADO')) acciones.push(['cancelar', 'Cancelar pedido', 'peligro']);
  const cli = p.tipo === 'EXTERNO' ? clientePorId(p.cliente_id) : null;
  const d = abrirModal(`Pedido ${p.folio}`, `<div class="form">
    <div class="titulo"><span>${chipPed(p.estado)} <span class="nota">${p.tipo === 'EXTERNO' ? 'Cliente externo' : 'Traspaso a sucursal'} · ${p.solicito === 'PORTAL' ? 'pedido desde el portal' : p.solicito === 'SUCURSAL' ? 'solicitado por la sucursal' : 'capturado en bodega'}</span></span><b>${dinero(p.total)}</b></div>
    <div class="info-oc">
      <div><h4>Para</h4><b>${esc(destinoPedido(p))}</b>${cli && cli.telefono ? '<br>' + esc(cli.telefono) : ''}${p.tipo === 'EXTERNO' ? `<br>${p.condicion === 'CREDITO' ? 'Crédito' : 'Contado'}${Number(p.iva_tasa) ? ' · IVA ' + p.iva_tasa + '%' : ''}` : ''}</div>
      <div><h4>Surte</h4><b>${esc((S.idx.alm[p.origen_id] || {}).nombre || '')}</b><br>Entrega: ${fechaCorta(p.fecha_entrega)}</div>
      <div><h4>Avance</h4>${avancePedido(p)}% entregado<br>Pedido: ${fechaHora(p.fecha)}${p.cerrado ? '<br>Terminado: ' + fechaHora(p.cerrado) : ''}</div>
    </div>
    <div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">En ruta</th><th class="num">Entregado</th><th class="num">Pendiente</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead>
      <tbody>${p.lineas.map(l => { const pr = S.idx.prod[l.producto_id] || {}; const ruta = Math.max(0, Number(l.surtido) - Number(l.entregado));
        return `<tr><td>${esc(pr.nombre || '—')}<small>${esc(pr.unidad || '')}</small></td><td class="num">${numero(l.cantidad)}</td><td class="num">${ruta ? numero(ruta) : '—'}</td>
          <td class="num">${numero(l.entregado)}</td><td class="num ${pendienteLinea(l) > 0 && p.estado !== 'CANCELADO' ? 'txt-error' : ''}">${numero(pendienteLinea(l))}</td>
          <td class="num">${dinero(l.precio)}</td><td class="num">${dinero(l.cantidad * l.precio)}</td></tr>`; }).join('')}</tbody></table></div>
    ${p.notas ? `<p><b>Notas:</b> ${esc(p.notas)}</p>` : ''}
    ${p.envios.length ? `<div><h3>Envíos</h3><ul class="lista">${p.envios.map(e => `<li><div><b>${esc(e.folio)}</b> ${chipEnv(e.estado)} · ${fechaHora(e.fecha)} · ${dinero(e.total)}
        <small>${e.lineas.map(l => `${numero(l.cantidad)} ${esc((S.idx.prod[l.producto_id] || {}).nombre || '')}${e.estado === 'ENTREGADO' && Number(l.recibido) < Number(l.cantidad) ? ` (llegaron ${numero(l.recibido)})` : ''}`).join(' · ')}</small>
        ${e.recibio ? `<small>Recibió: ${esc(e.recibio)} · ${fechaHora(e.entregado)}</small>` : ''}</div>
        <span class="acciones"><button type="button" class="btn mini sec" data-rem="${esc(e.id)}">Remisión</button>
        ${e.estado === 'EN_RUTA' && rol() !== 'CLIENTE' ? `<button type="button" class="btn mini" data-ent="${esc(e.id)}">Confirmar entrega</button>` : ''}
        ${e.estado === 'EN_RUTA' && bodega ? `<button type="button" class="btn mini peligro" data-cenv="${esc(e.id)}">Cancelar envío</button>` : ''}</span></li>`).join('')}</ul></div>` : ''}
    ${acciones.length && !PD.offline ? `<div class="acciones" id="pd-acc">${acciones.map(([k, t, c]) => `<button type="button" class="btn ${c}" data-a="${k}">${t}</button>`).join('')}</div>` : ''}
  </div>`, true);
  d.onclick = async e => {
    const rem = e.target.closest('[data-rem]'), ent = e.target.closest('[data-ent]'), cenv = e.target.closest('[data-cenv]'), a = e.target.closest('[data-a]');
    try {
      if (rem) imprimirRemision(p, p.envios.find(x => x.id === rem.dataset.rem));
      if (ent) dlgEntrega(p, p.envios.find(x => x.id === ent.dataset.ent));
      if (cenv) {
        const motivo = prompt('Motivo de la cancelación del envío (la mercancía regresa a la bodega):');
        if (!motivo) return;
        const r = await conCarga('Cancelando envío…', () => api('cancelarEnvio', { envio_id: cenv.dataset.cenv, motivo }));
        toast('Envío cancelado; la mercancía regresó a la bodega.', 'ok');
        actualizarPedidoLocal(r); sincronizar(); dlgPedido(r);
      }
      if (!a) return;
      const k = a.dataset.a;
      if (k === 'editar') return dlgEditorPedido(p);
      if (k === 'surtir') return dlgSurtir(p);
      if (k === 'programar') return dlgProgramar(p);
      if (k === 'cancelar' || k === 'cerrar') {
        const motivo = prompt(k === 'cancelar' ? 'Motivo de la cancelación:' : 'Motivo del cierre (lo pendiente ya no se enviará):');
        if (!motivo) return;
        const r = await conCarga('Actualizando…', () => api(k === 'cancelar' ? 'cancelarPedido' : 'cerrarPedido', { id: p.id, motivo }));
        toast(k === 'cancelar' ? 'Pedido cancelado.' : 'Pedido cerrado.', 'ok');
        actualizarPedidoLocal(r); dlgPedido(r);
      }
    } catch (err) { toast(err.message, 'error'); if (err.sesion) { cerrarModal(); sesionVencida(err.message); } }
  };
}

function dlgProgramar(p) {
  const d = abrirModal(`Programar ${p.folio}`, `<form id="fprog" class="form">
    <label>Fecha de surtido y entrega<input name="fecha" type="date" required value="${esc(p.fecha_entrega || hoyLocal())}"></label>
    <p class="msg" id="fprog-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Programar</button></div></form>`);
  $('#fprog', d).onsubmit = async ev => {
    ev.preventDefault();
    try {
      const r = await conCarga('Programando…', () => api('programarPedido', { id: p.id, fecha_entrega: ev.target.fecha.value }));
      toast(`${r.folio} programado para el ${fechaCorta(r.fecha_entrega)}.`, 'ok');
      actualizarPedidoLocal(r);
      dlgPedido(r);
    } catch (e) { $('#fprog-msg', d).textContent = e.message; }
  };
}

function dlgSurtir(p) {
  const envioId = uuid();
  const ex = mapaExistencias();
  const filas = p.lineas.filter(l => porSurtirLinea(l) > 0);
  const credito = p.tipo === 'EXTERNO' && p.condicion === 'CREDITO';
  const d = abrirModal(`Lotear ${p.folio}`, `<form id="fsur" class="form" autocomplete="off">
    <p class="nota">Captura lo que se carga en este envío. Sale del inventario de ${esc((S.idx.alm[p.origen_id] || {}).nombre || 'la bodega')}; lo que no envíes queda pendiente para otro envío.</p>
    <div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr><th>Producto</th><th class="num">Por surtir</th><th class="num">Existencia</th><th class="num">Enviar</th></tr></thead>
      <tbody>${filas.map((l, i) => { const pr = S.idx.prod[l.producto_id] || {}; const e = ex[p.origen_id + '|' + l.producto_id] || 0; const sug = Math.max(0, Math.min(porSurtirLinea(l), e));
        return `<tr><td>${esc(pr.nombre || '—')}<small>${esc(pr.codigo || '')}</small></td><td class="num">${numero(porSurtirLinea(l))} ${esc(pr.unidad || '')}</td>
          <td class="num ${e < porSurtirLinea(l) ? 'txt-error' : ''}">${numero(e)}</td><td class="num"><input type="number" min="0" step="any" data-i="${i}" value="${sug}"></td></tr>`; }).join('')}</tbody></table></div>
    <label>Notas del envío (chofer, unidad, ruta)<input name="notas"></label>
    ${credito && esGeneral() ? '<label class="chk"><input type="checkbox" name="forzar"> Autorizar aunque rebase el crédito del cliente</label>' : ''}
    <label class="chk"><input type="checkbox" name="imprimir" checked> Imprimir remisión</label>
    <p class="msg" id="fsur-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Generar envío</button></div></form>`, true);
  const f = $('#fsur', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const lineas = filas.map((l, i) => ({ linea_id: l.id, cantidad: Number(f.querySelector(`[data-i="${i}"]`).value) || 0 })).filter(x => x.cantidad > 0);
    if (!lineas.length) { $('#fsur-msg', d).textContent = 'Captura al menos una cantidad.'; return; }
    try {
      const r = await conCarga('Generando envío…', () => api('surtirPedido', { id: p.id, envio_id: envioId, lineas, notas: f.notas.value.trim(), forzar: f.forzar ? f.forzar.checked : false }));
      const env = r.envios.find(x => x.id === envioId);
      toast(`Envío ${env.folio} en ruta.`, 'ok');
      actualizarPedidoLocal(r);
      sincronizar();
      if (f.imprimir.checked) imprimirRemision(r, env);
      dlgPedido(r);
    } catch (e) { $('#fsur-msg', d).textContent = e.message; }
  };
}

function dlgEntrega(p, envio) {
  const precio = id => (p.lineas.find(l => l.id === id) || {}).precio || 0;
  const factor = 1 + (Number(p.iva_tasa) || 0) / 100;
  const externo = p.tipo === 'EXTERNO';
  const d = abrirModal(`Entrega de ${envio.folio}`, `<form id="fent" class="form" autocomplete="off">
    <p class="nota">Captura lo que el ${externo ? 'cliente' : 'personal de la sucursal'} recibió. Lo que no se reciba regresa al inventario de la bodega y queda pendiente en el pedido.</p>
    <div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr><th>Producto</th><th class="num">Enviado</th><th class="num">Recibido</th></tr></thead>
      <tbody>${envio.lineas.map((l, i) => `<tr><td>${esc((S.idx.prod[l.producto_id] || {}).nombre || '—')}</td><td class="num">${numero(l.cantidad)}</td>
        <td class="num"><input type="number" min="0" step="any" max="${l.cantidad}" data-i="${i}" value="${l.cantidad}"></td></tr>`).join('')}</tbody></table></div>
    <div class="fila2"><label>Recibió (nombre)<input name="recibio" required></label><label>Notas<input name="notas"></label></div>
    ${externo ? `<div class="cobro-res" id="fe-total"></div>
      ${p.condicion === 'CREDITO' ? '<p class="nota">El importe recibido se suma al crédito del cliente.</p>' : `
      <label class="chk"><input type="checkbox" name="cobrado" checked> Se cobró al entregar</label>
      <div class="fila2" id="fe-pago"><label>Monto cobrado<input name="monto" type="number" step="0.01" min="0"></label>
        <label>Forma de pago<select name="metodo">${['EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'CHEQUE'].map(m => `<option value="${m}">${METODO_TXT[m]}</option>`).join('')}</select></label></div>`}` : ''}
    <p class="msg" id="fent-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Confirmar entrega</button></div></form>`, true);
  const f = $('#fent', d);
  const recibidos = () => envio.lineas.map((l, i) => ({ envio_linea_id: l.id, recibido: Number(f.querySelector(`[data-i="${i}"]`).value) || 0, linea_id: l.linea_id, enviado: Number(l.cantidad) }));
  const calcular = () => {
    if (!externo) return 0;
    const t = Math.round(recibidos().reduce((s, x) => s + x.recibido * precio(x.linea_id), 0) * factor * 100) / 100;
    $('#fe-total', d).innerHTML = `<span>Importe recibido${factor > 1 ? ' (con IVA)' : ''}</span><b>${dinero(t)}</b>`;
    if (f.monto && !f.monto.dataset.tocado) f.monto.value = t.toFixed(2);
    return t;
  };
  calcular();
  f.oninput = e => { if (e.target.name === 'monto') e.target.dataset.tocado = '1'; calcular(); };
  if (f.cobrado) f.cobrado.onchange = () => { $('#fe-pago', d).hidden = !f.cobrado.checked; };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const rs = recibidos();
    if (rs.some(x => x.recibido > x.enviado)) { $('#fent-msg', d).textContent = 'No se puede recibir más de lo enviado.'; return; }
    const pago = f.cobrado && f.cobrado.checked ? { monto: Number(f.monto.value) || 0, metodo: f.metodo.value } : null;
    try {
      const r = await conCarga('Registrando entrega…', () => api('entregarEnvio', { envio_id: envio.id, recibio: f.recibio.value.trim(), notas: f.notas.value.trim(),
        lineas: rs.map(x => ({ envio_linea_id: x.envio_linea_id, recibido: x.recibido })), pago }));
      toast(r.estado === 'ENTREGADO' ? `Pedido ${r.folio} entregado completo.` : `Entrega registrada; ${r.folio} tiene pendientes.`, 'ok');
      actualizarPedidoLocal(r);
      sincronizar();
      dlgPedido(r);
    } catch (e) { $('#fent-msg', d).textContent = e.message; }
  };
}

/* Documento tamaño carta (remisión, estado de cuenta) */
function imprimirDocumento(titulo, cuerpo) {
  const ifr = document.createElement('iframe');
  ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(ifr);
  const doc = ifr.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
    @page { size: letter; margin: 1.5cm; } body { font: 11px/1.45 Arial, sans-serif; color: #222; margin: 0; }
    .cab { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #E0DE27; padding-bottom: 8px; margin-bottom: 12px; }
    .cab img { width: 70px; } .cab h1 { margin: 0; color: #0172B6; font-size: 18px; } .folio { color: #E21319; font-weight: bold; font-size: 14px; }
    .cajas { display: flex; gap: 10px; margin-bottom: 12px; } .caja { flex: 1; border: 1px solid #cfd8dc; border-radius: 6px; padding: 8px; }
    .caja h3 { margin: 0 0 4px; font-size: 9px; color: #0172B6; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; } th { background: #0172B6; color: #fff; text-align: left; padding: 5px; font-size: 10px; }
    td { padding: 5px; border-bottom: 1px solid #e3e8ea; } .n { text-align: right; } .tot td { font-weight: bold; border-top: 2px solid #0172B6; }
    .firmas { display: flex; gap: 40px; margin-top: 60px; } .firmas div { flex: 1; border-top: 1px solid #888; text-align: center; padding-top: 4px; }
  </style></head><body>${cuerpo}</body></html>`);
  doc.close();
  setTimeout(() => {
    try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) { /* sin impresora */ }
    setTimeout(() => ifr.remove(), 3000);
  }, 300);
}

function imprimirRemision(p, e) {
  if (!e) return;
  const externo = p.tipo === 'EXTERNO';
  const cli = externo ? clientePorId(p.cliente_id) || (S.cliente && S.cliente.id === p.cliente_id ? S.cliente : {}) : null;
  const dest = externo ? null : S.idx.alm[p.destino_id] || {};
  const orig = S.idx.alm[p.origen_id] || {};
  const precio = id => (p.lineas.find(l => l.id === id) || {}).precio || 0;
  let sub = 0;
  const filas = e.lineas.map(l => {
    const pr = S.idx.prod[l.producto_id] || {};
    const imp = Number(l.cantidad) * precio(l.linea_id);
    sub += imp;
    return `<tr><td>${esc(pr.codigo || '')}</td><td>${esc(pr.nombre || '')}</td><td>${esc(pr.unidad || '')}</td><td class="n">${numero(l.cantidad)}</td>
      ${e.estado === 'ENTREGADO' ? `<td class="n">${numero(l.recibido)}</td>` : '<td class="n">&nbsp;</td>'}${externo ? `<td class="n">${dinero(precio(l.linea_id))}</td><td class="n">${dinero(imp)}</td>` : ''}</tr>`;
  }).join('');
  const iva = Math.round(sub * (Number(p.iva_tasa) || 0)) / 100;
  imprimirDocumento(`Remisión ${e.folio}`, `
    <div class="cab"><div style="display:flex;gap:10px;align-items:center"><img src="icons/icon-192.png" alt=""><div><h1>${esc(CFG.NOMBRE)}</h1>${esc(orig.nombre || '')}${orig.direccion ? '<br>' + esc(orig.direccion) : ''}</div></div>
      <div style="text-align:right"><h1>REMISIÓN</h1><div class="folio">${esc(e.folio)}</div>Pedido ${esc(p.folio)}<br>${fechaHora(e.fecha)}</div></div>
    <div class="cajas"><div class="caja"><h3>${externo ? 'Cliente' : 'Sucursal'}</h3><b>${esc(externo ? cli.nombre || '' : dest.nombre || '')}</b><br>
      ${esc(externo ? cli.direccion || '' : dest.direccion || '')}${(externo ? cli.telefono : dest.telefono) ? '<br>Tel. ' + esc(externo ? cli.telefono : dest.telefono) : ''}${externo && cli.rfc ? '<br>RFC ' + esc(cli.rfc) : ''}</div>
      <div class="caja"><h3>Entrega</h3>Fecha programada: ${fechaCorta(p.fecha_entrega)}<br>${externo ? (p.condicion === 'CREDITO' ? 'Condición: crédito' : 'Condición: contado') : 'Traspaso entre almacenes'}${e.notas ? '<br>' + esc(e.notas) : ''}</div></div>
    <table><thead><tr><th>Código</th><th>Producto</th><th>Unidad</th><th class="n">Enviado</th><th class="n">Recibido</th>${externo ? '<th class="n">Precio</th><th class="n">Importe</th>' : ''}</tr></thead>
      <tbody>${filas}${externo ? `<tr class="tot"><td colspan="6" class="n">Subtotal</td><td class="n">${dinero(sub)}</td></tr>${iva ? `<tr><td colspan="6" class="n">IVA ${p.iva_tasa}%</td><td class="n">${dinero(iva)}</td></tr>` : ''}
        <tr class="tot"><td colspan="6" class="n">Total</td><td class="n">${dinero(sub + iva)}</td></tr>` : ''}</tbody></table>
    ${e.recibio ? `<p>Recibió: <b>${esc(e.recibio)}</b> · ${fechaHora(e.entregado)}</p>` : ''}
    <div class="firmas"><div>Entregó (nombre y firma)</div><div>Recibió (nombre y firma)</div></div>`);
}

/* ---------- Portal del cliente ---------- */
const PT = { datos: null, carrito: null, cat: '', q: '' };

async function cargarPortal(c) {
  if (!navigator.onLine) { if (c) c.innerHTML = '<p class="aviso-offline">El portal necesita conexión a internet.</p>'; return null; }
  try {
    PT.datos = await conCarga('Cargando…', () => api('portal'));
    S.cliente = PT.datos.cliente;
    return PT.datos;
  } catch (e) {
    if (c) c.innerHTML = `<p class="txt-error">${esc(e.message)}</p>`;
    if (e.sesion) sesionVencida(e.message);
    return null;
  }
}

function vInicioPortal(el) {
  const c = S.cliente || {};
  const disp = c.credito ? creditoDisponible(c) : 0;
  el.innerHTML = `<div class="saludo"><h2>Hola, ${esc(c.nombre || S.usuario.nombre)}</h2><p>Portal de clientes · ${esc(CFG.NOMBRE)}</p></div>
    <div class="tarjetas">
      <div class="tarjeta"><span>Saldo pendiente</span><b>${dinero(c.saldo)}</b></div>
      ${c.credito ? `<div class="tarjeta"><span>Crédito disponible</span><b>${dinero(disp)}</b><small>Límite ${dinero(c.limite_credito)} · ${c.dias_credito} días</small></div>` : ''}
      <button type="button" class="tarjeta ${Number(c.vencido) > 0 ? 'alerta-roja' : ''}" data-ir="estado"><span>Vencido</span><b>${dinero(c.vencido)}</b></button>
    </div>
    <div class="portal-acciones">
      <button type="button" class="ir-caja" data-ir="tienda"><b>Hacer un pedido</b><span>Catálogo con tus precios</span></button>
      <button type="button" class="btn sec" data-ir="mispedidos">Mis pedidos</button>
      <button type="button" class="btn sec" data-ir="estado">Estado de cuenta</button>
    </div>
    ${Number(c.vencido) > 0 ? '<p class="aviso-offline">Tienes saldo vencido: los pedidos nuevos solo pueden ser de contado hasta que se regularice.</p>' : ''}`;
  el.onclick = e => { const b = e.target.closest('[data-ir]'); if (b) irA(b.dataset.ir); };
  S.refrescar = () => vInicioPortal(el);
}

async function vTienda(el) {
  if (!PT.carrito) PT.carrito = (await DB.get('carrito:' + S.usuario.usuario)) || { lineas: [], condicion: '', fecha: '', notas: '' };
  const K = PT.carrito;
  const cli = S.cliente || {};
  const puedeCredito = cli.credito && !(Number(cli.vencido) > 0);
  if (!K.condicion) K.condicion = puedeCredito ? 'CREDITO' : 'CONTADO';
  if (!puedeCredito) K.condicion = 'CONTADO';
  el.innerHTML = `<div class="titulo"><h2>Hacer un pedido</h2></div>
    <div class="caja">
      <section class="caja-buscar">
        <input id="pt-q" type="search" placeholder="Busca por nombre o código" value="${esc(PT.q)}" autocomplete="off">
        <div class="cats" id="pt-cats"></div><div class="cj-res" id="pt-res"></div>
      </section>
      <aside class="caja-ticket">
        <b>Tu pedido</b>
        <div class="cj-lineas" id="pt-lineas"></div>
        <div class="cj-total" id="pt-total"></div>
        <label>Pago<select id="pt-cond"><option value="CONTADO">Contado</option>${puedeCredito ? `<option value="CREDITO" ${K.condicion === 'CREDITO' ? 'selected' : ''}>Crédito (disponible ${dinero(creditoDisponible(cli))})</option>` : ''}</select></label>
        <label>Fecha deseada de entrega<input id="pt-fecha" type="date" min="${hoyLocal()}" value="${esc(K.fecha)}"></label>
        <label>Notas<input id="pt-notas" value="${esc(K.notas)}" placeholder="Horario, dirección de entrega…"></label>
        <p class="msg" id="pt-msg"></p>
        <button type="button" class="btn cobrar" id="pt-enviar">Enviar pedido</button>
      </aside>
    </div>
    <div class="cj-movil"><button type="button" class="cj-ver" id="pt-ver"></button><button type="button" class="btn cobrar" id="pt-enviar2">Enviar</button></div>`;
  const guardarCarrito = () => DB.set('carrito:' + S.usuario.usuario, K);
  const cats = S.catalogo.categorias.slice().sort(porNombre);
  $('#pt-cats', el).innerHTML = [['', 'Todo']].concat(cats.map(c => [c.id, c.nombre])).map(([id, n]) => `<button type="button" data-cat="${esc(id)}" class="${PT.cat === id ? 'activo' : ''}">${esc(n)}</button>`).join('');
  const pintarRes = () => {
    const q = normal(PT.q);
    const l = S.catalogo.productos.filter(p => (!PT.cat || p.categoria_id === PT.cat) && (!q || coincide(p, q))).sort(porNombre).slice(0, 80);
    $('#pt-res', el).innerHTML = l.map(p => `<button type="button" class="prod" data-p="${esc(p.id)}"><b>${esc(p.nombre)}</b>
      <span class="fila-oc"><span class="precio">${dinero(precioCliente(p, cli))}</span><small class="${p.disponible ? 'txt-ok' : 'txt-error'}">${p.disponible ? 'Disponible' : 'Agotado'}</small></span></button>`).join('') || '<p class="nota">Sin productos.</p>';
  };
  const total = () => K.lineas.reduce((s, l) => { const p = S.idx.prod[l.producto_id]; return s + (p ? precioCliente(p, cli) * l.cantidad : 0); }, 0);
  const pintarCarrito = () => {
    K.lineas = K.lineas.filter(l => S.idx.prod[l.producto_id]);
    ponerHTML($('#pt-lineas', el), K.lineas.length ? K.lineas.map((l, i) => {
      const p = S.idx.prod[l.producto_id];
      const pr = precioCliente(p, cli);
      return `<div class="cj-linea"><div class="cj-nombre">${esc(p.nombre)}<small>${dinero(pr)} c/u</small></div>
        <div class="cj-cant"><button type="button" data-menos="${i}">−</button><input type="number" min="0" step="any" data-cant="${i}" value="${l.cantidad}"><button type="button" data-mas="${i}">+</button></div>
        <b class="cj-imp">${dinero(pr * l.cantidad)}</b><button type="button" class="icono" data-quitar="${i}">✕</button></div>`;
    }).join('') : '<p class="nota cj-vacio">Toca un producto para agregarlo.</p>');
    $('#pt-total', el).innerHTML = `<span>${plural(K.lineas.length, 'producto')}</span><b>${dinero(total())}</b>`;
    $('#pt-ver', el).innerHTML = `<small>${plural(K.lineas.length, 'producto')} · ver pedido</small><b>${dinero(total())}</b>`;
    $('#pt-enviar', el).disabled = $('#pt-enviar2', el).disabled = !K.lineas.length;
    guardarCarrito();
  };
  pintarRes(); pintarCarrito();
  $('#pt-q', el).oninput = e => { PT.q = e.target.value; pintarRes(); };
  $('#pt-cats', el).onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { PT.cat = b.dataset.cat; $$('#pt-cats button', el).forEach(x => x.classList.toggle('activo', x === b)); pintarRes(); } };
  $('#pt-res', el).onclick = e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const ya = K.lineas.find(l => l.producto_id === b.dataset.p);
    if (ya) ya.cantidad += 1; else K.lineas.push({ producto_id: b.dataset.p, cantidad: 1 });
    pintarCarrito();
  };
  const lin = $('#pt-lineas', el);
  lin.onclick = e => {
    const t = e.target;
    if (t.dataset.mas !== undefined) K.lineas[t.dataset.mas].cantidad += 1;
    else if (t.dataset.menos !== undefined) { const l = K.lineas[t.dataset.menos]; l.cantidad -= 1; if (l.cantidad <= 0) K.lineas.splice(Number(t.dataset.menos), 1); }
    else if (t.closest('[data-quitar]')) K.lineas.splice(Number(t.closest('[data-quitar]').dataset.quitar), 1);
    else return;
    pintarCarrito();
  };
  lin.onchange = e => {
    const i = e.target.dataset.cant;
    if (i === undefined) return;
    const n = Number(e.target.value);
    if (n > 0) K.lineas[i].cantidad = n; else K.lineas.splice(Number(i), 1);
    pintarCarrito();
  };
  $('#pt-cond', el).onchange = e => { K.condicion = e.target.value; guardarCarrito(); };
  $('#pt-fecha', el).onchange = e => { K.fecha = e.target.value; guardarCarrito(); };
  $('#pt-notas', el).oninput = e => { K.notas = e.target.value; guardarCarrito(); };
  $('#pt-ver', el).onclick = () => $('.caja-ticket', el).scrollIntoView({ behavior: 'smooth' });
  const enviar = async () => {
    const msg = $('#pt-msg', el);
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para enviar el pedido. Tu carrito se guarda en este equipo.'; return; }
    if (!K.id) { K.id = uuid(); guardarCarrito(); }
    try {
      const r = await conCarga('Enviando pedido…', () => api('guardarPedido', { pedido: { nuevo: true, id: K.id, condicion: K.condicion, fecha_entrega: K.fecha, notas: K.notas, lineas: K.lineas } }));
      PT.carrito = { lineas: [], condicion: '', fecha: '', notas: '' };
      await DB.set('carrito:' + S.usuario.usuario, PT.carrito);
      toast(`¡Gracias! Recibimos tu pedido ${r.pedido.folio}. Te avisaremos cuando vaya en camino.`, 'ok');
      PT.datos = null;
      irA('mispedidos');
    } catch (e) {
      msg.textContent = e.message;
      if (/crédito|vencido/i.test(e.message)) delete K.id;   // podrá reintentarlo de contado
    }
  };
  $('#pt-enviar', el).onclick = enviar;
  $('#pt-enviar2', el).onclick = enviar;
  S.refrescar = () => { pintarRes(); pintarCarrito(); };
}

async function vMisPedidos(el) {
  el.innerHTML = '<div class="titulo"><h2>Mis pedidos</h2><button type="button" class="btn" id="mp-nuevo">Hacer un pedido</button></div><div id="mp-lista"></div>';
  $('#mp-nuevo', el).onclick = () => irA('tienda');
  const c = $('#mp-lista', el);
  const D = PT.datos || (await cargarPortal(c));
  if (!D) return;
  const l = D.pedidos.slice().sort((a, b) => String(b.folio).localeCompare(String(a.folio)));
  c.innerHTML = l.length ? `<div class="tarjetas grandes">${l.map(p => `<button type="button" class="tarjeta" data-pd="${esc(p.id)}">
      <span class="fila-oc"><b>${esc(p.folio)}</b>${chipPed(p.estado)}</span>
      <small>Pedido ${fechaHora(p.fecha)}${p.fecha_entrega ? ' · entrega ' + fechaCorta(p.fecha_entrega) : ''}</small>
      <span class="fila-oc"><small>${p.envios.filter(e => e.estado === 'EN_RUTA').length ? '<b>🚚 En camino</b>' : avancePedido(p) + '% entregado'}</small><b>${dinero(p.total)}</b></span>
      ${['EN_PROCESO'].includes(p.estado) ? `<span class="barra-avance"><span style="width:${avancePedido(p)}%"></span></span>` : ''}
    </button>`).join('')}</div>` : '<p class="vacio">Aún no tienes pedidos.</p>';
  c.onclick = async e => {
    const b = e.target.closest('[data-pd]');
    if (!b) return;
    const p = D.pedidos.find(x => x.id === b.dataset.pd);
    const d = abrirModal(`Pedido ${p.folio}`, `<div class="form">
      <div class="titulo"><span>${chipPed(p.estado)} · ${p.condicion === 'CREDITO' ? 'Crédito' : 'Contado'}</span><b>${dinero(p.total)}</b></div>
      <div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Entregado</th><th class="num">Precio</th></tr></thead>
        <tbody>${p.lineas.map(l => `<tr><td>${esc((S.idx.prod[l.producto_id] || {}).nombre || '—')}</td><td class="num">${numero(l.cantidad)}</td><td class="num">${numero(l.entregado)}</td><td class="num">${dinero(l.precio)}</td></tr>`).join('')}</tbody></table></div>
      ${p.envios.filter(x => x.estado !== 'CANCELADO').length ? `<h3>Envíos</h3><ul class="lista">${p.envios.filter(x => x.estado !== 'CANCELADO').map(x => `<li><span><b>${esc(x.folio)}</b> ${chipEnv(x.estado)} · ${fechaHora(x.fecha)}${x.recibio ? ' · recibió ' + esc(x.recibio) : ''}</span>
        <button type="button" class="btn mini sec" data-rem="${esc(x.id)}">Remisión</button></li>`).join('')}</ul>` : '<p class="nota">Tu pedido aún no sale de bodega.</p>'}
      ${p.notas ? `<p class="nota">${esc(p.notas)}</p>` : ''}
      ${p.estado === 'SOLICITADO' ? '<div class="acciones"><button type="button" class="btn peligro" id="mp-cancelar">Cancelar pedido</button></div>' : ''}</div>`, true);
    d.onclick = async ev => {
      const r = ev.target.closest('[data-rem]');
      if (r) imprimirRemision(p, p.envios.find(x => x.id === r.dataset.rem));
      if (ev.target.id === 'mp-cancelar' && confirm('¿Cancelar este pedido?')) {
        try {
          await conCarga('Cancelando…', () => api('cancelarPedido', { id: p.id, motivo: 'Cancelado por el cliente' }));
          cerrarModal(); toast('Pedido cancelado.', 'ok'); PT.datos = null; vMisPedidos(el);
        } catch (err) { toast(err.message, 'error'); }
      }
    };
  };
}

async function vEstadoCuenta(el) {
  el.innerHTML = '<div class="titulo"><h2>Estado de cuenta</h2><button type="button" class="btn sec" id="ec-imp">Imprimir</button></div><div id="ec-cuerpo"></div>';
  const c = $('#ec-cuerpo', el);
  const D = await cargarPortal(c);
  if (!D) return;
  const hoy = D.hoy;
  const abiertas = D.cuentas.filter(x => Number(x.saldo) > 0.005).sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
  const cli = D.cliente;
  const filas = D.cuentas.slice().sort((a, b) => String(b.fecha_cuenta).localeCompare(String(a.fecha_cuenta)));
  const estado = x => (Number(x.saldo) <= 0.005 ? '<span class="est cxp-PAGADA">Pagado</span>' : String(x.vence) < hoy ? '<span class="est cxp-VENCIDA">Vencido</span>'
    : String(x.vence) <= sumarDiasYmd(hoy, 5) ? '<span class="est cxp-POR_VENCER">Por vencer</span>' : '<span class="est cxp-PENDIENTE">Pendiente</span>');
  const tabla = `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Fecha</th><th>Documento</th><th>Vence</th><th class="num">Importe</th><th class="num">Abonado</th><th class="num">Saldo</th><th>Estado</th></tr></thead>
    <tbody>${filas.map(x => `<tr><td>${fechaCorta(x.fecha_cuenta)}</td><td>${esc(x.folio)}</td><td>${fechaCorta(x.vence)}</td><td class="num">${dinero(x.monto)}</td>
      <td class="num">${dinero(x.pagado)}</td><td class="num"><b>${dinero(x.saldo)}</b></td><td>${estado(x)}</td></tr>`).join('') || '<tr><td colspan="7" class="vacio">Sin movimientos.</td></tr>'}</tbody></table></div>`;
  const abonos = D.abonos.slice().sort((a, b) => String(b.fecha_abono).localeCompare(String(a.fecha_abono)));
  c.innerHTML = `<div class="tarjetas">
      <div class="tarjeta"><span>Saldo total</span><b>${dinero(cli.saldo)}</b><small>${plural(abiertas.length, 'documento')}</small></div>
      ${cli.credito ? `<div class="tarjeta"><span>Crédito disponible</span><b>${dinero(D.disponible)}</b><small>Límite ${dinero(cli.limite_credito)}</small></div>` : ''}
      <div class="tarjeta ${cli.vencido > 0 ? 'alerta-roja' : ''}"><span>Vencido</span><b>${dinero(cli.vencido)}</b></div>
      ${abiertas.length ? `<div class="tarjeta"><span>Próximo vencimiento</span><b>${fechaCorta(abiertas[0].vence)}</b><small>${dinero(abiertas[0].saldo)}</small></div>` : ''}
    </div>${tabla}
    ${abonos.length ? `<h3>Pagos recibidos</h3><div class="tabla-cont"><table class="tabla"><thead><tr><th>Fecha</th><th>Forma de pago</th><th>Referencia</th><th class="num">Monto</th></tr></thead>
      <tbody>${abonos.map(a => `<tr><td>${fechaCorta(a.fecha_abono)}</td><td>${METODO_TXT[a.metodo] || a.metodo}</td><td>${esc(a.referencia || '')}</td><td class="num">${dinero(a.monto)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $('#ec-imp', el).onclick = () => imprimirDocumento('Estado de cuenta', `
    <div class="cab"><div style="display:flex;gap:10px;align-items:center"><img src="icons/icon-192.png" alt=""><h1>${esc(CFG.NOMBRE)}</h1></div>
      <div style="text-align:right"><h1>ESTADO DE CUENTA</h1>${fechaCorta(hoy)}</div></div>
    <div class="cajas"><div class="caja"><h3>Cliente</h3><b>${esc(cli.nombre)}</b>${cli.rfc ? '<br>RFC ' + esc(cli.rfc) : ''}</div>
      <div class="caja"><h3>Resumen</h3>Saldo: <b>${dinero(cli.saldo)}</b><br>Vencido: ${dinero(cli.vencido)}${cli.credito ? '<br>Crédito disponible: ' + dinero(D.disponible) : ''}</div></div>
    <table><thead><tr><th>Fecha</th><th>Documento</th><th>Vence</th><th class="n">Importe</th><th class="n">Abonado</th><th class="n">Saldo</th></tr></thead>
      <tbody>${filas.map(x => `<tr><td>${fechaCorta(x.fecha_cuenta)}</td><td>${esc(x.folio)}</td><td>${fechaCorta(x.vence)}</td><td class="n">${dinero(x.monto)}</td><td class="n">${dinero(x.pagado)}</td><td class="n">${dinero(x.saldo)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="5" class="n">Saldo total</td><td class="n">${dinero(cli.saldo)}</td></tr></tbody></table>`);
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
        <label id="lbl-cli">Cliente (acceso al portal)<select name="cliente_id"><option value="">Elige…</option>${(S.clientes || []).slice().sort(porNombre).map(c => `<option value="${esc(c.id)}" ${c.id === u.cliente_id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
      </div>
      <label>${nuevo ? 'Contraseña inicial' : 'Nueva contraseña (déjala vacía para no cambiarla)'}<input name="password" type="text" ${nuevo ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
      <p class="nota">Al entrar por primera vez se le pedirá cambiarla.</p>
      ${nuevo ? '' : `<label class="chk"><input type="checkbox" name="activo" ${u.activo ? 'checked' : ''}> Activo</label>`}
      <p class="msg" id="fu-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fu', d);
  const pintarAlm = () => {
    $('#lbl-alm', d).hidden = ['ADMIN_GENERAL', 'CLIENTE'].includes(f.rol.value);
    $('#lbl-cli', d).hidden = f.rol.value !== 'CLIENTE';
  };
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
        almacen_id: f.almacen_id.value, cliente_id: f.cliente_id.value, password: f.password.value, activo: nuevo ? true : f.activo.checked
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
    ${esGeneral() ? `<div class="panel"><h3>Empresa</h3><p class="nota">Nombre, RFC, dirección y logo que aparecen en las órdenes de compra.</p><button type="button" class="btn sec" id="b-empresa">Datos de la empresa</button></div>` : ''}
    ${esAdminCaja() || rol() === 'CAJERO' ? `<div class="panel"><h3>Impresora de tickets</h3><p class="nota">Ancho del papel, ticket doble, logo y cómo imprimir directo en este equipo.</p><button type="button" class="btn sec" id="b-imp">Configurar impresora</button></div>` : ''}
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
  const bimp = $('#b-imp', el);
  if (bimp) bimp.onclick = dlgImpresora;
  if (esGeneral()) $('#b-empresa', el).onclick = dlgEmpresa;
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
  await cargarImpresora().catch(() => {});

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
  document.addEventListener('keydown', e => {
    if (e.key === 'F2' && S.vista === 'caja' && !$('#dlg').open) { e.preventDefault(); const b = $('#cj-cobrar'); if (b && !b.disabled) b.click(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.usuario && navigator.onLine &&
        Date.now() - S.ultimaSync > CFG.SYNC_MINUTOS * 60000) sincronizar();
  });

  const ses = await DB.get('sesion');
  if (ses && ses.usuario) {
    await cargarSesion(ses);
    S.vista = rol() === 'CAJERO' ? 'caja' : 'inicio';
    mostrarApp();
    if (navigator.onLine) sincronizar();
  } else {
    mostrarLogin('', /^https?:\/\//.test(CFG.API_URL) ? '' : 'Falta configurar API_URL en config.js.');
  }
  ocultarCarga(true);

  setInterval(() => { if (S.usuario && navigator.onLine) sincronizar(); }, Math.max(1, Number(CFG.SYNC_MINUTOS) || 15) * 60000);
  setInterval(actualizarBarra, 30000);
}

document.addEventListener('DOMContentLoaded', iniciar);
