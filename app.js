'use strict';
/* Control de Inventario — Fase 1
 * App instalable que funciona sin internet con los últimos datos descargados.
 * Servidor: Google Apps Script (API) + Google Sheets (base de datos). */

const CFG = Object.assign({ NOMBRE: 'Control de Inventario', SYNC_MINUTOS: 15, API_URL: '' }, window.APP_CONFIG || {});
CFG.NOMBRE_ORIGINAL = CFG.NOMBRE;
const VERSION_APP = '5.7.5';

const ROL_TXT = {
  ADMIN_GENERAL: 'Administrador general',
  ADMIN_SUCURSAL: 'Administrador de sucursal',
  INVENTARIOS: 'Control de inventarios',
  CAJERO: 'Cajero',
  CLIENTE: 'Cliente',
  VERIFICADOR: 'Verificador de precios (tablet fija)'
};
const HORARIOS_ENTREGA = ['09:00-11:00', '11:00-13:00', '13:00-15:00', '15:00-17:00', '17:00-19:00', '19:00-21:00'];
const entregaTxt = p => [p.horario_entrega ? p.horario_entrega.replace('-', ' a ') : '', p.modalidad === 'RECOGER' ? 'recoge en tienda' : p.modalidad === 'DOMICILIO' ? 'a domicilio' : ''].filter(Boolean).join(' · ');
// Si el equipo quedó como verificador de precios, al recargar vuelve a esa pantalla
const kioscoGuardado = () => { try { return localStorage.getItem('kiosco_verificador') === '1'; } catch (e) { return false; } };
const vistaInicial = () => (kioscoGuardado() && VISTAS.verificador.roles.includes(rol()) ? 'verificador' : ({ CAJERO: 'caja', VERIFICADOR: 'verificador' })[rol()] || 'inicio');
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
  d.classList.toggle('ancho', ancho === true);
  d.classList.toggle('medio', ancho === 'medio');
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
  if (!S.usuario || S.usuario.usuario !== ses.usuario.usuario) { CMP.datos = null; CPP.datos = null; PER.base = null; ANA.datos = null; ANA.temp = null; CJ.estado = null; VT.cli = null; VT.ventas = null; PD.datos = null; PT.datos = null; PT.carrito = null; }
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
  S.otras = (await DB.get('otras')) || null;
  S.cajaAnterior = (await DB.get('cajaAnterior')) || {};
  const cj = (await DB.get('cajas')) || {};
  S.cajas = cj.lista || [];
  S.cajasAbiertas = cj.abiertas || {};
  S.cliente = rol() === 'CLIENTE' ? (await DB.get('cliente')) || null : null;
  S.avisos = (await DB.get('avisos')) || null;
  S.temporadasAviso = (await DB.get('temporadasAviso')) || [];
  S.temporadasLista = (await DB.get('temporadasLista')) || [];
  S.personalAvisos = (await DB.get('personalAvisos')) || null;
  S.horariosEntrega = (await DB.get('horariosEntrega')) || null;
  S.avisosCliente = (await DB.get('avisosCliente')) || null;
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
    S.vista = vistaInicial();
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
    await enviarChecadas();
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
    S.otras = d.otras || null;
    await DB.set('otras', S.otras);
    if (d.cajaAnterior) { S.cajaAnterior = d.cajaAnterior; await DB.set('cajaAnterior', S.cajaAnterior); }
    if (d.cajas) { S.cajas = d.cajas; S.cajasAbiertas = d.cajasAbiertas || {}; await DB.set('cajas', { lista: S.cajas, abiertas: S.cajasAbiertas }); }
    S.alertas = d.alertas || null;
    await DB.set('alertas', S.alertas);
    S.avisos = d.avisos || null;
    await DB.set('avisos', S.avisos);
    if (d.temporadas) { S.temporadasAviso = d.temporadas; await DB.set('temporadasAviso', S.temporadasAviso); }
    if (d.temporadas_lista) { S.temporadasLista = d.temporadas_lista; await DB.set('temporadasLista', S.temporadasLista); }
    S.personalAvisos = d.personal || null;
    await DB.set('personalAvisos', S.personalAvisos);
    if (d.horarios_entrega) { S.horariosEntrega = d.horarios_entrega; await DB.set('horariosEntrega', S.horariosEntrega); }
    if (d.avisos_cliente) {
      S.avisosCliente = d.avisos_cliente;
      await DB.set('avisosCliente', S.avisosCliente);
      notificarNuevos(d.avisos_cliente.nuevos, 'avisosVistos:' + d.usuario.usuario, './');
    }
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
    revisarApariencia(d.apariencia_v);
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
  analisis: { titulo: 'Análisis', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS'], render: vAnalisis },
  personal: { titulo: 'Personal', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'], render: vPersonal },
  checador: { titulo: 'Checador', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vChecador },
  almacenes: { titulo: 'Almacenes', roles: ['ADMIN_GENERAL'], render: vAlmacenes },
  usuarios: { titulo: 'Usuarios', roles: ['ADMIN_GENERAL', 'ADMIN_SUCURSAL'], render: vUsuarios },
  tienda: { titulo: 'Hacer pedido', roles: ['CLIENTE'], render: vTienda },
  entienda: { titulo: 'Comprar en tienda', roles: ['CLIENTE'], render: vEnTienda },
  avisos: { titulo: 'Avisos', roles: ['CLIENTE'], render: vAvisos },
  verificador: { titulo: 'Verificador de precios', roles: ['VERIFICADOR', 'ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS', 'CAJERO'], render: vVerificador },
  mispedidos: { titulo: 'Mis pedidos', roles: ['CLIENTE'], render: vMisPedidos },
  estado: { titulo: 'Estado de cuenta', roles: ['CLIENTE'], render: vEstadoCuenta },
  cuenta: { titulo: 'Mi cuenta', roles: null, render: vCuenta }
};
const puedeVer = k => !VISTAS[k].roles || VISTAS[k].roles.includes(rol());

function mostrarLogin(usuario = '', msg = '') {
  $('#toasts').innerHTML = '';
  $('#pantalla-app').hidden = true;
  $('#pantalla-publica').hidden = true;
  $('#pantalla-login').hidden = false;
  actualizarBurbujaPrecio();
  const f = $('#form-login');
  if (usuario) f.usuario.value = usuario;
  $('#login-msg').textContent = msg;
  $('#login-estado').textContent = navigator.onLine ? '' : 'Sin conexión: solo pueden entrar usuarios que ya usaron este equipo.';
  (usuario ? f.password : f.usuario).focus();
}

function mostrarApp() {
  bloquearKiosco(rol() === 'VERIFICADOR' || S.vista === 'verificador');
  setTimeout(actualizarBurbujaPrecio, 0);
  $('#pantalla-login').hidden = true;
  $('#pantalla-publica').hidden = true;
  $('#pantalla-app').hidden = false;
  pintarMenu();
  pintarVista();
  actualizarBarra();
}

// Menú agrupado por áreas; cada entrada es [vista, título, pestaña opcional]
const GRUPOS_MENU = [
  ['Vender', [['caja', 'Caja'], ['ventas', 'Ventas y cortes', 'ventas'], ['ventas', 'Clientes', 'clientes'], ['ventas', 'Por cobrar', 'cobrar'], ['pedidos', 'Pedidos'], ['verificador', 'Verificador de precios']]],
  ['Inventario', [['productos', 'Productos'], ['inventario', 'Inventario'], ['movimientos', 'Movimientos'], ['analisis', 'Análisis y temporadas'], ['almacenes', 'Almacenes']]],
  ['Compras', [['compras', 'Compras y proveedores'], ['pagar', 'Por pagar']]],
  ['Personal', [['personal', 'Personal y nómina'], ['checador', 'Checador']]],
  ['Ajustes', [['usuarios', 'Usuarios'], ['cuenta', 'Mi cuenta']]]
];
function burbujaVista(k) {
  return k === 'pagar' && S.alertas ? S.alertas.vencidas + S.alertas.por_vencer
    : k === 'pedidos' && S.avisos ? S.avisos.solicitados + S.avisos.por_surtir + (rol() === 'ADMIN_SUCURSAL' ? S.avisos.en_ruta : 0)
    : k === 'personal' && S.personalAvisos ? S.personalAvisos.vacaciones + S.personalAvisos.adelantos
    : k === 'analisis' && S.temporadasAviso ? S.temporadasAviso.length
    : k === 'avisos' && S.avisosCliente ? S.avisosCliente.no_leidos : 0;
}
const esActivaMenu = (k, tab) => S.vista === k && (!tab || (typeof VT !== 'undefined' && VT.pestana === tab));
function pintarMenu() {
  const chip = (n, roja) => (n ? `<span class="burbuja ${roja ? 'roja' : ''}">${n}</span>` : '');
  const boton = (k, t, tab) => `<button type="button" data-v="${k}" ${tab ? `data-tab="${tab}"` : ''} class="${esActivaMenu(k, tab) ? 'activo' : ''}">${t}${tab && tab !== 'ventas' ? '' : chip(burbujaVista(k), k === 'pagar' && S.alertas && S.alertas.vencidas)}</button>`;
  // Clientes y verificador: pocas opciones, menú simple
  if (['CLIENTE', 'VERIFICADOR'].includes(rol())) {
    $('#menu').innerHTML = Object.keys(VISTAS).filter(puedeVer).map(k => boton(k, VISTAS[k].titulo)).join('');
    return;
  }
  const html = [boton('inicio', 'Inicio')];
  GRUPOS_MENU.forEach(([nombre, items]) => {
    const vis = items.filter(([k]) => VISTAS[k] && puedeVer(k));
    if (!vis.length) return;
    if (vis.length === 1) { html.push(boton(vis[0][0], vis[0][1], vis[0][2])); return; }
    const n = [...new Set(vis.map(x => x[0]))].reduce((s, k) => s + (burbujaVista(k) || 0), 0);
    const activo = vis.some(([k, , tab]) => esActivaMenu(k, tab));
    html.push(`<div class="menu-grupo ${activo ? 'activo' : ''}"><button type="button" class="menu-cab" aria-haspopup="true" aria-expanded="false">${nombre}${chip(n)}<span class="flecha">▾</span></button>
      <div class="menu-lista" hidden>${vis.map(([k, t, tab]) => boton(k, t, tab)).join('')}</div></div>`);
  });
  $('#menu').innerHTML = html.join('');
}

function irA(k) {
  S.vista = k;
  pintarMenu();
  pintarVista();
  actualizarBurbujaPrecio();
  window.scrollTo(0, 0);
}

function pintarVista() {
  if (!S.usuario) return;
  if (rol() === 'VERIFICADOR') S.vista = 'verificador';
  if (!puedeVer(S.vista)) S.vista = 'inicio';
  if (AT.cam) { AT.cam.detener(); AT.cam = null; }
  if (VF.cam && S.vista !== 'verificador') { VF.cam.detener(); VF.cam = null; }
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
    ${VISTAS.analisis.roles.includes(rol()) && S.temporadasAviso && S.temporadasAviso.length ? `<div class="panel aviso-temp"><h3>Temporadas próximas</h3><ul class="lista">${S.temporadasAviso.map(t => `<li class="clic" data-ir-temp="${esc(t.id)}"><span><b>${esc(t.nombre)}</b>
        <small>${t.en_temporada ? 'En temporada' : `Empieza el ${fechaCorta(t.inicio)} · faltan ${t.dias_faltan} días`}</small></span><span class="btn mini sec">Preparar</span></li>`).join('')}</ul></div>` : ''}
    ${S.personalAvisos && (S.personalAvisos.vacaciones || S.personalAvisos.adelantos) ? `<div class="tarjetas"><button type="button" class="tarjeta alerta" id="t-pers"><span>Solicitudes del personal</span><b>${S.personalAvisos.vacaciones + S.personalAvisos.adelantos}</b>
        <small>${S.personalAvisos.vacaciones} de vacaciones · ${plural(S.personalAvisos.adelantos, 'adelanto')}</small></button></div>` : ''}
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
  $$('[data-ir-temp]', el).forEach(b => { b.onclick = () => { ANA.tab = 'temporadas'; ANA.temp = b.dataset.irTemp; irA('analisis'); }; });
  const tp = $('#t-pers', el);
  if (tp) tp.onclick = () => { PER.tab = 'solicitudes'; irA('personal'); };
  S.refrescar = () => vInicio(el);
}

/* ---- Productos ---- */
function vProductos(el) {
  const puede = puedeCatalogo();
  const borra = esGeneral();
  const veVentas = ['ADMIN_GENERAL', 'ADMIN_SUCURSAL', 'INVENTARIOS'].includes(rol());
  F.psel = F.psel || new Set();
  F.pper = F.pper || '7';
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo)).sort(porNombre);
  el.innerHTML = `
    <div class="titulo"><h2>Productos</h2>${puede ? `<div class="acciones"><button type="button" class="btn sec" id="btn-cats">Categorías</button><button type="button" class="btn sec" id="btn-importar">Importar Excel</button><button type="button" class="btn" id="btn-nuevo">Nuevo producto</button></div>` : ''}</div>
    <div class="filtros">
      <input id="f-q" type="search" placeholder="Buscar por nombre, código o escanea el código de barras" value="${esc(F.pq || '')}" autocomplete="off">
      <select id="f-cat"><option value="">Todas las categorías</option>${cats.map(c => `<option value="${esc(c.id)}" ${F.pcat === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="f-inact" ${F.pinact ? 'checked' : ''}> Ver inactivos</label>
      ${veVentas ? `<select id="f-orden"><option value="">Ordenar por nombre</option><option value="cantidad">Más vendidos (piezas)</option><option value="importe">Más vendidos (importe)</option></select>
      <select id="f-per" ${F.porden ? '' : 'hidden'}>${Object.entries(PERIODOS).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join('')}</select>` : ''}
    </div>
    <p class="nota" id="p-mv" hidden></p>
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
    // Ventas del periodo (si se ordena por más vendidos)
    const mv = F.porden ? MV[F.pper] : null;
    const vend = id => (mv && mv.mapa[id]) || { cantidad: 0, importe: 0 };
    let lista = S.catalogo.productos
      .filter(p => (F.pinact || esActivo(p.activo)) && (!F.pcat || p.categoria_id === F.pcat) && (!q || coincide(p, q)))
      .sort(mv ? (a, b) => (vend(b.id)[F.porden] - vend(a.id)[F.porden]) || porNombre(a, b) : porNombre);
    filtrados = lista;
    const pmv = $('#p-mv', el);
    if (pmv) {
      pmv.hidden = !mv;
      if (mv) pmv.innerHTML = `Ventas del <b>${fechaCorta(mv.desde)}</b> al <b>${fechaCorta(mv.hasta)}</b>${esGeneral() ? ' en todas las sucursales' : ''}: ${numero(mv.piezas)} piezas · ${dinero(mv.importe)}. Sin contar ventas canceladas.`;
    }
    const total = lista.length;
    lista = lista.slice(0, 300);
    $('#lista', el).innerHTML = total ? `
      <div class="tabla-cont"><table class="tabla">
        <thead><tr>${borra ? '<th class="col-sel"><input type="checkbox" id="ps-pag" title="Seleccionar los de esta página"></th>' : ''}${mv ? '<th class="num">#</th>' : ''}<th>Código</th><th>Producto</th><th>Categoría</th>${veCostos() ? '<th class="num">Costo</th>' : ''}<th class="num">Menudeo</th><th class="num">Mayoreo</th><th class="num">Existencia</th>${mv ? '<th class="num">Vendido</th><th class="num">Importe</th>' : ''}</tr></thead>
        <tbody>${lista.map((p, ip) => {
          const c = alms.reduce((s, a) => s + (ex[a.id + '|' + p.id] || 0), 0);
          const bajo = Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo);
          return `<tr data-id="${esc(p.id)}" class="clic ${esActivo(p.activo) ? '' : 'inactivo'} ${F.psel.has(p.id) ? 'sel' : ''}">
            ${borra ? `<td class="col-sel"><input type="checkbox" data-sel="${esc(p.id)}" ${F.psel.has(p.id) ? 'checked' : ''}></td>` : ''}
            ${mv ? `<td class="num rank">${vend(p.id).cantidad > 0 ? ip + 1 : ''}</td>` : ''}
            <td>${esc(p.codigo)}${p.codigo_barras ? `<small>${esc(p.codigo_barras)}</small>` : ''}</td>
            <td>${esc(p.nombre)}</td>
            <td>${esc(S.idx.cat[p.categoria_id] ? S.idx.cat[p.categoria_id].nombre : '—')}</td>
            ${veCostos() ? `<td class="num">${dinero(p.costo)}</td>` : ''}
            <td class="num">${dinero(p.precio_menudeo)}</td>
            <td class="num">${dinero(p.precio_mayoreo)}</td>
            <td class="num ${bajo ? 'txt-error' : ''}">${numero(c)} ${esc(p.unidad || '')}</td>
            ${mv ? `<td class="num"><b>${numero(vend(p.id).cantidad)}</b></td><td class="num">${dinero(vend(p.id).importe)}</td>` : ''}</tr>`;
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
  if (veVentas) {
    const fo = $('#f-orden', el), fp = $('#f-per', el);
    fo.value = F.porden || '';
    fp.value = F.pper;
    const aplicar = async () => {
      F.porden = fo.value; F.pper = fp.value;
      fp.hidden = !F.porden;
      if (F.porden && !MV[F.pper]) {
        if (!navigator.onLine) { toast('Necesitas conexión para consultar las ventas.', 'error'); fo.value = F.porden = ''; fp.hidden = true; return; }
        const [desde, hasta] = PERIODOS[F.pper][1]();
        try {
          const r = await conCarga('Consultando ventas…', () => api('masVendidos', { desde, hasta }));
          const mapa = {};
          r.productos.forEach(x => { mapa[x.producto_id] = x; });
          MV[F.pper] = { desde: r.desde, hasta: r.hasta, mapa, piezas: r.productos.reduce((t, x) => t + x.cantidad, 0), importe: r.productos.reduce((t, x) => t + x.importe, 0) };
          setTimeout(() => { delete MV[F.pper]; }, 5 * 60000);   // se vuelve a consultar después de 5 minutos
        } catch (e) { toast(e.message, 'error'); fo.value = F.porden = ''; fp.hidden = true; return; }
      }
      pintar();
    };
    fo.onchange = aplicar;
    fp.onchange = aplicar;
    if (F.porden) aplicar();
  }
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

// Periodos para "más vendidos": [texto, () => [desde, hasta]]
const MV = {};
const PERIODOS = {
  '7': ['Últimos 7 días', () => [hoyLocal(-6), hoyLocal()]],
  semana: ['Esta semana', () => { const d = new Date().getDay() || 7; return [hoyLocal(1 - d), hoyLocal()]; }],
  mes: ['Este mes', () => [hoyLocal().slice(0, 8) + '01', hoyLocal()]],
  '30': ['Últimos 30 días', () => [hoyLocal(-29), hoyLocal()]],
  mespas: ['Mes pasado', () => { const h = new Date(); const ini = new Date(h.getFullYear(), h.getMonth() - 1, 1), fin = new Date(h.getFullYear(), h.getMonth(), 0);
    const f = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; return [f(ini), f(fin)]; }]
};

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
    <form id="fp" class="form dos-col">
      <div class="col">
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
      <div class="fila3">
        <label>Caducidad del inventario actual <small>(opcional)</small><input name="caducidad" type="date" value="${val(p.caducidad)}" ${ro}></label>
        <label>Producto de temporada<select name="temporada_id" ${ro}><option value="">No es de temporada</option>${(S.temporadasLista || []).map(t => `<option value="${esc(t.id)}" ${p.temporada_id === t.id ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}
          ${p.temporada_id && !(S.temporadasLista || []).some(t => t.id === p.temporada_id) ? `<option value="${esc(p.temporada_id)}" selected>(temporada actual)</option>` : ''}</select></label>
        <label class="chk"><input type="checkbox" name="descontinuado" ${esActivo(p.descontinuado || false) ? 'checked' : ''} ${ro}> Descontinuado (vender lo que queda y no volver a comprar)</label>
      </div>
      </div>
      <div class="col">
      <div class="prod-media">
        <div class="prod-foto" id="fp-foto">${p.imagen ? `<img data-img="${esc(p.imagen)}" alt="">` : '<span>Sin imagen</span>'}</div>
        <div class="prod-media-der">
          <label>Descripción <small>(se ve en la caja)</small><textarea name="descripcion" rows="3" maxlength="600" ${ro}>${val(p.descripcion)}</textarea></label>
          ${puede ? `<div class="acciones"><label class="btn mini sec">${p.imagen ? 'Cambiar imagen' : 'Agregar imagen'}<input type="file" accept="image/*" id="fp-img" hidden></label>
            <button type="button" class="btn mini sec" id="fp-img-quitar" ${p.imagen ? '' : 'hidden'}>Quitar imagen</button></div>` : ''}
        </div>
      </div>
      ${!nuevo && alms.length ? (() => { const red = mapaRed(); const ver = almacenesActivos().filter(a => alms.some(x => x.id === a.id) || (red[a.id + '|' + p.id] || 0) > 0);
        return `<div class="existencias"><b>Existencias</b>${ver.map(a => `<span>${esc(a.nombre)}: <b>${numero(red[a.id + '|' + p.id] || 0)}</b> ${esc(p.unidad || '')}</span>`).join('')}</div>`; })() : ''}
      </div>
      <p class="msg" id="fp-msg"></p>
      ${puede ? `<div class="pie">${!nuevo && esGeneral() ? '<button type="button" class="btn peligro izq" id="fp-del">Eliminar</button>' : ''}<button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>` : ''}
    </form>`, 'medio');
  const f = $('#fp', d);
  cargarImgs($('#fp-foto', d));
  let imagenNueva = null;   // data URL elegido, '' = quitar, null = sin cambio
  const finp = $('#fp-img', d);
  if (finp) finp.onchange = async e => {
    const a = e.target.files[0];
    if (!a) return;
    try {
      imagenNueva = await reducirImagen(a, 500, { limite: 300000 });
      $('#fp-foto', d).innerHTML = `<img src="${imagenNueva}" alt="">`;
      $('#fp-img-quitar', d).hidden = false;
    } catch (er) { $('#fp-msg', d).textContent = er.message; }
  };
  const fq = $('#fp-img-quitar', d);
  if (fq) fq.onclick = () => { imagenNueva = ''; $('#fp-foto', d).innerHTML = '<span>Sin imagen</span>'; fq.hidden = true; };
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
      caducidad: f.caducidad.value,
      temporada_id: f.temporada_id.value,
      descontinuado: f.descontinuado.checked,
      descripcion: f.descripcion.value.trim(),
      activo: f.activo.checked
    };
    btn.disabled = true;
    msg.textContent = 'Guardando…';
    try {
      let r = await api('guardarProducto', { producto });
      if (imagenNueva) {
        msg.textContent = 'Subiendo imagen…';
        r = await api('subirImagenProducto', { producto_id: r.id, datos: imagenNueva });
        IMGS.mem[r.imagen] = imagenNueva;
        DB.set('img:' + r.imagen, imagenNueva);
      } else if (imagenNueva === '' && r.imagen) r = await api('quitarImagenProducto', { producto_id: r.id });
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
  { clave: 'existencia', titulo: 'Existencia', ancho: 12, num: true, alias: ['existencia', 'cantidad', 'stock', 'inventario', 'existencias'] },
  { clave: 'descripcion', titulo: 'Detalle para la caja', ancho: 40, alias: ['detalle para la caja', 'detalle', 'descripcion larga', 'detalle del producto'] }
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
  ['• Detalle para la caja: texto opcional que ve el cajero al registrar el producto (presentación, sabor, uso...).'],
  ['• No cambies los títulos de la primera fila ni el nombre de la hoja.'],
  ['• Puedes guardar como .xlsx o .csv.'],
  [''],
  ['Ejemplo de filas:'],
  ['Código interno', 'Código de barras', 'Nombre *', 'Categoría', 'Unidad', 'Costo', 'Precio menudeo', 'Precio mayoreo', 'Stock mínimo', 'Existencia', 'Detalle para la caja'],
  ['', '7501055300013', 'Arroz Morelos 1 kg', 'Abarrotes', 'PZA', 22, 32, 28, 30, 120, 'Grano largo, bolsa de 1 kg'],
  ['A-102', '', 'Queso fresco', 'Lácteos', 'KG', 85, 120, 110, 5, 12.5, '']
];

function descargarPlantilla(conCatalogo) {
  const filas = [COLS_IMPORT.map(c => c.titulo)];
  if (conCatalogo) {
    S.catalogo.productos.filter(p => esActivo(p.activo)).sort(porNombre).forEach(p => {
      filas.push([p.codigo || '', p.codigo_barras || '', p.nombre, (S.idx.cat[p.categoria_id] || {}).nombre || '', p.unidad || '',
        veCostos() ? Number(p.costo) || 0 : '', Number(p.precio_menudeo) || 0, Number(p.precio_mayoreo) || 0, Number(p.stock_minimo) || 0, '', p.descripcion || '']);
    });
  }
  const blob = Excel.crearXlsx([
    { nombre: 'Productos', filas, encabezado: true, anchos: COLS_IMPORT.map(c => c.ancho), columnasTexto: [0, 1] },
    { nombre: 'Instrucciones', filas: INSTRUCCIONES_IMPORT, anchos: [16, 18, 36, 14, 9, 9, 15, 15, 13, 12, 30], columnasTexto: [1] }
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
  const todos = almacenesActivos();
  const hayRed = todos.length > 1;
  if (!F.ialm || !(alms.some(a => a.id === F.ialm) || (F.ialm === '*' && hayRed))) F.ialm = alms[0] ? alms[0].id : '';
  el.innerHTML = `
    <div class="titulo"><h2>Inventario</h2><div class="acciones"><button type="button" class="btn sec" id="btn-donde">¿Dónde hay?</button><button type="button" class="btn sec" id="btn-csv">Exportar CSV</button></div></div>
    <div class="filtros">
      ${alms.length > 1 || hayRed
        ? `<select id="f-alm">${alms.map(a => `<option value="${esc(a.id)}" ${a.id === F.ialm ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}
            ${hayRed ? `<option value="*" ${F.ialm === '*' ? 'selected' : ''}>Todos los almacenes</option>` : ''}</select>`
        : `<span class="chip">${esc(alms[0] ? alms[0].nombre : 'Sin almacén asignado')}</span>`}
      <input id="f-q" type="search" placeholder="Buscar producto o escanear" value="${esc(F.iq || '')}" autocomplete="off">
      <label class="chk"><input type="checkbox" id="f-bajo" ${F.ibajo ? 'checked' : ''}> Solo bajo mínimo</label>
    </div>
    <div id="res" class="tarjetas"></div>
    <div id="lista"></div>`;

  const filas = () => {
    const red = F.ialm === '*';
    const ex = red ? mapaRed() : mapaExistencias();
    const q = normal(F.iq || '');
    return S.catalogo.productos
      .filter(p => esActivo(p.activo) && (!q || coincide(p, q)))
      .map(p => {
        if (!red) return { p, c: ex[F.ialm + '|' + p.id] || 0 };
        const por = todos.map(a => ex[a.id + '|' + p.id] || 0);
        return { p, por, c: por.reduce((s, n) => s + n, 0) };
      })
      .filter(x => !F.ibajo || (Number(x.p.stock_minimo) > 0 && x.c < Number(x.p.stock_minimo)))
      .sort((a, b) => porNombre(a.p, b.p));
  };

  const pintar = () => {
    const l = filas();
    if (F.ialm === '*') return pintarRed(l);
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
          return `<tr class="clic ${bajo ? 'fila-alerta' : ''}" data-p="${esc(p.id)}"><td>${esc(p.nombre)}</td><td>${esc(p.codigo)}</td>
            <td class="num ${c < 0 ? 'txt-error' : ''}"><b>${numero(c)}</b> ${esc(p.unidad || '')}</td>
            <td class="num">${numero(p.stock_minimo)}</td>
            ${costos ? `<td class="num">${dinero(p.costo)}</td><td class="num">${dinero(c * (Number(p.costo) || 0))}</td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>
      ${l.length > 500 ? `<p class="nota">Mostrando 500 de ${l.length}. Usa la búsqueda o exporta el CSV.</p>` : ''}`
      : '<p class="vacio">Sin productos para mostrar.</p>';
  };
  // Todos los almacenes: una columna por almacén y el total
  const pintarRed = l => {
    const mio = S.usuario.almacen_id;
    const unidades = l.reduce((s, x) => s + Math.max(0, x.c), 0);
    const sinNada = l.filter(x => x.c <= 0).length;
    $('#res', el).innerHTML = `
      <div class="tarjeta"><span>Productos</span><b>${numero(l.length)}</b></div>
      <div class="tarjeta"><span>Unidades en todos los almacenes</span><b>${numero(unidades)}</b></div>
      <div class="tarjeta ${sinNada ? 'alerta' : ''}"><span>Sin existencia en ningún lado</span><b>${numero(sinNada)}</b></div>
      ${veCostos() && esGeneral() ? `<div class="tarjeta"><span>Valor a costo</span><b>${dinero(l.reduce((s, x) => s + Math.max(0, x.c) * (Number(x.p.costo) || 0), 0))}</b></div>` : ''}`;
    const vis = l.slice(0, 500);
    $('#lista', el).innerHTML = l.length ? `
      <div class="tabla-cont"><table class="tabla tabla-red">
        <thead><tr><th>Producto</th>${todos.map(a => `<th class="num ${a.id === mio ? 'col-mia' : ''}">${esc(a.nombre)}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${vis.map(({ p, por, c }) => {
          const bajo = Number(p.stock_minimo) > 0 && c < Number(p.stock_minimo);
          return `<tr class="clic ${bajo ? 'fila-alerta' : ''}" data-p="${esc(p.id)}"><td>${esc(p.nombre)}<small>${esc(p.codigo)}</small></td>
            ${por.map((n, i) => `<td class="num ${todos[i].id === mio ? 'col-mia' : ''} ${n > 0 ? '' : n < 0 ? 'txt-error' : 'txt-suave'}">${n ? numero(n) : '—'}</td>`).join('')}
            <td class="num"><b>${numero(c)}</b> ${esc(p.unidad || '')}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${l.length > 500 ? `<p class="nota">Mostrando 500 de ${l.length}. Usa la búsqueda o exporta el CSV.</p>` : ''}
      <p class="nota">Toca un producto para ver dirección y teléfono de cada almacén${puedePedirTraspaso() ? ' o pedir un traspaso' : ''}. Existencias de la última actualización.</p>`
      : '<p class="vacio">Sin productos para mostrar.</p>';
  };
  pintar();
  S.refrescar = pintar;
  $('#lista', el).onclick = e => {
    const tr = e.target.closest('tr[data-p]');
    if (tr) dlgDondeHay(S.idx.prod[tr.dataset.p], S.usuario.almacen_id || (F.ialm !== '*' ? F.ialm : ''));
  };
  $('#btn-donde', el).onclick = () => dlgDondeHay(null);

  const alm = $('#f-alm', el);
  if (alm) alm.onchange = () => { F.ialm = alm.value; pintar(); };
  const q = $('#f-q', el);
  q.oninput = () => { F.iq = q.value; pintar(); };
  $('#f-bajo', el).onchange = e => { F.ibajo = e.target.checked; pintar(); };
  $('#btn-csv', el).onclick = () => {
    if (F.ialm === '*') {
      const csvR = [['Producto', 'Codigo', 'Unidad'].concat(todos.map(a => a.nombre), ['Total'])]
        .concat(filas().map(({ p, por, c }) => [p.nombre, p.codigo, p.unidad || ''].concat(por, [c])))
        .map(f => f.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const ar = document.createElement('a');
      ar.href = URL.createObjectURL(new Blob(['\ufeff' + csvR], { type: 'text/csv;charset=utf-8' }));
      ar.download = `inventario-todos-${new Date().toISOString().slice(0, 10)}.csv`;
      ar.click();
      setTimeout(() => URL.revokeObjectURL(ar.href), 2000);
      return;
    }
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

/* ---- Existencias en todos los almacenes ---- */
// Junta lo de este usuario (con movimientos pendientes) y lo que hay en los demás almacenes (última sincronización)
function mapaRed() {
  const m = mapaExistencias();
  (S.otras || []).forEach(([a, p, c]) => { const k = a + '|' + p; if (m[k] === undefined) m[k] = Number(c) || 0; });
  return m;
}
const almacenesActivos = () => S.catalogo.almacenes.filter(a => esActivo(a.activo))
  .sort((a, b) => (a.tipo === b.tipo ? porNombre(a, b) : a.tipo === 'BODEGA' ? -1 : 1));
const puedePedirTraspaso = () => ['ADMIN_SUCURSAL', 'CAJERO'].includes(rol()) && !!S.usuario.almacen_id;

// Cuánto hay en los otros almacenes (para avisar en la caja y en el visor)
function resumenOtros(pid, miAlm, red = mapaRed()) {
  return almacenesActivos().filter(a => a.id !== miAlm)
    .map(a => ({ a, c: red[a.id + '|' + pid] || 0 })).filter(x => x.c > 0);
}

// ¿Dónde hay? Muestra la existencia del producto en cada almacén, con opción de pedir traspaso o dar los datos al cliente
function dlgDondeHay(producto, miAlm = S.usuario.almacen_id) {
  const d = abrirModal('¿Dónde hay?', `<div class="form">
    <div id="dh-sel"></div>
    <div id="dh-res"></div>
    <p class="nota">Existencias de la última actualización (${S.ultimaSync ? fechaHora(S.ultimaSync) : 'nunca'}). Las de otras sucursales pueden haber cambiado desde entonces.</p>
  </div>`, true);
  const sel = selectorProducto($('#dh-sel', d), p => pintar(p));
  const pintar = p => {
    const res = $('#dh-res', d);
    if (!p) { res.innerHTML = '<p class="vacio">Busca o escanea un producto.</p>'; return; }
    const red = mapaRed();
    const filas = almacenesActivos().map(a => ({ a, c: red[a.id + '|' + p.id] || 0, mio: a.id === miAlm }))
      .sort((x, y) => (y.mio - x.mio) || (y.c - x.c));
    const total = filas.reduce((s, x) => s + Math.max(0, x.c), 0);
    const pedir = puedePedirTraspaso();
    res.innerHTML = `<div class="dh-cab"><b>${esc(p.nombre)}</b><span>Total en todos los almacenes: <b>${numero(total)} ${esc(p.unidad || '')}</b></span></div>
      <div class="tabla-cont"><table class="tabla"><thead><tr><th>Almacén</th><th>Dirección y teléfono</th><th class="num">Existencia</th><th></th></tr></thead>
      <tbody>${filas.map(({ a, c, mio }) => `<tr class="${mio ? 'fila-mia' : ''}">
        <td><b>${esc(a.nombre)}</b><small>${a.tipo === 'BODEGA' ? 'Bodega' : 'Sucursal'}${mio ? ' · aquí' : ''}</small></td>
        <td>${esc(a.direccion || '—')}${a.telefono ? `<small>Tel. ${esc(a.telefono)}</small>` : ''}</td>
        <td class="num ${c > 0 ? '' : 'txt-suave'}"><b>${numero(c)}</b> ${esc(p.unidad || '')}</td>
        <td class="dh-acc">${!mio && c > 0 ? `${pedir ? `<button type="button" class="btn mini" data-pedir="${esc(a.id)}">Pedir traspaso</button>` : ''}
          <button type="button" class="btn mini sec" data-datos="${esc(a.id)}">Datos para el cliente</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${total <= 0 ? '<p class="aviso-caja">No hay existencia en ningún almacén.</p>' : ''}
      <div id="dh-pedir"></div>`;
    res.onclick = e => {
      const bp = e.target.closest('[data-pedir]'), bd = e.target.closest('[data-datos]');
      if (bd) imprimirDatosSucursal(p, S.idx.alm[bd.dataset.datos], red[bd.dataset.datos + '|' + p.id] || 0);
      if (bp) formTraspaso(p, S.idx.alm[bp.dataset.pedir], red[bp.dataset.pedir + '|' + p.id] || 0);
    };
  };
  // Pide al otro almacén que mande el producto a esta sucursal (llega como solicitud en su sección de Pedidos)
  const formTraspaso = (p, origen, disponible) => {
    const c = $('#dh-pedir', d);
    c.innerHTML = `<form class="panel dh-form" id="fdh">
      <h3>Pedir ${esc(p.nombre)} a ${esc(origen.nombre)}</h3>
      <div class="fila2"><label>Cantidad<input name="cantidad" type="number" min="1" step="any" max="${disponible}" value="1" required inputmode="decimal"></label>
        <label>Nota para ${esc(origen.nombre)}<input name="notas" maxlength="200" placeholder="Ej. Un cliente lo espera hoy"></label></div>
      <p class="msg" id="fdh-msg"></p>
      <div class="pie"><button type="button" class="btn sec" id="fdh-no">Cancelar</button><button class="btn" type="submit">Enviar solicitud</button></div></form>`;
    const f = $('#fdh', c);
    f.cantidad.focus(); f.cantidad.select();
    $('#fdh-no', c).onclick = () => { c.innerHTML = ''; };
    f.onsubmit = async ev => {
      ev.preventDefault();
      const msg = $('#fdh-msg', c);
      const cant = Number(f.cantidad.value);
      if (!(cant > 0)) { msg.textContent = 'Escribe la cantidad.'; return; }
      if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para enviar la solicitud.'; return; }
      try {
        const r = await conCarga('Enviando solicitud…', () => api('guardarPedido', { pedido: {
          nuevo: true, id: uuid(), tipo: 'INTERNO', origen_id: origen.id, notas: f.notas.value.trim(),
          lineas: [{ producto_id: p.id, cantidad: cant }] } }));
        cerrarModal();
        toast(`Solicitud ${r.pedido.folio} enviada a ${origen.nombre}. Llegará como traspaso a tu sucursal.`, 'ok');
        if (rol() === 'ADMIN_SUCURSAL' && PD.datos) actualizarPedidoLocal(r.pedido);
      } catch (e) { msg.textContent = e.message; }
    };
  };
  if (producto) { sel.elegido = producto; sel.actualizar(); $('.sel-q', d).hidden = true; $('.elegido', d).hidden = false; }
  else $('.sel-q', d).focus();
  pintar(producto);
}

// Papelito para el cliente: a qué sucursal ir y cómo llegar
function imprimirDatosSucursal(p, a, cantidad) {
  imprimirDoc(() => [{ k: 'logo' }, { k: 'titulo', s: CFG.NOMBRE }, { k: 'sep' },
    { k: 'centro', s: 'Su producto está disponible en', neg: false }, { k: 'titulo', s: a.nombre },
    ...(a.direccion ? [{ k: 'centro', s: a.direccion }] : []), ...(a.telefono ? [{ k: 'centro', s: 'Tel. ' + a.telefono }] : []),
    { k: 'sep' }, { k: 'txt', s: p.nombre }, { k: 'par', a: 'Precio', b: dinero(p.precio_menudeo) },
    { k: 'txt', s: `Existencia al ${fechaHora(S.ultimaSync || Date.now())}: ${numero(cantidad)} ${p.unidad || ''}` },
    { k: 'sep' }, { k: 'centro', s: 'Le recomendamos llamar antes de ir.' }]);
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
  ctl.elegir = elegir;
  ctl.buscarOtro = () => { q.hidden = false; ele.hidden = true; q.value = ''; q.focus(); };   // deja el resultado y vuelve a escuchar el lector
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
        <label id="lbl-cad">Caduca <small>(opcional)</small><input name="caducidad" type="date"></label>
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
    $('#lbl-cad', el).hidden = M.tipo !== 'ENTRADA';
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
      caducidad: M.tipo === 'ENTRADA' ? fm.caducidad.value : '',
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
    fm.caducidad.value = '';
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
function dlgEditorOrden(base, modo = 'orden', inicial = null) {
  const esProg = modo === 'programada';
  const nuevo = !base;
  const D = CMP.datos;
  const almsDestino = almacenesVisibles();
  const almDef = (almsDestino.find(a => a.tipo === 'BODEGA') || almsDestino[0] || {}).id || '';
  const o = base ? JSON.parse(JSON.stringify(base)) : {
    proveedor_id: '', almacen_id: almDef, iva_tasa: 16, fecha_entrega: esProg ? '' : hoyLocal(3), notas: '', lineas: [],
    frecuencia: 'SEMANAL', proxima: hoyLocal(7), accion: 'BORRADOR', activo: true, nombre: '', ...(inicial || {})
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
    S.catalogo.productos.filter(p => esActivo(p.activo) && !esActivo(p.descontinuado || false) && Number(p.stock_minimo) > 0).forEach(p => {
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
      <div class="tabla-cont"><table class="tabla lineas-oc"><thead><tr><th>Producto</th><th class="num">Pendiente</th><th class="num">Llegó</th><th class="num">Costo unit.</th><th>Caduca</th></tr></thead>
        <tbody>${pendientes.map(({ l, pend }, i) => {
          const p = S.idx.prod[l.producto_id] || {};
          return `<tr><td>${esc(p.nombre || '—')}<small>${esc(p.codigo || '')}</small></td><td class="num">${numero(pend)} ${esc(p.unidad || '')}</td>
            <td class="num"><input type="number" min="0" step="any" data-i="${i}" data-k="cantidad" value="${pend}"></td>
            <td class="num"><input type="number" min="0" step="0.01" data-i="${i}" data-k="costo" value="${l.costo}"></td>
            <td><input type="date" data-i="${i}" data-k="caducidad" title="Fecha de caducidad (opcional)"></td></tr>`;
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
      costo: f.querySelector(`[data-i="${i}"][data-k="costo"]`).value,
      caducidad: f.querySelector(`[data-i="${i}"][data-k="caducidad"]`).value
    })).filter(x => x.cantidad > 0);
    if (!lineas.length) { msg.textContent = 'Captura al menos una cantidad recibida.'; return; }
    const demas = lineas.filter(x => x.cantidad > x.pend);
    if (demas.length && !confirm('Algunas cantidades son mayores a lo pendiente. ¿Registrar de todos modos?')) return;
    msg.textContent = '';
    try {
      const r = await conCarga('Registrando recepción…', () => api('recibirOrden', {
        id: o.id, recepcion_id: recepcionId, factura: f.factura.value.trim(), notas: f.notas.value.trim(),
        actualizar_costo: f.actualizar.checked, lineas: lineas.map(({ linea_id, cantidad, costo, caducidad }) => ({ linea_id, cantidad, costo, caducidad }))
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
      <div class="fila2"><label>Entregas a clientes desde<input name="entrega_inicio" type="time" step="1800" value="${esc(emp.entrega_inicio || '09:00')}"></label>
        <label>hasta<input name="entrega_fin" type="time" step="1800" value="${esc(emp.entrega_fin || '21:00')}"></label></div>
      <p class="nota" id="emp-franjas"></p>
      <div class="campo"><span>Logo para las órdenes de compra</span>
        <div class="fila-form"><img id="emp-logo" class="logo-prev" alt="" ${logo ? `src="${logo}"` : 'hidden'}>
          <div class="acciones"><label class="btn sec">Elegir imagen<input type="file" accept="image/png,image/jpeg" id="emp-arch" hidden></label>
          <button type="button" class="btn sec" id="emp-app">Usar el ícono de la app</button>
          <button type="button" class="btn sec" id="emp-quitar" ${logo ? '' : 'hidden'}>Quitar</button></div></div></div>
      <p class="msg" id="femp-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#femp', d), img = $('#emp-logo', d), msg = $('#femp-msg', d);
  const franjas = () => {
    const m = t => { const x = /^(\d{1,2}):(\d{2})/.exec(t || ''); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
    const h = v => String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
    const a = m(f.entrega_inicio.value), b = m(f.entrega_fin.value), l = [];
    if (a !== null && b !== null) for (let x = a; x < b && l.length < 12; x += 120) l.push(h(x) + ' a ' + h(Math.min(x + 120, b)));
    $('#emp-franjas', d).textContent = l.length ? 'Los clientes eligen entre: ' + l.join(' · ') : 'La hora final debe ser después de la inicial.';
  };
  f.entrega_inicio.oninput = f.entrega_fin.oninput = franjas;
  franjas();
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
        nombre: f.nombre.value, rfc: f.rfc.value, direccion: f.direccion.value, telefono: f.telefono.value, email: f.email.value,
        entrega_inicio: f.entrega_inicio.value, entrega_fin: f.entrega_fin.value, logo
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
const CJ = { estado: null, cuentas: null, activa: '', vista: 'imagenes', cat: '', q: '' };
// Varias cuentas abiertas a la vez: CJ.ticket es siempre la cuenta activa
Object.defineProperty(CJ, 'ticket', { get() { return (CJ.cuentas || []).find(c => c.id === CJ.activa) || { cliente_id: '', lineas: [] }; } });
const cuentaVacia = c => !c.lineas.length && !c.cliente_id && !c.nombre;
function nuevaCuenta() {
  const n = (CJ.cuentas || []).reduce((m, c) => Math.max(m, c.n || 0), 0) + 1;
  const c = { id: uuid(), n, nombre: '', cliente_id: '', lineas: [], ultimo: '' };
  CJ.cuentas.push(c);
  CJ.activa = c.id;
  return c;
}
const guardarCuentas = () => DB.set('caja:cuentas:' + S.usuario.usuario, { lista: CJ.cuentas, activa: CJ.activa });
function nombreCuenta(c) {
  if (c.nombre) return c.nombre;
  const cli = clientePorId(c.cliente_id);
  return cli ? cli.nombre : 'Cuenta ' + c.n;
}
const totalCuenta = c => Math.round(c.lineas.reduce((s, l) => s + Number(l.cantidad) * Number(l.precio), 0) * 100) / 100;
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
const iniciales = t => String(t || '').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const ticketCorto = id => String(id).replace(/-/g, '').slice(0, 8).toUpperCase();

async function cargarCaja() {
  CJ.estado = (await DB.get('caja:' + S.usuario.usuario)) || { corte: null, ventas: [], abonos: [], ultimoCorte: null };
  const g = await DB.get('caja:cuentas:' + S.usuario.usuario);
  CJ.cuentas = g && Array.isArray(g.lista) && g.lista.length ? g.lista : [];
  if (!CJ.cuentas.length) nuevaCuenta();
  else CJ.activa = CJ.cuentas.some(c => c.id === g.activa) ? g.activa : CJ.cuentas[0].id;
  CJ.vista = (await DB.get('caja:vista')) || 'imagenes';
  F.cajaId = F.cajaId || (await DB.get('caja:ultima')) || '';
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
      <div><b>Caja · ${esc(alm.nombre || '')}${E.corte.caja_id ? ' · ' + esc(nombreCaja(E.corte.caja_id) || 'Caja') : ''}</b><small>Abierta ${fechaHora(E.corte.apertura)} · Fondo ${dinero(E.corte.fondo)} · ${plural(E.ventas.filter(v => !v.cancelada).length, 'venta')}</small></div>
      <div class="acciones"><button type="button" class="btn sec" id="cj-ticket">Imprimir ticket</button>
        <button type="button" class="btn sec" id="cj-ventas">Ventas del turno</button>
        <button type="button" class="btn sec" id="cj-abono">Cobrar abono</button>
        <button type="button" class="btn sec" id="cj-cerrar">Cerrar caja</button>
        ${IMP.modo === 'ble' && !impresoraBLELista() ? '<button type="button" class="btn" id="cj-ble">Conectar impresora</button>' : ''}
        ${modoDirecto() && IMP.cajon ? '<button type="button" class="btn sec" id="cj-cajon">Abrir cajón</button>' : ''}
        <button type="button" class="btn sec icono-txt" id="cj-imp" title="Configurar impresora">⚙ Impresora</button></div>
    </div>
    <div class="caja ${CJ.vista === 'imagenes' ? 'con-img' : 'solo-lista'}">
      <section class="caja-buscar">
        <div class="cj-busca"><input id="cj-q" type="search" placeholder="Escanea o busca (3*código = 3 piezas)" title="Escanea o busca por nombre o código. Escribe 3*código para agregar 3 piezas." autocomplete="off" value="${esc(CJ.q)}">
          <button type="button" class="btn sec" id="cj-donde" title="Buscar en qué sucursal o bodega hay un producto">¿Dónde hay?</button>
          <div class="seg" id="cj-vista" role="group" aria-label="Vista de productos"><button type="button" data-vista="imagenes" class="${CJ.vista === 'imagenes' ? 'activo' : ''}">Con imágenes</button><button type="button" data-vista="lista" class="${CJ.vista === 'lista' ? 'activo' : ''}">Solo lista</button></div></div>
        <div class="cats" id="cj-cats"></div>
        <div class="cj-res ${CJ.vista === 'lista' ? 'en-lista' : ''}" id="cj-res"></div>
      </section>
      <div class="caja-der">
      ${CJ.vista === 'imagenes' ? '<aside class="caja-visor" id="cj-visor"></aside>' : ''}
      <aside class="caja-ticket">
        <div class="cj-cuentas" id="cj-cuentas"></div>
        <button type="button" class="cj-cliente" id="cj-cliente"></button>
        <div class="cj-lineas" id="cj-lineas"></div>
        <div class="cj-total" id="cj-total"></div>
        <div class="acciones"><button type="button" class="btn cobrar" id="cj-cobrar">Cobrar <small>(F2)</small></button>
          <button type="button" class="btn sec" id="cj-auto" title="Cobrar lo que el cliente escaneó con su teléfono">Autocobro</button>
          <button type="button" class="btn sec" id="cj-vaciar">Vaciar</button></div>
      </aside>
      </div>
    </div>
    <div class="cj-movil" id="cj-movil"><button type="button" class="cj-ver" id="cj-ver"></button><button type="button" class="btn cobrar" id="cj-cobrar2">Cobrar</button></div>`;

  const q = $('#cj-q', el);
  const cats = S.catalogo.categorias.filter(c => esActivo(c.activo)).sort(porNombre);
  $('#cj-cats', el).innerHTML = [['', 'Todas']].concat(cats.map(c => [c.id, c.nombre]))
    .map(([id, n]) => `<button type="button" data-cat="${esc(id)}" class="${CJ.cat === id ? 'activo' : ''}">${esc(n)}</button>`).join('');

  const pintarRes = () => {
    const ex = mapaRed();
    const enOtro = pid => S.catalogo.almacenes.some(a => a.id !== E.corte.almacen_id && esActivo(a.activo) && (ex[a.id + '|' + pid] || 0) > 0);
    const cli = clientePorId(CJ.ticket.cliente_id);
    const t = normal(CJ.q.replace(/^\d+(\.\d+)?\*/, ''));
    const lista = S.catalogo.productos
      .filter(p => esActivo(p.activo) && (!CJ.cat || p.categoria_id === CJ.cat) && (!t || coincide(p, t)))
      .sort(porNombre).slice(0, 60);
    const conImg = CJ.vista === 'imagenes';
    $('#cj-res', el).innerHTML = lista.length ? lista.map(p => {
      const c = ex[E.corte.almacen_id + '|' + p.id] || 0;
      const exis = `<small class="${c <= 0 ? 'txt-error' : ''}">${numero(c)} ${esc(p.unidad || '')}${c <= 0 && enOtro(p.id) ? ' · hay en otra' : ''}</small>`;
      if (!conImg) return `<button type="button" class="prod-fila" data-p="${esc(p.id)}"><span>${esc(p.nombre)}</span><span class="precio">${dinero(precioCliente(p, cli))}</span>${exis}</button>`;
      return `<button type="button" class="prod" data-p="${esc(p.id)}"><span class="prod-img">${p.imagen ? `<img data-img="${esc(p.imagen)}" alt="">` : `<i>${esc(iniciales(p.nombre))}</i>`}</span><b>${esc(p.nombre)}</b>
        <span class="fila-oc"><span class="precio">${dinero(precioCliente(p, cli))}</span>${exis}</span></button>`;
    }).join('') : '<p class="nota">Sin productos que coincidan.</p>';
    if (conImg) cargarImgs($('#cj-res', el));
  };
  // Imagen y descripción del último producto registrado en la cuenta
  const pintarVisor = () => {
    const v = $('#cj-visor', el);
    if (!v) return;
    const p = S.idx.prod[CJ.ticket.ultimo];
    if (!p) { v.innerHTML = '<div class="vis-vacio">Aquí verás la imagen y la descripción del producto que registres.</div>'; return; }
    const c = mapaExistencias()[E.corte.almacen_id + '|' + p.id] || 0;
    const l = CJ.ticket.lineas.find(x => x.producto_id === p.id);
    v.innerHTML = `<div class="vis-img">${p.imagen ? `<img data-img="${esc(p.imagen)}" alt="">` : `<i>${esc(iniciales(p.nombre))}</i>`}</div>
      <div class="vis-txt"><b>${esc(p.nombre)}</b><span class="precio">${dinero(l ? l.precio : precioCliente(p, clientePorId(CJ.ticket.cliente_id)))}${l ? ` <small>× ${numero(l.cantidad)}</small>` : ''}</span>
        ${p.descripcion ? `<p>${esc(p.descripcion)}</p>` : ''}<small>${p.codigo_barras ? esc(p.codigo_barras) + ' · ' : ''}Existencia: ${numero(c)} ${esc(p.unidad || '')}</small>
        ${(() => { const o = resumenOtros(p.id, E.corte.almacen_id); return o.length ? `<small class="vis-otras">En otros: ${o.slice(0, 3).map(x => `${esc(x.a.nombre)} ${numero(x.c)}`).join(' · ')}${o.length > 3 ? '…' : ''}</small>` : ''; })()}
        <button type="button" class="btn mini sec" id="cj-vis-donde">¿Dónde hay?</button></div>`;
    $('#cj-vis-donde', v).onclick = () => dlgDondeHay(p, E.corte.almacen_id);
    cargarImgs(v);
  };
  const pintarCuentas = () => {
    const varias = CJ.cuentas.length > 1;
    $('#cj-cuentas', el).innerHTML = CJ.cuentas.map(c => {
      const act = c.id === CJ.activa;
      return `<div class="cta ${act ? 'activa' : ''}"><button type="button" class="cta-sel" data-cta="${esc(c.id)}"><span>${esc(nombreCuenta(c))}</span><small>${c.lineas.length ? dinero(totalCuenta(c)) : 'vacía'}</small></button>
        ${act ? `<button type="button" class="icono" data-ren title="Ponerle nombre">✎</button>` : ''}${varias ? `<button type="button" class="icono" data-cerrar-cta="${esc(c.id)}" title="Cerrar cuenta">✕</button>` : ''}</div>`;
    }).join('') + '<button type="button" class="cta-nueva" id="cj-nueva" title="Atender a otro cliente sin perder esta cuenta (F4)">+ Nueva cuenta</button>';
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
    pintarCuentas();
    pintarVisor();
    guardarCuentas();
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
    CJ.ticket.ultimo = p.id;
    pintarTicket();
  };
  CJ.repintar = () => { pintarRes(); pintarTicket(); };
  S.refrescar = CJ.repintar;
  pintarRes();
  pintarTicket();
  q.focus();

  q.oninput = () => { CJ.q = q.value; pintarRes(); };
  const traerAutocobro = async codigo => {
    if (!navigator.onLine) { toast('Para traer un autocobro se necesita internet.', 'error'); return; }
    try {
      const r = await conCarga('Trayendo el autocobro…', () => api('tomarAutocobro', { codigo, almacen_id: E.corte.almacen_id }));
      const c = cuentaVacia(CJ.ticket) ? CJ.ticket : nuevaCuenta();
      const cli = clientePorId(r.cliente_id);
      Object.assign(c, { cliente_id: cli ? r.cliente_id : '', nombre: (r.cliente || 'Cliente') + ' · autocobro ' + r.codigo, autocobro: r.id });
      c.lineas = r.lineas.filter(l => S.idx.prod[l.producto_id]).map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad), precio: precioCliente(S.idx.prod[l.producto_id], cli) }));
      c.ultimo = c.lineas.length ? c.lineas[c.lineas.length - 1].producto_id : '';
      CJ.activa = c.id;
      pintarTicket(); pintarRes();
      toast(`Autocobro de ${r.cliente}: ${plural(c.lineas.length, 'producto')} por ${dinero(totalCuenta(c))}. Revisa la mercancía y cobra.`, 'ok');
    } catch (er) { toast(er.message, 'error'); }
  };
  $('#cj-auto', el).onclick = () => {
    const v = prompt('Código de autocobro que muestra el cliente (6 números):');
    if (v && v.trim()) traerAutocobro(v.trim());
  };
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (/^AC\s?\d{3}\s?\d{3}$/i.test(q.value.trim())) { const v = q.value.replace(/\s/g, ''); q.value = ''; CJ.q = ''; traerAutocobro(v); return; }
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
    if (CJ.ticket.lineas.length && !confirm('¿Vaciar esta cuenta?')) return;
    Object.assign(CJ.ticket, { cliente_id: '', lineas: [], ultimo: '' });
    pintarTicket(); pintarRes();
  };
  // Cuentas: cambiar, nombrar, cerrar y abrir otra
  const activar = id => {
    const act = CJ.ticket;
    if (id !== act.id && cuentaVacia(act)) CJ.cuentas = CJ.cuentas.filter(c => c !== act);
    CJ.activa = id;
    pintarTicket(); pintarRes();
    q.focus();
  };
  $('#cj-cuentas', el).onclick = e => {
    const sel = e.target.closest('[data-cta]');
    if (sel) return activar(sel.dataset.cta);
    if (e.target.closest('[data-ren]')) {
      const n = prompt('Nombre para identificar esta cuenta (ej. "Señora de blusa azul"):', nombreCuenta(CJ.ticket));
      if (n !== null) { CJ.ticket.nombre = n.trim().slice(0, 30); pintarTicket(); }
      return;
    }
    const cer = e.target.closest('[data-cerrar-cta]');
    if (cer) {
      const c = CJ.cuentas.find(x => x.id === cer.dataset.cerrarCta);
      if (c.lineas.length && !confirm(`¿Descartar "${nombreCuenta(c)}" con ${plural(c.lineas.length, 'producto')}?`)) return;
      CJ.cuentas = CJ.cuentas.filter(x => x !== c);
      if (!CJ.cuentas.length) nuevaCuenta();
      else if (CJ.activa === c.id) CJ.activa = CJ.cuentas[CJ.cuentas.length - 1].id;
      pintarTicket(); pintarRes();
      return;
    }
    if (e.target.closest('#cj-nueva')) {
      if (cuentaVacia(CJ.ticket)) { toast('Esta cuenta está vacía: úsala para el siguiente cliente.', ''); q.focus(); return; }
      nuevaCuenta();
      pintarTicket(); pintarRes();
      q.focus();
    }
  };
  $('#cj-donde', el).onclick = () => dlgDondeHay(null, E.corte.almacen_id);
  $('#cj-vista', el).onclick = e => {
    const b = e.target.closest('[data-vista]');
    if (!b || b.dataset.vista === CJ.vista) return;
    CJ.vista = b.dataset.vista;
    DB.set('caja:vista', CJ.vista);
    vCaja(el);
  };
  $('#cj-cobrar', el).onclick = () => dlgCobrar(() => {
    // La cuenta cobrada se cierra; las demás siguen abiertas
    CJ.cuentas = CJ.cuentas.filter(c => c.id !== CJ.activa);
    const espera = CJ.cuentas.filter(c => c.lineas.length).length;
    CJ.cuentas = CJ.cuentas.filter(c => !cuentaVacia(c));
    nuevaCuenta();
    guardarCuentas();
    if (espera) toast(`${espera === 1 ? 'Queda 1 cuenta abierta' : `Quedan ${espera} cuentas abiertas`}: tócala arriba del ticket para seguir cobrándola.`, 'aviso');
    vCaja(el);
  });
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
        <label id="cj-caja-l" hidden>Caja<select name="caja_id"></select></label>
        <label>Fondo inicial (cuenta el efectivo que hay en la caja)<input name="fondo" type="number" step="0.01" min="0" value="0" inputmode="decimal"></label>
        <p class="nota" id="cj-ant"></p>
        <button class="btn" type="submit">Abrir caja</button>
        ${esAdminCaja() ? '<button type="button" class="btn mini sec" id="cj-cajas">Administrar cajas de la sucursal</button>' : ''}
      </form>` : '<p class="txt-error">No tienes una sucursal asignada.</p>'}
      ${E.ultimoCorte ? `<p class="nota">Último corte: ${fechaHora(E.ultimoCorte.cierre)} · diferencia ${dinero(E.ultimoCorte.diferencia)}
        <button type="button" class="btn mini sec" id="cj-reimp-corte">Reimprimir corte</button></p>` : ''}
    </div>`;
  const f = $('#cj-abrir', el);
  // Cajas de la sucursal elegida (si tiene registradas); se recuerda la última que usó este equipo
  const llenarCajas = () => {
    const l = cajasDe(f.almacen_id.value);
    $('#cj-caja-l', el).hidden = !l.length;
    f.caja_id.innerHTML = l.length ? '<option value="">Elige la caja…</option>' + l.map(c => {
      const uso = (S.cajasAbiertas || {})[c.id];
      return `<option value="${esc(c.id)}">${esc(c.nombre)}${uso ? ` — en uso por ${esc(uso.cajero)}` : ''}</option>`;
    }).join('') : '';
    if (l.some(c => c.id === F.cajaId)) f.caja_id.value = F.cajaId;
    else if (l.length === 1) f.caja_id.value = l[0].id;
  };
  const clave = () => claveCaja(f.almacen_id.value, f.caja_id.value);
  // Lo que dejó el turno anterior de esta caja (su "queda en caja")
  const anterior = () => (S.cajaAnterior || {})[clave()] || null;
  const revisarFondo = () => {
    const a = anterior(), p = $('#cj-ant', el);
    if (!a || a.queda === null) { p.textContent = ''; return; }
    const dif = Math.round(((Number(f.fondo.value) || 0) - a.queda) * 100) / 100;
    p.className = dif ? 'aviso-caja' : 'nota';
    p.innerHTML = `El turno anterior (${esc(a.cajero)}, ${fechaHora(a.cierre)}) dejó <b>${dinero(a.queda)}</b> en caja.` +
      (dif ? ` <b>No coincide: ${dif > 0 ? 'sobran' : 'faltan'} ${dinero(Math.abs(dif))}.</b>` : ' ✓ Coincide.');
  };
  if (f) {
    const ponerSugerido = () => { const a = anterior(); f.fondo.value = a && a.queda !== null ? a.queda.toFixed(2) : '0'; revisarFondo(); };
    llenarCajas();
    ponerSugerido();
    f.almacen_id.onchange = () => { llenarCajas(); ponerSugerido(); };
    f.caja_id.onchange = ponerSugerido;
    const bcj = $('#cj-cajas', el);
    if (bcj) bcj.onclick = () => dlgCajas(f.almacen_id.value, () => { cerrarModal(); vCaja(el); });
    f.fondo.oninput = revisarFondo;
    f.fondo.focus();
    f.fondo.select();
    f.onsubmit = async ev => {
      ev.preventDefault();
      if (cajasDe(f.almacen_id.value).length && !f.caja_id.value) { toast('Elige la caja que vas a usar.', 'error'); f.caja_id.focus(); return; }
      const uso = (S.cajasAbiertas || {})[clave()];
      if (uso && uso.usuario_id !== S.usuario.id && !confirm(`${f.caja_id.value ? nombreCaja(f.caja_id.value) : 'Esta caja'} está abierta por ${uso.cajero} desde ${fechaHora(uso.apertura)}. ¿Abrirla de todos modos?`)) return;
      const a = anterior();
      const dif = a && a.queda !== null ? Math.round(((Number(f.fondo.value) || 0) - a.queda) * 100) / 100 : 0;
      if (dif && !confirm(`El fondo no coincide con lo que dejó el turno anterior (${dinero(a.queda)}): ${dif > 0 ? 'sobran' : 'faltan'} ${dinero(Math.abs(dif))}. Quedará registrado en el corte. ¿Abrir la caja así?`)) return;
      F.cajaAlm = f.almacen_id.value;
      F.cajaId = f.caja_id.value;
      DB.set('caja:ultima', F.cajaId);
      const op = { clase: 'CORTE_ABRIR', id: uuid(), almacen_id: f.almacen_id.value, caja_id: f.caja_id.value, fondo: Number(f.fondo.value) || 0 };
      E.corte = { id: op.id, almacen_id: op.almacen_id, caja_id: op.caja_id, fondo: op.fondo, apertura: new Date().toISOString() };
      S.cajasAbiertas = Object.assign({}, S.cajasAbiertas, { [claveCaja(op.almacen_id, op.caja_id)]: { corte_id: op.id, cajero: S.usuario.nombre, usuario_id: S.usuario.id, apertura: E.corte.apertura } });
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
    <form id="fcob" class="form dos-col" autocomplete="off">
      <div class="col">
        <div class="cobro-total"><span>Total a cobrar</span><b>${dinero(total)}</b><small>${esc(cli ? cli.nombre : 'Público en general')}</small></div>
        <label>Efectivo recibido<input name="recibido" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
        <div class="billetes">${['Exacto', 20, 50, 100, 200, 500, 1000].map(b => `<button type="button" data-b="${b}">${b === 'Exacto' ? b : '$' + b}</button>`).join('')}</div>
        <div class="cobro-res" id="cob-res"></div>
      </div>
      <div class="col">
        <div class="fila2">
          <label>Tarjeta<input name="tarjeta" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
          <label>Transferencia<input name="transferencia" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
        </div>
        ${cli && cli.credito ? `<div class="fila-credito"><label>Crédito <small>${vencido ? '<span class="txt-error">tiene saldo vencido</span>' : 'disponible ' + dinero(disp)}</small>
          <input name="credito" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></label>
          <button type="button" class="btn sec" id="cob-credito">Todo a crédito</button></div>` : ''}
        <div class="fila2">
          <label>Ticket<select name="ticket"><option value="0">No imprimir</option><option value="1">Imprimir</option><option value="2">Imprimir doble</option></select></label>
          <label>Ticket por correo<input name="correo" type="email" list="cob-mails" placeholder="opcional" autocomplete="off"></label>
        </div>
      </div>
      <datalist id="cob-mails">${cli && cli.email ? `<option value="${esc(cli.email)}">` : ''}</datalist>
      <p class="msg" id="cob-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Regresar</button><button class="btn" type="submit">Confirmar venta</button></div>
    </form>`, 'medio');
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
      pagos: { efectivo: c.efectivo, tarjeta: v('tarjeta'), transferencia: v('transferencia'), credito }, recibido: c.efectivo > 0 ? c.recibido : 0,
      autocobro_id: CJ.ticket.autocobro || ''
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
      case 'logo': return IMP.logo ? `<img src="${esc(logoSrc())}" alt="">` : '';
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
  img.src = logoSrc();
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
    ...(c.caja_id || c.caja ? [{ k: 'txt', s: 'Caja: ' + (c.caja || nombreCaja(c.caja_id)) }] : []), { k: 'txt', s: 'Cajero: ' + (c.cajero || S.usuario.nombre) }, { k: 'txt', s: 'Apertura: ' + fechaHora(c.apertura) }, { k: 'txt', s: 'Cierre: ' + fechaHora(c.cierre) },
    { k: 'sep' }, { k: 'par', a: 'Ventas', b: String(c.ventas) }, p('Total vendido', c.total_ventas), p('Efectivo', c.efectivo), p('Tarjeta', c.tarjeta),
    p('Transferencia', c.transferencia), p('A crédito', c.credito), p('Abonos en efectivo', c.abonos_efectivo), p('Abonos otros medios', c.abonos_otros),
    { k: 'sep' }, p('Fondo inicial', c.fondo), p('Efectivo esperado', c.esperado), p('Efectivo contado', c.contado), p('Diferencia', c.diferencia, true),
    ...(c.retiro !== undefined && c.retiro !== '' ? [p('Retiro', c.retiro), p('Queda en caja', c.queda)] : []),
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
    <form id="fimp" class="form dos-col">
      <p class="nota completo">Esta configuración se guarda en este equipo. Cada caja puede tener la suya.</p>
      <div class="col">
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
      </div>
      <div class="col col-imp">
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
      </div>
      <p class="msg" id="fimp-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`, 'medio');
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
    almacen_id: E.corte.almacen_id, caja_id: E.corte.caja_id || '', apertura: E.corte.apertura, fondo: Number(E.corte.fondo) || 0, ventas: vs.length,
    total_ventas: s(vs, v => v.total), efectivo: s(vs, v => v.pagos.efectivo), tarjeta: s(vs, v => v.pagos.tarjeta),
    transferencia: s(vs, v => v.pagos.transferencia), credito: s(vs, v => v.pagos.credito),
    abonos_efectivo: s(E.abonos.filter(a => a.metodo === 'EFECTIVO'), a => a.monto), abonos_otros: s(E.abonos.filter(a => a.metodo !== 'EFECTIVO'), a => a.monto)
  };
  r.esperado = Math.round((r.fondo + r.efectivo + r.abonos_efectivo) * 100) / 100;
  return r;
}

function dlgCerrarCaja(alTerminar) {
  const abiertas = (CJ.cuentas || []).filter(c => c.lineas.length);
  if (abiertas.length && !confirm(`Hay ${plural(abiertas.length, 'cuenta')} sin cobrar (${abiertas.map(nombreCuenta).join(', ')}). Se conservan para el siguiente turno. ¿Cerrar la caja de todos modos?`)) return;
  const r = resumenCorteLocal();
  const fila = (t, n) => `<span>${t}</span><span>${dinero(n)}</span>`;
  const d = abrirModal('Cerrar caja (corte)', `
    <form id="fcorte" class="form dos-col">
      <div class="col"><div class="corte-res">
        <span>Ventas</span><span>${r.ventas}</span>${fila('Total vendido', r.total_ventas)}${fila('Efectivo', r.efectivo)}${fila('Tarjeta', r.tarjeta)}
        ${fila('Transferencia', r.transferencia)}${fila('A crédito', r.credito)}${fila('Abonos en efectivo', r.abonos_efectivo)}${fila('Abonos otros medios', r.abonos_otros)}
        ${fila('Fondo inicial', r.fondo)}<b>Efectivo esperado en caja</b><b>${dinero(r.esperado)}</b>
      </div></div>
      <div class="col">
      <label>Efectivo contado (todo el dinero que hay en la caja)<input name="contado" type="number" step="0.01" min="0" required inputmode="decimal"></label>
      <p id="fc-dif" class="cobro-res"></p>
      <div class="fila2"><label>Retiro (lo que se entrega o deposita)<input name="retiro" type="number" step="0.01" min="0" value="" inputmode="decimal" placeholder="0.00"></label>
        <label>Queda en caja para el siguiente turno<input name="queda" readonly tabindex="-1"></label></div>
      <label>Notas<input name="notas" placeholder="Faltantes, observaciones"></label>
      <label class="chk"><input type="checkbox" name="imprimir" ${IMP.auto ? 'checked' : ''}> Imprimir corte</label>
      ${misPendientes().filter(o => o.clase && o.estado === 'pendiente').length ? '<p class="aviso-offline">Hay operaciones por enviar. El corte se enviará después de ellas, en orden.</p>' : ''}
      </div>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Regresar</button><button class="btn" type="submit">Cerrar caja</button></div>
    </form>`, 'medio');
  const f = $('#fcorte', d);
  f.contado.focus();
  const calc = () => {
    const contado = Math.round((Number(f.contado.value) || 0) * 100) / 100;
    const retiro = Math.round((Number(f.retiro.value) || 0) * 100) / 100;
    const dif = Math.round((contado - r.esperado) * 100) / 100;
    $('#fc-dif', d).innerHTML = f.contado.value === '' ? '' : `<span>Diferencia</span><b class="${dif === 0 ? 'cambio' : 'txt-error'}">${dif > 0 ? 'A favor (sobran) ' : dif < 0 ? 'En contra (faltan) ' : 'Cuadra · '}${dinero(Math.abs(dif))}</b>`;
    f.queda.value = dinero(Math.max(0, contado - retiro));
    return { contado, retiro, dif };
  };
  calc();
  f.oninput = calc;
  f.onsubmit = async ev => {
    ev.preventDefault();
    const E = CJ.estado;
    const { contado, retiro } = calc();
    if (retiro > contado + 0.001) { toast('El retiro no puede ser mayor que el efectivo contado.', 'error'); return; }
    const op = { clase: 'CORTE_CERRAR', id: uuid(), corte_id: E.corte.id, contado, retiro, notas: f.notas.value.trim() };
    const corte = Object.assign({}, r, { contado, retiro, queda: Math.round((contado - retiro) * 100) / 100,
      diferencia: Math.round((contado - r.esperado) * 100) / 100, cierre: new Date().toISOString(), notas: op.notas, cajero: S.usuario.nombre });
    await encolarCaja(op);
    E.ultimoCorte = corte;
    E.corte = null;
    E.ventas = [];
    E.abonos = [];
    await guardarCaja();
    // Lo que deja este turno es lo que debe encontrar el siguiente
    const k = claveCaja(r.almacen_id, r.caja_id);
    S.cajaAnterior = Object.assign({}, S.cajaAnterior, { [k]: { cierre: corte.cierre, cajero: S.usuario.nombre, queda: corte.queda } });
    DB.set('cajaAnterior', S.cajaAnterior);
    if (S.cajasAbiertas) delete S.cajasAbiertas[k];
    if (f.imprimir.checked) imprimirCorte(corte);
    alTerminar();
    dlgFinTurno(corte);
  };
}

// Mensaje al terminar el turno
function dlgFinTurno(c) {
  const ok = Math.abs(Number(c.diferencia)) < 0.005;
  const nombre = String(S.usuario.nombre || '').split(' ')[0];
  const d = abrirModal(ok ? '¡Corte correcto!' : 'Corte con diferencia', `<div class="form fin-turno ${ok ? 'bien' : 'mal'}">
    <div class="fin-icono">${ok ? '✓' : '!'}</div>
    <h3>${ok ? `¡Gracias por tu turno, ${esc(nombre)}!` : `Gracias por tu turno, ${esc(nombre)}.`}</h3>
    <p>${ok ? 'Tu corte fue correcto: el efectivo coincide con lo esperado.' : `Tu corte tiene ${c.diferencia > 0 ? 'un sobrante' : 'un faltante'} de <b>${dinero(Math.abs(c.diferencia))}</b>. Quedó registrado para que el encargado lo revise.`}</p>
    <div class="corte-res"><span>Efectivo esperado</span><span>${dinero(c.esperado)}</span><span>Efectivo contado</span><span>${dinero(c.contado)}</span>
      <span>Retiro</span><span>${dinero(c.retiro)}</span><b>Queda en caja</b><b>${dinero(c.queda)}</b></div>
    <div class="pie"><button type="button" class="btn sec" id="ft-imp">Imprimir corte</button><button type="button" class="btn" data-cerrar>Terminar</button></div></div>`);
  $('#ft-imp', d).onclick = () => imprimirCorte(c);
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
    <div class="segmentos" id="vt-tabs">${[['ventas', 'Ventas'], ['cortes', 'Turnos y cortes'], ['clientes', 'Clientes'], ['cobrar', 'Por cobrar']]
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

/* ---- Turnos de caja (cortes) ---- */
// Tablero por día: cada turno con su inicio de caja (y si cuadra con el anterior), ventas por forma de pago,
// esperado, contado, diferencia, retiro y lo que quedó. Cada total abre su desglose y cada venta su detalle.
const PAGOS_TXT = { total: 'Ventas', efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito' };

async function pintarCortes(c) {
  if (!VT.tDesde) { VT.tDesde = hoyLocal(); VT.tHasta = hoyLocal(); }
  const alms = esGeneral() ? S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre) : [];
  c.innerHTML = `<div class="filtros">
      <label class="chk">Desde <input type="date" id="tu-desde" value="${VT.tDesde}"></label>
      <label class="chk">Hasta <input type="date" id="tu-hasta" value="${VT.tHasta}"></label>
      ${alms.length ? `<select id="tu-alm"><option value="">Todas las sucursales</option>${alms.map(a => `<option value="${esc(a.id)}" ${VT.tAlm === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select>` : ''}
      ${(S.cajas || []).length ? `<select id="tu-caja"><option value="">Todas las cajas</option>${(S.cajas || []).slice().sort((a, b) => String(a.nombre).localeCompare(b.nombre, 'es', { numeric: true }))
        .map(cj => `<option value="${esc(cj.id)}" ${VT.tCaja === cj.id ? 'selected' : ''}>${esc(cj.nombre)}${alms.length ? ' · ' + esc((S.idx.alm[cj.almacen_id] || {}).nombre || '') : ''}</option>`).join('')}</select>` : ''}
      <button type="button" class="btn sec" id="tu-hoy">Hoy</button><button type="button" class="btn sec" id="tu-buscar">Consultar</button>
    </div><div id="tu-cuerpo"></div>`;
  const cuerpo = $('#tu-cuerpo', c);
  const cargar = async () => {
    VT.tDesde = $('#tu-desde', c).value; VT.tHasta = $('#tu-hasta', c).value; VT.tAlm = ($('#tu-alm', c) || {}).value || '';
    VT.tCaja = ($('#tu-caja', c) || {}).value || '';
    const r = await pedir(cuerpo, 'Consultando turnos…', () => Promise.all([
      api('cortes', { desde: VT.tDesde, hasta: VT.tHasta, almacen_id: VT.tAlm, caja_id: VT.tCaja }),
      api('ventas', { desde: VT.tDesde, hasta: VT.tHasta, almacen_id: VT.tAlm })]));
    if (!r) return;
    [VT.cortes, VT.tVentas] = r;
    // Con una caja elegida, el resumen cuenta solo las ventas de sus turnos
    if (VT.tCaja) { const ids = new Set(VT.cortes.map(k => k.id)); VT.tVentas = VT.tVentas.filter(v => ids.has(v.corte_id)); }
    VT.tDetalle = {};
    pintarTablero();
  };
  const pintarTablero = () => {
    const cortes = VT.cortes, vs = VT.tVentas.filter(v => !v.cancelada);
    const s = (l, k) => Math.round(l.reduce((t, x) => t + (Number(x[k]) || 0), 0) * 100) / 100;
    const cerrados = cortes.filter(k => k.estado === 'CERRADO');
    const faltan = s(cerrados.filter(k => k.diferencia < 0), 'diferencia'), sobran = s(cerrados.filter(k => k.diferencia > 0), 'diferencia');
    const tarjeta = (k, t, valor, extra = '', cls = '') => `<button type="button" class="tarjeta clic ${cls}" data-res="${k}"><span>${t}</span><b>${valor}</b>${extra}</button>`;
    cuerpo.innerHTML = `
      <h3 class="tu-sub">Resumen ${VT.tDesde === VT.tHasta ? 'del día ' + fechaCorta(VT.tDesde) : `del ${fechaCorta(VT.tDesde)} al ${fechaCorta(VT.tHasta)}`}</h3>
      <div class="tarjetas tu-res">
        ${tarjeta('total', 'Venta total', dinero(s(vs, 'total')), `<small>${plural(vs.length, 'venta')}</small>`)}
        ${tarjeta('efectivo', 'Efectivo', dinero(s(vs, 'efectivo')))}
        ${tarjeta('tarjeta', 'Tarjeta', dinero(s(vs, 'tarjeta')))}
        ${tarjeta('transferencia', 'Transferencias', dinero(s(vs, 'transferencia')))}
        ${tarjeta('credito', 'A crédito', dinero(s(vs, 'credito')))}
        ${tarjeta('retiros', 'Retiros de caja', dinero(s(cerrados, 'retiro')), `<small>${plural(cerrados.length, 'turno')} ${cerrados.length === 1 ? 'cerrado' : 'cerrados'}</small>`)}
        ${tarjeta('difs', 'Faltantes / sobrantes', `${faltan ? '−' + dinero(-faltan) : dinero(0)}`, sobran ? `<small>Sobrantes ${dinero(sobran)}</small>` : '', faltan ? 'alerta' : '')}
        ${tarjeta('productos', 'Productos vendidos', numero(vs.reduce((t, v) => t + v.lineas.reduce((x, l) => x + Number(l.cantidad), 0), 0)), '<small>ver los más vendidos</small>')}
      </div>
      <h3 class="tu-sub">Turnos</h3>
      ${cortes.length ? `<div class="turnos">${cortes.map(tarjetaTurno).join('')}</div>` : '<p class="vacio">No hay turnos en estas fechas.</p>'}`;
  };
  cuerpo.onclick = e => {
    const res = e.target.closest('[data-res]'), tu = e.target.closest('[data-tu]');
    const vs = VT.tVentas || [];
    if (res) {
      const k = res.dataset.res;
      if (k === 'productos') return dlgProductosVendidos('Productos vendidos', vs);
      if (k === 'retiros' || k === 'difs') return dlgListaCortes(k);
      return dlgListaVentas(`${PAGOS_TXT[k]} · ${VT.tDesde === VT.tHasta ? fechaCorta(VT.tDesde) : 'periodo'}`, vs, k);
    }
    if (tu) {
      const corte = VT.cortes.find(x => x.id === tu.dataset.tu), k = tu.dataset.k;
      const deTurno = vs.filter(v => v.corte_id === corte.id);
      const titulo = `${PAGOS_TXT[k] || ''} · turno de ${corte.cajero}`;
      if (k === 'productos') return dlgProductosVendidos(`Productos vendidos · turno de ${corte.cajero}`, deTurno);
      if (k === 'abonos') return dlgAbonosTurno(corte);
      if (k === 'anterior' && corte.anterior) {
        const prev = VT.cortes.find(x => x.id === corte.anterior.id);
        if (prev) return dlgCorteResumen(prev);
        return toast('El turno anterior es de otra fecha; amplía el periodo para verlo.', '');
      }
      if (k === 'corte') return dlgCorteResumen(corte);
      return dlgListaVentas(titulo, deTurno, k);
    }
  };
  $('#tu-buscar', c).onclick = cargar;
  $('#tu-hoy', c).onclick = () => { $('#tu-desde', c).value = hoyLocal(); $('#tu-hasta', c).value = hoyLocal(); cargar(); };
  VT.tRecargar = cargar;
  await cargar();
}

function tarjetaTurno(k) {
  const abierto = k.estado !== 'CERRADO';
  const alm = (S.idx.alm[k.almacen_id] || {}).nombre || '';
  const dif = Number(k.diferencia) || 0;
  const estado = abierto ? '<span class="est est-ENVIADA">En curso</span>'
    : Math.abs(dif) < 0.005 ? '<span class="est est-RECIBIDA">Corte correcto</span>'
    : `<span class="est est-ATRASADA">${dif < 0 ? 'Faltan' : 'Sobran'} ${dinero(Math.abs(dif))}</span>`;
  let inicio;
  if (!k.anterior) inicio = '<span class="txt-suave">Primer turno registrado en esta caja</span>';
  else if (k.anterior.queda === null) inicio = `<span class="txt-suave">El turno anterior (${esc(k.anterior.cajero)}) no registró lo que dejó</span>`;
  else if (Math.abs(k.dif_apertura) < 0.005) inicio = `<span class="txt-ok">✓ Cuadra con lo que dejó ${esc(k.anterior.cajero)}</span>`;
  else inicio = `<span class="txt-error">✗ ${esc(k.anterior.cajero)} dejó ${dinero(k.anterior.queda)}: ${k.dif_apertura < 0 ? 'faltan' : 'sobran'} ${dinero(Math.abs(k.dif_apertura))}</span>`;
  const b = (key, t, v, cls = '') => `<button type="button" class="tu-dato ${cls}" data-tu="${esc(k.id)}" data-k="${key}"><span>${t}</span><b>${v}</b></button>`;
  const vs = (VT.tVentas || []).filter(v => v.corte_id === k.id && !v.cancelada);
  const suma = c => Math.round(vs.reduce((t, v) => t + (Number(v[c]) || 0), 0) * 100) / 100;
  // Mientras está abierto, los totales salen de las ventas ya registradas
  const val = c => (abierto ? suma(c) : Number(k[c === 'total' ? 'total_ventas' : c]) || 0);
  return `<article class="turno ${abierto ? 'abierto' : Math.abs(dif) < 0.005 ? 'bien' : 'mal'}">
    <header><div><b>${esc(k.cajero)}</b> · ${esc(alm)}${k.caja ? ` · <b>${esc(k.caja)}</b>` : ''}<small>${fechaHora(k.apertura)} → ${abierto ? 'en curso' : fechaHora(k.cierre)}</small></div>${estado}</header>
    <div class="tu-inicio"><button type="button" class="tu-dato" data-tu="${esc(k.id)}" data-k="anterior"><span>Inicio de caja</span><b>${dinero(k.fondo)}</b></button><p>${inicio}</p></div>
    <div class="tu-grid">
      ${b('total', `Ventas (${abierto ? vs.length : k.ventas})`, dinero(val('total')), 'fuerte')}
      ${b('efectivo', 'Efectivo', dinero(val('efectivo')))}${b('tarjeta', 'Tarjeta', dinero(val('tarjeta')))}
      ${b('transferencia', 'Transferencia', dinero(val('transferencia')))}${b('credito', 'Crédito', dinero(val('credito')))}
      ${b('abonos', 'Abonos', abierto ? 'ver' : dinero((Number(k.abonos_efectivo) || 0) + (Number(k.abonos_otros) || 0)))}
      ${abierto ? '' : `${b('corte', 'Esperado en caja', dinero(k.esperado))}${b('corte', 'Contado', dinero(k.contado))}
      ${b('corte', 'Diferencia', `${dif > 0 ? '+' : dif < 0 ? '−' : ''}${dinero(Math.abs(dif))}`, Math.abs(dif) < 0.005 ? 'ok' : 'error')}
      ${b('corte', 'Retiro', k.retiro === '' || k.retiro === undefined ? '—' : dinero(k.retiro))}
      ${b('corte', 'Queda en caja', k.queda === '' || k.queda === undefined ? '—' : dinero(k.queda))}`}
      ${b('productos', 'Productos vendidos', numero(vs.reduce((t, v) => t + v.lineas.reduce((x, l) => x + Number(l.cantidad), 0), 0)))}
    </div>
    ${k.notas ? `<p class="nota">Notas: ${esc(k.notas)}</p>` : ''}
  </article>`;
}

// Lista de ventas (todas o solo las pagadas con una forma de pago); cada una abre su detalle
function dlgListaVentas(titulo, ventas, campo = 'total') {
  const lista = ventas.filter(v => campo === 'total' || Number(v[campo]) > 0).slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const validas = lista.filter(v => !v.cancelada);
  const total = Math.round(validas.reduce((t, v) => t + Number(v[campo]), 0) * 100) / 100;
  const abrir = () => {
    const d = abrirModal(titulo, `<div class="form">
      <div class="dh-cab"><span>${plural(validas.length, 'venta')}${lista.length > validas.length ? ` · ${lista.length - validas.length} cancelada(s)` : ''}</span><b>${dinero(total)}</b></div>
      ${lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Folio</th><th>Hora</th><th>Cajero</th><th>Cliente</th>${campo !== 'total' ? `<th class="num">${PAGOS_TXT[campo]}</th>` : ''}<th class="num">Total</th></tr></thead>
        <tbody>${lista.map(v => `<tr class="clic ${v.cancelada ? 'inactivo' : ''}" data-v="${esc(v.id)}"><td><b>${esc(v.folio)}</b>${v.cancelada ? '<small>cancelada</small>' : ''}</td>
          <td>${new Date(v.fecha).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(v.cajero)}</td>
          <td>${esc(clienteNombre(v.cliente_id))}</td>${campo !== 'total' ? `<td class="num">${dinero(v[campo])}</td>` : ''}<td class="num">${dinero(v.total)}</td></tr>`).join('')}</tbody></table></div>
        <p class="nota">Toca una venta para ver sus productos.</p>` : '<p class="vacio">Sin ventas.</p>'}</div>`, true);
    d.onclick = e => {
      const tr = e.target.closest('tr[data-v]');
      if (!tr) return;
      dlgVentaDetalle(lista.find(v => v.id === tr.dataset.v), () => VT.tRecargar && VT.tRecargar());
      botonVolver(abrir);
    };
  };
  abrir();
}

// Agrega "← Volver" arriba de la ventana para regresar a la lista anterior
function botonVolver(fn) {
  const cu = $('#dlg .dlg-cuerpo');
  if (!cu) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn mini sec volver'; b.textContent = '← Volver';
  b.onclick = fn;
  cu.prepend(b);
}

// Productos vendidos: piezas, importe y número de ventas, ordenables
function dlgProductosVendidos(titulo, ventas) {
  const m = {};
  ventas.filter(v => !v.cancelada).forEach(v => v.lineas.forEach(l => {
    const x = m[l.producto_id] = m[l.producto_id] || { producto_id: l.producto_id, cantidad: 0, importe: 0, ventas: 0 };
    x.cantidad += Number(l.cantidad); x.importe += Number(l.cantidad) * Number(l.precio); x.ventas++;
  }));
  let orden = 'cantidad';
  const d = abrirModal(titulo, `<div class="form"><div class="segmentos" id="pv-orden"><button type="button" data-o="cantidad" class="activo">Más piezas</button><button type="button" data-o="importe">Mayor importe</button></div><div id="pv-lista"></div></div>`, true);
  const pintar = () => {
    const l = Object.values(m).sort((a, b) => b[orden] - a[orden]);
    const tot = l.reduce((t, x) => t + x.importe, 0);
    $('#pv-lista', d).innerHTML = l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>#</th><th>Producto</th><th class="num">Piezas</th><th class="num">Importe</th><th class="num">% de la venta</th><th class="num">Ventas</th></tr></thead>
      <tbody>${l.map((x, i) => { const p = S.idx.prod[x.producto_id] || {}; return `<tr><td>${i + 1}</td><td>${esc(p.nombre || '—')}<small>${esc(p.codigo || '')}</small></td>
        <td class="num"><b>${numero(Math.round(x.cantidad * 1000) / 1000)}</b> ${esc(p.unidad || '')}</td><td class="num">${dinero(x.importe)}</td>
        <td class="num">${tot ? (x.importe / tot * 100).toFixed(1) + '%' : '—'}</td><td class="num">${x.ventas}</td></tr>`; }).join('')}</tbody></table></div>`
      : '<p class="vacio">Sin productos vendidos.</p>';
  };
  pintar();
  $('#pv-orden', d).onclick = e => {
    const b = e.target.closest('[data-o]');
    if (!b) return;
    orden = b.dataset.o;
    $$('#pv-orden button', d).forEach(x => x.classList.toggle('activo', x === b));
    pintar();
  };
}

async function dlgAbonosTurno(k) {
  let det = VT.tDetalle[k.id];
  if (!det) {
    try { det = VT.tDetalle[k.id] = await conCarga('Cargando abonos…', () => api('turno', { id: k.id })); } catch (e) { toast(e.message, 'error'); return; }
  }
  abrirModal(`Abonos · turno de ${k.cajero}`, `<div class="form">${det.abonos.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Hora</th><th>Cliente</th><th>Forma de pago</th><th class="num">Monto</th></tr></thead>
    <tbody>${det.abonos.map(a => `<tr><td>${fechaHora(a.fecha_abono || a.registrado)}</td><td>${esc(a.cliente)}</td><td>${esc(METODOS_CAJA[a.metodo] || a.metodo)}</td><td class="num">${dinero(a.monto)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="vacio">Sin abonos en este turno.</p>'}</div>`);
}

// Resumen del corte de un turno (para revisar o reimprimir)
function dlgCorteResumen(k) {
  const f = (t, n) => `<span>${t}</span><span>${dinero(n)}</span>`;
  const d = abrirModal(`Corte de ${k.cajero}`, `<div class="form">
    <p>${esc((S.idx.alm[k.almacen_id] || {}).nombre || '')} · ${fechaHora(k.apertura)} → ${k.estado === 'CERRADO' ? fechaHora(k.cierre) : 'en curso'}</p>
    ${k.estado === 'CERRADO' ? `<div class="corte-res">${f('Inicio de caja (fondo)', k.fondo)}${f('Ventas en efectivo', k.efectivo)}${f('Abonos en efectivo', k.abonos_efectivo)}
      <b>Efectivo esperado</b><b>${dinero(k.esperado)}</b>${f('Efectivo contado', k.contado)}
      <b>Diferencia</b><b class="${Math.abs(k.diferencia) < 0.005 ? 'cambio' : 'txt-error'}">${k.diferencia > 0 ? 'A favor ' : k.diferencia < 0 ? 'En contra ' : ''}${dinero(Math.abs(k.diferencia))}</b>
      ${k.retiro !== '' && k.retiro !== undefined ? f('Retiro', k.retiro) + `<b>Queda en caja</b><b>${dinero(k.queda)}</b>` : ''}</div>
      <div class="corte-res">${f('Tarjeta', k.tarjeta)}${f('Transferencia', k.transferencia)}${f('A crédito', k.credito)}${f('Abonos otros medios', k.abonos_otros)}<b>Venta total</b><b>${dinero(k.total_ventas)}</b></div>
      ${k.notas ? `<p class="nota">Notas: ${esc(k.notas)}</p>` : ''}
      <div class="acciones"><button type="button" class="btn sec" id="cr-imp">Imprimir corte</button></div>` : '<p class="nota">El turno sigue abierto.</p>'}</div>`);
  const bi = $('#cr-imp', d);
  if (bi) bi.onclick = () => imprimirCorte(k);
}

// Turnos con retiro o con diferencia en el periodo
function dlgListaCortes(tipo) {
  const l = VT.cortes.filter(k => k.estado === 'CERRADO' && (tipo === 'retiros' ? Number(k.retiro) > 0 : Math.abs(Number(k.diferencia)) >= 0.005));
  const d = abrirModal(tipo === 'retiros' ? 'Retiros de caja' : 'Faltantes y sobrantes', `<div class="form">${l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Cierre</th><th>Cajero</th><th>Sucursal</th><th class="num">${tipo === 'retiros' ? 'Retiro' : 'Diferencia'}</th><th class="num">Queda en caja</th></tr></thead>
    <tbody>${l.map(k => `<tr class="clic" data-k="${esc(k.id)}"><td>${fechaHora(k.cierre)}</td><td>${esc(k.cajero)}</td><td>${esc((S.idx.alm[k.almacen_id] || {}).nombre || '')}</td>
      <td class="num ${tipo === 'difs' ? 'txt-error' : ''}">${tipo === 'retiros' ? dinero(k.retiro) : (k.diferencia > 0 ? '+' : '−') + dinero(Math.abs(k.diferencia))}</td><td class="num">${k.queda === '' ? '—' : dinero(k.queda)}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="vacio">${tipo === 'retiros' ? 'Sin retiros registrados.' : 'Todos los cortes cuadraron.'}</p>`}</div>`, true);
  const abrir = () => dlgListaCortes(tipo);
  d.onclick = e => { const tr = e.target.closest('tr[data-k]'); if (tr) { dlgCorteResumen(VT.cortes.find(k => k.id === tr.dataset.k)); botonVolver(abrir); } };
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
        <label>Días para pagar <small>(naturales, desde el día del pedido o venta)</small><input name="dias_credito" type="number" step="1" min="0" list="cl-dias-sug" value="${cl.dias_credito || 30}">
          <datalist id="cl-dias-sug">${[7, 15, 30, 45, 60, 90, 120].map(n => `<option value="${n}">`).join('')}</datalist></label></div>
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
    <span class="fila-oc"><small>${p.fecha_entrega ? (p.fecha_entrega === hoy ? '<b>Hoy</b>' : (atrasado ? '<b class="txt-error">Atrasado ' : '') + fechaCorta(p.fecha_entrega) + (atrasado ? '</b>' : '')) : 'Sin fecha'}${entregaTxt(p) ? ' · ' + entregaTxt(p) : ''}${enRuta ? ` · ${enRuta} en ruta` : ''}</small><b>${dinero(p.total)}</b></span>
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
      <td>${fechaCorta(p.fecha_entrega)}${entregaTxt(p) ? `<small>${entregaTxt(p)}</small>` : ''}</td><td>${avancePedido(p)}%</td><td class="num">${dinero(p.total)}</td><td>${chipPed(p.estado)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="vacio">Sin pedidos.</p>'}`;
  const qi = $('#pd-q', c);
  qi.oninput = () => { PD.q = qi.value; const pos = qi.selectionStart; pintarListaPedidos(c); const n = $('#pd-q', c); n.focus(); n.setSelectionRange(pos, pos); };
}

function dlgEditorPedido(base) {
  const nuevo = !base;
  const esSuc = rol() === 'ADMIN_SUCURSAL';
  const bodegas = S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.tipo === 'BODEGA').sort(porNombre);
  // La sucursal puede pedir a la bodega o a otra sucursal
  const origenes = rol() === 'INVENTARIOS' ? S.catalogo.almacenes.filter(a => a.id === S.usuario.almacen_id)
    : esSuc ? bodegas.concat(S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.tipo === 'SUCURSAL' && a.id !== S.usuario.almacen_id).sort(porNombre)) : bodegas;
  const sucursales = S.catalogo.almacenes.filter(a => esActivo(a.activo) && a.tipo === 'SUCURSAL').sort(porNombre);
  const p = base ? JSON.parse(JSON.stringify(base)) : {
    tipo: esSuc ? 'INTERNO' : 'EXTERNO', origen_id: (origenes[0] || {}).id || '', cliente_id: '', destino_id: esSuc ? S.usuario.almacen_id : '',
    condicion: 'CONTADO', iva_tasa: 0, fecha_entrega: hoyLocal(1), notas: '', lineas: []
  };
  const lineas = p.lineas.map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad), precio: Number(l.precio) }));
  const clientes = (S.clientes || []).filter(c => c.activo !== false).sort(porNombre);
  const d = abrirModal(nuevo ? (esSuc ? 'Solicitar mercancía' : 'Nuevo pedido') : `Editar ${p.folio}`, `
    <form id="fped" class="form" autocomplete="off">
      ${esSuc ? `<p class="nota">La solicitud llega al almacén que elijas en "Surte" para que la programe y la mande a ${esc((S.idx.alm[S.usuario.almacen_id] || {}).nombre || 'tu sucursal')}.</p>` : `
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

// Mensaje listo para avisar al cliente por WhatsApp según cómo va su pedido
function mensajeWhatsApp(p) {
  const hola = `Hola, te escribimos de ${CFG.NOMBRE} sobre tu pedido ${p.folio} (${dinero(p.total)}). `;
  const cuando = (p.fecha_entrega ? fechaCorta(p.fecha_entrega) : '') + (p.horario_entrega ? ' de ' + p.horario_entrega.replace('-', ' a ') : '');
  if (p.estado === 'SOLICITADO') return hola + 'Ya lo recibimos y en breve lo programamos.';
  if (p.estado === 'PROGRAMADO') return hola + (p.modalidad === 'RECOGER' ? `Estará listo para que pases por él el ${cuando}.` : `Quedó programado para entregarse el ${cuando}.`);
  if (p.estado === 'EN_PROCESO') return hola + (p.envios.some(e => e.estado === 'EN_RUTA') ? 'Ya va en camino.' : 'Lo estamos preparando.');
  if (p.estado === 'ENTREGADO') return hola + '¡Gracias por tu compra!';
  if (p.estado === 'CANCELADO') return hola + 'Lamentablemente fue cancelado. Cualquier duda, aquí estamos.';
  return hola;
}

function dlgPedido(p) {
  if (!p) return;
  // Surte quien tiene el almacén de origen: bodega, o la sucursal a la que otra le pidió un traspaso
  const bodega = esBodegaRol() || (rol() === 'ADMIN_SUCURSAL' && p.origen_id === S.usuario.almacen_id);
  const enRuta = p.envios.filter(e => e.estado === 'EN_RUTA');
  const hayPend = p.lineas.some(l => porSurtirLinea(l) > 0);
  const tieneEnvios = p.envios.some(e => e.estado !== 'CANCELADO');
  const acciones = [];
  if (bodega && ['SOLICITADO', 'PROGRAMADO', 'EN_PROCESO'].includes(p.estado)) acciones.push(['programar', p.estado === 'SOLICITADO' ? 'Aceptar y programar' : 'Reprogramar', 'sec']);
  if (bodega && ['SOLICITADO', 'PROGRAMADO', 'EN_PROCESO'].includes(p.estado) && hayPend) acciones.push(['surtir', 'Lotear / surtir', '']);
  const otraPidio = rol() === 'ADMIN_SUCURSAL' && p.destino_id !== S.usuario.almacen_id;   // solo quien pidió lo edita
  if (['SOLICITADO', 'PROGRAMADO'].includes(p.estado) && !tieneEnvios && !otraPidio && (bodega || p.estado === 'SOLICITADO')) acciones.push(['editar', 'Editar', 'sec']);
  if (bodega && p.estado === 'EN_PROCESO' && !enRuta.length) acciones.push(['cerrar', 'Cerrar con faltante', 'sec']);
  if (['SOLICITADO', 'PROGRAMADO'].includes(p.estado) && !tieneEnvios && (bodega || p.estado === 'SOLICITADO')) acciones.push(['cancelar', 'Cancelar pedido', 'peligro']);
  const cli = p.tipo === 'EXTERNO' ? clientePorId(p.cliente_id) : null;
  const telWa = p.tipo === 'EXTERNO' ? (String((cli && cli.telefono) || '').replace(/\D/g, '').slice(-10) || ((String(p.notas || '').match(/Tel\. (\d{10})/) || [])[1] || '')) : '';
  const d = abrirModal(`Pedido ${p.folio}`, `<div class="form">
    <div class="titulo"><span>${chipPed(p.estado)} <span class="nota">${p.tipo === 'EXTERNO' ? 'Cliente externo' : 'Traspaso a sucursal'} · ${p.solicito === 'PORTAL' ? 'pedido desde el portal' : p.solicito === 'SUCURSAL' ? 'solicitado por la sucursal' : 'capturado en bodega'}</span></span><b>${dinero(p.total)}</b></div>
    <div class="info-oc">
      <div><h4>Para</h4><b>${esc(destinoPedido(p))}</b>${cli && cli.telefono ? '<br>' + esc(cli.telefono) : ''}${telWa.length === 10 ? ` <a class="btn mini sec wa" target="_blank" rel="noopener" href="https://wa.me/52${telWa}?text=${encodeURIComponent(mensajeWhatsApp(p))}">WhatsApp</a>` : ''}${p.tipo === 'EXTERNO' ? `<br>${p.condicion === 'CREDITO' ? 'Crédito' : 'Contado'}${Number(p.iva_tasa) ? ' · IVA ' + p.iva_tasa + '%' : ''}` : ''}</div>
      <div><h4>Surte</h4><b>${esc((S.idx.alm[p.origen_id] || {}).nombre || '')}</b><br>Entrega: ${fechaCorta(p.fecha_entrega)}${entregaTxt(p) ? ' · ' + entregaTxt(p) : ''}</div>
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
    <div class="cab"><div style="display:flex;gap:10px;align-items:center"><img src="${esc(logoSrc())}" alt=""><div><h1>${esc(CFG.NOMBRE)}</h1>${esc(orig.nombre || '')}${orig.direccion ? '<br>' + esc(orig.direccion) : ''}</div></div>
      <div style="text-align:right"><h1>REMISIÓN</h1><div class="folio">${esc(e.folio)}</div>Pedido ${esc(p.folio)}<br>${fechaHora(e.fecha)}</div></div>
    <div class="cajas"><div class="caja"><h3>${externo ? 'Cliente' : 'Sucursal'}</h3><b>${esc(externo ? cli.nombre || '' : dest.nombre || '')}</b><br>
      ${esc(externo ? cli.direccion || '' : dest.direccion || '')}${(externo ? cli.telefono : dest.telefono) ? '<br>Tel. ' + esc(externo ? cli.telefono : dest.telefono) : ''}${externo && cli.rfc ? '<br>RFC ' + esc(cli.rfc) : ''}</div>
      <div class="caja"><h3>Entrega</h3>Fecha programada: ${fechaCorta(p.fecha_entrega)}${entregaTxt(p) ? ' · ' + entregaTxt(p) : ''}<br>${externo ? (p.condicion === 'CREDITO' ? 'Condición: crédito' : 'Condición: contado') : 'Traspaso entre almacenes'}${e.notas ? '<br>' + esc(e.notas) : ''}</div></div>
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
  const prox = (c.vencimientos || []).find(x => x.dias >= 0);
  el.innerHTML = `<div class="saludo"><h2>Hola, ${esc(c.nombre || S.usuario.nombre)}</h2><p>Portal de clientes · ${esc(CFG.NOMBRE)}</p></div>
    ${avisoCredito(c)}
    ${S.avisosCliente && S.avisosCliente.nuevos && S.avisosCliente.nuevos.length ? `<button type="button" class="aviso-nuevo" data-ir="avisos"><span>${iconoAviso(S.avisosCliente.nuevos[0].tipo)}</span>
      <span><b>${esc(S.avisosCliente.nuevos[0].titulo)}</b><small>${esc(S.avisosCliente.nuevos[0].mensaje)}</small></span>${S.avisosCliente.no_leidos > 1 ? `<small>+${S.avisosCliente.no_leidos - 1} más</small>` : ''}</button>` : ''}
    ${permisoNotif() === 'default' ? '<p><button type="button" class="btn sec" id="pi-notif">🔔 Avísame en este teléfono cuando cambie mi pedido</button></p>' : ''}
    ${c.credito || Number(c.saldo) > 0 ? `<div class="tarjetas">
      <button type="button" class="tarjeta" data-ir="estado"><span>Saldo pendiente</span><b>${dinero(c.saldo)}</b>${prox ? `<small>Próximo vencimiento: ${dinero(prox.saldo)} el ${fechaCorta(prox.vence)}</small>` : ''}</button>
      ${c.credito ? `<div class="tarjeta"><span>Crédito disponible</span><b>${dinero(c.disponible !== undefined ? c.disponible : disp)}</b><small>Límite ${dinero(c.limite_credito)} · cada pedido vence a ${c.dias_credito} días</small></div>` : ''}
      <button type="button" class="tarjeta ${Number(c.vencido) > 0 ? 'alerta-roja' : ''}" data-ir="estado"><span>Vencido</span><b>${dinero(c.vencido)}</b></button>
    </div>` : '<p class="nota">Tus pedidos se pagan al recibir o al recoger. Si te interesa crédito, pídelo en la tienda.</p>'}
    <div class="portal-acciones">
      <button type="button" class="ir-caja" data-ir="tienda"><b>Hacer un pedido</b><span>Catálogo con tus precios · elige día y horario</span></button>
      <button type="button" class="ir-caja ir-tienda" data-ir="entienda"><b>Estoy en la tienda</b><span>Escanea tus productos, verifica precios y paga rápido en caja</span></button>
      <button type="button" class="btn sec" data-ir="mispedidos">Mis pedidos</button>
      <button type="button" class="btn sec" data-ir="estado">Estado de cuenta</button>
    </div>
    <p><button type="button" class="link" id="pi-datos">Mis datos: ${esc(c.telefono ? telBonito(c.telefono) : 'agrega tu teléfono')} · ${esc(c.direccion || 'agrega tu dirección')}</button></p>`;
  $('#pi-datos', el).onclick = e => { e.stopPropagation(); dlgMisDatos(); };
  const pn = $('#pi-notif', el);
  if (pn) pn.onclick = async e => { e.stopPropagation(); if (await pedirPermisoNotif()) pn.remove(); };
  el.onclick = e => { const b = e.target.closest('[data-ir]'); if (b) irA(b.dataset.ir); };
  S.refrescar = () => vInicioPortal(el);
}

async function vTienda(el) {
  if (!PT.carrito) PT.carrito = (await DB.get('carrito:' + S.usuario.usuario)) || { lineas: [], condicion: '', fecha: '', notas: '' };
  const K = PT.carrito;
  if (!K.modalidad) K.modalidad = 'DOMICILIO';
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
        ${puedeCredito ? `<label>¿Cómo pagas?<select id="pt-cond"><option value="CREDITO" ${K.condicion === 'CREDITO' ? 'selected' : ''}>A crédito · disponible ${dinero(cli.disponible !== undefined ? cli.disponible : creditoDisponible(cli))} · vence a ${cli.dias_credito} días</option><option value="CONTADO" ${K.condicion === 'CONTADO' ? 'selected' : ''}>Pago al recibir o recoger</option></select></label>`
          : `<p class="nota">${cli.credito ? '<b class="txt-error">Tienes pagos vencidos:</b> este pedido se paga al recibir o recoger.' : 'Pagas al recibir o al recoger (efectivo o tarjeta).'}</p><input type="hidden" id="pt-cond" value="CONTADO">`}
        <label>¿Cómo lo recibes?<select id="pt-mod"><option value="DOMICILIO">Entrega a domicilio</option><option value="RECOGER" ${K.modalidad === 'RECOGER' ? 'selected' : ''}>Paso a recogerlo a la tienda</option></select></label>
        <div class="fila2"><label>Fecha<input id="pt-fecha" type="date" min="${hoyLocal()}" value="${esc(K.fecha)}"></label>
          <label>Horario<select id="pt-hora"><option value="">Cualquier hora</option>${(S.horariosEntrega || HORARIOS_ENTREGA).map(h => `<option value="${h}" ${K.horario === h ? 'selected' : ''}>${h.replace('-', ' a ')}</option>`).join('')}</select></label></div>
        <p class="nota" id="pt-dir">${K.modalidad === 'RECOGER' ? 'Lo recoges en la tienda.' : cli.direccion ? `Se entrega en: <b>${esc(cli.direccion)}</b> · <button type="button" class="link" id="pt-misdatos">cambiar</button>` : '<button type="button" class="link" id="pt-misdatos">Agrega tu dirección de entrega</button>'}</p>
        <label>Notas<input id="pt-notas" value="${esc(K.notas)}" placeholder="Referencias, quién recibe…"></label>
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
  $('#pt-hora', el).onchange = e => { K.horario = e.target.value; guardarCarrito(); };
  $('#pt-mod', el).onchange = e => { K.modalidad = e.target.value; guardarCarrito(); vTienda(el); };
  const bmd = $('#pt-misdatos', el);
  if (bmd) bmd.onclick = dlgMisDatos;
  $('#pt-notas', el).oninput = e => { K.notas = e.target.value; guardarCarrito(); };
  $('#pt-ver', el).onclick = () => $('.caja-ticket', el).scrollIntoView({ behavior: 'smooth' });
  const enviar = async () => {
    const msg = $('#pt-msg', el);
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para enviar el pedido. Tu carrito se guarda en este equipo.'; return; }
    if (!K.id) { K.id = uuid(); guardarCarrito(); }
    try {
      const r = await conCarga('Enviando pedido…', () => api('guardarPedido', { pedido: { nuevo: true, id: K.id, condicion: K.condicion, fecha_entrega: K.fecha, horario_entrega: K.horario || '', modalidad: K.modalidad, notas: K.notas, lineas: K.lineas } }));
      PT.carrito = { lineas: [], condicion: '', fecha: '', notas: '', modalidad: K.modalidad };
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
      <small>Pedido ${fechaHora(p.fecha)}${p.fecha_entrega ? ' · entrega ' + fechaCorta(p.fecha_entrega) : ''}${entregaTxt(p) ? ' · ' + entregaTxt(p) : ''}</small>
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
    <div class="cab"><div style="display:flex;gap:10px;align-items:center"><img src="${esc(logoSrc())}" alt=""><h1>${esc(CFG.NOMBRE)}</h1></div>
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
        <small>${numero(prods)} productos con existencia · ${dinero(valor)}</small>
        ${a.tipo === 'SUCURSAL' && cajasDe(a.id).length ? `<small>Cajas: ${esc(cajasDe(a.id).map(c => c.nombre).join(', '))}</small>` : ''}</button>`;
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

/* ---- Cajas de cobro de cada sucursal ---- */
const claveCaja = (almacenId, cajaId) => cajaId || 'ALM:' + almacenId;
const cajasDe = (almacenId, todas = false) => (S.cajas || []).filter(c => c.almacen_id === almacenId && (todas || c.activo !== false))
  .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }));
const nombreCaja = id => ((S.cajas || []).find(c => c.id === id) || {}).nombre || '';

function dlgCajas(almacenId, alVolver) {
  const alm = S.idx.alm[almacenId] || {};
  const d = abrirModal(`Cajas · ${alm.nombre || ''}`, `<div class="form">
    <p class="nota">Cada caja lleva su propio turno: al abrir, la app compara el fondo con lo que dejó el turno anterior de esa misma caja. Si la sucursal tiene una sola caja no hace falta registrarla.</p>
    <ul class="lista" id="cjs-lista"></ul>
    <form id="fcjs" class="fila-form"><input name="nombre" placeholder="Nombre de la caja (ej. Caja 1, Caja rápida)" required maxlength="40"><button class="btn">Agregar caja</button></form>
    <p class="msg" id="cjs-msg"></p>
    ${alVolver ? '<div class="pie"><button type="button" class="btn sec" id="cjs-volver">Listo</button></div>' : ''}</div>`);
  const msg = $('#cjs-msg', d);
  const pintar = () => {
    const l = cajasDe(almacenId, true);
    $('#cjs-lista', d).innerHTML = l.length ? l.map(c => `<li><span class="${c.activo !== false ? '' : 'tachado'}">${esc(c.nombre)}${(S.cajasAbiertas || {})[c.id] ? ` <small>en uso: ${esc(S.cajasAbiertas[c.id].cajero)}</small>` : ''}</span>
      <span class="acciones"><button type="button" class="btn mini sec" data-ren="${esc(c.id)}">Cambiar nombre</button>
      <button type="button" class="btn mini sec" data-tog="${esc(c.id)}">${c.activo !== false ? 'Desactivar' : 'Activar'}</button></span></li>`).join('')
      : '<li class="nota">Sin cajas registradas: la sucursal funciona como una sola caja.</li>';
  };
  const guardar = async caja => {
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para guardar.'; return false; }
    try {
      const r = await conCarga('Guardando…', () => api('guardarCaja', { caja: Object.assign({ almacen_id: almacenId }, caja) }));
      S.cajas = (S.cajas || []).filter(c => c.almacen_id !== almacenId).concat(r);
      DB.set('cajas', { lista: S.cajas, abiertas: S.cajasAbiertas || {} });
      msg.textContent = '';
      pintar();
      return true;
    } catch (e) { msg.textContent = e.message; return false; }
  };
  pintar();
  $('#fcjs', d).onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    if (await guardar({ nombre: f.nombre.value.trim() })) f.reset();
  };
  $('#cjs-lista', d).onclick = e => {
    const r = e.target.closest('[data-ren]'), t = e.target.closest('[data-tog]');
    const c = (S.cajas || []).find(x => x.id === (r || t || {}).dataset?.[r ? 'ren' : 'tog']);
    if (!c) return;
    if (r) { const n = prompt('Nuevo nombre de la caja:', c.nombre); if (n && n.trim()) guardar({ id: c.id, nombre: n.trim(), activo: c.activo !== false }); }
    if (t) guardar({ id: c.id, nombre: c.nombre, activo: c.activo === false });
  };
  const v = $('#cjs-volver', d);
  if (v) v.onclick = alVolver;
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
      ${!nuevo && a.tipo === 'SUCURSAL' ? `<div class="campo"><span>Cajas de cobro</span><div class="fila-form"><span class="nota">${esc(cajasDe(a.id).map(c => c.nombre).join(', ') || 'Una sola caja (sin registrar)')}</span>
        <button type="button" class="btn mini sec" id="fa-cajas">Administrar cajas</button></div></div>` : ''}
      <p class="msg" id="fa-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fa', d);
  const bc = $('#fa-cajas', d);
  if (bc) bc.onclick = () => dlgCajas(a.id, () => dlgAlmacen(a));
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
  const roles = esGeneral() ? Object.keys(ROL_TXT) : ['CAJERO', 'INVENTARIOS', 'VERIFICADOR'];
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
    <div class="panel"><p><b>${esc(S.usuario.nombre)}</b> (${esc(S.usuario.usuario)})</p><p>${esc(ROL_TXT[rol()] || rol())}${a ? ' · ' + esc(a.nombre) : ''}</p>
      ${rol() === 'CLIENTE' ? '<button type="button" class="btn sec" id="b-misdatos">Mis datos de contacto y entrega</button>' : ''}</div>
    <div class="panel">
      <h3>Este equipo</h3>
      <p>Datos guardados: ${numero(S.catalogo.productos.length)} productos, ${numero(S.catalogo.almacenes.length)} almacenes.</p>
      <p>Última actualización: <b>${S.ultimaSync ? fechaHora(S.ultimaSync) : 'nunca'}</b></p>
      <p class="nota" id="persist"></p>
      <div class="acciones"><button type="button" class="btn" id="b-sync">Sincronizar ahora</button><button type="button" class="btn sec" id="b-inst" ${promptInstalar ? '' : 'hidden'}>Instalar en este equipo</button>
        ${S.catalogo.productos.some(p => p.imagen) ? '<button type="button" class="btn sec" id="b-imgs">Descargar imágenes de productos</button>' : ''}</div>
      <label class="letra-equipo">Tamaño de letra en este equipo<select id="b-letra"><option value="0">Igual que la empresa</option>${LETRAS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
    </div>
    ${esGeneral() ? `<div class="panel"><h3>Apariencia</h3><p class="nota">Nombre, logo, colores, tema, tamaño de letra e imagen de fondo para todos los equipos.</p><button type="button" class="btn sec" id="b-apar">Cambiar apariencia</button></div>` : ''}
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
  const bmd = $('#b-misdatos', el);
  if (bmd) bmd.onclick = dlgMisDatos;
  const bl = $('#b-letra', el);
  bl.value = String(APAR.letraEquipo || 0);
  bl.onchange = async () => { APAR.letraEquipo = Number(bl.value) || 0; await DB.set('letra-equipo', APAR.letraEquipo); aplicarApariencia(); };
  const bimgs = $('#b-imgs', el);
  if (bimgs) bimgs.onclick = descargarImagenes;
  const bap = $('#b-apar', el);
  if (bap) bap.onclick = dlgApariencia;
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

/* ---------------- Apariencia ---------------- */
// La define el administrador general para toda la empresa; el tamaño de letra se puede ajustar en cada equipo.
const APAR = { datos: null, letraEquipo: 0 };
const LOGO_APP = 'icons/icon-192.png';
const logoSrc = () => (APAR.datos && APAR.datos.logo) || LOGO_APP;
const LETRAS = [[0.9, 'Pequeña'], [1, 'Normal'], [1.15, 'Grande'], [1.3, 'Muy grande']];

function textoSobre(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 160 ? '#111111' : '#ffffff';
}

function aplicarApariencia(a = APAR.datos) {
  const c = (a && a.config) || {};
  const r = document.documentElement;
  const css = (k, v) => (v ? r.style.setProperty(k, v) : r.style.removeProperty(k));
  css('--marca-primario', c.primario);
  css('--marca-primario-txt', c.primario ? textoSobre(c.primario) : '');
  css('--marca-acento', c.acento);
  if (c.tema === 'claro' || c.tema === 'oscuro') r.dataset.tema = c.tema; else delete r.dataset.tema;
  css('--escala', String(APAR.letraEquipo || c.letra || 1));
  const fondo = a && a.fondo;
  document.body.classList.toggle('con-fondo', !!fondo);
  css('--fondo-img', fondo ? `url("${fondo}")` : '');
  css('--velo', fondo ? (c.velo || 82) + '%' : '');
  const logo = (a && a.logo) || LOGO_APP;
  $$('.marca img, .login-caja img').forEach(im => { if (im.getAttribute('src') !== logo) im.src = logo; });
  const ico = document.querySelector('link[rel=icon]');
  if (ico) ico.href = logo;
  CFG.NOMBRE = c.nombre || CFG.NOMBRE_ORIGINAL;
  document.title = CFG.NOMBRE;
  $('#login-titulo').textContent = CFG.NOMBRE;
  $('#app-nombre').textContent = CFG.NOMBRE;
  Object.keys(cacheLogo).forEach(k => delete cacheLogo[k]);
}

async function cargarApariencia() {
  APAR.datos = (await DB.get('apariencia')) || null;
  APAR.letraEquipo = Number(await DB.get('letra-equipo')) || 0;
  aplicarApariencia();
}

// Se llama al sincronizar: si la versión cambió, descarga la apariencia nueva
async function revisarApariencia(v) {
  if (v === undefined || (APAR.datos && APAR.datos.version === v) || (!APAR.datos && !v)) return;
  try {
    APAR.datos = await api('apariencia');
    await DB.set('apariencia', APAR.datos);
    aplicarApariencia();
  } catch (e) { /* se reintenta en la siguiente sincronización */ }
}

// Reduce una imagen elegida por el usuario. Devuelve un data URL que no pasa de "limite" caracteres.
function reducirImagen(archivo, max, { tipo = 'image/jpeg', limite = 400000, fondoBlanco = tipo === 'image/jpeg' } = {}) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      let lado = max, res = '';
      for (let i = 0; i < 6; i++) {
        const e = Math.min(1, lado / Math.max(im.width, im.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.width * e));
        c.height = Math.max(1, Math.round(im.height * e));
        const g = c.getContext('2d');
        if (fondoBlanco) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(im, 0, 0, c.width, c.height);
        res = c.toDataURL(tipo, 0.8);
        if (res.length > limite && tipo === 'image/png') res = c.toDataURL('image/jpeg', 0.85);
        if (res.length <= limite) return ok(res);
        lado = Math.round(lado * 0.75);
      }
      mal(new Error('La imagen es demasiado grande.'));
    };
    im.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la imagen. Usa JPG o PNG.')); };
    im.src = url;
  });
}

