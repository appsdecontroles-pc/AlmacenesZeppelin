'use strict';
/* Lectura y escritura de Excel (.xlsx) y CSV sin librerías externas.
 * Un .xlsx es un archivo ZIP con hojas en XML. */

const Excel = (() => {
  /* ---------- CRC32 y ZIP (escritura, sin compresión) ---------- */
  const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function crearZip(archivos) {
    const enc = new TextEncoder();
    const partes = [], central = [];
    let offset = 0;
    const d = new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    archivos.forEach(({ nombre, contenido }) => {
      const nom = enc.encode(nombre);
      const datos = typeof contenido === 'string' ? enc.encode(contenido) : contenido;
      const crc = crc32(datos);
      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true);
      loc.setUint16(4, 20, true);
      loc.setUint16(6, 0x0800, true);
      loc.setUint16(8, 0, true);
      loc.setUint16(10, hora, true);
      loc.setUint16(12, fecha, true);
      loc.setUint32(14, crc, true);
      loc.setUint32(18, datos.length, true);
      loc.setUint32(22, datos.length, true);
      loc.setUint16(26, nom.length, true);
      loc.setUint16(28, 0, true);
      partes.push(new Uint8Array(loc.buffer), nom, datos);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, hora, true);
      cen.setUint16(14, fecha, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, datos.length, true);
      cen.setUint32(24, datos.length, true);
      cen.setUint16(28, nom.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nom);
      offset += 30 + nom.length + datos.length;
    });
    const tamCentral = central.reduce((s, p) => s + p.length, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true);
    fin.setUint16(8, archivos.length, true);
    fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tamCentral, true);
    fin.setUint32(16, offset, true);
    return new Blob([...partes, ...central, new Uint8Array(fin.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------- ZIP (lectura) ---------- */
  async function leerZip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('El archivo no es un Excel válido (.xlsx).');
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entradas = {};
    for (let n = 0; n < total; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const metodo = dv.getUint16(p + 10, true);
      const tam = dv.getUint32(p + 20, true);
      const lnom = dv.getUint16(p + 28, true);
      const lext = dv.getUint16(p + 30, true);
      const lcom = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const nombre = dec.decode(new Uint8Array(buf, p + 46, lnom));
      entradas[nombre] = { metodo, tam, local };
      p += 46 + lnom + lext + lcom;
    }
    return {
      existe: n => !!entradas[n],
      async texto(nombre) {
        const e = entradas[nombre];
        if (!e) return null;
        const inicio = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
        const datos = new Uint8Array(buf, inicio, e.tam);
        if (e.metodo === 0) return dec.decode(datos);
        if (e.metodo !== 8) throw new Error('Formato de compresión no compatible.');
        if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede leer Excel. Usa Chrome o Edge actualizados, o guarda el archivo como CSV.');
        const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(flujo).text();
      }
    };
  }

  const xml = t => new DOMParser().parseFromString(t, 'application/xml');
  const tags = (nodo, nombre) => Array.from(nodo.getElementsByTagNameNS('*', nombre));

  function colANum(ref) {
    const letras = ref.replace(/[0-9]/g, '');
    let n = 0;
    for (let i = 0; i < letras.length; i++) n = n * 26 + (letras.charCodeAt(i) - 64);
    return n - 1;
  }

  // Devuelve una lista de filas (arreglos de celdas) de la hoja preferida
  async function leerXlsx(buf, hojaPreferida) {
    const zip = await leerZip(buf);
    const wbTxt = await zip.texto('xl/workbook.xml');
    if (!wbTxt) throw new Error('El archivo no es un Excel válido (.xlsx).');
    const wb = xml(wbTxt);
    const hojas = tags(wb, 'sheet').map(h => ({
      nombre: h.getAttribute('name'),
      rid: h.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || h.getAttribute('r:id')
    }));
    if (!hojas.length) throw new Error('El Excel no tiene hojas.');
    const rels = xml(await zip.texto('xl/_rels/workbook.xml.rels') || '<x/>');
    const destinos = {};
    tags(rels, 'Relationship').forEach(r => { destinos[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const hoja = hojas.find(h => h.nombre && h.nombre.toLowerCase() === String(hojaPreferida || '').toLowerCase()) || hojas[0];
    let ruta = destinos[hoja.rid] || 'worksheets/sheet1.xml';
    ruta = ruta.startsWith('/') ? ruta.slice(1) : 'xl/' + ruta.replace(/^\.\//, '');

    const compartidos = [];
    const ssTxt = await zip.texto('xl/sharedStrings.xml');
    if (ssTxt) tags(xml(ssTxt), 'si').forEach(si => compartidos.push(tags(si, 't').map(t => t.textContent).join('')));

    const hojaTxt = await zip.texto(ruta);
    if (!hojaTxt) throw new Error('No se pudo leer la hoja ' + hoja.nombre + '.');
    const filas = [];
    tags(xml(hojaTxt), 'row').forEach((row, i) => {
      const numFila = Number(row.getAttribute('r')) || i + 1;
      const fila = [];
      let col = 0;
      tags(row, 'c').forEach(c => {
        const ref = c.getAttribute('r');
        if (ref) col = colANum(ref);
        const t = c.getAttribute('t');
        const v = tags(c, 'v')[0];
        let valor = '';
        if (t === 's') valor = compartidos[Number(v && v.textContent)] ?? '';
        else if (t === 'inlineStr') valor = tags(c, 't').map(x => x.textContent).join('');
        else if (t === 'b') valor = v ? v.textContent === '1' : '';
        else if (t === 'str' || t === 'e') valor = v ? v.textContent : '';
        else if (v) { const n = Number(v.textContent); valor = isNaN(n) ? v.textContent : n; }
        fila[col] = valor;
        col++;
      });
      filas[numFila - 1] = fila;
    });
    return Array.from(filas, f => Array.from(f || [], v => (v === undefined ? '' : v)));
  }

  /* ---------- CSV ---------- */
  function leerCsv(buf) {
    let texto = new TextDecoder('utf-8').decode(buf);
    if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(buf);
    texto = texto.replace(/^﻿/, '');
    const primera = texto.split(/\r?\n/)[0] || '';
    const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
    const filas = [];
    let fila = [], campo = '', comillas = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (comillas) {
        if (ch === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
        } else campo += ch;
      } else if (ch === '"') comillas = true;
      else if (ch === sep) { fila.push(campo); campo = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && texto[i + 1] === '\n') i++;
        fila.push(campo); filas.push(fila); fila = []; campo = '';
      } else campo += ch;
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }

  async function leerArchivo(archivo, hojaPreferida) {
    const buf = await archivo.arrayBuffer();
    const nombre = archivo.name.toLowerCase();
    if (nombre.endsWith('.csv') || nombre.endsWith('.txt')) return leerCsv(buf);
    if (nombre.endsWith('.xls')) throw new Error('El formato .xls antiguo no es compatible. En Excel usa "Guardar como" > Libro de Excel (.xlsx).');
    return leerXlsx(buf, hojaPreferida);
  }

  /* ---------- Escritura de .xlsx ---------- */
  const escXml = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function letraCol(i) {
    let s = '';
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  // hojas: [{ nombre, filas: [[...]], anchos: [n], columnasTexto: [i], encabezado: true }]
  function hojaXml(h) {
    const cols = (h.anchos || []).map((w, i) => {
      const estilo = (h.columnasTexto || []).includes(i) ? ' style="2"' : '';
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${estilo}/>`;
    }).join('');
    const filas = h.filas.map((fila, r) => `<row r="${r + 1}">${fila.map((v, c) => {
      if (v === '' || v === null || v === undefined) return '';
      const ref = letraCol(c) + (r + 1);
      const s = r === 0 && h.encabezado ? 1 : ((h.columnasTexto || []).includes(c) ? 2 : (h.ajustar ? 3 : 0));
      if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const congelar = h.encabezado
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${congelar}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${filas}</sheetData></worksheet>`;
  }

  function crearXlsx(hojas) {
    const ns = 'http://schemas.openxmlformats.org/';
    const archivos = [
      { nombre: '[Content_Types].xml', contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((h, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { nombre: '_rels/.rels', contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { nombre: 'xl/workbook.xml', contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${escXml(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { nombre: 'xl/_rels/workbook.xml.rels', contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${ns}package/2006/relationships">${hojas.map((h, i) => `<Relationship Id="rId${i + 1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${hojas.length + 1}" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { nombre: 'xl/styles.xml', contenido: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${ns}spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` }
    ];
    hojas.forEach((h, i) => archivos.push({ nombre: `xl/worksheets/sheet${i + 1}.xml`, contenido: hojaXml(h) }));
    return crearZip(archivos);
  }

  function descargar(blob, nombre) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  return { leerArchivo, leerXlsx, leerCsv, crearXlsx, descargar };
})();