/* ---------------- Imágenes de productos ---------------- */
// Se guardan en el equipo al verlas por primera vez; así la caja las muestra aunque no haya internet.
const IMGS = { mem: {}, cola: new Set(), esperando: [], timer: null };

async function imagenLocal(id) {
  if (!id) return '';
  if (IMGS.mem[id]) return IMGS.mem[id];
  const v = await DB.get('img:' + id);
  if (v) IMGS.mem[id] = v;
  return v || '';
}

// Pide al servidor las que no están en el equipo (en grupos)
function pedirImagenes(ids) {
  return new Promise(resolver => {
    ids.forEach(id => IMGS.cola.add(id));
    IMGS.esperando.push(resolver);
    clearTimeout(IMGS.timer);
    IMGS.timer = setTimeout(async () => {
      const lista = [...IMGS.cola];
      const fin = IMGS.esperando;
      IMGS.cola.clear();
      IMGS.esperando = [];
      if (navigator.onLine && S.online !== false) {
        for (let i = 0; i < lista.length; i += 20) {
          try {
            const r = await api('imagenes', { ids: lista.slice(i, i + 20) });
            for (const [id, url] of Object.entries(r)) { IMGS.mem[id] = url; await DB.set('img:' + id, url); }
          } catch (e) { break; }
        }
      }
      fin.forEach(f => f());
    }, 120);
  });
}

// Pone la imagen en cada <img data-img="id"> del contenedor
async function cargarImgs(cont) {
  const faltan = [];
  for (const im of $$('img[data-img]', cont)) {
    const url = await imagenLocal(im.dataset.img);
    if (url) { im.src = url; im.classList.add('lista'); } else faltan.push(im);
  }
  if (!faltan.length) return;
  await pedirImagenes([...new Set(faltan.map(im => im.dataset.img))]);
  faltan.forEach(im => {
    const url = IMGS.mem[im.dataset.img];
    if (url && im.isConnected) { im.src = url; im.classList.add('lista'); }
  });
}

// Descarga al equipo todas las imágenes de productos (para usar la caja sin internet)
async function descargarImagenes() {
  const ids = [...new Set(S.catalogo.productos.filter(p => esActivo(p.activo) && p.imagen).map(p => p.imagen))];
  const faltan = [];
  for (const id of ids) if (!(await imagenLocal(id))) faltan.push(id);
  if (!faltan.length) { toast(`Las ${plural(ids.length, 'imagen')} ya están en este equipo.`, 'ok'); return; }
  if (!navigator.onLine) { toast('Necesitas conexión para descargar las imágenes.', 'error'); return; }
  await conCarga(`Descargando ${plural(faltan.length, 'imagen')}…`, () => pedirImagenes(faltan));
  const listas = faltan.filter(id => IMGS.mem[id]).length;
  toast(`${plural(listas, 'imagen')} ${listas === 1 ? 'guardada' : 'guardadas'} en este equipo.`, listas ? 'ok' : 'error');
}

/* ---------------- Diálogo de apariencia ---------------- */
function dlgApariencia() {
  const actual = APAR.datos || { config: {}, logo: '', fondo: '' };
  const c = Object.assign({ primario: '#0172b6', acento: '#e0de27', tema: 'auto', letra: 1, velo: 82, nombre: '' }, actual.config);
  let logo = actual.logo || '', fondo = actual.fondo || '';
  let logoCambio = false, fondoCambio = false;
  const d = abrirModal('Apariencia de la app', `
    <form id="fap" class="form dos-col">
      <p class="nota completo">Se aplica en todos los equipos de la empresa. Los cambios se ven aquí mismo antes de guardar.</p>
      <div class="col">
      <label>Nombre que aparece en la app<input name="nombre" maxlength="60" value="${esc(c.nombre)}" placeholder="${esc(CFG.NOMBRE_ORIGINAL)}"></label>
      <div class="campo"><span>Logo (app, tickets y órdenes de compra)</span>
        <div class="fila-form"><img id="ap-logo" class="logo-prev" alt="" src="${esc(logo || LOGO_APP)}">
          <div class="acciones"><label class="btn sec">Cambiar logo<input type="file" accept="image/png,image/jpeg" id="ap-logo-arch" hidden></label>
          <button type="button" class="btn sec" id="ap-logo-quitar">Usar el original</button></div></div></div>
      <div class="fila2">
        <label>Color principal<input name="primario" type="color" value="${esc(c.primario)}"></label>
        <label>Color de acento<input name="acento" type="color" value="${esc(c.acento)}"></label>
      </div>
      <div class="fila2">
        <label>Tema<select name="tema"><option value="auto">Automático (según el equipo)</option><option value="claro">Claro</option><option value="oscuro">Oscuro</option></select></label>
        <label>Tamaño de letra<select name="letra">${LETRAS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
      </div>
      <div class="acciones"><button type="button" class="btn mini sec" id="ap-marca">Colores de la marca</button></div>
      </div>
      <div class="col">
      <div class="campo"><span>Imagen de fondo</span>
        <div class="fila-form"><div id="ap-fondo" class="fondo-prev"></div>
          <div class="acciones"><label class="btn sec">Elegir imagen<input type="file" accept="image/*" id="ap-fondo-arch" hidden></label>
          <button type="button" class="btn sec" id="ap-fondo-quitar">Sin imagen</button></div></div></div>
      <label id="ap-velo-l">Qué tanto se ve la imagen<input name="velo" type="range" min="40" max="95" step="1" value="${135 - Number(c.velo)}"></label>
      </div>
      <p class="msg" id="fap-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`, 'medio');
  const f = $('#fap', d), msg = $('#fap-msg', d);
  f.tema.value = c.tema;
  f.letra.value = String(LETRAS.reduce((m, [v]) => (Math.abs(v - c.letra) < Math.abs(m - c.letra) ? v : m), 1));
  const leer = () => ({ nombre: f.nombre.value.trim(), primario: f.primario.value, acento: f.acento.value, tema: f.tema.value,
    letra: Number(f.letra.value), velo: 135 - Number(f.velo.value) });
  const vista = () => {
    const pf = $('#ap-fondo', d);
    pf.style.backgroundImage = fondo ? `url("${fondo}")` : '';
    pf.textContent = fondo ? '' : 'Sin imagen';
    $('#ap-velo-l', d).hidden = !fondo;
    $('#ap-logo', d).src = logo || LOGO_APP;
    aplicarApariencia({ config: leer(), logo, fondo });
  };
  vista();
  f.oninput = vista;
  let guardado = false;
  d.addEventListener('close', () => { if (!guardado) aplicarApariencia(); }, { once: true });
  $('#ap-marca', d).onclick = () => { f.primario.value = '#0172b6'; f.acento.value = '#e0de27'; vista(); };
  $('#ap-logo-arch', d).onchange = async e => {
    const a = e.target.files[0];
    if (!a) return;
    try { logo = await reducirImagen(a, 256, { tipo: 'image/png', limite: 44000 }); logoCambio = true; vista(); } catch (er) { msg.textContent = er.message; }
  };
  $('#ap-logo-quitar', d).onclick = () => { logo = ''; logoCambio = true; vista(); };
  $('#ap-fondo-arch', d).onchange = async e => {
    const a = e.target.files[0];
    if (!a) return;
    try { fondo = await reducirImagen(a, 1600, { limite: 1000000 }); fondoCambio = true; vista(); } catch (er) { msg.textContent = er.message; }
  };
  $('#ap-fondo-quitar', d).onclick = () => { fondo = ''; fondoCambio = true; vista(); };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!navigator.onLine) { msg.textContent = 'Necesitas conexión para guardar la apariencia.'; return; }
    const datos = { apariencia: leer() };
    if (logoCambio) datos.logo = logo;
    if (fondoCambio) datos.fondo = fondo;
    try {
      APAR.datos = await conCarga('Guardando apariencia…', () => api('guardarApariencia', datos));
      await DB.set('apariencia', APAR.datos);
      guardado = true;
      cerrarModal();
      aplicarApariencia();
      toast('Apariencia guardada. Los demás equipos la verán al sincronizar.', 'ok');
    } catch (e) { msg.textContent = e.message; }
  };
}

/* ---------------- Personal y nómina ---------------- */
const PER = { tab: 'asistencia', base: null, desde: '', hasta: '', alm: '', emp: '', ntipo: 'QUINCENAL', nfecha: '' };
const LETRA_DIA = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const NOMBRE_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ESTADO_DIA = {
  A_TIEMPO: ['A tiempo', '✓'], RETARDO: ['Retardo', 'R'], FALTA: ['Falta', 'F'], DESCANSO: ['Descanso', 'D'], VACACIONES: ['Vacaciones', 'V'],
  PERMISO: ['Permiso con goce', 'P'], INCAPACIDAD: ['Incapacidad (sin pago)', 'I'], FIJO: ['Salario fijo (no checa)', '$'], PENDIENTE: ['Pendiente de checar', '·']
};
const TIPO_PAGO_TXT = { DIARIO: 'Diario', SEMANAL: 'Semanal', QUINCENAL: 'Quincenal' };
const ESTADO_SOL = { SOLICITADA: 'Por aprobar', SOLICITADO: 'Por aprobar', APROBADA: 'Aprobada', APROBADO: 'Aprobado', RECHAZADA: 'Rechazada',
  RECHAZADO: 'Rechazado', CANCELADA: 'Cancelada', CANCELADO: 'Cancelado', DESCONTADO: 'Descontado en nómina' };
const diaSem = ymd => new Date(ymd + 'T12:00:00').getDay();
const sumarDiasL = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const finMes = ymd => { const d = new Date(ymd.slice(0, 8) + '01T12:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return d.toISOString().slice(0, 10); };
const quincenaDe = ymd => (Number(ymd.slice(8)) <= 15 ? [ymd.slice(0, 8) + '01', ymd.slice(0, 8) + '15'] : [ymd.slice(0, 8) + '16', finMes(ymd)]);
const horaDe = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const rangoTxt = (a, b) => (a === b ? `${Number(a.slice(8))} ${MESES[Number(a.slice(5, 7)) - 1]} ${a.slice(0, 4)}`
  : `${Number(a.slice(8))}${a.slice(5, 7) !== b.slice(5, 7) ? ' ' + MESES[Number(a.slice(5, 7)) - 1] : ''} al ${Number(b.slice(8))} ${MESES[Number(b.slice(5, 7)) - 1]} ${b.slice(0, 4)}`);
const empNombre = id => ((PER.base && PER.base.empleados.find(e => e.id === id)) || {}).nombre || '—';
const almNombre = id => (S.idx.alm[id] || {}).nombre || '';

async function cargarPersonal(forzar = false) {
  if (!PER.base || forzar) PER.base = await api('personal');
  return PER.base;
}

function vPersonal(el) {
  const tabs = [['asistencia', 'Asistencia'], ['nomina', 'Nómina'], ['solicitudes', 'Solicitudes'], ['bonos', 'Bonos'], ['empleados', 'Empleados'], ['reglas', 'Horarios y reglas']];
  const pend = S.personalAvisos ? S.personalAvisos.vacaciones + S.personalAvisos.adelantos : 0;
  el.innerHTML = `<div class="titulo"><h2>Personal</h2><div class="acciones"><button type="button" class="btn sec" id="pe-chk">Abrir checador</button></div></div>
    <div class="segmentos" id="pe-tabs">${tabs.map(([k, t]) => `<button type="button" data-t="${k}" class="${PER.tab === k ? 'activo' : ''}">${t}${k === 'solicitudes' && pend ? ` <span class="burbuja">${pend}</span>` : ''}</button>`).join('')}</div>
    <div id="pe-cuerpo"></div>`;
  const c = $('#pe-cuerpo', el);
  const pintar = async () => {
    const base = await pedir(c, 'Cargando personal…', () => cargarPersonal());
    if (!base) return;
    ({ asistencia: pePintarAsistencia, nomina: pePintarNomina, solicitudes: pePintarSolicitudes, bonos: pePintarBonos, empleados: pePintarEmpleados, reglas: pePintarReglas })[PER.tab](c);
  };
  $('#pe-tabs', el).onclick = e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    PER.tab = b.dataset.t;
    $$('#pe-tabs button', el).forEach(x => x.classList.toggle('activo', x === b));
    pintar();
  };
  $('#pe-chk', el).onclick = () => irA('checador');
  PER.repintar = async (forzar = true) => { if (forzar) PER.base = null; await pintar(); };
  S.refrescar = null;
  pintar();
}

function filtrosSucursal(id, valor) {
  if (!esGeneral()) return '';
  const alms = S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre);
  return `<select id="${id}"><option value="">Todas las sucursales</option>${alms.map(a => `<option value="${esc(a.id)}" ${valor === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select>`;
}

/* ---- Asistencia: tabla de la quincena ---- */
async function pePintarAsistencia(c) {
  if (!PER.desde) [PER.desde, PER.hasta] = quincenaDe(hoyLocal());
  const emps = PER.base.empleados.filter(e => e.activo).sort(porNombre);
  c.innerHTML = `<div class="filtros">
      <div class="nav-periodo"><button type="button" class="btn sec mini" id="as-ant" aria-label="Quincena anterior">‹</button>
        <b id="as-rango">${rangoTxt(PER.desde, PER.hasta)}</b><button type="button" class="btn sec mini" id="as-sig" aria-label="Quincena siguiente">›</button></div>
      ${filtrosSucursal('as-alm', PER.alm)}
      <select id="as-emp"><option value="">Todas las personas</option>${emps.map(e => `<option value="${esc(e.id)}" ${PER.emp === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select>
      <button type="button" class="btn sec" id="as-hoy">Quincena actual</button>
    </div>
    <div class="leyenda">${Object.entries(ESTADO_DIA).map(([k, [t, s]]) => `<span><i class="asis-c e-${k}">${s}</i>${t}</span>`).join('')}</div>
    <div id="as-tabla"></div>`;
  const t = $('#as-tabla', c);
  if (!PER.base.empleados.length) { t.innerHTML = '<p class="vacio">Aún no hay empleados. Regístralos en la pestaña Empleados.</p>'; return; }
  const r = await pedir(t, 'Calculando asistencia…', () => api('asistencia', { desde: PER.desde, hasta: PER.hasta, almacen_id: PER.alm, empleado_id: PER.emp }));
  if (!r) return;
  PER.asis = r;
  const grupos = {};
  r.empleados.forEach(e => (grupos[e.almacen_id] = grupos[e.almacen_id] || []).push(e));
  const cols = r.dias.length + 7;
  const tot = { base: 0, desc: 0, mas: 0, total: 0 };
  const fila = e => {
    const n = e.nomina;
    const desc = n.desc_faltas + n.desc_retardos + n.adelantos + n.otros_descuentos, mas = n.bonos + n.bono_puntualidad + (n.bono_ventas || 0) + n.prima_vacacional;
    tot.base += n.base; tot.desc += desc; tot.mas += mas; tot.total += n.total;
    return `<tr><td class="asis-nom"><button type="button" class="link" data-emp="${esc(e.id)}">${esc(e.nombre)}</button><small>${esc(e.puesto || '')}${e.puesto ? ' · ' : ''}${TIPO_PAGO_TXT[e.tipo_pago]}</small></td>
      ${r.dias.map(d => {
        const x = e.dias[d] || {};
        const est = x.estado || '';
        const sim = est === 'RETARDO' ? '+' + x.minutos_tarde : est ? ESTADO_DIA[est][1] : '';
        const tip = [est ? ESTADO_DIA[est][0] : 'Sin registro', x.entrada ? 'Entrada ' + horaDe(x.entrada) : '', x.salida ? 'Salida ' + horaDe(x.salida) : '', x.manual ? 'Registro manual' : '', x.notas || ''].filter(Boolean).join(' · ');
        return `<td class="asis-c e-${est || 'NADA'} ${x.manual ? 'manual' : ''}" data-e="${esc(e.id)}" data-d="${d}" title="${esc(tip)}">${sim}</td>`;
      }).join('')}
      <td class="num">${e.conteo.RETARDO || ''}</td><td class="num">${(e.conteo.FALTA + e.conteo.INCAPACIDAD) || ''}</td>
      <td class="num">${dinero(n.base)}</td><td class="num txt-error">${desc ? '−' + dinero(desc) : '—'}</td><td class="num txt-ok">${mas ? '+' + dinero(mas) : '—'}</td>
      <td class="num"><b>${dinero(n.total)}</b></td></tr>`;
  };
  const cuerpo = Object.keys(grupos).sort((a, b) => almNombre(a).localeCompare(almNombre(b))).map(a =>
    `<tr class="asis-grupo"><td colspan="${cols}">${esc(almNombre(a) || 'Sin sucursal')}</td></tr>` + grupos[a].sort(porNombre).map(fila).join('')).join('');
  t.innerHTML = r.empleados.length ? `<div class="tabla-cont asis-cont"><table class="tabla asis">
    <thead><tr><th class="asis-nom">Empleado</th>${r.dias.map(d => `<th class="asis-d ${d === r.hoy ? 'hoy' : ''} ${[0, 6].includes(diaSem(d)) ? 'finde' : ''}"><small>${LETRA_DIA[diaSem(d)]}</small>${Number(d.slice(8))}</th>`).join('')}
      <th class="num">Ret.</th><th class="num">Faltas</th><th class="num">Salario fijo</th><th class="num">Descuentos</th><th class="num">Bonos y prima</th><th class="num">Salario final</th></tr></thead>
    <tbody>${cuerpo}</tbody>
    <tfoot><tr class="tot"><td colspan="${r.dias.length + 3}">Total de la quincena</td><td class="num">${dinero(tot.base)}</td><td class="num">−${dinero(tot.desc)}</td><td class="num">+${dinero(tot.mas)}</td><td class="num">${dinero(tot.total)}</td></tr></tfoot></table></div>
    <p class="nota">Toca un día para justificarlo o corregir horas; toca un nombre para ver el detalle de su pago, bonos y descuentos. ${r.hasta >= r.hoy ? 'La quincena no ha terminado: los importes son preliminares.' : ''}</p>`
    : '<p class="vacio">No hay empleados con esos filtros.</p>';
  t.onclick = e => {
    const td = e.target.closest('td[data-d]'), b = e.target.closest('[data-emp]');
    if (td) dlgDiaAsistencia(r.empleados.find(x => x.id === td.dataset.e), td.dataset.d);
    if (b) dlgDetallePago(r.empleados.find(x => x.id === b.dataset.emp), r);
  };
  const mover = dir => {
    if (dir < 0) [PER.desde, PER.hasta] = quincenaDe(sumarDiasL(PER.desde, -1));
    else [PER.desde, PER.hasta] = quincenaDe(sumarDiasL(PER.hasta, 1));
    pePintarAsistencia(c);
  };
  $('#as-ant', c).onclick = () => mover(-1);
  $('#as-sig', c).onclick = () => mover(1);
  $('#as-hoy', c).onclick = () => { PER.desde = ''; pePintarAsistencia(c); };
  const fa = $('#as-alm', c);
  if (fa) fa.onchange = () => { PER.alm = fa.value; pePintarAsistencia(c); };
  $('#as-emp', c).onchange = e => { PER.emp = e.target.value; pePintarAsistencia(c); };
}

function dlgDiaAsistencia(emp, dia) {
  const x = emp.dias[dia] || {};
  const d = abrirModal(`${emp.nombre} · ${NOMBRE_DIA[diaSem(dia)]} ${fechaCorta(dia)}`, `
    <form id="fdia" class="form">
      <p>Ahora: <b>${x.estado ? ESTADO_DIA[x.estado][0] : 'Sin registro'}</b>${x.minutos_tarde ? ` (${x.minutos_tarde} min tarde)` : ''}${x.manual ? ' · registrado a mano' : ''}</p>
      <label>Marcar el día como<select name="estado"><option value="AUTO">Automático (según las checadas y el horario)</option>
        ${['A_TIEMPO', 'RETARDO', 'FALTA', 'PERMISO', 'INCAPACIDAD', 'DESCANSO'].map(k => `<option value="${k}" ${x.manual && x.estado === k ? 'selected' : ''}>${ESTADO_DIA[k][0]}</option>`).join('')}</select></label>
      <div class="fila2"><label>Hora de entrada<input name="entrada" type="time" value="${horaDe(x.entrada)}"></label><label>Hora de salida<input name="salida" type="time" value="${horaDe(x.salida)}"></label></div>
      <label>Nota<input name="notas" value="${esc(x.notas && !String(x.notas).startsWith('op:') ? x.notas : '')}" placeholder="Ej. Cita médica, olvidó checar"></label>
      <p class="nota">Las vacaciones se registran en Solicitudes para que se descuenten de sus días y se pague la prima.</p>
      <p class="msg" id="fdia-msg"></p>
      <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
    </form>`);
  const f = $('#fdia', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await conCarga('Guardando…', () => api('guardarAsistencia', { empleado_id: emp.id, dia, estado: f.estado.value, entrada: f.entrada.value, salida: f.salida.value, notas: f.notas.value.trim() }));
      cerrarModal();
      toast('Día actualizado.', 'ok');
      PER.repintar(false);
    } catch (e) { $('#fdia-msg', d).textContent = e.message; }
  };
}

// Detalle del pago de una persona en el rango, con bonos y descuentos
function dlgDetallePago(emp, r) {
  const n = emp.nomina, c = emp.conteo;
  const f = (t, v, cls = '') => `<span>${t}</span><span class="${cls}">${v}</span>`;
  const d = abrirModal(`${emp.nombre} · ${rangoTxt(r.desde, r.hasta)}`, `<div class="form">
    <div class="dos-col"><div class="col">
      <div class="corte-res">${f('Salario diario', dinero(n.salario_diario))}${f('Tipo de pago', TIPO_PAGO_TXT[emp.tipo_pago])}
        ${f('A tiempo', c.A_TIEMPO)}${f('Retardos', c.RETARDO + (emp.retardos_falta ? ` (= ${emp.retardos_falta} falta)` : ''))}${f('Faltas', c.FALTA)}
        ${f('Permisos', c.PERMISO)}${f('Incapacidad', c.INCAPACIDAD)}${f('Vacaciones', c.VACACIONES)}${f('Descansos', c.DESCANSO)}</div>
    </div><div class="col">
      <div class="corte-res">${f('Salario fijo', dinero(n.base))}${f('− Faltas', dinero(n.desc_faltas), 'txt-error')}${f('− Retardos', dinero(n.desc_retardos), 'txt-error')}
        ${f('− Adelantos', dinero(n.adelantos), 'txt-error')}${f('− Otros descuentos', dinero(n.otros_descuentos), 'txt-error')}
        ${f('+ Bonos', dinero(n.bonos), 'txt-ok')}${f('+ Bono de puntualidad', dinero(n.bono_puntualidad), 'txt-ok')}${f('+ Bonos de metas', dinero(n.bono_ventas || 0), 'txt-ok')}${f('+ Prima vacacional', dinero(n.prima_vacacional), 'txt-ok')}
        <b>Salario final</b><b>${dinero(n.total)}</b></div>
      ${n.preliminar ? '<p class="nota">Preliminar: el periodo no ha terminado.</p>' : ''}
    </div></div>
    ${(emp.bonos_detalle || []).length ? `<h3>Bonos ganados</h3><ul class="lista">${emp.bonos_detalle.map(b => `<li><span><b class="txt-ok">+${dinero(b.monto)}</b> ${esc(b.nombre)}
      <small>${rangoTxt(b.inicio, b.fin)}${b.logro !== null ? ` · logró ${b.medida === 'PIEZAS' ? numero(b.logro) + ' pzas' : dinero(b.logro)} de ${b.medida === 'PIEZAS' ? numero(b.meta) + ' pzas' : dinero(b.meta)}` : ''}</small></span></li>`).join('')}</ul>` : ''}
    <h3>Bonos y descuentos a mano</h3>
    <ul class="lista">${emp.incidencias.length ? emp.incidencias.map(i => `<li><span><b class="${i.tipo === 'BONO' ? 'txt-ok' : 'txt-error'}">${i.tipo === 'BONO' ? '+' : '−'}${dinero(i.monto)}</b> ${esc(i.concepto)} <small>${fechaCorta(i.dia)}</small></span>
      <button type="button" class="btn mini sec" data-quitar="${esc(i.id)}">Quitar</button></li>`).join('') : '<li class="nota">Sin bonos ni descuentos registrados.</li>'}</ul>
    <form id="finc" class="fila-form">
      <select name="tipo"><option value="BONO">Bono</option><option value="DESCUENTO">Descuento</option></select>
      <input name="monto" type="number" min="0" step="0.01" placeholder="Monto" required inputmode="decimal">
      <input name="concepto" placeholder="Concepto (ej. Meta de ventas, faltante de caja)" required>
      <input name="dia" type="date" value="${r.hoy >= r.desde && r.hoy <= r.hasta ? r.hoy : r.hasta}" min="${r.desde}" max="${r.hasta}">
      <button class="btn">Agregar</button></form>
    <p class="msg" id="finc-msg"></p>
    <div class="pie"><button type="button" class="btn sec" id="dp-vac">Registrar vacaciones</button><button type="button" class="btn sec" id="dp-ade">Registrar adelanto</button>
      <button type="button" class="btn" data-cerrar>Listo</button></div></div>`, 'medio');
  $('#finc', d).onsubmit = async ev => {
    ev.preventDefault();
    const fi = ev.target;
    try {
      await conCarga('Guardando…', () => api('guardarIncidencia', { empleado_id: emp.id, tipo: fi.tipo.value, monto: fi.monto.value, concepto: fi.concepto.value.trim(), dia: fi.dia.value }));
      cerrarModal(); toast('Registrado.', 'ok'); PER.repintar(false);
    } catch (e) { $('#finc-msg', d).textContent = e.message; }
  };
  d.addEventListener('click', async e => {
    const q = e.target.closest('[data-quitar]');
    if (!q || !confirm('¿Quitar este registro?')) return;
    try { await conCarga('Quitando…', () => api('eliminarIncidencia', { id: q.dataset.quitar })); cerrarModal(); PER.repintar(false); } catch (er) { toast(er.message, 'error'); }
  });
  $('#dp-vac', d).onclick = () => dlgVacacionesAdmin(emp.id);
  $('#dp-ade', d).onclick = () => dlgAdelantoAdmin(emp.id);
}

/* ---- Nómina por periodo de pago ---- */
async function pePintarNomina(c) {
  if (!PER.nfecha) PER.nfecha = hoyLocal();
  c.innerHTML = `<div class="filtros">
      <select id="no-tipo">${Object.entries(TIPO_PAGO_TXT).map(([k, t]) => `<option value="${k}" ${PER.ntipo === k ? 'selected' : ''}>Pago ${t.toLowerCase()}</option>`).join('')}</select>
      <div class="nav-periodo"><button type="button" class="btn sec mini" id="no-ant">‹</button><b id="no-rango"></b><button type="button" class="btn sec mini" id="no-sig">›</button></div>
      ${filtrosSucursal('no-alm', PER.alm)}
    </div><div id="no-tabla"></div>`;
  const t = $('#no-tabla', c);
  const r = await pedir(t, 'Calculando nómina…', () => api('nomina', { tipo_pago: PER.ntipo, fecha: PER.nfecha, almacen_id: PER.alm }));
  if (!r) return;
  $('#no-rango', c).textContent = rangoTxt(r.desde, r.hasta);
  const filas = r.filas.slice().sort((a, b) => almNombre(a.almacen_id).localeCompare(almNombre(b.almacen_id)) || a.nombre.localeCompare(b.nombre));
  const s = k => filas.reduce((x, f) => x + (Number(f[k]) || 0), 0);
  const prelim = !r.cerrada && r.hasta >= hoyLocal();
  const pagado = f => f.pagado && f.pagado !== '' && f.pagado !== false;
  t.innerHTML = filas.length ? `
    <p>${r.cerrada ? `<span class="est est-RECIBIDA">Nómina cerrada</span> ${filas.filter(pagado).length} de ${filas.length} pagados.` : prelim ? '<span class="est est-ENVIADA">Preliminar</span> El periodo aún no termina.' : '<span class="est est-ATRASADA">Por cerrar</span> El periodo ya terminó.'}</p>
    <div class="tabla-cont"><table class="tabla nomina">
      <thead><tr>${r.cerrada ? '<th class="col-sel"><input type="checkbox" id="no-todos"></th>' : ''}<th>Empleado</th><th>Sucursal</th><th class="num">Días</th><th class="num">Faltas</th><th class="num">Ret.</th>
        <th class="num">Salario fijo</th><th class="num">− Faltas</th><th class="num">− Retardos</th><th class="num">+ Bonos</th><th class="num">+ Puntualidad</th><th class="num">+ Metas</th><th class="num">+ Prima vac.</th>
        <th class="num">− Adelantos</th><th class="num">− Otros</th><th class="num">Salario final</th>${r.cerrada ? '<th>Pago</th>' : ''}</tr></thead>
      <tbody>${filas.map(f => `<tr class="clic" data-f="${esc(f.id || f.empleado_id)}">${r.cerrada ? `<td class="col-sel"><input type="checkbox" data-sel="${esc(f.id)}" ${pagado(f) ? 'disabled' : ''}></td>` : ''}
        <td><b>${esc(f.nombre)}</b><small>#${esc(f.numero)}</small></td><td>${esc(almNombre(f.almacen_id))}</td><td class="num">${f.dias_pagados}</td><td class="num">${f.faltas || ''}</td><td class="num">${f.retardos || ''}</td>
        <td class="num">${dinero(f.base)}</td><td class="num txt-error">${Number(f.desc_faltas) ? dinero(f.desc_faltas) : ''}</td><td class="num txt-error">${Number(f.desc_retardos) ? dinero(f.desc_retardos) : ''}</td>
        <td class="num txt-ok">${Number(f.bonos) ? dinero(f.bonos) : ''}</td><td class="num txt-ok">${Number(f.bono_puntualidad) ? dinero(f.bono_puntualidad) : ''}</td><td class="num txt-ok">${Number(f.bono_ventas) ? dinero(f.bono_ventas) : ''}</td><td class="num txt-ok">${Number(f.prima_vacacional) ? dinero(f.prima_vacacional) : ''}</td>
        <td class="num txt-error">${Number(f.adelantos) ? dinero(f.adelantos) : ''}</td><td class="num txt-error">${Number(f.otros_descuentos) ? dinero(f.otros_descuentos) : ''}</td>
        <td class="num"><b>${dinero(f.total)}</b></td>${r.cerrada ? `<td>${pagado(f) ? `<span class="est est-RECIBIDA">Pagado</span>` : '<span class="est est-ENVIADA">Pendiente</span>'}</td>` : ''}</tr>`).join('')}</tbody>
      <tfoot><tr class="tot">${r.cerrada ? '<td></td>' : ''}<td colspan="5">Total (${filas.length})</td><td class="num">${dinero(s('base'))}</td><td class="num">${dinero(s('desc_faltas'))}</td><td class="num">${dinero(s('desc_retardos'))}</td>
        <td class="num">${dinero(s('bonos'))}</td><td class="num">${dinero(s('bono_puntualidad'))}</td><td class="num">${dinero(s('bono_ventas'))}</td><td class="num">${dinero(s('prima_vacacional'))}</td><td class="num">${dinero(s('adelantos'))}</td>
        <td class="num">${dinero(s('otros_descuentos'))}</td><td class="num">${dinero(s('total'))}</td>${r.cerrada ? '<td></td>' : ''}</tr></tfoot></table></div>
    <div class="acciones">
      ${!r.cerrada && esGeneral() ? '<button type="button" class="btn" id="no-cerrar">Cerrar nómina</button>' : ''}
      ${r.cerrada && esGeneral() ? '<button type="button" class="btn" id="no-pagar">Marcar seleccionados como pagados</button><button type="button" class="btn sec" id="no-reabrir">Reabrir</button>' : ''}
      <button type="button" class="btn sec" id="no-recibos">Imprimir recibos</button><button type="button" class="btn sec" id="no-excel">Exportar a Excel</button></div>
    <p class="nota">Al cerrar, los importes quedan fijos y los adelantos aprobados del periodo se marcan como descontados.</p>`
    : `<p class="vacio">No hay empleados con pago ${TIPO_PAGO_TXT[PER.ntipo].toLowerCase()} en este periodo.</p>`;
  const mover = dir => {
    PER.nfecha = dir < 0 ? sumarDiasL(r.desde, -1) : sumarDiasL(r.hasta, 1);
    pePintarNomina(c);
  };
  $('#no-ant', c).onclick = () => mover(-1);
  $('#no-sig', c).onclick = () => mover(1);
  $('#no-tipo', c).onchange = e => { PER.ntipo = e.target.value; pePintarNomina(c); };
  const fa = $('#no-alm', c);
  if (fa) fa.onchange = () => { PER.alm = fa.value; pePintarNomina(c); };
  if (!filas.length) return;
  const bc = $('#no-cerrar', c);
  if (bc) bc.onclick = async () => {
    const forzar = prelim;
    if (!confirm(forzar ? 'El periodo aún no termina. ¿Cerrar la nómina de todos modos con lo registrado hasta hoy?' : `¿Cerrar la nómina del ${rangoTxt(r.desde, r.hasta)} por ${dinero(s('total'))}?`)) return;
    try { await conCarga('Cerrando nómina…', () => api('cerrarNomina', { tipo_pago: PER.ntipo, fecha: r.desde, forzar })); toast('Nómina cerrada.', 'ok'); PER.base = null; pePintarNomina(c); } catch (e) { toast(e.message, 'error'); }
  };
  const bp = $('#no-pagar', c);
  if (bp) bp.onclick = async () => {
    const ids = $$('[data-sel]:checked', c).map(x => x.dataset.sel);
    if (!ids.length) { toast('Selecciona a quién se le pagó.', ''); return; }
    try { const x = await conCarga('Guardando…', () => api('pagarNomina', { ids })); toast(`${plural(x.pagados, 'pago')} ${x.pagados === 1 ? 'registrado' : 'registrados'}.`, 'ok'); pePintarNomina(c); } catch (e) { toast(e.message, 'error'); }
  };
  const tt = $('#no-todos', c);
  if (tt) tt.onchange = () => $$('[data-sel]:not(:disabled)', c).forEach(x => { x.checked = tt.checked; });
  const br = $('#no-reabrir', c);
  if (br) br.onclick = async () => {
    if (!confirm('¿Reabrir esta nómina? Se recalculará con los datos actuales.')) return;
    try { await conCarga('Reabriendo…', () => api('reabrirNomina', { tipo_pago: PER.ntipo, desde: r.desde })); toast('Nómina reabierta.', 'ok'); pePintarNomina(c); } catch (e) { toast(e.message, 'error'); }
  };
  $('#no-recibos', c).onclick = () => imprimirRecibosNomina(r, filas);
  $('#no-excel', c).onclick = () => {
    const enc = ['Número', 'Empleado', 'Sucursal', 'Días pagados', 'Faltas', 'Retardos', 'Salario fijo', 'Desc. faltas', 'Desc. retardos', 'Bonos', 'Bono puntualidad', 'Bonos de metas',
      'Prima vacacional', 'Adelantos', 'Otros descuentos', 'Salario final', 'Pagado'];
    const n = v => Number(v) || 0;
    Excel.descargar(Excel.crearXlsx([{ nombre: 'Nómina', encabezado: true, anchos: [9, 28, 18, 8, 7, 7, 13, 12, 12, 11, 12, 12, 12, 12, 12, 13, 10],
      filas: [enc].concat(filas.map(f => [f.numero, f.nombre, almNombre(f.almacen_id), n(f.dias_pagados), n(f.faltas), n(f.retardos), n(f.base), n(f.desc_faltas), n(f.desc_retardos),
        n(f.bonos), n(f.bono_puntualidad), n(f.bono_ventas), n(f.prima_vacacional), n(f.adelantos), n(f.otros_descuentos), n(f.total), pagado(f) ? 'Sí' : 'No'])) }]),
      `nomina-${PER.ntipo.toLowerCase()}-${r.desde}.xlsx`);
  };
  $('table.nomina tbody', c).onclick = e => {
    if (e.target.closest('.col-sel')) return;
    const tr = e.target.closest('tr[data-f]');
    if (!tr) return;
    const f = filas.find(x => (x.id || x.empleado_id) === tr.dataset.f);
    imprimirRecibosNomina(r, [f], true);
  };
}

// Recibos de nómina (uno por hoja) para imprimir y firmar
function imprimirRecibosNomina(r, filas, verAntes = false) {
  const emp = (CMP.datos && CMP.datos.empresa) || {};
  const fila = (t, v) => (Number(v) ? `<tr><td>${t}</td><td class="n">${dinero(v)}</td></tr>` : '');
  const html = filas.map((f, i) => `<div style="${i ? 'page-break-before:always;' : ''}">
    <div class="cab"><div style="display:flex;gap:10px;align-items:center"><img src="${esc(logoSrc())}" alt=""><div><h1>${esc(emp.nombre || CFG.NOMBRE)}</h1><div>Recibo de nómina</div></div></div>
      <div style="text-align:right"><div class="folio">${TIPO_PAGO_TXT[r.tipo_pago]}</div><div>${rangoTxt(r.desde, r.hasta)}</div></div></div>
    <div class="cajas"><div class="caja"><h3>Empleado</h3><b>${esc(f.nombre)}</b><br>Número ${esc(f.numero)} · ${esc(almNombre(f.almacen_id))}</div>
      <div class="caja"><h3>Días</h3>Pagados: ${f.dias_pagados} · Faltas: ${f.faltas || 0} · Retardos: ${f.retardos || 0}${f.vacaciones ? ' · Vacaciones: ' + f.vacaciones : ''}<br>Salario diario: ${dinero(f.salario_diario)}</div></div>
    <div class="cajas"><div class="caja"><h3>Percepciones</h3><table>${fila('Salario fijo', f.base)}${fila('Bonos', f.bonos)}${fila('Bono de puntualidad', f.bono_puntualidad)}${fila('Bonos de metas', f.bono_ventas)}${fila('Prima vacacional', f.prima_vacacional)}</table></div>
      <div class="caja"><h3>Deducciones</h3><table>${fila('Faltas', f.desc_faltas)}${fila('Retardos', f.desc_retardos)}${fila('Adelantos de nómina', f.adelantos)}${fila('Otros descuentos', f.otros_descuentos)}</table></div></div>
    <table><tr class="tot"><td>Neto a pagar</td><td class="n">${dinero(f.total)}</td></tr></table>
    <div class="firmas"><div>Recibí de conformidad<br>${esc(f.nombre)}</div><div>Entregó</div></div></div>`).join('');
  if (!verAntes) { imprimirDocumento('Recibos de nómina', html); return; }
  const d = abrirModal(`Recibo de ${filas[0].nombre}`, `<div class="form"><div class="recibo-prev">${html}</div><div class="pie"><button type="button" class="btn sec" data-cerrar>Cerrar</button><button type="button" class="btn" id="rc-imp">Imprimir</button></div></div>`, 'medio');
  $('#rc-imp', d).onclick = () => imprimirDocumento('Recibo de nómina', html);
}

/* ---- Solicitudes de vacaciones y adelantos ---- */
function pePintarSolicitudes(c) {
  const B = PER.base;
  const vac = B.vacaciones.slice().sort((a, b) => (a.estado === 'SOLICITADA') - (b.estado === 'SOLICITADA') || String(a.desde).localeCompare(b.desde)).reverse();
  const ade = B.adelantos.slice().sort((a, b) => (a.estado === 'SOLICITADO') - (b.estado === 'SOLICITADO') || String(a.dia).localeCompare(b.dia)).reverse();
  const emp = id => B.empleados.find(e => e.id === id) || {};
  c.innerHTML = `<div class="acciones"><button type="button" class="btn sec" id="so-vac">Registrar vacaciones</button><button type="button" class="btn sec" id="so-ade">Registrar adelanto</button></div>
    <div class="dos-col">
    <div class="col panel"><h3>Vacaciones</h3>${vac.length ? `<ul class="lista">${vac.map(v => `<li><span><b>${esc(emp(v.empleado_id).nombre || '—')}</b>
        <small>${fechaCorta(v.desde)} al ${fechaCorta(v.hasta)} · ${plural(v.dias, 'día')}${v.estado === 'SOLICITADA' ? ` · le quedan ${(emp(v.empleado_id).vacaciones || {}).disponibles} días` : ''}${v.notas ? ' · ' + esc(v.notas) : ''}</small>
        <small><span class="est est-${v.estado === 'SOLICITADA' ? 'ENVIADA' : v.estado === 'APROBADA' ? 'RECIBIDA' : 'CANCELADA'}">${ESTADO_SOL[v.estado]}</span>${v.origen === 'CHECADOR' ? ' · pedida en el checador' : ''}</small></span>
        <span class="acciones">${v.estado === 'SOLICITADA' ? `<button type="button" class="btn mini" data-v="${esc(v.id)}" data-a="APROBAR">Aprobar</button><button type="button" class="btn mini sec" data-v="${esc(v.id)}" data-a="RECHAZAR">Rechazar</button>`
          : v.estado === 'APROBADA' && v.desde >= hoyLocal() ? `<button type="button" class="btn mini sec" data-v="${esc(v.id)}" data-a="CANCELAR">Cancelar</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="vacio">Sin solicitudes.</p>'}</div>
    <div class="col panel"><h3>Adelantos de nómina</h3>${ade.length ? `<ul class="lista">${ade.map(a => `<li><span><b>${esc(emp(a.empleado_id).nombre || '—')}</b> · ${dinero(a.monto)}
        <small>${fechaCorta(a.dia)}${a.motivo ? ' · ' + esc(a.motivo) : ''}</small>
        <small><span class="est est-${a.estado === 'SOLICITADO' ? 'ENVIADA' : ['APROBADO', 'DESCONTADO'].includes(a.estado) ? 'RECIBIDA' : 'CANCELADA'}">${ESTADO_SOL[a.estado]}</span>${a.origen === 'CHECADOR' ? ' · pedido en el checador' : ''}</small></span>
        <span class="acciones">${a.estado === 'SOLICITADO' ? `<button type="button" class="btn mini" data-ad="${esc(a.id)}" data-a="APROBAR">Aprobar</button><button type="button" class="btn mini sec" data-ad="${esc(a.id)}" data-a="RECHAZAR">Rechazar</button>`
          : a.estado === 'APROBADO' ? `<button type="button" class="btn mini sec" data-ad="${esc(a.id)}" data-a="CANCELAR">Cancelar</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="vacio">Sin solicitudes.</p>'}
      <p class="nota">Tope: ${B.reglas.tope_adelanto}% del sueldo del periodo, ${B.reglas.adelantos_por_periodo || 'sin límite de'} adelanto(s) por periodo, después de ${B.reglas.antiguedad_adelanto} días de trabajo. Se descuenta en la nómina del periodo.</p></div>
    </div>`;
  $('#so-vac', c).onclick = () => dlgVacacionesAdmin();
  $('#so-ade', c).onclick = () => dlgAdelantoAdmin();
  c.onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const vac = !!b.dataset.v;
    if (b.dataset.a !== 'APROBAR' && !confirm(b.dataset.a === 'CANCELAR' ? '¿Cancelar?' : '¿Rechazar la solicitud?')) return;
    try {
      await conCarga('Guardando…', () => api(vac ? 'resolverVacaciones' : 'resolverAdelanto', { id: b.dataset.v || b.dataset.ad, accion: b.dataset.a }));
      toast('Listo.', 'ok');
      await PER.repintar();
      sincronizar();
    } catch (er) { toast(er.message, 'error'); }
  };
}

function selectEmpleado(sel = '') {
  return `<select name="empleado_id" required><option value="">Elige a la persona…</option>${PER.base.empleados.filter(e => e.activo).sort(porNombre)
    .map(e => `<option value="${esc(e.id)}" ${e.id === sel ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select>`;
}

function dlgVacacionesAdmin(empId = '') {
  const d = abrirModal('Registrar vacaciones', `<form id="fva" class="form">
    <label>Empleado${selectEmpleado(empId)}</label><p class="nota" id="fva-saldo"></p>
    <div class="fila2"><label>Desde<input name="desde" type="date" required></label><label>Hasta<input name="hasta" type="date" required></label></div>
    <label>Notas<input name="notas"></label>
    <label class="chk"><input type="checkbox" name="aprobar" checked> Aprobar de una vez</label>
    <p class="msg" id="fva-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`);
  const f = $('#fva', d);
  const saldo = () => {
    const e = PER.base.empleados.find(x => x.id === f.empleado_id.value);
    const v = e && e.vacaciones;
    $('#fva-saldo', d).textContent = !v ? '' : v.anios < 1 ? `Aún no cumple un año (al cumplirlo tendrá ${v.derecho_al_cumplir} días).`
      : `${v.anios} año(s) de antigüedad: ${v.derecho} días por ley · tomados ${v.tomados} · por aprobar ${v.pendientes} · disponibles ${v.disponibles}. Prima vacacional ${PER.base.reglas.prima_vacacional}%.`;
  };
  f.empleado_id.onchange = saldo; saldo();
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await conCarga('Guardando…', async () => {
        const v = await api('solicitarVacaciones', { empleado_id: f.empleado_id.value, desde: f.desde.value, hasta: f.hasta.value, notas: f.notas.value.trim() });
        if (f.aprobar.checked) await api('resolverVacaciones', { id: v.id, accion: 'APROBAR' });
      });
      cerrarModal(); toast('Vacaciones registradas.', 'ok'); PER.repintar();
    } catch (e) { $('#fva-msg', d).textContent = e.message; }
  };
}

function dlgAdelantoAdmin(empId = '') {
  const d = abrirModal('Registrar adelanto de nómina', `<form id="fad" class="form">
    <label>Empleado${selectEmpleado(empId)}</label><p class="nota" id="fad-disp"></p>
    <div class="fila2"><label>Monto<input name="monto" type="number" min="0" step="0.01" required inputmode="decimal"></label><label>Motivo<input name="motivo"></label></div>
    <label class="chk"><input type="checkbox" name="aprobar" checked> Aprobar de una vez</label>
    <p class="msg" id="fad-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`);
  const f = $('#fad', d);
  const disp = () => {
    const e = PER.base.empleados.find(x => x.id === f.empleado_id.value);
    const a = e && e.adelanto;
    $('#fad-disp', d).textContent = !a ? '' : a.motivo || `Puede pedir hasta ${dinero(a.disponible)} (${a.tope}% de ${dinero(a.sueldo_periodo)}; ya pidió ${dinero(a.usado)} en el periodo del ${fechaCorta(a.periodo.inicio)} al ${fechaCorta(a.periodo.fin)}).`;
    if (a) f.monto.max = a.disponible;
  };
  f.empleado_id.onchange = disp; disp();
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await conCarga('Guardando…', async () => {
        const a = await api('solicitarAdelanto', { empleado_id: f.empleado_id.value, monto: f.monto.value, motivo: f.motivo.value.trim() });
        if (f.aprobar.checked) await api('resolverAdelanto', { id: a.id, accion: 'APROBAR' });
      });
      cerrarModal(); toast('Adelanto registrado.', 'ok'); PER.repintar();
    } catch (e) { $('#fad-msg', d).textContent = e.message; }
  };
}

/* ---- Bonos: puntualidad, meta de ventas y promoción de un producto ---- */
const TIPO_BONO = { PUNTUALIDAD: 'Puntualidad', VENTAS: 'Meta de ventas', PRODUCTO: 'Promover un producto' };
const DESTINO_BONO = { PERSONA: 'Una persona', GRUPO: 'Grupo de personas', PRESENTES: 'Todos los presentes', TURNO: 'Turno completo' };
const PERIODO_BONO = { DIARIO: 'Por día', SEMANAL: 'Por semana', QUINCENAL: 'Por quincena' };
const fmtMeta = (v, medida) => (medida === 'PIEZAS' ? numero(v) + ' pzas' : dinero(v));

function resumenBono(b) {
  const B = PER.base;
  const quien = b.destino === 'PERSONA' || b.destino === 'GRUPO' ? b.empleados.map(empNombre).join(', ')
    : b.destino === 'TURNO' ? 'Turno ' + ((B.horarios.find(h => h.id === b.horario_id) || {}).nombre || '—') : 'Todos los presentes';
  const reglas = [b.sin_faltas ? 'sin faltas' : '', b.sin_retardos ? 'sin retardos' : '', b.meses_min ? `${b.meses_min}+ meses de antigüedad` : ''].filter(Boolean);
  const meta = b.tipo === 'PUNTUALIDAD' ? 'Llegar a tiempo todos los días, sin faltas'
    : `Meta ${fmtMeta(b.meta, b.medida)}${b.tipo === 'PRODUCTO' ? ' de ' + ((S.idx.prod[b.producto_id] || {}).nombre || 'producto') : ' de venta'} ${b.medicion === 'PERSONAL' ? 'vendidos por cada persona' : 'de la sucursal'}`;
  return `${meta} · ${PERIODO_BONO[b.periodo].toLowerCase()} · ${dinero(b.monto)} ${b.reparto === 'REPARTIR' ? 'a repartir' : 'a cada quien'}<br>
    ${esc(quien)}${b.area ? ' · área ' + esc(b.area) : ''}${b.almacen_id ? ' · ' + esc(almNombre(b.almacen_id)) : ''}${reglas.length ? ' · solo ' + reglas.join(', ') : ''}
    ${b.desde || b.hasta ? `· vigente ${b.desde ? 'del ' + fechaCorta(b.desde) : ''} ${b.hasta ? 'al ' + fechaCorta(b.hasta) : ''}` : ''}`;
}

async function pePintarBonos(c) {
  if (!PER.bfecha) PER.bfecha = hoyLocal();
  c.innerHTML = `<div class="filtros"><div class="nav-periodo"><button type="button" class="btn sec mini" id="bo-ant">‹</button><b id="bo-rango"></b><button type="button" class="btn sec mini" id="bo-sig">›</button></div>
    <button type="button" class="btn" id="bo-nuevo">Nuevo bono</button></div><div id="bo-res"></div>`;
  $('#bo-nuevo', c).onclick = () => dlgBono(null);
  const res = $('#bo-res', c);
  const r = await pedir(res, 'Calculando bonos…', () => api('bonos', { fecha: PER.bfecha }));
  if (!r) return;
  $('#bo-rango', c).textContent = 'Quincena ' + rangoTxt(r.desde, r.hasta);
  $('#bo-ant', c).onclick = () => { PER.bfecha = sumarDiasL(r.desde, -1); pePintarBonos(c); };
  $('#bo-sig', c).onclick = () => { PER.bfecha = sumarDiasL(r.hasta, 1); pePintarBonos(c); };
  if (!r.bonos.length) {
    res.innerHTML = `<p class="vacio">No hay bonos. Son opcionales: crea uno de puntualidad, de meta de ventas o para promover un producto.</p>`;
    return;
  }
  const porBono = {};
  r.resultados.forEach(x => (porBono[x.bono_id] = porBono[x.bono_id] || []).push(x));
  res.innerHTML = `<div class="bonos">${r.bonos.sort((a, b) => (b.activo - a.activo) || a.nombre.localeCompare(b.nombre)).map(b => {
    const rs = porBono[b.id] || [];
    const total = rs.reduce((s, x) => s + x.total, 0);
    const gan = {};
    rs.forEach(x => x.ganadores.forEach(g => { gan[g.empleado_id] = (gan[g.empleado_id] || 0) + g.monto; }));
    const avance = b.tipo === 'PUNTUALIDAD' ? '' : b.periodo === 'DIARIO'
      ? `<p><b>${rs.filter(x => x.grupos.some(g => g.alcanzada)).length}</b> de ${rs.length} días con meta cumplida</p>`
      : rs.map(x => `<div class="avance-per"><small>${rangoTxt(x.inicio, x.fin)}${x.terminado ? '' : ' · en curso'}</small>${x.grupos.filter(g => g.logro !== null).map(g => {
          const nom = b.medicion === 'PERSONAL' ? empNombre(g.clave) : almNombre(g.clave) || 'Todas';
          return `<div class="avance"><span>${esc(nom)}</span><div class="barra ${g.alcanzada ? 'lleno' : ''}"><i style="width:${Math.min(100, Math.round(g.logro / x.meta * 100))}%"></i></div>
            <small>${fmtMeta(g.logro, x.medida)} de ${fmtMeta(x.meta, x.medida)}${g.alcanzada ? ' ✓' : ''}</small></div>`;
        }).join('') || '<p class="nota">Sin participantes.</p>'}</div>`).join('');
    return `<div class="panel bono ${b.activo ? '' : 'inactivo'}"><div class="titulo"><h3>${esc(b.nombre)}</h3><span class="chip-al al-${b.tipo === 'PUNTUALIDAD' ? 'ok' : b.tipo === 'VENTAS' ? 'aviso' : 'gris'}">${TIPO_BONO[b.tipo]}</span></div>
      <p class="nota">${resumenBono(b)}</p>${b.activo ? '' : '<p class="nota"><b>Inactivo</b></p>'}
      ${avance}
      <p>Ganado en la quincena: <b>${dinero(total)}</b>${Object.keys(gan).length ? ` · ${Object.entries(gan).map(([id, m]) => `${esc(empNombre(id))} ${dinero(m)}`).join(', ')}` : ''}</p>
      <div class="acciones"><button type="button" class="btn mini sec" data-ed="${esc(b.id)}">Editar</button></div></div>`;
  }).join('')}</div>
  <p class="nota">Cada bono se paga en la nómina en la que termina su periodo. Solo lo gana quien trabajó al menos un día del periodo y cumple las reglas. Los importes de la quincena en curso son preliminares.</p>`;
  res.onclick = e => { const x = e.target.closest('[data-ed]'); if (x) dlgBono(r.bonos.find(b => b.id === x.dataset.ed)); };
}

function dlgBono(b) {
  const B = PER.base, nuevo = !b;
  b = b || { tipo: 'VENTAS', monto: '', reparto: 'CADA_UNO', meta: '', medida: 'IMPORTE', medicion: 'SUCURSAL', periodo: 'QUINCENAL', destino: 'PRESENTES',
    empleados: [], almacen_id: esGeneral() ? '' : S.usuario.almacen_id, area: '', sin_faltas: true, sin_retardos: false, meses_min: 0, activo: true };
  const emps = B.empleados.filter(e => e.activo).sort(porNombre);
  const alms = S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre);
  const d = abrirModal(nuevo ? 'Nuevo bono' : b.nombre, `<form id="fbo" class="form" autocomplete="off">
    <div class="dos-col"><div class="col">
      <label>Nombre<input name="nombre" required value="${esc(b.nombre || '')}" placeholder="Ej. Meta de diciembre, Promo ponche"></label>
      <label>Tipo de bono<select name="tipo">${Object.entries(TIPO_BONO).map(([k, t]) => `<option value="${k}" ${b.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div data-si="PRODUCTO"><span class="campo-tit">Producto a promover</span><div id="fbo-prod"></div></div>
      <div class="fila2" data-si="VENTAS PRODUCTO"><label>Meta<input name="meta" type="number" min="0" step="0.01" value="${esc(b.meta || '')}" inputmode="decimal"></label>
        <label data-si="PRODUCTO">Medida<select name="medida"><option value="PIEZAS" ${b.medida === 'PIEZAS' ? 'selected' : ''}>Piezas vendidas</option><option value="IMPORTE" ${b.medida !== 'PIEZAS' ? 'selected' : ''}>$ vendido</option></select></label></div>
      <label data-si="VENTAS PRODUCTO">Cuenta la venta de<select name="medicion"><option value="SUCURSAL">La sucursal completa</option><option value="PERSONAL" ${b.medicion === 'PERSONAL' ? 'selected' : ''}>Cada persona (lo que cobró con su usuario de caja)</option></select></label>
      <div class="fila2"><label>Monto del bono ($)<input name="monto" type="number" min="0" step="0.01" required value="${esc(b.monto || '')}" inputmode="decimal"></label>
        <label>Se da<select name="reparto"><option value="CADA_UNO">A cada persona que cumple</option><option value="REPARTIR" ${b.reparto === 'REPARTIR' ? 'selected' : ''}>Repartido entre quienes cumplen</option></select></label></div>
      <label>Se mide y se paga<select name="periodo">${Object.entries(PERIODO_BONO).map(([k, t]) => `<option value="${k}" ${b.periodo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="fila2"><label>Vigente desde <small>(opcional)</small><input name="desde" type="date" value="${esc(b.desde || '')}"></label><label>Hasta<input name="hasta" type="date" value="${esc(b.hasta || '')}"></label></div>
    </div><div class="col">
      <label>Aplica a<select name="destino">${Object.entries(DESTINO_BONO).map(([k, t]) => `<option value="${k}" ${b.destino === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label data-dest="PERSONA">Persona<select name="persona"><option value="">Elige…</option>${emps.map(e => `<option value="${esc(e.id)}" ${b.empleados[0] === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select></label>
      <div data-dest="GRUPO" class="grupo-emps">${emps.map(e => `<label class="chk"><input type="checkbox" name="g_${esc(e.id)}" ${b.empleados.includes(e.id) ? 'checked' : ''}> ${esc(e.nombre)} <small>${esc(e.area || '')}</small></label>`).join('')}</div>
      <label data-dest="TURNO">Turno (horario)<select name="horario_id">${B.horarios.map(h => `<option value="${esc(h.id)}" ${b.horario_id === h.id ? 'selected' : ''}>${esc(h.nombre)} (${esc(h.hora_entrada)}–${esc(h.hora_salida)})</option>`).join('')}</select></label>
      <div class="fila2"><label>Sucursal<select name="almacen_id" ${esGeneral() ? '' : 'disabled'}><option value="">Todas (cada una con su meta)</option>${alms.map(a => `<option value="${esc(a.id)}" ${b.almacen_id === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
        <label>Área<input name="area" list="fbo-areas" value="${esc(b.area || '')}" placeholder="Todas las áreas"><datalist id="fbo-areas">${(B.areas || []).map(a => `<option value="${esc(a)}">`).join('')}</datalist></label></div>
      <fieldset class="reglas-bono"><legend>Solo participan</legend>
        <label class="chk"><input type="checkbox" name="sin_faltas" ${b.sin_faltas ? 'checked' : ''}> Quienes no faltaron</label>
        <label class="chk"><input type="checkbox" name="sin_retardos" ${b.sin_retardos ? 'checked' : ''}> Quienes no tuvieron retardos</label>
        <label class="chk"><input type="checkbox" name="con_meses" ${b.meses_min ? 'checked' : ''}> Quienes tienen al menos <input name="meses_min" type="number" min="1" max="600" value="${b.meses_min || 3}" class="mini-num"> meses</label>
        <button type="button" class="btn mini sec" id="fbo-todas">Todas las anteriores</button>
        <p class="nota" data-si="PUNTUALIDAD">El de puntualidad ya exige no faltar ni tener retardos, y no aplica a quien no usa checador.</p>
      </fieldset>
      <label>Notas<input name="notas" value="${esc(b.notas || '')}"></label>
      <label class="chk"><input type="checkbox" name="activo" ${b.activo !== false ? 'checked' : ''}> Activo</label>
    </div></div>
    <p class="msg" id="fbo-msg"></p>
    <div class="pie">${nuevo ? '' : '<button type="button" class="btn peligro izq" id="fbo-del">Eliminar</button>'}<button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`, 'medio');
  const f = $('#fbo', d);
  const sel = selectorProducto($('#fbo-prod', d));
  if (b.producto_id && S.idx.prod[b.producto_id]) { sel.elegido = S.idx.prod[b.producto_id]; sel.actualizar(); $('.sel-q', d).hidden = true; $('.elegido', d).hidden = false; }
  const ver = () => {
    $$('[data-si]', d).forEach(x => { x.hidden = !x.dataset.si.split(' ').includes(f.tipo.value); });
    $$('[data-dest]', d).forEach(x => { x.hidden = x.dataset.dest !== f.destino.value; });
  };
  f.tipo.onchange = ver; f.destino.onchange = ver; ver();
  $('#fbo-todas', d).onclick = () => { f.sin_faltas.checked = f.sin_retardos.checked = f.con_meses.checked = true; };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const empleados = f.destino.value === 'PERSONA' ? [f.persona.value].filter(Boolean) : f.destino.value === 'GRUPO' ? emps.filter(e => f['g_' + e.id].checked).map(e => e.id) : [];
    try {
      await conCarga('Guardando…', () => api('guardarBono', { bono: { id: b.id || '', nombre: f.nombre.value, tipo: f.tipo.value, monto: f.monto.value, reparto: f.reparto.value,
        meta: f.meta.value, medida: f.medida.value, medicion: f.medicion.value, producto_id: sel.elegido ? sel.elegido.id : '', periodo: f.periodo.value,
        destino: f.destino.value, empleados, horario_id: f.horario_id.value, almacen_id: f.almacen_id.value, area: f.area.value.trim(),
        sin_faltas: f.sin_faltas.checked, sin_retardos: f.sin_retardos.checked, meses_min: f.con_meses.checked ? f.meses_min.value : 0,
        desde: f.desde.value, hasta: f.hasta.value, notas: f.notas.value, activo: f.activo.checked } }));
      cerrarModal(); toast('Bono guardado.', 'ok'); PER.repintar();
    } catch (e) { $('#fbo-msg', d).textContent = e.message; }
  };
  const del = $('#fbo-del', d);
  if (del) del.onclick = async () => {
    if (!confirm(`¿Eliminar el bono ${b.nombre}? Las nóminas ya cerradas no cambian.`)) return;
    try { await conCarga('Eliminando…', () => api('eliminarBono', { id: b.id })); cerrarModal(); PER.repintar(); } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---- Empleados ---- */
function pePintarEmpleados(c) {
  const B = PER.base;
  const hor = id => (B.horarios.find(h => h.id === id) || {}).nombre || '—';
  const l = B.empleados.slice().sort((a, b) => (b.activo - a.activo) || Number(a.numero) - Number(b.numero));
  c.innerHTML = `<div class="acciones"><button type="button" class="btn" id="em-nuevo">Nuevo empleado</button></div>
    ${l.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Núm.</th><th>Nombre</th><th>Sucursal</th><th>Ingreso</th><th>Pago</th><th class="num">Salario diario</th><th>Horario</th><th class="num">Vacaciones</th><th>NIP</th></tr></thead>
      <tbody>${l.map(e => `<tr class="clic ${e.activo ? '' : 'inactivo'}" data-id="${esc(e.id)}"><td>${esc(e.numero)}</td><td><b>${esc(e.nombre)}</b><small>${esc(e.puesto || '')}</small></td>
        <td>${esc(almNombre(e.almacen_id))}${e.area ? `<small>${esc(e.area)}</small>` : ''}</td><td>${fechaCorta(e.fecha_ingreso)}<small>${e.vacaciones.anios} año(s)</small></td><td>${TIPO_PAGO_TXT[e.tipo_pago]}</td>
        <td class="num">${dinero(e.salario_diario)}</td><td>${esc(hor(e.horario_id))}</td><td class="num">${e.vacaciones.anios >= 1 ? e.vacaciones.disponibles + ' días' : '—'}</td>
        <td>${!e.usa_checador ? '<small>No checa (salario fijo)</small>' : e.tiene_pin ? '✓' : '<span class="txt-error">Falta</span>'}</td></tr>`).join('')}</tbody></table></div>
      <p class="nota">Cada empleado checa con su número y su NIP en la pantalla Checador de cualquier equipo de la sucursal.</p>` : '<p class="vacio">Aún no hay empleados.</p>'}`;
  $('#em-nuevo', c).onclick = () => dlgEmpleado(null);
  c.onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) dlgEmpleado(B.empleados.find(x => x.id === tr.dataset.id)); };
}

function dlgEmpleado(e) {
  const B = PER.base;
  const nuevo = !e;
  e = e || { tipo_pago: 'QUINCENAL', activo: true, fecha_ingreso: hoyLocal(), almacen_id: S.usuario.almacen_id || '' };
  const alms = S.catalogo.almacenes.filter(a => esActivo(a.activo)).sort(porNombre);
  const d = abrirModal(nuevo ? 'Nuevo empleado' : e.nombre, `<form id="femp" class="form" autocomplete="off">
    <div class="dos-col"><div class="col">
      <div class="fila2"><label>Número<input name="numero" value="${esc(e.numero || '')}" inputmode="numeric" placeholder="Automático"></label>
        <label>Puesto<input name="puesto" value="${esc(e.puesto || '')}"></label></div>
      <label>Nombre completo<input name="nombre" required value="${esc(e.nombre || '')}"></label>
      <label>Sucursal<select name="almacen_id" ${esGeneral() ? '' : 'disabled'}>${alms.map(a => `<option value="${esc(a.id)}" ${a.id === e.almacen_id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></label>
      <div class="fila2"><label>Teléfono<input name="telefono" type="tel" value="${esc(e.telefono || '')}"></label><label>Correo<input name="email" type="email" value="${esc(e.email || '')}"></label></div>
      <label>Fecha de ingreso<input name="fecha_ingreso" type="date" value="${esc(e.fecha_ingreso || '')}" required></label>
    </div><div class="col">
      <div class="fila2"><label>Se le paga<select name="tipo_pago">${Object.entries(TIPO_PAGO_TXT).map(([k, t]) => `<option value="${k}" ${e.tipo_pago === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Salario diario<input name="salario_diario" type="number" min="0" step="0.01" value="${esc(e.salario_diario || '')}" required inputmode="decimal"></label></div>
      <p class="nota" id="femp-eq"></p>
      <label class="chk"><input type="checkbox" name="usa_checador" ${e.usa_checador !== false ? 'checked' : ''}> Usa el checador <small>(si no, se le paga su salario fijo sin registrar entradas)</small></label>
      <label>Horario<select name="horario_id"><option value="">Sin horario (de lunes a sábado)</option>${B.horarios.filter(h => esActivo(h.activo) || h.id === e.horario_id).map(h => `<option value="${esc(h.id)}" ${h.id === e.horario_id ? 'selected' : ''}>${esc(h.nombre)} (${esc(h.hora_entrada)}–${esc(h.hora_salida)})</option>`).join('')}</select></label>
      <div class="fila2"><label>NIP <small>(4 a 6 números)</small><input name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="${e.tiene_pin ? 'Dejar vacío para no cambiar' : 'Para checar y hacer solicitudes'}"></label>
        <label>Área<input name="area" list="femp-areas" value="${esc(e.area || '')}" placeholder="Ej. Caja, Almacén, Piso"><datalist id="femp-areas">${(B.areas || []).map(a => `<option value="${esc(a)}">`).join('')}</datalist></label></div>
      <label>Usuario de caja <small>(para bonos por sus ventas)</small><select name="usuario_id"><option value="">Ninguno</option>${(B.usuarios || []).map(x => `<option value="${esc(x.id)}" ${x.id === e.usuario_id ? 'selected' : ''}>${esc(x.nombre)} (${esc(x.usuario)})</option>`).join('')}</select></label>
      <label>Notas<input name="notas" value="${esc(e.notas || '')}"></label>
      <label class="chk"><input type="checkbox" name="activo" ${e.activo !== false ? 'checked' : ''}> Activo</label>
    </div></div>
    <p class="msg" id="femp-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`, 'medio');
  const f = $('#femp', d);
  const eq = () => { const s = Number(f.salario_diario.value) || 0; $('#femp-eq', d).textContent = s ? `Equivale a ${dinero(s * 7)} por semana, ${dinero(s * 15)} por quincena o ${dinero(s * 30.4)} al mes.` : ''; };
  f.salario_diario.oninput = eq; eq();
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await conCarga('Guardando…', () => api('guardarEmpleado', { empleado: { id: e.id || '', numero: f.numero.value.trim(), nombre: f.nombre.value, puesto: f.puesto.value,
        almacen_id: f.almacen_id.value, telefono: f.telefono.value, email: f.email.value, fecha_ingreso: f.fecha_ingreso.value, tipo_pago: f.tipo_pago.value,
        salario_diario: f.salario_diario.value, horario_id: f.horario_id.value, pin: f.pin.value.trim(), area: f.area.value.trim(), usuario_id: f.usuario_id.value, usa_checador: f.usa_checador.checked,
        notas: f.notas.value, activo: f.activo.checked } }));
      cerrarModal(); toast('Empleado guardado.', 'ok'); PER.repintar();
    } catch (er) { $('#femp-msg', d).textContent = er.message; }
  };
}

/* ---- Horarios y reglas ---- */
function pePintarReglas(c) {
  const B = PER.base, R = B.reglas, ag = esGeneral();
  const dias = h => String(h.dias_semana).split(',').map(n => LETRA_DIA[n]).join(' ');
  const ley = [[1, 12], [2, 14], [3, 16], [4, 18], [5, 20], ['6 a 10', 22], ['11 a 15', 24], ['16 a 20', 26], ['21 a 25', 28]];
  c.innerHTML = `<div class="dos-col"><div class="col panel"><div class="titulo"><h3>Horarios</h3><button type="button" class="btn sec mini" id="ho-nuevo">Nuevo horario</button></div>
      ${B.horarios.length ? `<ul class="lista">${B.horarios.map(h => `<li class="clic" data-h="${esc(h.id)}"><span><b>${esc(h.nombre)}</b> ${esActivo(h.activo) ? '' : '<small>(inactivo)</small>'}
        <small>${esc(h.hora_entrada)} a ${esc(h.hora_salida)} · ${dias(h)} · tolerancia ${h.tolerancia} min · después de ${h.limite_retardo || '—'} min cuenta como falta</small></span></li>`).join('')}</ul>`
        : '<p class="vacio">Registra al menos un horario antes de dar de alta empleados.</p>'}
      <h3>Vacaciones por ley</h3><table class="tabla"><thead><tr><th>Años cumplidos</th><th class="num">Días</th></tr></thead><tbody>${ley.map(([a, dd]) => `<tr><td>${a}</td><td class="num">${dd}</td></tr>`).join('')}</tbody></table>
    </div>
    <form id="freg" class="col panel form"><h3>Reglas de pago</h3>
      <div class="fila2"><label>Tope de adelanto (% del sueldo del periodo)<select name="tope_adelanto">${[20, 25, 30, 40, 50, 60, 70, 100].concat([R.tope_adelanto]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
        .map(v => `<option value="${v}" ${v === R.tope_adelanto ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>
        <label>Adelantos por periodo<input name="adelantos_por_periodo" type="number" min="0" max="10" value="${R.adelantos_por_periodo}"></label></div>
      <div class="fila2"><label>Días trabajados para pedir adelanto<input name="antiguedad_adelanto" type="number" min="0" value="${R.antiguedad_adelanto}"></label>
        <label>Prima vacacional (%)<input name="prima_vacacional" type="number" min="0" max="100" value="${R.prima_vacacional}"></label></div>
      <div class="fila2"><label>Descuento por cada retardo ($)<input name="descuento_retardo" type="number" min="0" step="0.01" value="${R.descuento_retardo}"></label>
        <label>Retardos que equivalen a una falta<input name="retardos_por_falta" type="number" min="0" max="31" value="${R.retardos_por_falta}"><small>0 = no aplica</small></label></div>
      <div class="fila2"><label>La semana de pago empieza en<select name="inicio_semana">${NOMBRE_DIA.map((t, i) => `<option value="${i}" ${i === R.inicio_semana ? 'selected' : ''}>${t}</option>`).join('')}</select></label><span></span></div>
      <p class="nota">Los bonos de puntualidad, de ventas y de producto son opcionales: se configuran en la pestaña <b>Bonos</b>.</p>
      <label>Zona horaria del negocio<select name="zona">${B.zonas.map(z => `<option value="${z}" ${z === R.zona ? 'selected' : ''}>${z.replace('America/', '').replace('_', ' ')}${z === 'America/Mazatlan' ? ' (Sinaloa, Nayarit, Sur de Baja California)' : z === 'America/Mexico_City' ? ' (Centro)' : ''}</option>`).join('')}</select>
        <small>Define la hora oficial para checadas, cortes y reportes.</small></label>
      <p class="nota">Pago diario: solo se pagan los días trabajados (más vacaciones y permisos). Pago semanal y quincenal: salario fijo de todos los días del periodo, incluido el descanso semanal; las faltas se descuentan. La incapacidad no se paga aquí. Quien no usa checador cobra su salario fijo completo.</p>
      <p class="msg" id="freg-msg"></p>
      ${ag ? '<div class="pie"><button class="btn" type="submit">Guardar reglas</button></div>' : '<p class="nota">Solo el administrador general cambia las reglas.</p>'}
    </form></div>`;
  $('#ho-nuevo', c).onclick = () => dlgHorario(null);
  c.querySelector('.lista') && (c.querySelector('.lista').onclick = e => { const li = e.target.closest('[data-h]'); if (li) dlgHorario(B.horarios.find(h => h.id === li.dataset.h)); });
  const f = $('#freg', c);
  if (!ag) $$('input,select', f).forEach(x => { x.disabled = true; });
  f.onsubmit = async ev => {
    ev.preventDefault();
    const reglas = {};
    ['tope_adelanto', 'adelantos_por_periodo', 'antiguedad_adelanto', 'prima_vacacional', 'descuento_retardo', 'retardos_por_falta', 'inicio_semana'].forEach(k => { reglas[k] = Number(f[k].value) || 0; });
    reglas.zona = f.zona.value;
    try { await conCarga('Guardando reglas…', () => api('guardarReglasNomina', { reglas })); toast('Reglas guardadas.', 'ok'); PER.repintar(); } catch (e) { $('#freg-msg', c).textContent = e.message; }
  };
}

function dlgHorario(h) {
  const nuevo = !h;
  h = h || { hora_entrada: '09:00', hora_salida: '18:00', dias_semana: '1,2,3,4,5,6', tolerancia: 10, limite_retardo: 30, activo: true };
  const dias = String(h.dias_semana).split(',');
  const d = abrirModal(nuevo ? 'Nuevo horario' : h.nombre, `<form id="fho" class="form">
    <label>Nombre<input name="nombre" required value="${esc(h.nombre || '')}" placeholder="Ej. Matutino, Lunes a sábado"></label>
    <div class="fila2"><label>Entrada<input name="hora_entrada" type="time" required value="${esc(h.hora_entrada)}"></label><label>Salida<input name="hora_salida" type="time" required value="${esc(h.hora_salida)}"></label></div>
    <div class="campo"><span>Días de trabajo</span><div class="dias-sem">${[1, 2, 3, 4, 5, 6, 0].map(i => `<label class="chk"><input type="checkbox" name="d${i}" ${dias.includes(String(i)) ? 'checked' : ''}> ${NOMBRE_DIA[i].slice(0, 3)}</label>`).join('')}</div></div>
    <div class="fila2"><label>Tolerancia (minutos)<input name="tolerancia" type="number" min="0" max="120" value="${h.tolerancia}"><small>Hasta aquí cuenta a tiempo.</small></label>
      <label>Falta después de (minutos)<input name="limite_retardo" type="number" min="0" max="600" value="${h.limite_retardo}"><small>Entre la tolerancia y este límite es retardo. 0 = nunca es falta.</small></label></div>
    <label class="chk"><input type="checkbox" name="activo" ${esActivo(h.activo) ? 'checked' : ''}> Activo</label>
    <p class="msg" id="fho-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`);
  const f = $('#fho', d);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const ds = [0, 1, 2, 3, 4, 5, 6].filter(i => f['d' + i].checked).join(',');
    try {
      await conCarga('Guardando…', () => api('guardarHorario', { horario: { id: h.id || '', nombre: f.nombre.value, hora_entrada: f.hora_entrada.value, hora_salida: f.hora_salida.value,
        dias_semana: ds, tolerancia: f.tolerancia.value, limite_retardo: f.limite_retardo.value, activo: f.activo.checked } }));
      cerrarModal(); toast('Horario guardado.', 'ok'); PER.repintar();
    } catch (e) { $('#fho-msg', d).textContent = e.message; }
  };
}

/* ---------------- Checador (entradas y salidas con número y NIP) ---------------- */
const CHK = { numero: '', pin: '', datos: null, reloj: null, inactivo: null };

async function enviarChecadas() {
  const cola = (await DB.get('checadas')) || [];
  if (!cola.length) return;
  const quedan = [];
  for (const c of cola) {
    try {
      const r = await api('checador', { numero: c.numero, pin: c.pin, accion: 'checar', momento: c.momento, id: c.id });
      if (!r.duplicado) toast(`Checada sin conexión enviada: ${r.nombre}, ${r.tipo === 'ENTRADA' ? 'entrada' : 'salida'} ${r.hora}.`, 'ok');
    } catch (e) {
      if (e.red) { quedan.push(c); continue; }
      toast(`No se registró una checada sin conexión (número ${c.numero}): ${e.message}`, 'error');
    }
  }
  await DB.set('checadas', quedan);
}

function vChecador(el) {
  clearInterval(CHK.reloj);
  el.innerHTML = `<div class="checador">
    <div class="chk-reloj"><b id="chk-hora"></b><span id="chk-fecha"></span></div>
    <form id="chk-form" class="panel chk-panel" autocomplete="off">
      <h2>Checador</h2>
      <p class="nota">Escribe tu número de empleado y tu NIP.</p>
      <div class="fila2"><label>Número<input name="numero" inputmode="numeric" maxlength="6" required></label>
        <label>NIP<input name="pin" type="password" inputmode="numeric" maxlength="6" required></label></div>
      <div class="teclado">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join('')}<button type="button" data-k="borrar" aria-label="Borrar">⌫</button><button type="button" data-k="0">0</button><button type="submit" class="ok">OK</button></div>
      <p class="msg" id="chk-msg"></p>
      <p class="nota" id="chk-cola"></p>
    </form>
    <div id="chk-persona" hidden></div>
  </div>`;
  const f = $('#chk-form', el), msg = $('#chk-msg', el), per = $('#chk-persona', el);
  let campo = f.numero;
  f.numero.onfocus = () => { campo = f.numero; };
  f.pin.onfocus = () => { campo = f.pin; };
  f.numero.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); f.pin.focus(); } };
  const reloj = () => {
    if (!el.isConnected || !$('#chk-hora', el)) { clearInterval(CHK.reloj); return; }
    const d = new Date();
    $('#chk-hora', el).textContent = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#chk-fecha', el).textContent = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  reloj();
  CHK.reloj = setInterval(reloj, 1000);
  const cola = async () => { const n = ((await DB.get('checadas')) || []).length; const p = $('#chk-cola', el); if (p) p.textContent = n ? `${plural(n, 'checada')} sin conexión esperando enviarse.` : ''; };
  cola();
  $('.teclado', el).onclick = e => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    if (b.dataset.k === 'borrar') campo.value = campo.value.slice(0, -1);
    else if (campo.value.length < 6) campo.value += b.dataset.k;
    if (campo === f.numero && f.numero.value.length >= 1) { /* sigue en número hasta que toque NIP */ }
  };
  const reiniciar = () => {
    clearTimeout(CHK.inactivo);
    CHK.numero = CHK.pin = ''; CHK.datos = null;
    per.hidden = true; per.innerHTML = '';
    f.hidden = false; f.reset(); msg.textContent = '';
    f.numero.focus(); campo = f.numero;
    cola();
  };
  const vigilar = () => { clearTimeout(CHK.inactivo); CHK.inactivo = setTimeout(() => { if (el.isConnected) reiniciar(); }, 45000); };
  const resultado = (html, cls, despues = 4500) => {
    per.innerHTML = `<div class="panel chk-res ${cls}">${html}</div>`;
    per.hidden = false; f.hidden = true;
    clearTimeout(CHK.inactivo);
    CHK.inactivo = setTimeout(() => { if (el.isConnected) reiniciar(); }, despues);
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const numero = f.numero.value.trim(), pin = f.pin.value.trim();
    if (!numero || !pin) { msg.textContent = 'Escribe tu número y tu NIP.'; (numero ? f.pin : f.numero).focus(); return; }
    CHK.numero = numero; CHK.pin = pin;
    if (!navigator.onLine) {
      per.innerHTML = `<div class="panel chk-persona"><h2>Sin conexión</h2><p>Tu checada se guardará en este equipo y se enviará al volver el internet. El NIP se revisa al enviarla.</p>
        <button type="button" class="btn chk-grande" id="chk-off">Registrar entrada o salida</button><button type="button" class="btn sec" id="chk-salir">Cancelar</button></div>`;
      per.hidden = false; f.hidden = true; vigilar();
      $('#chk-salir', per).onclick = reiniciar;
      $('#chk-off', per).onclick = async () => {
        const c = (await DB.get('checadas')) || [];
        c.push({ id: uuid(), numero, pin, momento: new Date().toISOString() });
        await DB.set('checadas', c);
        resultado(`<h2>Checada guardada</h2><p class="chk-hora-g">${horaDe(new Date().toISOString())}</p><p>Se enviará al volver el internet.</p>`, 'bien');
      };
      return;
    }
    try {
      CHK.datos = await conCarga('Verificando…', () => api('checador', { numero, pin, accion: 'identificar' }));
      pintarPersona();
    } catch (e) { msg.textContent = e.message; f.pin.value = ''; f.pin.focus(); }
  };
  const pintarPersona = () => {
    const D = CHK.datos, h = D.empleado.horario;
    const sig = D.siguiente;
    const q = D.quincena;
    per.innerHTML = `<div class="panel chk-persona">
      <h2>Hola, ${esc(D.empleado.nombre.split(' ')[0])}</h2>
      <p>${esc(D.empleado.puesto || '')}${h ? ` · Horario ${esc(h.hora_entrada)} a ${esc(h.hora_salida)}` : ''}</p>
      <p>Hoy: entrada <b>${horaDe(D.hoy.entrada) || '—'}</b> · salida <b>${horaDe(D.hoy.salida) || '—'}</b></p>
      ${sig === 'NO_CHECA' ? '<p class="aviso-caja">Tienes salario fijo: no necesitas checar.</p>' : sig === 'COMPLETO' ? '<p class="aviso-caja">Ya registraste tu entrada y tu salida de hoy.</p>' : `<button type="button" class="btn chk-grande ${sig === 'SALIDA' ? 'salida' : ''}" id="chk-marcar">Registrar ${sig === 'ENTRADA' ? 'entrada' : 'salida'}</button>`}
      <div class="chk-quin"><b>Tu quincena (${rangoTxt(q.desde, q.hasta)})</b><div>${Object.entries(q.dias).map(([d, x]) => `<span class="asis-c e-${x.estado || 'NADA'}" title="${fechaCorta(d)} ${x.estado ? ESTADO_DIA[x.estado][0] : ''}">${Number(d.slice(8))}</span>`).join('')}</div>
        <small>${q.conteo.A_TIEMPO} a tiempo · ${q.conteo.RETARDO} retardos · ${q.conteo.FALTA} faltas</small></div>
      ${D.bonos && (D.bonos.avance.length || D.bonos.ganados.length) ? `<div class="chk-bonos"><b>Tus bonos</b>
        ${D.bonos.ganados.length ? `<p class="txt-ok">Ganados esta quincena: <b>${dinero(D.bonos.ganados.reduce((s2, b) => s2 + b.monto, 0))}</b></p>` : ''}
        ${D.bonos.avance.filter(b => b.tipo !== 'PUNTUALIDAD' && b.logro !== undefined).slice(0, 4).map(b => `<div class="avance"><span>${esc(b.nombre)} <small>(al ${fechaCorta(b.fin)})</small></span>
          <div class="barra"><i style="width:${Math.min(100, Math.round(b.logro / b.meta * 100))}%"></i></div>
          <small>${b.medida === 'PIEZAS' ? numero(b.logro) + ' de ' + numero(b.meta) + ' pzas' : dinero(b.logro) + ' de ' + dinero(b.meta)} · bono ${dinero(b.monto)}</small></div>`).join('')}</div>` : ''}
      <div class="acciones"><button type="button" class="btn sec" id="chk-vac">Pedir vacaciones${D.vacaciones.anios >= 1 ? ` (${D.vacaciones.disponibles - D.vacaciones.pendientes} días)` : ''}</button>
        <button type="button" class="btn sec" id="chk-ade">Pedir adelanto${D.adelanto.disponible ? ` (hasta ${dinero(D.adelanto.disponible)})` : ''}</button>
        <button type="button" class="btn sec" id="chk-salir">Salir</button></div>
      <div id="chk-extra"></div>
      ${D.solicitudes.length ? `<details><summary>Mis solicitudes</summary><ul class="lista">${D.solicitudes.map(s => `<li>${s.desde ? `Vacaciones ${fechaCorta(s.desde)} al ${fechaCorta(s.hasta)}` : `Adelanto ${dinero(s.monto)}`} · ${ESTADO_SOL[s.estado] || s.estado}</li>`).join('')}</ul></details>` : ''}
    </div>`;
    per.hidden = false; f.hidden = true; vigilar();
    per.onclick = vigilar;
    $('#chk-salir', per).onclick = reiniciar;
    const bm = $('#chk-marcar', per);
    if (bm) bm.onclick = async () => {
      try {
        const r = await conCarga('Registrando…', () => api('checador', { numero: CHK.numero, pin: CHK.pin, accion: 'checar', id: uuid() }));
        const tarde = r.tipo === 'ENTRADA' && r.estado !== 'A_TIEMPO';
        resultado(`<h2>${r.tipo === 'ENTRADA' ? 'Entrada' : 'Salida'} registrada</h2><p class="chk-hora-g">${r.hora}</p>
          <p>${r.tipo === 'SALIDA' ? `¡Gracias por tu trabajo, ${esc(r.nombre.split(' ')[0])}! Que descanses.` : r.estado === 'A_TIEMPO' ? `¡Buen día, ${esc(r.nombre.split(' ')[0])}! Llegaste a tiempo.`
            : r.estado === 'RETARDO' ? `Retardo de ${r.minutos_tarde} minutos.` : `Llegaste ${r.minutos_tarde} minutos tarde: cuenta como falta. Habla con tu encargado.`}</p>`, tarde ? 'mal' : 'bien');
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#chk-vac', per).onclick = () => {
      $('#chk-extra', per).innerHTML = `<form class="form" id="chk-fv"><div class="fila2"><label>Desde<input name="desde" type="date" required min="${hoyLocal()}"></label><label>Hasta<input name="hasta" type="date" required min="${hoyLocal()}"></label></div>
        <label>Comentario<input name="notas"></label><button class="btn">Enviar solicitud</button></form>`;
      $('#chk-fv', per).onsubmit = async ev => {
        ev.preventDefault();
        const fv = ev.target;
        try {
          const r = await conCarga('Enviando…', () => api('checador', { numero: CHK.numero, pin: CHK.pin, accion: 'vacaciones', desde: fv.desde.value, hasta: fv.hasta.value, notas: fv.notas.value.trim() }));
          resultado(`<h2>Solicitud enviada</h2><p>Vacaciones del ${fechaCorta(r.vacaciones.desde)} al ${fechaCorta(r.vacaciones.hasta)} (${plural(r.vacaciones.dias, 'día')}). Tu encargado la revisará.</p>`, 'bien', 6000);
        } catch (e) { toast(e.message, 'error'); }
      };
    };
    $('#chk-ade', per).onclick = () => {
      const a = CHK.datos.adelanto;
      $('#chk-extra', per).innerHTML = a.motivo ? `<p class="aviso-caja">${esc(a.motivo)}</p>` : `<form class="form" id="chk-fa">
        <p class="nota">Puedes pedir hasta ${dinero(a.disponible)} (${a.tope}% de tu sueldo del periodo). Se descuenta en tu próximo pago.</p>
        <div class="fila2"><label>Monto<input name="monto" type="number" min="1" max="${a.disponible}" step="0.01" required inputmode="decimal"></label><label>Motivo<input name="motivo"></label></div>
        <button class="btn">Enviar solicitud</button></form>`;
      const fa = $('#chk-fa', per);
      if (fa) fa.onsubmit = async ev => {
        ev.preventDefault();
        try {
          const r = await conCarga('Enviando…', () => api('checador', { numero: CHK.numero, pin: CHK.pin, accion: 'adelanto', monto: fa.monto.value, motivo: fa.motivo.value.trim() }));
          resultado(`<h2>Solicitud enviada</h2><p>Adelanto de ${dinero(r.adelanto.monto)}. Tu encargado la revisará.</p>`, 'bien', 6000);
        } catch (e) { toast(e.message, 'error'); }
      };
    };
  };
  S.refrescar = null;
  f.numero.focus();
}

/* ---------------- Análisis de ventas, rotación y temporadas ---------------- */
const ANA = { tab: 'top', per: '30', desde: '', hasta: '', alm: '', metrica: 'cantidad', agrupar: false, datos: null, clave: '', filtro: '', sel: new Set(), temp: null };
const PERIODOS_ANA = {
  '7': ['Últimos 7 días', () => [hoyLocal(-6), hoyLocal()]],
  '30': ['Últimos 30 días', () => [hoyLocal(-29), hoyLocal()]],
  mes: ['Este mes', () => [hoyLocal().slice(0, 8) + '01', hoyLocal()]],
  mespas: ['Mes pasado', () => { const h = new Date(); const f = x => x.toISOString().slice(0, 10); return [f(new Date(h.getFullYear(), h.getMonth() - 1, 1, 12)), f(new Date(h.getFullYear(), h.getMonth(), 0, 12))]; }],
  '90': ['Últimos 3 meses', () => [hoyLocal(-89), hoyLocal()]],
  anio: ['Este año', () => [hoyLocal().slice(0, 5) + '01-01', hoyLocal()]],
  '365': ['Últimos 12 meses', () => [hoyLocal(-364), hoyLocal()]],
  libre: ['Elegir fechas…', () => [ANA.desde || hoyLocal(-29), ANA.hasta || hoyLocal()]]
};
const ALERTAS = {
  REABASTECER: ['Tener más', 'Se vende bien y lo que hay alcanza para menos de 15 días (o está bajo el mínimo).', 'ok'],
  PROMOCION_CADUCIDAD: ['Promocionar ya', 'Caduca en menos de 1 mes y lleva más de 2 meses en inventario: descuento, regalo con compra o degustación.', 'rojo'],
  CADUCADO: ['Caducado', 'Ya caducó: retirarlo del anaquel.', 'rojo'],
  SIN_MOVIMIENTO: ['Sin ventas en 2 meses', 'Propuesta para retirar: liquidarlo y no volver a comprarlo.', 'rojo'],
  NO_LLEGA_TEMPORADA: ['No aguanta a su temporada', 'Es de temporada pero caduca antes de la siguiente (o antes de que termine): sacarlo ahora.', 'aviso'],
  CADUCA_PRONTO: ['Caduca pronto', 'Vence en menos de 1 mes.', 'aviso'],
  SOBREINVENTARIO: ['Demasiado inventario', 'Hay para más de 4 meses de venta: promocionar y no reabastecer.', 'aviso'],
  DESCONTINUADO: ['Descontinuado', 'Vender lo que queda; no se vuelve a comprar.', 'gris']
};
const puedeMarcar = () => ['ADMIN_GENERAL', 'INVENTARIOS'].includes(rol());
const catNombre = id => (S.idx.cat[id] || {}).nombre || 'Sin categoría';
const tempNombre = id => ((S.temporadasLista || []).find(t => t.id === id) || {}).nombre || '';

async function cargarAnalisis(forzar = false) {
  const [desde, hasta] = PERIODOS_ANA[ANA.per][1]();
  ANA.desde = desde; ANA.hasta = hasta;
  const clave = [desde, hasta, ANA.alm].join('|');
  if (!ANA.datos || ANA.clave !== clave || forzar) {
    ANA.datos = await api('analisis', { desde, hasta, almacen_id: ANA.alm });
    ANA.clave = clave;
  }
  return ANA.datos;
}

function vAnalisis(el) {
  const tabs = [['top', 'Más vendidos'], ['rotacion', 'Rotación y sugerencias'], ['temporadas', 'Temporadas']];
  el.innerHTML = `<div class="titulo"><h2>Análisis de ventas</h2><div class="acciones"><button type="button" class="btn sec" id="an-act">Actualizar</button></div></div>
    <div class="segmentos" id="an-tabs">${tabs.map(([k, t]) => `<button type="button" data-t="${k}" class="${ANA.tab === k ? 'activo' : ''}">${t}</button>`).join('')}</div>
    <div id="an-cuerpo"></div>`;
  const c = $('#an-cuerpo', el);
  const pintar = (forzar = false) => ({ top: anPintarTop, rotacion: anPintarRotacion, temporadas: anPintarTemporadas })[ANA.tab](c, forzar);
  $('#an-tabs', el).onclick = e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    ANA.tab = b.dataset.t;
    $$('#an-tabs button', el).forEach(x => x.classList.toggle('activo', x === b));
    pintar();
  };
  $('#an-act', el).onclick = () => pintar(true);
  ANA.repintar = pintar;
  S.refrescar = null;
  pintar();
}

function filtrosAnalisis(c, alCambiar, conMetrica = true) {
  const f = document.createElement('div');
  f.className = 'filtros';
  f.innerHTML = `<select id="an-per">${Object.entries(PERIODOS_ANA).map(([k, [t]]) => `<option value="${k}" ${ANA.per === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <span id="an-libre" ${ANA.per === 'libre' ? '' : 'hidden'}><input type="date" id="an-desde" value="${ANA.desde}"> a <input type="date" id="an-hasta" value="${ANA.hasta}"></span>
    ${filtrosSucursal('an-alm', ANA.alm)}
    ${conMetrica ? `<div class="seg" id="an-met"><button type="button" data-m="cantidad" class="${ANA.metrica === 'cantidad' ? 'activo' : ''}">Piezas</button><button type="button" data-m="importe" class="${ANA.metrica === 'importe' ? 'activo' : ''}">Importe</button></div>` : ''}`;
  c.prepend(f);
  $('#an-per', f).onchange = e => { ANA.per = e.target.value; $('#an-libre', f).hidden = ANA.per !== 'libre'; if (ANA.per !== 'libre') alCambiar(); };
  $$('#an-desde, #an-hasta', f).forEach(x => { x.onchange = () => { ANA.desde = $('#an-desde', f).value; ANA.hasta = $('#an-hasta', f).value; if (ANA.desde && ANA.hasta) alCambiar(); }; });
  const a = $('#an-alm', f);
  if (a) a.onchange = () => { ANA.alm = a.value; alCambiar(); };
  const m = $('#an-met', f);
  if (m) m.onclick = e => { const b = e.target.closest('[data-m]'); if (b) { ANA.metrica = b.dataset.m; alCambiar(); } };
}

/* ---- Top 50 y top 10 por categoría ---- */
async function anPintarTop(c, forzar) {
  c.innerHTML = '<div id="an-res"></div>';
  filtrosAnalisis(c, () => anPintarTop(c));
  const res = $('#an-res', c);
  const d = await pedir(res, 'Analizando ventas…', () => cargarAnalisis(forzar));
  if (!d) return;
  const m = ANA.metrica;
  const vendidos = d.productos.filter(p => p.cantidad > 0).sort((a, b) => b[m] - a[m] || b.cantidad - a.cantidad);
  const total = vendidos.reduce((s, p) => s + p.importe, 0), piezas = vendidos.reduce((s, p) => s + p.cantidad, 0);
  const prod = id => S.idx.prod[id] || {};
  const top = vendidos.slice(0, 50);
  const lista = ANA.agrupar ? top.slice().sort((a, b) => catNombre(prod(a.id).categoria_id).localeCompare(catNombre(prod(b.id).categoria_id)) || b[m] - a[m]) : top;
  const rank = new Map(top.map((p, i) => [p.id, i + 1]));
  let catAnt = null;
  const filas = lista.map(p => {
    const pr = prod(p.id), cat = catNombre(pr.categoria_id);
    const grupo = ANA.agrupar && cat !== catAnt ? `<tr class="asis-grupo"><td colspan="8">${esc(cat)}</td></tr>` : '';
    catAnt = cat;
    return `${grupo}<tr class="clic" data-p="${esc(p.id)}"><td class="num rank">${rank.get(p.id)}</td><td>${esc(pr.nombre || '—')}${pr.temporada_id ? ` <small class="txt-aviso">★ ${esc(tempNombre(pr.temporada_id))}</small>` : ''}</td>
      <td>${esc(cat)}</td><td class="num"><b>${numero(p.cantidad)}</b> ${esc(pr.unidad || '')}</td><td class="num">${dinero(p.importe)}</td>
      <td class="num">${total ? (p.importe / total * 100).toFixed(1) + '%' : '—'}</td><td class="num">${numero(p.stock)}</td>
      <td class="num">${p.cobertura === null ? '—' : p.cobertura + ' días'}</td></tr>`;
  }).join('');
  // Top 10 de cada categoría
  const porCat = {};
  vendidos.forEach(p => { const k = prod(p.id).categoria_id || ''; (porCat[k] = porCat[k] || []).push(p); });
  const cats = Object.entries(porCat).map(([k, l]) => ({ k, l, tot: l.reduce((s, p) => s + p[m], 0) })).sort((a, b) => b.tot - a.tot);
  res.innerHTML = vendidos.length ? `
    <div class="tarjetas"><div class="tarjeta"><span>Venta del periodo</span><b>${dinero(total)}</b><small>${fechaCorta(d.desde)} al ${fechaCorta(d.hasta)}</small></div>
      <div class="tarjeta"><span>Piezas vendidas</span><b>${numero(Math.round(piezas))}</b></div><div class="tarjeta"><span>Productos distintos vendidos</span><b>${numero(vendidos.length)}</b></div>
      <div class="tarjeta"><span>Los 10 primeros representan</span><b>${total ? (vendidos.slice(0, 10).reduce((s, p) => s + p.importe, 0) / total * 100).toFixed(0) + '%' : '—'}</b><small>de la venta</small></div></div>
    <div class="titulo"><h3>Top 50 por ${m === 'cantidad' ? 'piezas' : 'importe'}</h3><label class="chk"><input type="checkbox" id="an-agr" ${ANA.agrupar ? 'checked' : ''}> Ordenar por categoría</label></div>
    <div class="tabla-cont"><table class="tabla"><thead><tr><th class="num">#</th><th>Producto</th><th>Categoría</th><th class="num">Piezas</th><th class="num">Importe</th><th class="num">% de la venta</th><th class="num">Existencia</th><th class="num">Alcanza para</th></tr></thead>
      <tbody>${filas}</tbody></table></div>
    <h3>Top 10 de cada categoría</h3>
    <div class="top-cats">${cats.map(({ k, l, tot }) => `<div class="panel top-cat"><div class="titulo"><h4>${esc(catNombre(k))}</h4><small>${m === 'cantidad' ? numero(tot) + ' pzas' : dinero(tot)}</small></div>
      <ol>${l.slice(0, 10).map(p => `<li data-p="${esc(p.id)}" class="clic"><span>${esc(prod(p.id).nombre || '—')}</span><b>${m === 'cantidad' ? numero(p.cantidad) : dinero(p.importe)}</b></li>`).join('')}</ol></div>`).join('')}</div>`
    : '<p class="vacio">No hay ventas en este periodo.</p>';
  const ag = $('#an-agr', res);
  if (ag) ag.onchange = () => { ANA.agrupar = ag.checked; anPintarTop(c); };
  res.onclick = e => { const x = e.target.closest('[data-p]'); if (x) dlgDondeHay(S.idx.prod[x.dataset.p]); };
}

/* ---- Rotación: qué tener más, qué promocionar y qué retirar ---- */
async function anPintarRotacion(c, forzar) {
  c.innerHTML = '<div id="an-res"></div>';
  const res = $('#an-res', c);
  const d = await pedir(res, 'Analizando inventario…', () => cargarAnalisis(forzar));
  if (!d) return;
  const prod = id => S.idx.prod[id] || {};
  const conAlerta = d.productos.filter(p => p.alertas.length);
  const cuenta = k => d.productos.filter(p => p.alertas.includes(k)).length;
  const lista = (ANA.filtro ? d.productos.filter(p => p.alertas.includes(ANA.filtro)) : conAlerta)
    .sort((a, b) => Object.keys(ALERTAS).indexOf(a.alertas[0]) - Object.keys(ALERTAS).indexOf(b.alertas[0]) || (prod(a.id).nombre || '').localeCompare(prod(b.id).nombre || ''));
  const marca = puedeMarcar();
  const abcTxt = { A: 'A · vende mucho', B: 'B · vende regular', C: 'C · vende poco', SIN_VENTA: 'Sin venta' };
  res.innerHTML = `
    <div class="tarjetas">${Object.entries(ALERTAS).map(([k, [t]]) => `<button type="button" class="tarjeta clic ${ANA.filtro === k ? 'sel' : ''} ${ALERTAS[k][2] === 'rojo' && cuenta(k) ? 'alerta-roja' : ALERTAS[k][2] === 'aviso' && cuenta(k) ? 'alerta' : ''}" data-f="${k}"><span>${t}</span><b>${cuenta(k)}</b></button>`).join('')}</div>
    ${ANA.filtro ? `<p>${esc(ALERTAS[ANA.filtro][1])} <button type="button" class="btn mini sec" data-f="">Ver todas</button></p>` : '<p class="nota">Toca una tarjeta para ver solo ese grupo.</p>'}
    ${marca ? '<div class="barra-sel" id="an-bar" hidden></div>' : ''}
    ${lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr>${marca ? '<th class="col-sel"></th>' : ''}<th>Producto</th><th class="num">Existencia</th><th class="num">Vendido 60 días</th><th>Última venta</th>
      <th class="num">En inventario</th><th>Caduca</th><th class="num">Alcanza para</th><th>Clase</th><th>Sugerencia</th></tr></thead>
      <tbody>${lista.map(p => {
        const pr = prod(p.id);
        return `<tr><td class="col-sel" ${marca ? '' : 'hidden'}><input type="checkbox" data-sel="${esc(p.id)}" ${ANA.sel.has(p.id) ? 'checked' : ''}></td>
          <td><button type="button" class="link" data-p="${esc(p.id)}">${esc(pr.nombre || '—')}</button><small>${esc(catNombre(pr.categoria_id))}${p.temporada_id ? ' · ★ ' + esc(tempNombre(p.temporada_id)) : ''}</small></td>
          <td class="num">${numero(p.stock)}</td><td class="num">${numero(p.cantidad_60)}</td><td>${p.ultima_venta ? fechaCorta(p.ultima_venta) : 'Nunca'}</td>
          <td class="num">${p.dias_en_inventario === null ? '—' : p.dias_en_inventario + ' días'}</td>
          <td class="${p.dias_caducidad !== null && p.dias_caducidad <= 30 ? 'txt-error' : ''}">${p.caducidad ? fechaCorta(p.caducidad) + (p.dias_caducidad < 0 ? ' (caducado)' : ` (${p.dias_caducidad} días)`) : '—'}</td>
          <td class="num">${p.cobertura === null ? '—' : p.cobertura + ' días'}</td><td>${abcTxt[p.abc] || '—'}</td>
          <td>${p.alertas.map(a => `<span class="chip-al al-${ALERTAS[a][2]}" title="${esc(ALERTAS[a][1])}">${ALERTAS[a][0]}</span>`).join(' ')}</td></tr>`;
      }).join('')}</tbody></table></div>` : `<p class="vacio">${ANA.filtro ? 'Ningún producto en este grupo.' : '¡Todo en orden! No hay productos con sugerencias.'}</p>`}
    <details class="ayuda"><summary>¿Cómo se calcula?</summary><ul>
      <li><b>Clase A, B y C:</b> por lo que dejó cada producto en los últimos 60 días. Los A suman el 80% de la venta; los B el siguiente 15%; los C el resto.</li>
      <li><b>En inventario:</b> antigüedad de la pieza más vieja que queda, contando que se vende primero lo que entró primero.</li>
      <li><b>Caduca:</b> la caducidad más próxima registrada en las entradas (o la que se puso en la ficha del producto).</li>
      <li><b>Productos de temporada:</b> no se marcan como "sin ventas" fuera de su temporada, pero sí avisan si caducan antes de la siguiente.</li>
      <li><b>Descontinuados:</b> no se sugieren en las órdenes de compra ni en las temporadas.</li></ul></details>`;
  const pintarBarra = () => {
    const bar = $('#an-bar', res);
    if (!bar) return;
    const n = ANA.sel.size;
    bar.hidden = !n;
    bar.innerHTML = n ? `<b>${plural(n, 'producto')}</b><button type="button" class="btn mini" data-acc="desc">Descontinuar</button><button type="button" class="btn mini sec" data-acc="react">Quitar descontinuado</button>
      <select id="an-temp"><option value="">Marcar de temporada…</option>${(S.temporadasLista || []).map(t => `<option value="${esc(t.id)}">${esc(t.nombre)}</option>`).join('')}<option value="-">Quitar de temporada</option></select>
      <button type="button" class="btn mini sec" data-acc="limpiar">Quitar selección</button>` : '';
  };
  pintarBarra();
  res.onclick = async e => {
    const f = e.target.closest('[data-f]');
    if (f) { ANA.filtro = f.dataset.f; anPintarRotacion(c); return; }
    const p = e.target.closest('[data-p]');
    if (p) { dlgProducto(S.idx.prod[p.dataset.p]); return; }
    const s = e.target.closest('[data-sel]');
    if (s) { ANA.sel[s.checked ? 'add' : 'delete'](s.dataset.sel); pintarBarra(); return; }
    const a = e.target.closest('[data-acc]');
    if (!a) return;
    if (a.dataset.acc === 'limpiar') { ANA.sel.clear(); anPintarRotacion(c); return; }
    await marcarSeleccion({ descontinuado: a.dataset.acc === 'desc' }, c);
  };
  res.onchange = async e => {
    if (e.target.id !== 'an-temp' || !e.target.value) return;
    await marcarSeleccion({ temporada_id: e.target.value === '-' ? '' : e.target.value }, c);
  };
}

async function marcarSeleccion(cambio, c) {
  try {
    const r = await conCarga('Guardando…', () => api('marcarProductos', Object.assign({ ids: [...ANA.sel] }, cambio)));
    toast(`${plural(r.actualizados, 'producto')} ${r.actualizados === 1 ? 'actualizado' : 'actualizados'}.`, 'ok');
    ANA.sel.clear();
    await sincronizar();
    await cargarAnalisis(true);
    anPintarRotacion(c);
  } catch (e) { toast(e.message, 'error'); }
}

/* ---- Temporadas ---- */
const TEMPORADAS_COMUNES = [
  ['Día de Reyes', 'FIJA', 1, 6, 1, 1], ['14 de febrero', 'FIJA', 2, 14, 1, 1], ['Semana Santa', 'SEMANA_SANTA', 0, 0, 8, 2],
  ['Día del Niño', 'FIJA', 4, 30, 1, 1], ['Día de las Madres', 'FIJA', 5, 10, 1, 1], ['Regreso a clases', 'FIJA', 8, 10, 25, 2],
  ['Fiestas patrias', 'FIJA', 9, 15, 2, 1], ['Día de Muertos', 'FIJA', 11, 1, 2, 1], ['Navidad', 'FIJA', 12, 1, 25, 2], ['Fin de año', 'FIJA', 12, 26, 6, 1]
];
const TIPO_TEMP = { FIJA: 'La misma fecha cada año', SEMANA_SANTA: 'Semana Santa (se calcula sola)', MANUAL: 'Cambia cada año (fechas a mano)' };

async function anPintarTemporadas(c, forzar) {
  if (ANA.temp) return anPintarTemporada(c, ANA.temp);
  c.innerHTML = '<div id="an-res"></div>';
  const res = $('#an-res', c);
  const l = await pedir(res, 'Cargando temporadas…', () => api('temporadas'));
  if (!l) return;
  S.temporadasLista = l.map(t => ({ id: t.id, nombre: t.nombre, activo: t.activo }));
  const marca = puedeMarcar();
  res.innerHTML = `${marca ? `<div class="acciones"><button type="button" class="btn" id="tp-nueva">Nueva temporada</button><button type="button" class="btn sec" id="tp-comunes">Agregar temporadas comunes</button></div>` : ''}
    ${l.length ? `<div class="temporadas">${l.map(t => `<button type="button" class="panel temporada ${t.en_temporada ? 'en' : t.en_aviso ? 'aviso' : ''} ${t.activo ? '' : 'inactivo'}" data-t="${esc(t.id)}">
      <div class="titulo"><h3>${esc(t.nombre)}</h3>${t.en_temporada ? '<span class="est est-RECIBIDA">En temporada</span>' : t.en_aviso ? '<span class="est est-ATRASADA">¡Prepárate!</span>' : ''}</div>
      ${t.proxima ? `<p><b>${fechaCorta(t.proxima.inicio)}</b>${t.proxima.fin !== t.proxima.inicio ? ' al ' + fechaCorta(t.proxima.fin) : ''}${t.dias_faltan ? ` · faltan <b>${t.dias_faltan}</b> días` : ''}</p>` : '<p class="nota">Sin fecha próxima: captura las fechas de este año.</p>'}
      <small>${TIPO_TEMP[t.tipo_fecha]} · aviso ${t.aviso_meses} ${t.aviso_meses === 1 ? 'mes' : 'meses'} antes${t.anterior ? ` · anterior: ${fechaCorta(t.anterior.inicio)}` : ''}</small>
      <small>${plural(t.productos_marcados, 'producto')} de temporada · ${t.propuestas.filter(p => !p.hecho).length} propuesta(s) pendiente(s)</small></button>`).join('')}</div>`
      : '<p class="vacio">Aún no hay temporadas. Agrega las comunes (Navidad, 14 de febrero, Semana Santa…) o crea las tuyas.</p>'}`;
  res.onclick = e => { const b = e.target.closest('[data-t]'); if (b) { ANA.temp = b.dataset.t; anPintarTemporada(c, ANA.temp); } };
  const bn = $('#tp-nueva', res);
  if (bn) bn.onclick = () => dlgTemporada(null, () => anPintarTemporadas(c));
  const bc = $('#tp-comunes', res);
  if (bc) bc.onclick = () => dlgTemporadasComunes(l, () => anPintarTemporadas(c));
}

function dlgTemporadasComunes(existentes, alTerminar) {
  const ya = new Set(existentes.map(t => normal(t.nombre)));
  const d = abrirModal('Temporadas comunes', `<form id="ftc" class="form"><p class="nota">Elige las que aplican a tu negocio. Después puedes cambiar fechas y avisos.</p>
    ${TEMPORADAS_COMUNES.map(([n, tipo, m, dd, dur, av], i) => `<label class="chk"><input type="checkbox" name="t${i}" ${ya.has(normal(n)) ? 'disabled' : 'checked'}> ${esc(n)}
      <small>${tipo === 'SEMANA_SANTA' ? 'se calcula cada año' : `${dd}/${String(m).padStart(2, '0')}${dur > 1 ? `, ${dur} días` : ''}`} · aviso ${av} mes(es) antes${ya.has(normal(n)) ? ' · ya existe' : ''}</small></label>`).join('')}
    <p class="nota">El Día del Padre y el Buen Fin cambian de fecha cada año: créalos con "Nueva temporada" y la opción de fechas a mano.</p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Agregar</button></div></form>`);
  $('#ftc', d).onsubmit = async ev => {
    ev.preventDefault();
    const elegidas = TEMPORADAS_COMUNES.filter((_, i) => ev.target['t' + i].checked && !ev.target['t' + i].disabled);
    try {
      await conCarga('Agregando temporadas…', async () => {
        for (const [nombre, tipo_fecha, mes_inicio, dia_inicio, duracion, aviso_meses] of elegidas) {
          await api('guardarTemporada', { temporada: { nombre, tipo_fecha, mes_inicio, dia_inicio, duracion, aviso_meses, dias_previos: 15, crecimiento: 10 } });
        }
      });
      cerrarModal(); toast(`${plural(elegidas.length, 'temporada')} ${elegidas.length === 1 ? 'agregada' : 'agregadas'}.`, 'ok');
      sincronizar(); alTerminar();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function dlgTemporada(t, alGuardar) {
  const nuevo = !t;
  t = t || { tipo_fecha: 'FIJA', mes_inicio: 12, dia_inicio: 1, duracion: 1, aviso_meses: 1, dias_previos: 15, crecimiento: 10, activo: true };
  const d = abrirModal(nuevo ? 'Nueva temporada' : t.nombre, `<form id="ftp" class="form">
    <label>Nombre<input name="nombre" required value="${esc(t.nombre || '')}" placeholder="Ej. Navidad, Día de las Madres"></label>
    <label>Fechas<select name="tipo_fecha">${Object.entries(TIPO_TEMP).map(([k, x]) => `<option value="${k}" ${t.tipo_fecha === k ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <div class="fila3" data-tipo="FIJA"><label>Día de inicio<input name="dia_inicio" type="number" min="1" max="31" value="${t.dia_inicio || 1}"></label>
      <label>Mes<select name="mes_inicio">${MESES.map((m, i) => `<option value="${i + 1}" ${Number(t.mes_inicio) === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Dura (días)<input name="duracion" type="number" min="1" max="120" value="${t.duracion || 1}"></label></div>
    <div class="fila2" data-tipo="MANUAL"><label>Inicio<input name="inicio" type="date" value="${esc(t.inicio || '')}"></label><label>Fin<input name="fin" type="date" value="${esc(t.fin || '')}"></label></div>
    <p class="nota" data-tipo="SEMANA_SANTA">Del Domingo de Ramos al Domingo de Pascua; se calcula sola cada año.</p>
    <div class="fila3"><label>Avisar<select name="aviso_meses">${[1, 2, 3].map(n => `<option value="${n}" ${Number(t.aviso_meses) === n ? 'selected' : ''}>${n} ${n === 1 ? 'mes' : 'meses'} antes</option>`).join('')}</select></label>
      <label>Ventas que cuentan antes (días)<input name="dias_previos" type="number" min="0" max="60" value="${t.dias_previos}"><small>La gente compra antes de la fecha.</small></label>
      <label>Crecimiento esperado (%)<input name="crecimiento" type="number" min="-100" max="500" value="${t.crecimiento}"><small>Para calcular cuánto tener.</small></label></div>
    <label>Notas<input name="notas" value="${esc(t.notas || '')}"></label>
    <label class="chk"><input type="checkbox" name="activo" ${t.activo !== false ? 'checked' : ''}> Activa</label>
    <p class="msg" id="ftp-msg"></p>
    <div class="pie">${nuevo ? '' : '<button type="button" class="btn peligro izq" id="ftp-del">Eliminar</button>'}<button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`);
  const f = $('#ftp', d);
  const ver = () => $$('[data-tipo]', d).forEach(x => { x.hidden = x.dataset.tipo !== f.tipo_fecha.value; });
  f.tipo_fecha.onchange = ver; ver();
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      const r = await conCarga('Guardando…', () => api('guardarTemporada', { temporada: Object.assign({}, t, {
        nombre: f.nombre.value, tipo_fecha: f.tipo_fecha.value, dia_inicio: f.dia_inicio.value, mes_inicio: f.mes_inicio.value, duracion: f.duracion.value,
        inicio: f.inicio.value, fin: f.fin.value, aviso_meses: f.aviso_meses.value, dias_previos: f.dias_previos.value, crecimiento: f.crecimiento.value,
        notas: f.notas.value, activo: f.activo.checked, propuestas: t.propuestas }) }));
      cerrarModal(); toast('Temporada guardada.', 'ok'); sincronizar(); alGuardar(r);
    } catch (e) { $('#ftp-msg', d).textContent = e.message; }
  };
  const bd = $('#ftp-del', d);
  if (bd) bd.onclick = async () => {
    if (!confirm(`¿Eliminar la temporada ${t.nombre}? Sus productos dejan de estar marcados como de temporada.`)) return;
    try { await conCarga('Eliminando…', () => api('eliminarTemporada', { id: t.id })); cerrarModal(); ANA.temp = null; sincronizar(); alGuardar(null); } catch (e) { toast(e.message, 'error'); }
  };
}

// Detalle: lo vendido la vez anterior, existencia, cuánto tener, ideas y propuestas
async function anPintarTemporada(c, id) {
  c.innerHTML = '<div id="an-res"></div>';
  const res = $('#an-res', c);
  const r = await pedir(res, 'Analizando la temporada…', () => api('temporada', { id, almacen_id: ANA.alm }));
  if (!r) { ANA.temp = null; return; }
  const T = r.temporada, prod = x => S.idx.prod[x] || {};
  const marca = puedeMarcar();
  const totAnt = r.filas.reduce((s, f) => s + f.importe_anterior, 0);
  const sugeridos = r.filas.filter(f => f.sugerido > 0);
  const rango = o => (o ? `${fechaCorta(o.inicio)}${o.fin !== o.inicio ? ' al ' + fechaCorta(o.fin) : ''}` : '—');
  res.innerHTML = `<div class="acciones"><button type="button" class="btn sec" id="tp-volver">← Todas las temporadas</button>${marca ? '<button type="button" class="btn sec" id="tp-editar">Editar temporada</button>' : ''}</div>
    <div class="titulo"><h3>${esc(T.nombre)}</h3>${T.en_temporada ? '<span class="est est-RECIBIDA">En temporada</span>' : T.en_aviso ? '<span class="est est-ATRASADA">¡Prepárate!</span>' : ''}</div>
    <div class="tarjetas"><div class="tarjeta"><span>Próxima</span><b>${rango(T.proxima)}</b>${T.dias_faltan ? `<small>faltan ${T.dias_faltan} días · aviso desde ${fechaCorta(T.aviso_desde)}</small>` : ''}</div>
      <div class="tarjeta"><span>Temporada anterior</span><b>${rango(T.anterior)}</b><small>${T.dias_previos ? `contando ${T.dias_previos} días antes · ` : ''}vendió ${dinero(totAnt)}</small></div>
      <div class="tarjeta"><span>Para tener (+${T.crecimiento}%)</span><b>${plural(sugeridos.length, 'producto')}</b><small>${numero(sugeridos.reduce((s, f) => s + f.sugerido, 0))} piezas por comprar</small></div></div>
    <div class="titulo"><h3>Productos</h3>${marca ? `<div class="acciones"><button type="button" class="btn mini sec" id="tp-marcar">Marcar producto de temporada</button>${sugeridos.length ? '<button type="button" class="btn mini" id="tp-oc">Orden de compra con lo sugerido</button>' : ''}</div>` : ''}</div>
    ${r.filas.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Vendido la vez anterior</th><th class="num">Hace dos temporadas</th><th class="num">Existencia</th><th class="num">Meta</th><th class="num">Sugerido comprar</th><th>Caducidad</th></tr></thead>
      <tbody>${r.filas.map(f => `<tr><td>${f.de_temporada ? '<span class="txt-aviso" title="Producto de temporada">★</span> ' : ''}${esc(prod(f.producto_id).nombre || '—')}${f.descontinuado ? ' <small>(descontinuado)</small>' : ''}
          ${marca ? `<button type="button" class="btn mini sec" data-marcar="${esc(f.producto_id)}" data-v="${f.de_temporada ? '' : esc(T.id)}">${f.de_temporada ? 'Quitar ★' : 'Marcar ★'}</button>` : ''}</td>
        <td class="num"><b>${numero(f.anterior)}</b></td><td class="num">${f.anterior2 ? numero(f.anterior2) : '—'}</td><td class="num">${numero(f.stock)}</td><td class="num">${numero(f.meta)}</td>
        <td class="num">${f.sugerido ? `<b class="txt-ok">${numero(f.sugerido)}</b>` : '—'}</td>
        <td class="${f.no_llega ? 'txt-error' : ''}">${f.caducidad ? fechaCorta(f.caducidad) + (f.no_llega ? ' · no llega' : '') : '—'}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="vacio">Aún no hay ventas registradas en la temporada anterior ni productos marcados. El próximo año ya tendrás la comparación.</p>'}
    <div class="dos-col"><div class="col panel"><h3>Ideas a partir de las ventas</h3>${r.ideas.length ? `<ul class="lista">${r.ideas.map(i => `<li><span><span class="chip-al al-${i.tipo === 'PRODUCTO' ? 'ok' : i.tipo === 'PROMOCION' ? 'aviso' : 'gris'}">${{ PRODUCTO: 'Producto', DINAMICA: 'Dinámica', PROMOCION: 'Promoción' }[i.tipo]}</span> ${esc(i.texto)}</span>
        ${marca ? `<button type="button" class="btn mini sec" data-idea="${esc(i.texto)}" data-tipo="${i.tipo}">Agregar a propuestas</button>` : ''}</li>`).join('')}</ul>` : '<p class="nota">Sin ideas por ahora.</p>'}</div>
      <div class="col panel"><h3>Propuestas para esta temporada</h3><ul class="lista" id="tp-props">${T.propuestas.length ? T.propuestas.map((p, i) => `<li><label class="chk"><input type="checkbox" data-hecho="${i}" ${p.hecho ? 'checked' : ''} ${marca ? '' : 'disabled'}>
          <span class="${p.hecho ? 'tachado' : ''}"><span class="chip-al al-gris">${{ PRODUCTO: 'Producto nuevo', DINAMICA: 'Dinámica', PROMOCION: 'Promoción' }[p.tipo]}</span> ${esc(p.texto)}</span></label>
          ${marca ? `<button type="button" class="btn mini sec" data-borrar="${i}">Quitar</button>` : ''}</li>`).join('') : '<li class="nota">Agrega productos nuevos que quieras probar o dinámicas (degustación, rifas, combos, decoración).</li>'}</ul>
        ${marca ? `<form id="tp-fprop" class="fila-form"><select name="tipo"><option value="PRODUCTO">Producto nuevo</option><option value="DINAMICA">Dinámica</option><option value="PROMOCION">Promoción</option></select>
          <input name="texto" placeholder="Ej. Traer rompope artesanal, degustación de ponche" required><button class="btn">Agregar</button></form>` : ''}</div></div>`;
  $('#tp-volver', res).onclick = () => { ANA.temp = null; anPintarTemporadas(c); };
  const guardarProps = async props => {
    try { await conCarga('Guardando…', () => api('guardarTemporada', { temporada: Object.assign({}, T, { propuestas: props }) })); anPintarTemporada(c, id); } catch (e) { toast(e.message, 'error'); }
  };
  if (!marca) return;
  $('#tp-editar', res).onclick = () => dlgTemporada(T, x => (x ? anPintarTemporada(c, id) : anPintarTemporadas(c)));
  $('#tp-fprop', res).onsubmit = ev => { ev.preventDefault(); guardarProps(T.propuestas.concat([{ texto: ev.target.texto.value.trim(), tipo: ev.target.tipo.value, hecho: false }])); };
  res.onclick = async e => {
    const h = e.target.closest('[data-hecho]'), b = e.target.closest('[data-borrar]'), i = e.target.closest('[data-idea]'), m = e.target.closest('[data-marcar]');
    if (h) return guardarProps(T.propuestas.map((p, k) => (k === Number(h.dataset.hecho) ? Object.assign({}, p, { hecho: h.checked }) : p)));
    if (b) return guardarProps(T.propuestas.filter((_, k) => k !== Number(b.dataset.borrar)));
    if (i) return guardarProps(T.propuestas.concat([{ texto: i.dataset.idea, tipo: i.dataset.tipo, hecho: false }]));
    if (m) {
      try { await conCarga('Guardando…', () => api('marcarProductos', { ids: [m.dataset.marcar], temporada_id: m.dataset.v })); sincronizar(); anPintarTemporada(c, id); } catch (er) { toast(er.message, 'error'); }
    }
  };
  $('#tp-marcar', res).onclick = () => {
    const d = abrirModal(`Producto de ${T.nombre}`, `<div class="form"><p class="nota">Los productos de temporada se destacan en su temporada y no se marcan como "sin ventas" el resto del año.</p><div id="tp-sel"></div></div>`);
    selectorProducto($('#tp-sel', d), async p => {
      if (!p) return;
      try { await conCarga('Guardando…', () => api('marcarProductos', { ids: [p.id], temporada_id: T.id })); cerrarModal(); toast(`${p.nombre} marcado de ${T.nombre}.`, 'ok'); sincronizar(); anPintarTemporada(c, id); } catch (er) { toast(er.message, 'error'); }
    });
    $('.sel-q', d).focus();
  };
  const boc = $('#tp-oc', res);
  if (boc) boc.onclick = async () => {
    try { await conCarga('Cargando compras…', () => cargarCompras()); } catch (e) { toast(e.message, 'error'); return; }
    dlgEditorOrden(null, 'orden', { notas: 'Compra para ' + T.nombre, lineas: sugeridos.map(f => ({ producto_id: f.producto_id, cantidad: f.sugerido, costo: Number(prod(f.producto_id).costo) || 0 })) });
  };
}

/* ---------------- Lector de códigos con la cámara ---------------- */
// Usa el lector del navegador (Chrome en Android). Si no existe (iPhone), carga ZXing desde internet.
let LECTOR = null;
function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar el lector de códigos (se necesita internet la primera vez).'));
    document.head.appendChild(s);
  });
}
async function lectorCodigos() {
  if (LECTOR) return LECTOR;
  if ('BarcodeDetector' in window) {
    try {
      const sop = await window.BarcodeDetector.getSupportedFormats();
      const fm = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'].filter(f => sop.includes(f));
      if (fm.length) {
        const det = new window.BarcodeDetector({ formats: fm });
        LECTOR = async video => { const r = await det.detect(video); return r.length ? r[0].rawValue : ''; };
        return LECTOR;
      }
    } catch (e) { /* sigue con el respaldo */ }
  }
  if (!window.ZXing) await cargarScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
  const Z = window.ZXing;
  const reader = new Z.MultiFormatReader();
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  LECTOR = async video => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w) return '';
    const k = Math.min(1, 900 / w);
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    ctx.drawImage(video, 0, 0, cv.width, cv.height);
    try { return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText(); } catch (e) { return ''; } finally { reader.reset(); }
  };
  return LECTOR;
}

// Abre la cámara dentro de un contenedor. alLeer(codigo) recibe cada código (sin repetir el mismo en 2.5 s).
async function abrirCamara(cont, { frontal = false, continuo = false, alLeer, alError }) {
  cont.innerHTML = `<div class="camara ${frontal ? 'espejo' : ''}"><video playsinline muted autoplay></video><div class="mira"></div><p class="cam-msg">Abriendo la cámara…</p></div>`;
  const video = $('video', cont), msg = $('.cam-msg', cont);
  const ctl = { activo: true, detener() { this.activo = false; clearTimeout(this.t); if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } };
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este equipo o navegador no permite usar la cámara.');
    const [stream, leer] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: frontal ? 'user' : { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }),
      lectorCodigos()
    ]);
    ctl.stream = stream;
    if (!ctl.activo) { ctl.detener(); return ctl; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    msg.textContent = 'Apunta al código de barras';
    let ultimo = '', cuando = 0;
    const ciclo = async () => {
      if (!ctl.activo || !cont.isConnected) { ctl.detener(); return; }
      let cod = '';
      try { cod = video.readyState >= 2 ? await leer(video) : ''; } catch (e) { cod = ''; }
      cod = String(cod || '').trim();
      if (cod && (cod !== ultimo || Date.now() - cuando > 2500)) {
        ultimo = cod; cuando = Date.now();
        if (navigator.vibrate) navigator.vibrate(60);
        pitido();
        if (!continuo) ctl.detener();
        alLeer(cod);
        if (!continuo) return;
      }
      ctl.t = setTimeout(ciclo, 180);
    };
    ciclo();
  } catch (e) {
    ctl.detener();
    const txt = e.name === 'NotAllowedError' ? 'Sin permiso para usar la cámara. Permítelo en el candado de la barra de direcciones.' : e.message;
    msg.textContent = txt;
    if (alError) alError(txt);
  }
  return ctl;
}
let AUDIO = null;
function pitido() {
  try {
    AUDIO = AUDIO || new (window.AudioContext || window.webkitAudioContext)();
    const o = AUDIO.createOscillator(), g = AUDIO.createGain();
    o.frequency.value = 1400; g.gain.value = 0.08;
    o.connect(g); g.connect(AUDIO.destination);
    o.start(); o.stop(AUDIO.currentTime + 0.09);
  } catch (e) { /* sin sonido */ }
}
const buscarPorCodigo = cod => S.idx.barras[cod] || S.idx.codigo[normal(cod)] || S.idx.barras[cod.replace(/^0+/, '')] ||
  S.catalogo.productos.find(p => p.codigo_barras && String(p.codigo_barras).replace(/^0+/, '') === cod.replace(/^0+/, '')) || null;

/* ---------------- Código de barras Code 128 (para que la caja lea el autocobro) ---------------- */
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121',
  '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421',
  '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131',
  '311141', '411131', '211412', '211214', '211232', '2331112'];
function codigoBarrasSVG(texto, alto = 90) {
  const vals = [104].concat([...texto].map(ch => ch.charCodeAt(0) - 32));
  const check = vals.reduce((s, v, i) => s + v * (i || 1), 0) % 103;
  const pats = vals.concat([check]).map(v => C128[v]).concat([C128[106]]);
  let x = 10;
  const barras = [];
  pats.join('').split('').forEach((w, i) => { const n = Number(w); if (i % 2 === 0) barras.push(`<rect x="${x}" y="0" width="${n}" height="${alto}"/>`); x += n; });
  return `<svg class="cod128" viewBox="0 0 ${x + 10} ${alto}" preserveAspectRatio="none" role="img" aria-label="${esc(texto)}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${barras.join('')}</g></svg>`;
}

/* ---------------- Portal: comprar en la tienda (autocobro) ---------------- */
const AT = { datos: null, cam: null };
async function cargarAutocobro() {
  if (!AT.datos) AT.datos = (await DB.get('autocobro:' + S.usuario.usuario)) || { id: '', almacen_id: '', lineas: [], codigo: '', total: 0, enviado: '' };
  return AT.datos;
}
const guardarAutocobro = () => DB.set('autocobro:' + S.usuario.usuario, AT.datos);

async function vEnTienda(el) {
  const K = await cargarAutocobro();
  const cli = S.cliente || {};
  const tiendas = S.catalogo.tiendas || [];
  if (AT.cam) { AT.cam.detener(); AT.cam = null; }
  if (!K.almacen_id || !tiendas.some(t => t.id === K.almacen_id)) {
    if (tiendas.length === 1) K.almacen_id = tiendas[0].id;
    else {
      el.innerHTML = `<div class="titulo"><h2>Comprar en tienda</h2></div><p>¿En qué sucursal estás?</p>
        <div class="tiendas">${tiendas.map(t => `<button type="button" class="tarjeta" data-t="${esc(t.id)}"><b>${esc(t.nombre)}</b><small>${esc(t.direccion || '')}</small></button>`).join('') || '<p class="vacio">No hay sucursales disponibles.</p>'}</div>`;
      el.onclick = e => { const b = e.target.closest('[data-t]'); if (b) { K.almacen_id = b.dataset.t; guardarAutocobro(); el.onclick = null; vEnTienda(el); } };
      return;
    }
  }
  el.onclick = null;
  const tienda = tiendas.find(t => t.id === K.almacen_id) || {};
  const precio = p => precioCliente(p, cli);
  const total = () => K.lineas.reduce((s, l) => { const p = S.idx.prod[l.producto_id]; return s + (p ? precio(p) * l.cantidad : 0); }, 0);
  if (K.codigo && K.verCodigo) return pintarCodigoAutocobro(el);
  el.innerHTML = `<div class="titulo"><h2>Comprar en tienda</h2><div class="acciones">${tiendas.length > 1 ? `<button type="button" class="btn sec mini" id="at-tienda">${esc(tienda.nombre)} · cambiar</button>` : `<span class="nota">${esc(tienda.nombre || '')}</span>`}</div></div>
    <p class="nota">Escanea los productos con tu teléfono mientras compras. Al terminar te damos un código para pagar rápido en caja.</p>
    <div class="at-botones"><button type="button" class="btn at-grande" id="at-escanear">📷 Escanear productos</button><button type="button" class="btn sec at-grande" id="at-precio">Verificar un precio</button></div>
    <div id="at-cam"></div>
    <div id="at-ultimo"></div>
    <input id="at-q" type="search" placeholder="O busca por nombre o código" autocomplete="off">
    <div id="at-sug" class="sugerencias-at"></div>
    <div class="panel"><h3>Tu carrito</h3><div class="cj-lineas" id="at-lineas"></div><div class="cj-total" id="at-total"></div>
      ${K.codigo ? `<p class="nota">Tu código de caja es <b>AC ${esc(K.codigo)}</b>. Si agregas o quitas productos, vuelve a tocar el botón para actualizarlo.</p>` : ''}
      <p class="msg" id="at-msg"></p>
      <div class="acciones"><button type="button" class="btn cobrar" id="at-terminar">${K.codigo ? 'Actualizar y ver mi código' : 'Terminar y pagar en caja'}</button>
        ${K.lineas.length || K.codigo ? '<button type="button" class="btn sec" id="at-vaciar">Empezar de nuevo</button>' : ''}</div></div>`;
  const pintarCarrito = () => {
    K.lineas = K.lineas.filter(l => S.idx.prod[l.producto_id]);
    $('#at-lineas', el).innerHTML = K.lineas.length ? K.lineas.map((l, i) => {
      const p = S.idx.prod[l.producto_id];
      return `<div class="cj-linea"><div class="cj-nombre">${esc(p.nombre)}<small>${dinero(precio(p))} c/u</small></div>
        <div class="cj-cant"><button type="button" data-menos="${i}">−</button><input type="number" min="0" step="any" data-cant="${i}" value="${l.cantidad}"><button type="button" data-mas="${i}">+</button></div>
        <b class="cj-imp">${dinero(precio(p) * l.cantidad)}</b><button type="button" class="icono" data-quitar="${i}" aria-label="Quitar">✕</button></div>`;
    }).join('') : '<p class="nota cj-vacio">Aún no escaneas productos.</p>';
    $('#at-total', el).innerHTML = `<span>${plural(K.lineas.reduce((s, l) => s + Number(l.cantidad), 0), 'artículo')}</span><b>${dinero(total())}</b>`;
    $('#at-terminar', el).disabled = !K.lineas.length;
    guardarAutocobro();
  };
  const agregar = p => {
    const ya = K.lineas.find(l => l.producto_id === p.id);
    if (ya) ya.cantidad += 1; else K.lineas.push({ producto_id: p.id, cantidad: 1 });
    $('#at-ultimo', el).innerHTML = `<div class="at-ultimo"><b>${esc(p.nombre)}</b><span class="precio">${dinero(precio(p))}</span><small>Agregado · llevas ${numero(K.lineas.find(l => l.producto_id === p.id).cantidad)}</small></div>`;
    pintarCarrito();
  };
  pintarCarrito();
  const cerrarCam = () => { if (AT.cam) { AT.cam.detener(); AT.cam = null; } $('#at-cam', el).innerHTML = ''; };
  $('#at-escanear', el).onclick = async () => {
    if (AT.cam) { cerrarCam(); $('#at-escanear', el).textContent = '📷 Escanear productos'; return; }
    $('#at-escanear', el).textContent = 'Cerrar cámara';
    AT.cam = await abrirCamara($('#at-cam', el), { continuo: true, alLeer: cod => {
      const p = buscarPorCodigo(cod);
      if (p) agregar(p); else toast(`El código ${cod} no está en el catálogo. Pregunta en caja.`, 'error');
    } });
  };
  $('#at-precio', el).onclick = async () => {
    cerrarCam();
    $('#at-escanear', el).textContent = '📷 Escanear productos';
    AT.cam = await abrirCamara($('#at-cam', el), { alLeer: cod => {
      cerrarCam();
      const p = buscarPorCodigo(cod);
      const d = abrirModal(p ? p.nombre : 'Producto no encontrado', p ? `<div class="form verif-res-mini"><p class="precio-grande">${dinero(precio(p))}</p>
          ${Number(p.precio_mayoreo) > 0 && Number(p.precio_mayoreo) !== precio(p) ? `<p>Mayoreo: ${dinero(p.precio_mayoreo)}</p>` : ''}${p.descripcion ? `<p class="nota">${esc(p.descripcion)}</p>` : ''}
          <div class="pie"><button type="button" class="btn sec" data-cerrar>Cerrar</button><button type="button" class="btn" id="vp-agregar">Agregar al carrito</button></div></div>`
        : `<div class="form"><p>El código ${esc(cod)} no está en el catálogo. Pregunta a un colaborador.</p><div class="pie"><button type="button" class="btn" data-cerrar>Cerrar</button></div></div>`);
      const b = $('#vp-agregar', d);
      if (b) b.onclick = () => { cerrarModal(); agregar(p); };
    } });
  };
  const q = $('#at-q', el), sug = $('#at-sug', el);
  q.oninput = () => {
    const v = normal(q.value.trim());
    const l = v ? S.catalogo.productos.filter(p => coincide(p, v)).sort(porNombre).slice(0, 8) : [];
    sug.innerHTML = l.map(p => `<button type="button" data-p="${esc(p.id)}"><span>${esc(p.nombre)}</span><b>${dinero(precio(p))}</b></button>`).join('');
  };
  q.onkeydown = e => { if (e.key === 'Enter') { const p = buscarPorCodigo(q.value.trim()); if (p) { agregar(p); q.value = ''; sug.innerHTML = ''; } } };
  sug.onclick = e => { const b = e.target.closest('[data-p]'); if (b) { agregar(S.idx.prod[b.dataset.p]); q.value = ''; sug.innerHTML = ''; } };
  const lin = $('#at-lineas', el);
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
  const bt = $('#at-tienda', el);
  if (bt) bt.onclick = () => { K.almacen_id = ''; guardarAutocobro(); vEnTienda(el); };
  const bv = $('#at-vaciar', el);
  if (bv) bv.onclick = async () => {
    if (!confirm('¿Vaciar tu carrito y empezar una compra nueva?')) return;
    if (K.id && K.codigo && navigator.onLine) api('cancelarAutocobro', { id: K.id }).catch(() => {});
    Object.assign(K, { id: '', lineas: [], codigo: '', total: 0, verCodigo: false });
    guardarAutocobro(); cerrarCam(); vEnTienda(el);
  };
  $('#at-terminar', el).onclick = async () => {
    const msg = $('#at-msg', el);
    if (!navigator.onLine) { msg.textContent = 'Necesitas internet para generar tu código. Tu carrito se queda guardado.'; return; }
    if (!K.id) K.id = uuid();
    try {
      const r = await conCarga('Generando tu código…', () => api('autocobro', { id: K.id, almacen_id: K.almacen_id, lineas: K.lineas }));
      Object.assign(K, { codigo: r.codigo, total: r.total, verCodigo: true });
      guardarAutocobro(); cerrarCam();
      pintarCodigoAutocobro(el);
    } catch (e) {
      msg.textContent = e.message;
      if (/cobrando|ya no está activo/.test(e.message)) {
        msg.textContent += ' Toca "Empezar de nuevo" para otra compra.';
      }
    }
  };
  S.refrescar = pintarCarrito;
}

function pintarCodigoAutocobro(el) {
  const K = AT.datos;
  el.innerHTML = `<div class="at-codigo panel">
    <h2>Paga en caja</h2>
    <p>Muestra este código a la persona de caja</p>
    ${codigoBarrasSVG('AC' + K.codigo)}
    <p class="at-num">AC ${esc(K.codigo.slice(0, 3))} ${esc(K.codigo.slice(3))}</p>
    <p class="precio-grande">${dinero(K.total)}</p>
    <p class="nota">${plural(K.lineas.reduce((s, l) => s + Number(l.cantidad), 0), 'artículo')} · el código vale solo hoy. En caja revisan tu mercancía y cobras con efectivo o tarjeta.</p>
    <div class="acciones"><button type="button" class="btn sec" id="at-seguir">Seguir comprando</button><button type="button" class="btn" id="at-listo">Ya pagué · nueva compra</button></div>
  </div>`;
  $('#at-seguir', el).onclick = () => { K.verCodigo = false; guardarAutocobro(); vEnTienda(el); };
  $('#at-listo', el).onclick = () => { Object.assign(K, { id: '', lineas: [], codigo: '', total: 0, verCodigo: false }); guardarAutocobro(); irA('mispedidos'); };
  S.refrescar = null;
}

/* ---------------- Verificador de precios (tablet fija) ---------------- */
const VF = { cam: null, t: null, salida: false };
function bloquearKiosco(activar) {
  document.body.classList.toggle('kiosco', activar);
  try { if (activar && rol() !== 'VERIFICADOR') localStorage.setItem('kiosco_verificador', '1'); else if (!activar) localStorage.removeItem('kiosco_verificador'); } catch (e) { /* sin almacenamiento */ }
  actualizarBurbujaPrecio();
  if (activar && !VF.trampa) {
    VF.trampa = () => { if (document.body.classList.contains('kiosco')) history.pushState({ kiosco: 1 }, ''); };
    history.pushState({ kiosco: 1 }, '');
    window.addEventListener('popstate', VF.trampa);
    document.addEventListener('contextmenu', e => { if (document.body.classList.contains('kiosco')) e.preventDefault(); });
  }
}

// Código de bloqueo del verificador (se guarda solo en este equipo, cifrado)
const VF_CLAVE = 'kiosco_codigo';
const leerCodigoKiosco = () => { try { return JSON.parse(localStorage.getItem(VF_CLAVE) || 'null'); } catch (e) { return null; } };
async function guardarCodigoKiosco(codigo) {
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  localStorage.setItem(VF_CLAVE, JSON.stringify({ salt, hash: await derivar(codigo, salt) }));
}
const quitarCodigoKiosco = () => { try { localStorage.removeItem(VF_CLAVE); } catch (e) { /* nada */ } };

function vVerificador(el) {
  if (!leerCodigoKiosco()) return pintarBloqueoVerificador(el);
  bloquearKiosco(true);
  const emp = CFG.NOMBRE;
  el.innerHTML = `<div class="verif">
    <div class="verif-marca"><img src="${esc(logoSrc())}" alt=""><b>${esc(emp)}</b></div>
    <div id="vf-inicio" class="verif-inicio">
      <button type="button" class="verif-btn" id="vf-btn">Verificar un precio</button>
      <p>Toca el botón y acerca el código de barras del producto a la cámara.</p>
    </div>
    <div id="vf-cam" class="verif-cam" hidden></div>
    <div id="vf-res" class="verif-res" hidden></div>
    <input id="vf-scan" class="vf-oculto" inputmode="none" autocomplete="off" aria-hidden="true" tabindex="-1">
    <button type="button" class="vf-candado" id="vf-candado" aria-label="Desbloquear (solo personal)">🔒</button>
  </div>`;
  const ini = $('#vf-inicio', el), cam = $('#vf-cam', el), res = $('#vf-res', el), scan = $('#vf-scan', el);
  const reiniciar = () => {
    clearTimeout(VF.t);
    if (VF.cam) { VF.cam.detener(); VF.cam = null; }
    cam.hidden = true; cam.innerHTML = ''; res.hidden = true; res.innerHTML = ''; ini.hidden = false;
    if (!VF.salida) scan.focus({ preventScroll: true });
  };
  VF.reiniciar = reiniciar;
  const mostrar = cod => {
    if (VF.cam) { VF.cam.detener(); VF.cam = null; }
    cam.hidden = true; ini.hidden = true; res.hidden = false;
    const p = buscarPorCodigo(String(cod).trim());
    res.innerHTML = p ? `<div class="verif-prod">
        ${p.imagen ? `<div class="verif-img"><img data-img="${esc(p.imagen)}" alt=""></div>` : ''}
        <div><h2>${esc(p.nombre)}</h2>${p.descripcion ? `<p>${esc(p.descripcion)}</p>` : ''}
          <p class="verif-precio">${dinero(p.precio_menudeo)}</p>
          ${Number(p.precio_mayoreo) > 0 && Number(p.precio_mayoreo) < Number(p.precio_menudeo) ? `<p class="verif-mayoreo">Mayoreo: ${dinero(p.precio_mayoreo)}</p>` : ''}
          <small>${esc(p.unidad || '')}${p.codigo_barras ? ' · ' + esc(p.codigo_barras) : ''}</small></div></div>`
      : `<div class="verif-no"><h2>No encontramos este producto</h2><p>Pide ayuda a un colaborador.</p><small>${esc(cod)}</small></div>`;
    if (p && p.imagen) cargarImgs(res);
    VF.t = setTimeout(reiniciar, p ? 9000 : 5000);
  };
  const abrir = async () => {
    clearTimeout(VF.t);
    try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (e) { /* sin pantalla completa */ }
    res.hidden = true; ini.hidden = true; cam.hidden = false;
    VF.cam = await abrirCamara(cam, { frontal: true, alLeer: mostrar, alError: () => { VF.t = setTimeout(reiniciar, 6000); } });
    VF.t = setTimeout(reiniciar, 25000);   // si nadie acerca un producto, vuelve solo al inicio
  };
  $('#vf-btn', el).onclick = abrir;
  // Tocar el resultado vuelve al botón de inmediato
  res.onclick = reiniciar;
  // Lector USB o Bluetooth (teclado): escribe el código y Enter
  scan.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const v = scan.value.trim(); scan.value = ''; if (v) mostrar(v); } };
  el.onclick = e => { if (!e.target.closest('button,input') && !VF.salida) scan.focus({ preventScroll: true }); };
  $('#vf-candado', el).onclick = () => dlgDesbloquearVerificador(reiniciar);
  S.refrescar = null;
  reiniciar();
}

// Antes de empezar: se elige el código que bloquea la pantalla
function pintarBloqueoVerificador(el) {
  const cuenta = rol() === 'VERIFICADOR';
  if (cuenta) bloquearKiosco(true);
  el.innerHTML = `<div class="verif"><form id="vfb" class="panel form verif-bloqueo" autocomplete="off">
    <div class="verif-marca"><span class="vf-ico">🔒</span><b>Bloquear el verificador de precios</b></div>
    <p class="nota">Elige un código numérico. La pantalla quedará fija en el verificador y solo se podrá salir con este código, desde el candado.</p>
    <div class="fila2"><label>Código (4 a 8 números)<input name="c1" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" required></label>
      <label>Repite el código<input name="c2" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" required></label></div>
    <p class="msg" id="vfb-msg"></p>
    <div class="pie">${cuenta ? '' : '<button type="button" class="btn sec" id="vfb-no">Cancelar</button>'}<button class="btn" type="submit">🔒 Bloquear y empezar</button></div>
  </form></div>`;
  const f = $('#vfb', el);
  f.c1.focus();
  const no = $('#vfb-no', el);
  if (no) no.onclick = () => irA('inicio');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const a = f.c1.value.trim(), b = f.c2.value.trim();
    if (!/^\d{4,8}$/.test(a)) { $('#vfb-msg', el).textContent = 'El código debe tener de 4 a 8 números.'; return; }
    if (a !== b) { $('#vfb-msg', el).textContent = 'Los códigos no coinciden.'; f.c2.value = ''; f.c2.focus(); return; }
    await guardarCodigoKiosco(a);
    vVerificador(el);
  };
  S.refrescar = null;
}

function dlgDesbloquearVerificador(alVolver) {
  VF.salida = true;
  const d = abrirModal('🔒 Desbloquear', `<form id="fvs" class="form" autocomplete="off">
    <label>Código de bloqueo<input name="codigo" type="password" inputmode="numeric" maxlength="8" required autofocus></label>
    <p class="msg" id="fvs-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Volver</button><button class="btn" type="submit">Desbloquear</button></div>
    <details class="vf-olvido"><summary>¿Olvidaste el código?</summary>
      <p class="nota">Un administrador puede desbloquear con su usuario y contraseña.</p>
      <div class="fila2"><input name="usuario" placeholder="Usuario" autocapitalize="none"><input name="password" type="password" placeholder="Contraseña"></div>
      <button type="button" class="btn sec mini" id="fvs-admin">Desbloquear como administrador</button></details>
  </form>`);
  const vigilar = setInterval(() => { if (!d.open) { clearInterval(vigilar); VF.salida = false; alVolver(); } }, 400);
  const cerrarAuto = setTimeout(() => { if (d.open) cerrarModal(); }, 45000);
  const f = $('#fvs', d), msg = $('#fvs-msg', d);
  VF.fallos = VF.fallos || 0;
  const opciones = () => {
    clearTimeout(cerrarAuto);
    VF.fallos = 0;
    f.outerHTML = `<div class="form"><p>Pantalla desbloqueada.</p>
      <div class="pie pie-col"><button type="button" class="btn sec" id="vs-act">Actualizar precios ahora</button>
        <button type="button" class="btn sec" id="vs-codigo">Cambiar el código</button>
        ${rol() === 'VERIFICADOR' ? '<button type="button" class="btn peligro" id="vs-salir">Cerrar sesión del verificador</button>'
          : '<button type="button" class="btn peligro" id="vs-app">Salir del verificador y volver a la app</button>'}
        <button type="button" class="btn" data-cerrar>Volver a bloquear</button></div></div>`;
    $('#vs-act', d).onclick = async () => { await sincronizar(true); toast('Precios actualizados.', 'ok'); };
    $('#vs-codigo', d).onclick = () => { clearInterval(vigilar); VF.salida = false; quitarCodigoKiosco(); cerrarModal(); if (VF.cam) { VF.cam.detener(); VF.cam = null; } pintarBloqueoVerificador($('#vista')); };
    const salirKiosco = async () => {
      clearInterval(vigilar); VF.salida = false;
      if (VF.cam) { VF.cam.detener(); VF.cam = null; }
      quitarCodigoKiosco();
      bloquearKiosco(false);
      try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) { /* nada */ }
      cerrarModal();
    };
    const bapp = $('#vs-app', d);
    if (bapp) bapp.onclick = async () => { await salirKiosco(); irA('inicio'); };
    const bsal = $('#vs-salir', d);
    if (bsal) bsal.onclick = async () => {
      await salirKiosco();
      if (S.online) api('logout').catch(() => {});
      await DB.del('sesion');
      const u = S.usuario.usuario;
      S.usuario = null; S.token = '';
      mostrarLogin(u);
    };
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (VF.bloqueoHasta && Date.now() < VF.bloqueoHasta) { msg.textContent = 'Demasiados intentos. Espera un minuto.'; return; }
    const k = leerCodigoKiosco();
    if (k && await derivar(f.codigo.value.trim(), k.salt) === k.hash) { opciones(); return; }
    VF.fallos++;
    if (VF.fallos >= 5) { VF.bloqueoHasta = Date.now() + 60000; VF.fallos = 0; }
    msg.textContent = 'Código incorrecto.';
    f.codigo.value = ''; f.codigo.focus();
  };
  $('#fvs-admin', d).onclick = async () => {
    const usuario = f.usuario.value.trim().toLowerCase(), password = f.password.value;
    if (!usuario || !password) { msg.textContent = 'Escribe usuario y contraseña.'; return; }
    let rolCol = '';
    try {
      await conCarga('Verificando…', () => api('validarColaborador', { usuario, password }));
      const cred = await DB.get('cred:' + usuario);
      rolCol = cred ? cred.usuario.rol : 'ADMIN';
    } catch (e) {
      if (!e.red) { msg.textContent = e.message; return; }
      const cred = await DB.get('cred:' + usuario);
      if (!cred || await derivar(password, cred.salt) !== cred.hash) { msg.textContent = 'Usuario o contraseña incorrectos.'; return; }
      rolCol = cred.usuario.rol;
    }
    if (['CAJERO', 'CLIENTE', 'VERIFICADOR'].includes(rolCol)) { msg.textContent = 'Solo un administrador puede desbloquear sin el código.'; return; }
    opciones();
  };
}

/* ---------------- Portal público: pedir sin cuenta y crear cuenta ---------------- */
const PUB = { datos: null, carrito: null, cat: '', q: '' };
const telBonito = t => String(t || '').replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');

async function abrirPublico(pantalla = 'pedir') {
  $('#pantalla-login').hidden = true;
  $('#pantalla-app').hidden = true;
  const P = $('#pantalla-publica');
  P.hidden = false;
  if (pantalla === 'registro') return pintarRegistro(P);
  PUB.carrito = PUB.carrito || (await DB.get('pub:carrito')) || { lineas: [], modalidad: 'DOMICILIO', fecha: '', horario: '', notas: '', tienda_id: '' };
  PUB.contacto = PUB.contacto || (await DB.get('pub:contacto')) || { nombre: '', telefono: '', direccion: '' };
  if (!PUB.datos) {
    PUB.datos = await DB.get('pub:tienda');
    if (navigator.onLine) {
      try {
        PUB.datos = await conCarga('Cargando el catálogo…', () => api('tiendaPublica'));
        await DB.set('pub:tienda', PUB.datos);
      } catch (e) { if (!PUB.datos) { P.innerHTML = `<div class="pub"><p class="txt-error">${esc(e.message)}</p><button type="button" class="btn" id="pub-volver">Volver</button></div>`; $('#pub-volver', P).onclick = salirPublico; return; } }
    }
    if (!PUB.datos) { P.innerHTML = '<div class="pub"><p class="aviso-offline">Necesitas internet para ver el catálogo.</p><button type="button" class="btn" id="pub-volver">Volver</button></div>'; $('#pub-volver', P).onclick = salirPublico; return; }
  }
  pintarPedidoPublico(P);
}

function salirPublico() {
  $('#pantalla-publica').hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  mostrarLogin();
}

function cabPublica(titulo) {
  const nom = CFG.NOMBRE || (PUB.datos && PUB.datos.empresa && PUB.datos.empresa.nombre);
  return `<header class="cab pub-cab"><div class="marca"><img src="${esc(logoSrc())}" alt="" width="56" height="56"><span>${esc(nom)}</span></div>
    <div class="acciones"><button type="button" class="btn sec mini" data-pub="registro">Crear cuenta</button><button type="button" class="btn mini" data-pub="entrar">Entrar</button></div></header>
    <h2 class="pub-tit">${esc(titulo)}</h2>`;
}

function pintarPedidoPublico(P) {
  const D = PUB.datos, K = PUB.carrito, C = PUB.contacto;
  const idx = {};
  D.catalogo.productos.forEach(p => { idx[p.id] = p; });
  const tiendas = D.catalogo.tiendas || [];
  P.innerHTML = `<div class="pub">${cabPublica('Haz tu pedido')}
    <p class="nota">No necesitas cuenta: déjanos tu nombre, teléfono y dirección. <b>Pagas al recibir o al recoger</b> (efectivo o tarjeta).</p>
    <div class="caja">
      <section class="caja-buscar">
        <input id="pub-q" type="search" placeholder="Busca un producto" value="${esc(PUB.q)}" autocomplete="off">
        <div class="cats" id="pub-cats"></div><div class="cj-res" id="pub-res"></div>
      </section>
      <aside class="caja-ticket">
        <b>Tu pedido</b>
        <div class="cj-lineas" id="pub-lineas"></div><div class="cj-total" id="pub-total"></div>
        <form id="pub-form" class="form" autocomplete="on">
          <label>Tu nombre<input name="nombre" required autocomplete="name" value="${esc(C.nombre)}"></label>
          <label>Teléfono (10 dígitos)<input name="telefono" type="tel" required autocomplete="tel" inputmode="tel" value="${esc(telBonito(C.telefono))}"></label>
          <label>¿Cómo lo recibes?<select name="modalidad"><option value="DOMICILIO">Entrega a domicilio</option><option value="RECOGER" ${K.modalidad === 'RECOGER' ? 'selected' : ''}>Paso a recogerlo</option></select></label>
          <label data-m="DOMICILIO">Dirección de entrega<input name="direccion" autocomplete="street-address" value="${esc(C.direccion)}" placeholder="Calle, número, colonia y referencias"></label>
          ${tiendas.length ? `<label data-m="RECOGER">¿En qué tienda?<select name="tienda_id">${tiendas.map(t => `<option value="${esc(t.id)}" ${K.tienda_id === t.id ? 'selected' : ''}>${esc(t.nombre)}${t.direccion ? ' · ' + esc(t.direccion) : ''}</option>`).join('')}</select></label>` : ''}
          <div class="fila2"><label>Día<input name="fecha" type="date" min="${D.hoy || hoyLocal()}" value="${esc(K.fecha)}"></label>
            <label>Horario<select name="horario"><option value="">Cualquier hora</option>${(D.horarios_entrega || HORARIOS_ENTREGA).map(h => `<option value="${h}" ${K.horario === h ? 'selected' : ''}>${h.replace('-', ' a ')}</option>`).join('')}</select></label></div>
          <label>Notas<input name="notas" value="${esc(K.notas)}" placeholder="Algo que debamos saber"></label>
          <p class="msg" id="pub-msg"></p>
          <button class="btn cobrar" type="submit" id="pub-enviar">Enviar pedido</button>
        </form>
      </aside>
    </div>
    <div id="pub-mios"></div>
    <div class="cj-movil"><button type="button" class="cj-ver" id="pub-ver"></button></div>
  </div>`;
  const f = $('#pub-form', P);
  const guardar = () => { DB.set('pub:carrito', K); DB.set('pub:contacto', C); };
  const verMod = () => $$('[data-m]', P).forEach(x => { x.hidden = x.dataset.m !== f.modalidad.value; });
  verMod();
  $('#pub-cats', P).innerHTML = [['', 'Todo']].concat(D.catalogo.categorias.slice().sort(porNombre).map(c => [c.id, c.nombre]))
    .map(([id, n]) => `<button type="button" data-cat="${esc(id)}" class="${PUB.cat === id ? 'activo' : ''}">${esc(n)}</button>`).join('');
  const pintarRes = () => {
    const q = normal(PUB.q);
    const l = D.catalogo.productos.filter(p => (!PUB.cat || p.categoria_id === PUB.cat) && (!q || coincide(p, q))).sort(porNombre).slice(0, 80);
    $('#pub-res', P).innerHTML = l.map(p => `<button type="button" class="prod" data-p="${esc(p.id)}"><b>${esc(p.nombre)}</b>
      <span class="fila-oc"><span class="precio">${dinero(p.precio_menudeo)}</span><small class="${p.disponible ? 'txt-ok' : 'txt-error'}">${p.disponible ? 'Disponible' : 'Agotado'}</small></span></button>`).join('') || '<p class="nota">Sin productos.</p>';
  };
  const total = () => K.lineas.reduce((s, l) => s + (idx[l.producto_id] ? Number(idx[l.producto_id].precio_menudeo) * l.cantidad : 0), 0);
  const pintarCarrito = () => {
    K.lineas = K.lineas.filter(l => idx[l.producto_id]);
    $('#pub-lineas', P).innerHTML = K.lineas.length ? K.lineas.map((l, i) => {
      const p = idx[l.producto_id];
      return `<div class="cj-linea"><div class="cj-nombre">${esc(p.nombre)}<small>${dinero(p.precio_menudeo)} c/u</small></div>
        <div class="cj-cant"><button type="button" data-menos="${i}">−</button><input type="number" min="0" step="any" data-cant="${i}" value="${l.cantidad}"><button type="button" data-mas="${i}">+</button></div>
        <b class="cj-imp">${dinero(Number(p.precio_menudeo) * l.cantidad)}</b><button type="button" class="icono" data-quitar="${i}" aria-label="Quitar">✕</button></div>`;
    }).join('') : '<p class="nota cj-vacio">Toca un producto para agregarlo.</p>';
    $('#pub-total', P).innerHTML = `<span>${plural(K.lineas.length, 'producto')}</span><b>${dinero(total())}</b>`;
    $('#pub-ver', P).innerHTML = `<small>${plural(K.lineas.length, 'producto')} · ver pedido</small><b>${dinero(total())}</b>`;
    $('#pub-enviar', P).disabled = !K.lineas.length;
    guardar();
  };
  pintarRes(); pintarCarrito();
  $('#pub-q', P).oninput = e => { PUB.q = e.target.value; pintarRes(); };
  $('#pub-cats', P).onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { PUB.cat = b.dataset.cat; $$('#pub-cats button', P).forEach(x => x.classList.toggle('activo', x === b)); pintarRes(); } };
  $('#pub-res', P).onclick = e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const ya = K.lineas.find(l => l.producto_id === b.dataset.p);
    if (ya) ya.cantidad += 1; else K.lineas.push({ producto_id: b.dataset.p, cantidad: 1 });
    pintarCarrito();
  };
  const lin = $('#pub-lineas', P);
  lin.onclick = e => {
    const t = e.target;
    if (t.dataset.mas !== undefined) K.lineas[t.dataset.mas].cantidad += 1;
    else if (t.dataset.menos !== undefined) { const l = K.lineas[t.dataset.menos]; l.cantidad -= 1; if (l.cantidad <= 0) K.lineas.splice(Number(t.dataset.menos), 1); }
    else if (t.closest('[data-quitar]')) K.lineas.splice(Number(t.closest('[data-quitar]').dataset.quitar), 1);
    else return;
    pintarCarrito();
  };
  lin.onchange = e => { const i = e.target.dataset.cant; if (i === undefined) return; const n = Number(e.target.value); if (n > 0) K.lineas[i].cantidad = n; else K.lineas.splice(Number(i), 1); pintarCarrito(); };
  f.oninput = () => {
    Object.assign(C, { nombre: f.nombre.value, telefono: f.telefono.value.replace(/\D/g, ''), direccion: f.direccion.value });
    Object.assign(K, { modalidad: f.modalidad.value, fecha: f.fecha.value, horario: f.horario.value, notas: f.notas.value, tienda_id: f.tienda_id ? f.tienda_id.value : '' });
    verMod(); guardar();
  };
  f.onchange = f.oninput;
  $('#pub-ver', P).onclick = () => $('.caja-ticket', P).scrollIntoView({ behavior: 'smooth' });
  f.onsubmit = async ev => {
    ev.preventDefault();
    f.oninput();
    const msg = $('#pub-msg', P);
    if (!navigator.onLine) { msg.textContent = 'Necesitas internet para enviar el pedido. Se queda guardado en este equipo.'; return; }
    if (!K.id) { K.id = uuid(); guardar(); }
    try {
      const r = await conCarga('Enviando pedido…', () => api('pedidoPublico', { pedido: { id: K.id, nombre: C.nombre, telefono: C.telefono, direccion: C.direccion,
        modalidad: K.modalidad, tienda_id: K.tienda_id, fecha_entrega: K.fecha, horario_entrega: K.horario, notas: K.notas, lineas: K.lineas } }));
      const mios = (await DB.get('pub:pedidos')) || [];
      mios.unshift({ id: r.pedido.id, folio: r.pedido.folio });
      await DB.set('pub:pedidos', mios.slice(0, 20));
      PUB.carrito = { lineas: [], modalidad: K.modalidad, fecha: '', horario: '', notas: '', tienda_id: K.tienda_id };
      await DB.set('pub:carrito', PUB.carrito);
      P.innerHTML = `<div class="pub">${cabPublica('¡Gracias, ' + C.nombre.split(' ')[0] + '!')}
        <div class="panel at-codigo"><p>Recibimos tu pedido</p><p class="at-num">${esc(r.pedido.folio)}</p><p class="precio-grande">${dinero(r.pedido.total)}</p>
          <p>${r.pedido.modalidad === 'RECOGER' ? 'Pasa a recogerlo' : 'Te lo llevamos'}${r.pedido.fecha_entrega ? ' el ' + fechaCorta(r.pedido.fecha_entrega) : ''}${r.pedido.horario_entrega ? ' de ' + r.pedido.horario_entrega.replace('-', ' a ') : ''}. Pagas en ese momento.</p>
          <p class="nota">Te llamaremos al ${esc(telBonito(C.telefono))} si hay algún cambio.</p>
          <div class="acciones"><button type="button" class="btn" id="pub-otro">Hacer otro pedido</button><button type="button" class="btn sec" data-pub="registro">Crear mi cuenta para guardar mis datos</button></div></div>
        <div id="pub-mios"></div></div>`;
      $('#pub-otro', P).onclick = () => pintarPedidoPublico(P);
      enlazarPublico(P);
      pintarMisPedidosPublicos(P);
    } catch (e) { msg.textContent = e.message; }
  };
  enlazarPublico(P);
  pintarMisPedidosPublicos(P);
}

function enlazarPublico(P) {
  $$('[data-pub]', P).forEach(b => {
    b.onclick = () => (b.dataset.pub === 'registro' ? pintarRegistro(P) : salirPublico());
  });
}

async function pintarMisPedidosPublicos(P) {
  const mios = (await DB.get('pub:pedidos')) || [];
  const c = $('#pub-mios', P);
  if (!c || !mios.length || !navigator.onLine || !PUB.contacto || !PUB.contacto.telefono) return;
  try {
    const [l, av] = await Promise.all([api('pedidosPublicos', { telefono: PUB.contacto.telefono, ids: mios.map(x => x.id) }),
      api('avisosPublicos', { telefono: PUB.contacto.telefono, ids: mios.map(x => x.id) }).catch(() => [])]);
    notificarNuevos(av, 'pub:avisosVistos', './#pedir');
    if (!l.length || !c.isConnected) return;
    c.innerHTML = `<div class="panel"><h3>Tus pedidos desde este teléfono</h3>
      ${permisoNotif() === 'default' ? '<button type="button" class="btn sec mini" id="pub-notif">🔔 Avísame en este teléfono cuando cambien</button>' : ''}
      ${av.length ? `<ul class="lista avisos">${av.slice(0, 5).map(a => `<li><span class="av-ico">${iconoAviso(a.tipo)}</span><span><b>${esc(a.titulo)}</b><small>${esc(a.mensaje)}</small></span></li>`).join('')}</ul>` : ''}
      <ul class="lista">${l.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).map(p => `<li><span><b>${esc(p.folio)}</b> · ${dinero(p.total)}
      <small>${p.fecha_entrega ? 'Entrega ' + fechaCorta(p.fecha_entrega) : 'Sin fecha'}${entregaTxt(p) ? ' · ' + entregaTxt(p) : ''}</small></span>${chipPed(p.estado)}</li>`).join('')}</ul></div>`;
    const bn = $('#pub-notif', c);
    if (bn) bn.onclick = async () => { if (await pedirPermisoNotif()) bn.remove(); };
    clearTimeout(PUB.reloj);
    PUB.reloj = setTimeout(() => { if (c.isConnected && document.visibilityState === 'visible') pintarMisPedidosPublicos(P); }, 5 * 60000);
  } catch (e) { /* sin conexión */ }
}

function pintarRegistro(P) {
  const C = PUB.contacto || {};
  P.hidden = false;
  $('#pantalla-login').hidden = true;
  P.innerHTML = `<div class="pub pub-reg">${cabPublica('Crea tu cuenta')}
    <form id="reg-form" class="panel form" autocomplete="on">
      <p class="nota">Solo eliges un usuario y una contraseña: guardamos tus datos y tus pedidos para la próxima vez. No tienes que confirmar nada.</p>
      <div class="fila2"><label>Usuario<input name="usuario" required autocapitalize="none" autocomplete="username" placeholder="ej. rosa.perez"></label>
        <label>Contraseña<input name="password" type="password" required minlength="6" autocomplete="new-password"></label></div>
      <label>Nombre<input name="nombre" required autocomplete="name" value="${esc(C.nombre || '')}"></label>
      <label>Teléfono (10 dígitos)<input name="telefono" type="tel" required inputmode="tel" autocomplete="tel" value="${esc(telBonito(C.telefono))}"></label>
      <label>Dirección <small>(para tus entregas)</small><input name="direccion" autocomplete="street-address" value="${esc(C.direccion || '')}"></label>
      <label>Correo <small>(opcional)</small><input name="email" type="email" autocomplete="email"></label>
      <p class="nota">Si ya pediste antes sin cuenta con este teléfono, verás esos pedidos en tu cuenta. El crédito lo autoriza el negocio.</p>
      <p class="msg" id="reg-msg"></p>
      <div class="pie"><button type="button" class="btn sec" id="reg-pedir">Pedir sin cuenta</button><button class="btn" type="submit">Crear cuenta y entrar</button></div>
    </form></div>`;
  enlazarPublico(P);
  $('#reg-pedir', P).onclick = () => abrirPublico('pedir');
  $('#reg-form', P).onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target, msg = $('#reg-msg', P);
    if (!navigator.onLine) { msg.textContent = 'Necesitas internet para crear tu cuenta.'; return; }
    const usuario = f.usuario.value.trim().toLowerCase(), password = f.password.value;
    try {
      const r = await conCarga('Creando tu cuenta…', () => api('registroCliente', { usuario, password, nombre: f.nombre.value.trim(),
        telefono: f.telefono.value, direccion: f.direccion.value.trim(), email: f.email.value.trim() }));
      await guardarCredencial(usuario, password, r.usuario, r.token);
      const ses = { token: r.token, usuario: r.usuario, offline: false };
      await DB.set('sesion', ses);
      await cargarSesion(ses);
      P.hidden = true;
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      S.vista = 'inicio';
      mostrarApp();
      await sincronizar();
      toast('¡Listo! Tu cuenta quedó creada.', 'ok');
    } catch (e) { msg.textContent = e.message; }
  };
}

/* ---- Portal con cuenta: mis datos y vencimientos ---- */
function avisoCredito(c) {
  if (!c || !c.credito) return '';
  const v = c.vencimientos || [];
  const vencidos = v.filter(x => x.dias < 0), pronto = v.filter(x => x.dias >= 0 && x.dias <= 7);
  if (vencidos.length) return `<div class="aviso-credito rojo"><b>Tienes ${plural(vencidos.length, 'pago')} vencido${vencidos.length === 1 ? '' : 's'} por ${dinero(vencidos.reduce((s, x) => s + x.saldo, 0))}.</b>
    Mientras no se liquide no puedes pedir a crédito; puedes pedir y pagar al recibir.</div>`;
  if (pronto.length) return `<div class="aviso-credito"><b>${pronto.length === 1 ? 'Un pago vence' : pronto.length + ' pagos vencen'} pronto:</b>
    ${pronto.map(x => `${dinero(x.saldo)} ${x.dias === 0 ? 'hoy' : `el ${fechaCorta(x.vence)} (${plural(x.dias, 'día')})`}`).join(' · ')}</div>`;
  return '';
}

function dlgMisDatos() {
  const c = S.cliente || {};
  const d = abrirModal('Mis datos', `<form id="fmd" class="form">
    <label>Nombre<input name="nombre" required value="${esc(c.nombre || '')}"></label>
    <label>Teléfono<input name="telefono" type="tel" required value="${esc(telBonito(c.telefono))}"></label>
    <label>Dirección de entrega<input name="direccion" value="${esc(c.direccion || '')}"></label>
    <label>Correo<input name="email" type="email" value="${esc(c.email || '')}"></label>
    <p class="msg" id="fmd-msg"></p>
    <div class="pie"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar</button></div></form>`);
  $('#fmd', d).onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await conCarga('Guardando…', () => api('guardarMisDatos', { nombre: f.nombre.value.trim(), telefono: f.telefono.value, direccion: f.direccion.value.trim(), email: f.email.value.trim() }));
      cerrarModal(); toast('Datos guardados.', 'ok'); sincronizar();
    } catch (e) { $('#fmd-msg', d).textContent = e.message; }
  };
}

/* ---------------- Avisos al cliente (notificaciones) ---------------- */
const permisoNotif = () => ('Notification' in window ? Notification.permission : 'no');
async function pedirPermisoNotif() {
  if (!('Notification' in window)) { toast('Este navegador no permite notificaciones. Instala la app o usa Chrome.', 'error'); return false; }
  const r = await Notification.requestPermission();
  if (r === 'granted') { toast('Listo: te avisaremos en este teléfono.', 'ok'); return true; }
  toast('No se activaron las notificaciones. Puedes permitirlas en el candado de la barra de direcciones.', '');
  return false;
}
async function mostrarNotificacion(titulo, cuerpo, url = './', tag = '') {
  if (permisoNotif() !== 'granted') return;
  const op = { body: cuerpo, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: tag || undefined, data: { url } };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.showNotification(titulo, op); return; }
  } catch (e) { /* sigue */ }
  try { new Notification(titulo, op); } catch (e) { /* sin notificaciones */ }
}
// Muestra como notificación del teléfono los avisos que aún no se han visto en este equipo
async function notificarNuevos(lista, clave, url) {
  if (!lista || !lista.length) return;
  const vistos = new Set((await DB.get(clave)) || []);
  const nuevos = lista.filter(a => !vistos.has(a.id));
  if (!nuevos.length) return;
  nuevos.slice(0, 3).reverse().forEach(a => mostrarNotificacion(a.titulo, a.mensaje, url, a.id));
  if (document.visibilityState === 'visible') nuevos.slice(0, 2).forEach(a => toast(a.titulo, 'ok'));
  lista.forEach(a => vistos.add(a.id));
  await DB.set(clave, [...vistos].slice(-300));
}
const iconoAviso = t => ({ PEDIDO: '📦', CREDITO: '💳', COBRANZA: '⏰', AUTOCOBRO: '🧾' })[t] || '🔔';

async function vAvisos(el) {
  el.innerHTML = `<div class="titulo"><h2>Avisos</h2>${permisoNotif() === 'granted' ? '' : '<button type="button" class="btn" id="av-perm">Activar notificaciones en este teléfono</button>'}</div><div id="av-lista"></div>`;
  const bp = $('#av-perm', el);
  if (bp) bp.onclick = async () => { if (await pedirPermisoNotif()) bp.remove(); };
  const c = $('#av-lista', el);
  const l = await pedir(c, 'Cargando avisos…', () => api('avisosCliente'));
  if (!l) return;
  c.innerHTML = l.length ? `<ul class="lista avisos">${l.map(a => `<li class="${a.leido ? '' : 'no-leido'}"><span class="av-ico">${iconoAviso(a.tipo)}</span>
      <span><b>${esc(a.titulo)}</b><small>${esc(a.mensaje)}</small><small class="nota">${fechaHora(a.creado)}</small></span></li>`).join('')}</ul>`
    : '<p class="vacio">Aquí verás cuándo se programa, sale o se entrega tu pedido, los cambios de tu crédito y tus vencimientos.</p>';
  if (l.some(a => !a.leido)) {
    api('leerAvisos').catch(() => {});
    if (S.avisosCliente) { S.avisosCliente.no_leidos = 0; S.avisosCliente.nuevos = []; DB.set('avisosCliente', S.avisosCliente); pintarMenu(); }
  }
  S.refrescar = null;
}

/* ---------------- Burbuja "Verificar precio" para el personal ---------------- */
const BP = { t: null };
const burbujaPrecioVisible = () => S.usuario && !['CLIENTE', 'VERIFICADOR'].includes(rol()) && !['caja', 'checador', 'verificador'].includes(S.vista)
  && !$('#pantalla-app').hidden && !(BP.oculta);
function iniciarBurbujaPrecio() {
  if ($('#burbuja-precio')) return;
  const b = document.createElement('button');
  b.id = 'burbuja-precio'; b.type = 'button'; b.className = 'burbuja-precio';
  b.title = 'Verificar un precio (F2)';
  b.innerHTML = '<span class="bp-ico">🏷️</span><span class="bp-txt">Verificar precio</span>';
  b.hidden = true;
  document.body.appendChild(b);
  b.onclick = abrirVerificarPrecio;
  const despertar = () => {
    if (b.hidden) return;
    b.classList.remove('dormida');
    clearTimeout(BP.t);
    BP.t = setTimeout(() => b.classList.add('dormida'), 5000);
  };
  ['mousemove', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, despertar, { passive: true }));
  let ultimoY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    b.classList.toggle('escondida', y > ultimoY + 4 && y > 200);   // se esconde al bajar, vuelve al subir
    if (y < ultimoY - 4) b.classList.remove('escondida');
    ultimoY = y;
  }, { passive: true });
  despertar();
}
function actualizarBurbujaPrecio() {
  const b = $('#burbuja-precio');
  if (b) b.hidden = !burbujaPrecioVisible();
}

function abrirVerificarPrecio() {
  const miAlm = S.usuario.almacen_id;
  const verCosto = !['CAJERO'].includes(rol());
  const d = abrirModal('Verificar precio', `<div class="form vp">
    <div class="vp-buscar"><div id="vp-sel"></div><button type="button" class="btn sec" id="vp-cam" title="Leer el código con la cámara">📷 Cámara</button></div>
    <div id="vp-camara"></div>
    <div id="vp-res"><p class="nota">Escanea el código con el lector, escríbelo o busca por nombre.</p></div>
  </div>`);
  let cam = null;
  const cerrarCam = () => { if (cam) { cam.detener(); cam = null; } $('#vp-camara', d).innerHTML = ''; };
  const pintar = p => {
    const res = $('#vp-res', d);
    if (!p) { res.innerHTML = ''; return; }
    const red = mapaRed();
    const mio = miAlm ? red[miAlm + '|' + p.id] || 0 : null;
    const total = almacenesActivos().reduce((s2, a) => s2 + (red[a.id + '|' + p.id] || 0), 0);
    const may = Number(p.precio_mayoreo) > 0 && Number(p.precio_mayoreo) < Number(p.precio_menudeo);
    res.innerHTML = `<div class="vp-prod">${p.imagen ? `<img data-img="${esc(p.imagen)}" alt="">` : ''}
      <div><h3>${esc(p.nombre)}</h3><p class="precio-grande">${dinero(p.precio_menudeo)}</p>
        ${may ? `<p>Mayoreo: <b>${dinero(p.precio_mayoreo)}</b></p>` : ''}
        ${verCosto && p.costo !== undefined ? `<p class="nota">Costo: ${dinero(p.costo)}${Number(p.precio_menudeo) > 0 ? ` · margen ${Math.round((1 - Number(p.costo) / Number(p.precio_menudeo)) * 100)}%` : ''}</p>` : ''}
        <p>${mio !== null ? `Aquí: <b>${numero(mio)}</b> ${esc(p.unidad || '')} · ` : ''}En todas: <b>${numero(total)}</b></p>
        <small>${esc(p.codigo || '')}${p.codigo_barras ? ' · ' + esc(p.codigo_barras) : ''}</small></div></div>
      <div class="pie"><button type="button" class="btn sec" id="vp-donde">¿Dónde hay?</button><button type="button" class="btn" data-cerrar>Listo</button></div>`;
    cargarImgs(res);
    $('#vp-donde', res).onclick = () => { cerrarCam(); dlgDondeHay(p); };
  };
  const sel = selectorProducto($('#vp-sel', d), p => { cerrarCam(); if (p) { pintar(p); sel.buscarOtro(); } });
  $('#vp-cam', d).onclick = async () => {
    if (cam) { cerrarCam(); return; }
    cam = await abrirCamara($('#vp-camara', d), { alLeer: cod => {
      cerrarCam();
      const p = buscarPorCodigo(cod);
      if (p) sel.elegir(p);
      else $('#vp-res', d).innerHTML = `<p class="txt-error">El código ${esc(cod)} no está en el catálogo.</p>`;
    } });
  };
  const vigilar = setInterval(() => { if (!d.open) { clearInterval(vigilar); cerrarCam(); } }, 500);
  setTimeout(() => { const q = $('.sel-q', d); if (q) q.focus(); }, 50);
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
  await cargarApariencia().catch(() => {});

  $('#form-login').addEventListener('submit', onLogin);
  $('#login-pedir').addEventListener('click', () => abrirPublico('pedir'));
  $('#login-registro').addEventListener('click', () => abrirPublico('registro'));
  $('#login-pub').hidden = CFG.PORTAL_PUBLICO === false;
  $('#menu').addEventListener('click', e => {
    const cab = e.target.closest('.menu-cab');
    if (cab) {
      const lista = cab.nextElementSibling, abrir = lista.hidden;
      $$('#menu .menu-lista').forEach(x => { x.hidden = true; x.previousElementSibling.setAttribute('aria-expanded', 'false'); });
      lista.hidden = !abrir; cab.setAttribute('aria-expanded', String(abrir));
      return;
    }
    const b = e.target.closest('[data-v]');
    if (!b) return;
    if (b.dataset.tab && typeof VT !== 'undefined') VT.pestana = b.dataset.tab;
    irA(b.dataset.v);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#menu')) $$('#menu .menu-lista').forEach(x => { x.hidden = true; }); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('#menu .menu-lista').forEach(x => { x.hidden = true; });
    if (e.key === 'F2' && S.usuario && burbujaPrecioVisible()) { e.preventDefault(); abrirVerificarPrecio(); }
  });
  iniciarBurbujaPrecio();
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
    if (e.key === 'F4' && S.vista === 'caja' && !$('#dlg').open) { e.preventDefault(); const b = $('#cj-nueva'); if (b) b.click(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.usuario && navigator.onLine &&
        Date.now() - S.ultimaSync > (rol() === 'CLIENTE' ? 2 : CFG.SYNC_MINUTOS) * 60000) sincronizar();
  });

  const ses = await DB.get('sesion');
  if (ses && ses.usuario) {
    await cargarSesion(ses);
    S.vista = vistaInicial();
    mostrarApp();
    if (navigator.onLine) sincronizar();
  } else if (/^#(pedir|registro)$/.test(location.hash) && CFG.PORTAL_PUBLICO !== false) {
    await abrirPublico(location.hash.slice(1));
  } else {
    mostrarLogin('', /^https?:\/\//.test(CFG.API_URL) ? '' : 'Falta configurar API_URL en config.js.');
  }
  ocultarCarga(true);

  setInterval(() => { if (S.usuario && navigator.onLine) sincronizar(); }, Math.max(1, Number(CFG.SYNC_MINUTOS) || 15) * 60000);
  setInterval(actualizarBarra, 30000);
}

document.addEventListener('DOMContentLoaded', iniciar);
