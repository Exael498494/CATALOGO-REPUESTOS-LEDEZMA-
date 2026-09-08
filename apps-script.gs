/**
 * NCS-CORPORATION-SRL — Backend de Apps Script para el catálogo y el admin.
 *
 * CAMBIOS PRINCIPALES respecto a la versión anterior (ver CAMBIOS.md para el detalle):
 *  1. FIX CRÍTICO: al editar un producto ya no se borran las columnas que el
 *     formulario del admin no envía (por ejemplo "svg"). Antes, cada edición
 *     reescribía la fila completa y ponía '' en cualquier columna no incluida
 *     en el payload -> esto causaba "cortes de información" reales en la hoja.
 *  2. Cache de 8 segundos para la lista pública (CacheService) que se invalida
 *     automáticamente apenas se guarda/oculta/borra un producto, así el
 *     catálogo se actualiza casi al instante sin sobrecargar la hoja con
 *     lecturas repetidas de cada visitante.
 *  3. LockService para evitar que dos guardados simultáneos pisen datos.
 *  4. Nuevas acciones: toggleActive (ocultar/mostrar sin borrar) y delete
 *     (borrar fila definitivamente), usadas por el nuevo admin.html.
 *  5. action=admin_list devuelve TODOS los productos (activos e inactivos)
 *     para que el panel admin pueda gestionar lo que está oculto. La acción
 *     "list" (la que usa el catálogo público) sigue mostrando solo activos.
 *  6. Token opcional de administrador (ADMIN_TOKEN) para proteger upsert /
 *     delete / toggleActive / uploadImage. Si lo dejas vacío, no se exige.
 */

const SHEET_NAME = 'Productos';
const DRIVE_FOLDER_ID = ''; // Opcional: pega aqui el ID de una carpeta de Drive para imagenes.

// Opcional pero recomendado: pon aqui una palabra/clave secreta y copia la
// misma clave en el campo "Token admin" de admin.html. Mientras esta
// constante esté vacía, cualquiera que tenga la URL del Apps Script podría
// editar el catálogo sin pasar por tu panel admin.
const ADMIN_TOKEN = '';

const CACHE_PREFIX = 'ncs_products_v2_';
const CACHE_TTL_SECONDS = 8; // tiempo que se reutiliza la lista publica antes de releer la hoja

// Clave usada en PropertiesService para guardar el tipo de cambio USD -> BOB
// que se edita desde el Admin y se muestra en el catalogo (recuadro "TC").
// No vive en la hoja de productos porque es un solo valor global, no una fila.
const TC_PROPERTY_KEY = 'tipo_cambio_usd_bob';

// ─── AUTOMATIZACIONES ────────────────────────────────────────────────────────
// Correo donde llegan las alertas de stock, el reporte diario y los avisos de
// pedidos nuevos. Cambialo si quieres recibirlos en otra cuenta.
const NOTIFY_EMAIL = 'villegasmejia321@gmail.com';

// Un producto se considera "stock bajo" cuando cantidad_stock <= este numero.
const LOW_STOCK_THRESHOLD = 5;

// Carpeta de Drive donde se guardan los respaldos diarios (se crea sola) y
// cuantos dias de respaldos conservar antes de borrar los mas viejos.
const BACKUP_FOLDER_NAME = 'Respaldos - Catalogo NCS';
const BACKUP_KEEP_DAYS = 30;

// Hoja donde se registran los pedidos que los clientes envian por WhatsApp.
const ORDERS_SHEET_NAME = 'Pedidos';

// Esquema simplificado a pedido del cliente. Solo estos campos se guardan y se
// muestran. id/activo/updated_at son internos (no aparecen en el formulario
// pero el sistema los necesita para identificar, ocultar y fechar la fila).
const HEADERS = [
  'id',
  'activo',
  'oem',
  'alterno',
  'origen',
  'marca',
  'descripcion',
  'categoria',
  'medida',
  'precio',
  'moneda',
  'cantidad_stock',
  'imagen_url',
  'updated_at'
];

function doGet(e) {
  e = e || {};
  const params = e.parameter || {};
  const action = (params.action || 'list').toLowerCase();
  if (action === 'setup') return jsonResponse(setupSheet_());
  if (action === 'admin_list') return jsonResponse({ products: listProducts_(true), tipo_cambio: getTipoCambio_() });
  return jsonResponse({ products: listProducts_(false), generated_at: new Date().toISOString(), tipo_cambio: getTipoCambio_() });
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    const action = String(body.action || '').toLowerCase();

    if (['uploadimage', 'upsert', 'delete', 'toggleactive', 'settipocambio'].indexOf(action) !== -1) {
      checkToken_(body);
    }

    if (action === 'uploadimage') return jsonResponse(uploadImage_(body));
    if (action === 'upsert') return jsonResponse(upsertProduct_(body.product || body));
    if (action === 'delete') return jsonResponse(deleteProduct_(body.id));
    if (action === 'toggleactive') return jsonResponse(toggleActive_(body.id, body.activo));
    if (action === 'settipocambio') return jsonResponse(setTipoCambio_(body.valor));
    // Accion publica (sin token): el catalogo registra el pedido del cliente
    // justo antes de abrir WhatsApp, para que quede constancia en la hoja.
    if (action === 'registrarpedido') return jsonResponse(registrarPedido_(body));

    return jsonResponse({ ok: false, error: 'Accion no soportada.' });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message || String(error) });
  }
}

function checkToken_(body) {
  if (!ADMIN_TOKEN) return; // sin token configurado = sin verificacion
  if (String(body.token || '') !== ADMIN_TOKEN) {
    throw new Error('Token de administrador invalido o ausente.');
  }
}

/** Lee el tipo de cambio guardado. Devuelve null si nunca se configuro. */
function getTipoCambio_() {
  const raw = PropertiesService.getScriptProperties().getProperty(TC_PROPERTY_KEY);
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
}

/** Guarda el tipo de cambio (protegido por ADMIN_TOKEN, igual que upsert/delete). */
function setTipoCambio_(valor) {
  const value = Number(valor);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Tipo de cambio invalido.');
  }
  PropertiesService.getScriptProperties().setProperty(TC_PROPERTY_KEY, String(value));
  return { ok: true, tipo_cambio: value };
}

function setupSheet_() {
  const sheet = getSheet_();
  const currentHeaders = sheet.getLastRow()
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length)).getValues()[0]
    : [];

  if (!currentHeaders.filter(Boolean).length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    const missingHeaders = HEADERS.filter(header => currentHeaders.indexOf(header) === -1);
    if (missingHeaders.length) {
      sheet
        .getRange(1, currentHeaders.length + 1, 1, missingHeaders.length)
        .setValues([missingHeaders]);
    }
  }

  return { ok: true, headers: HEADERS };
}

/**
 * Devuelve la lista de productos. Si includeInactive es false (catálogo
 * público) se usa un cache corto para que muchas visitas simultáneas no
 * generen una lectura de la hoja por cada una. El cache se invalida solo
 * (invalidateCache_) en cuanto se guarda, oculta o borra un producto, asi
 * que un cambio del admin llega al catálogo en segundos, no en minutos.
 */
function listProducts_(includeInactive) {
  const cache = CacheService.getScriptCache();
  const cacheKey = CACHE_PREFIX + (includeInactive ? 'all' : 'active');

  if (!includeInactive) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const sheet = getSheet_();
  setupSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values.shift().map(String);
  let rows = values
    .filter(row => row.some(Boolean))
    .map(row => rowToObject_(headers, row));

  if (!includeInactive) {
    rows = rows.filter(product => String(product.activo || 'SI').toUpperCase() !== 'NO');
    cache.put(cacheKey, JSON.stringify(rows), CACHE_TTL_SECONDS);
  }

  return rows;
}

function invalidateCache_() {
  const cache = CacheService.getScriptCache();
  cache.remove(CACHE_PREFIX + 'active');
  cache.remove(CACHE_PREFIX + 'all');
}

/** Ejecuta fn() con un lock de hoja para evitar que dos guardados a la vez se pisen. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    throw new Error('El sistema esta ocupado procesando otro cambio. Intenta de nuevo en unos segundos.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function upsertProduct_(product) {
  return withLock_(() => {
    const sheet = getSheet_();
    setupSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const idIndex = headers.indexOf('id');
    const id = String(product.id || product.oem || Utilities.getUuid()).trim();
    if (!id) throw new Error('Falta el codigo OEM del producto.');
    product.id = id;
    product.updated_at = new Date();

    let targetRow = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIndex]) === id) {
        targetRow = i + 1;
        break;
      }
    }

    let row;
    if (targetRow > 0) {
      // FIX: antes esto era headers.map(h => product[h] ?? '') sin condicion,
      // lo que borraba cualquier columna que el admin no conociera (ej. "svg").
      // Ahora: si el admin envia la columna (aunque sea como '' a proposito),
      // se respeta su valor. Si la columna NO viene en el payload, se
      // conserva lo que ya habia en la hoja.
      const existingRow = values[targetRow - 1];
      row = headers.map((header, i) => {
        if (Object.prototype.hasOwnProperty.call(product, header)) {
          return product[header] ?? '';
        }
        return existingRow[i] ?? '';
      });
      sheet.getRange(targetRow, 1, 1, headers.length).setValues([row]);
    } else {
      row = headers.map(header => product[header] ?? '');
      sheet.appendRow(row);
    }

    invalidateCache_();
    return { ok: true, id };
  });
}

function deleteProduct_(id) {
  return withLock_(() => {
    const targetId = String(id || '').trim();
    if (!targetId) throw new Error('Falta id del producto a eliminar.');

    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const idIndex = headers.indexOf('id');

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIndex]) === targetId) {
        sheet.deleteRow(i + 1);
        invalidateCache_();
        return { ok: true, id: targetId };
      }
    }
    throw new Error('No se encontro un producto con ese id.');
  });
}

/** Oculta o muestra un producto sin borrar la fila (columna "activo" = SI/NO). */
function toggleActive_(id, forcedValue) {
  return withLock_(() => {
    const targetId = String(id || '').trim();
    if (!targetId) throw new Error('Falta id del producto.');

    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const idIndex = headers.indexOf('id');
    const activoIndex = headers.indexOf('activo');

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIndex]) === targetId) {
        const current = String(values[i][activoIndex] || 'SI').toUpperCase();
        const next = forcedValue ? String(forcedValue).toUpperCase() : (current === 'NO' ? 'SI' : 'NO');
        sheet.getRange(i + 1, activoIndex + 1).setValue(next);
        invalidateCache_();
        return { ok: true, id: targetId, activo: next };
      }
    }
    throw new Error('No se encontro un producto con ese id.');
  });
}

function uploadImage_(body) {
  if (!body.dataUrl) throw new Error('Falta dataUrl.');

  const matches = String(body.dataUrl).match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('Formato de imagen invalido.');

  const mimeType = body.mimeType || matches[1];
  const extension = mimeType.split('/').pop() || 'png';
  const filename = body.filename || `producto-${Date.now()}.${extension}`;
  const bytes = Utilities.base64Decode(matches[2]);
  const blob = Utilities.newBlob(bytes, mimeType, filename);
  const folder = DRIVE_FOLDER_ID ? DriveApp.getFolderById(DRIVE_FOLDER_ID) : DriveApp.getRootFolder();
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (error) {
    throw new Error('La imagen se subio a Drive, pero no se pudo hacer publica. Revisa permisos de uso compartido en Drive.');
  }

  const fileId = file.getId();
  return {
    ok: true,
    fileId: fileId,
    // Formato thumbnail: es el mas estable hoy para <img> en sitios externos.
    // El catalogo y el admin igual generan variantes de respaldo a partir del
    // fileId por si Google bloquea temporalmente un host concreto.
    url: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`
  };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function rowToObject_(headers, row) {
  return headers.reduce((obj, header, index) => {
    let value = row[index];
    if (value instanceof Date) value = value.toISOString();
    obj[header] = value;
    return obj;
  }, {});
}

function parseBody_(e) {
  if (!e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error('JSON invalido recibido por Apps Script.');
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATIZACIONES
//
// COMO ACTIVARLAS (una sola vez):
//   1. En el editor de Apps Script, arriba elige la funcion
//      "instalarAutomatizaciones" y pulsa ▶ Ejecutar.
//   2. Google pedira autorizacion (correo + Drive). Acepta.
//   3. Listo. Desde ese momento corren solas:
//        - Alerta de stock bajo ...... cada 1 hora (solo avisa si hay novedades)
//        - Reporte diario ............ todos los dias a las 07:00
//        - Respaldo automatico ....... todos los dias a las 02:00
//   Para desactivarlas: ejecuta "desinstalarAutomatizaciones".
// ═════════════════════════════════════════════════════════════════════════════

const TRIGGER_HANDLERS = ['alertaStockBajo', 'reporteDiario', 'respaldoDiario'];

function instalarAutomatizaciones() {
  desinstalarAutomatizaciones();

  ScriptApp.newTrigger('alertaStockBajo').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('reporteDiario').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('respaldoDiario').timeBased().everyDays(1).atHour(2).create();

  Logger.log('Automatizaciones instaladas. Avisos a: ' + NOTIFY_EMAIL);
  return { ok: true, email: NOTIFY_EMAIL };
}

function desinstalarAutomatizaciones() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ─── 1. ALERTA DE STOCK BAJO (cada hora) ─────────────────────────────────────
// Revisa la hoja y avisa por correo SOLO cuando un producto entra en zona de
// stock bajo (<= LOW_STOCK_THRESHOLD) o se agota. Recuerda lo ya avisado en
// ScriptProperties para no repetir el mismo correo cada hora; si repones el
// stock, el producto sale de la lista y volvera a avisar si baja de nuevo.
function alertaStockBajo() {
  const products = listProducts_(true).filter(p =>
    String(p.activo || 'SI').toUpperCase() !== 'NO' && p.cantidad_stock !== ''
  );

  const props = PropertiesService.getScriptProperties();
  const notified = JSON.parse(props.getProperty('stock_bajo_notificados') || '{}');
  const lowNow = {};
  const newlyLow = [];

  products.forEach(p => {
    const qty = Number(p.cantidad_stock);
    if (isNaN(qty) || qty > LOW_STOCK_THRESHOLD) return;
    lowNow[p.id] = qty;
    // avisa si es nuevo en la lista, o si desde el ultimo aviso se agoto
    if (!(p.id in notified) || (qty <= 0 && notified[p.id] > 0)) {
      newlyLow.push(p);
    }
  });

  props.setProperty('stock_bajo_notificados', JSON.stringify(lowNow));
  if (!newlyLow.length) return;

  const filas = newlyLow.map(p => {
    const qty = Number(p.cantidad_stock);
    const estado = qty <= 0 ? '🔴 AGOTADO' : `🟡 quedan ${qty}`;
    return `<tr><td style="padding:6px 12px;border:1px solid #ddd;">${p.oem || p.id}</td>` +
      `<td style="padding:6px 12px;border:1px solid #ddd;">${p.descripcion || ''}</td>` +
      `<td style="padding:6px 12px;border:1px solid #ddd;">${p.marca || ''}</td>` +
      `<td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold;">${estado}</td></tr>`;
  }).join('');

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: `⚠️ Stock bajo: ${newlyLow.length} producto(s) por reponer`,
    htmlBody:
      `<p>Estos productos entraron en zona de stock bajo (≤ ${LOW_STOCK_THRESHOLD} unidades):</p>` +
      `<table style="border-collapse:collapse;">` +
      `<tr><th style="padding:6px 12px;border:1px solid #ddd;">OEM</th>` +
      `<th style="padding:6px 12px;border:1px solid #ddd;">Descripcion</th>` +
      `<th style="padding:6px 12px;border:1px solid #ddd;">Marca</th>` +
      `<th style="padding:6px 12px;border:1px solid #ddd;">Stock</th></tr>` +
      filas + `</table>` +
      `<p style="color:#888;">Aviso automatico del catalogo. No volvera a avisar por estos productos hasta que repongas su stock.</p>`
  });
}

// ─── 2. REPORTE DIARIO (07:00) ───────────────────────────────────────────────
function reporteDiario() {
  const all = listProducts_(true);
  const activos = all.filter(p => String(p.activo || 'SI').toUpperCase() !== 'NO');
  const ocultos = all.length - activos.length;

  let valorInventario = 0;
  let unidades = 0;
  const bajos = [];
  activos.forEach(p => {
    const qty = Number(p.cantidad_stock);
    const precio = Number(p.precio);
    if (!isNaN(qty)) {
      unidades += qty;
      if (!isNaN(precio)) valorInventario += qty * precio;
      if (qty <= LOW_STOCK_THRESHOLD) bajos.push(p);
    }
  });

  const hace24h = Date.now() - 24 * 60 * 60 * 1000;
  const modificados = all.filter(p => {
    const t = new Date(p.updated_at || 0).getTime();
    return t > hace24h;
  });

  const fmtBob = n => n.toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const listaBajos = bajos.length
    ? '<ul>' + bajos.map(p =>
        `<li>${p.oem || p.id} — ${p.descripcion || ''} (${Number(p.cantidad_stock)} uds.)</li>`).join('') + '</ul>'
    : '<p>✅ Ningun producto con stock bajo.</p>';
  const listaModificados = modificados.length
    ? '<ul>' + modificados.map(p =>
        `<li>${p.oem || p.id} — ${p.descripcion || ''}</li>`).join('') + '</ul>'
    : '<p>Sin cambios en las ultimas 24 horas.</p>';

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: `📋 Reporte diario del catalogo — ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy')}`,
    htmlBody:
      `<h2>Resumen del catalogo</h2>` +
      `<ul>` +
      `<li><b>Productos visibles en la web:</b> ${activos.length}</li>` +
      `<li><b>Productos ocultos:</b> ${ocultos}</li>` +
      `<li><b>Unidades totales en stock:</b> ${unidades}</li>` +
      `<li><b>Valor del inventario:</b> ${fmtBob(valorInventario)} BOB</li>` +
      `</ul>` +
      `<h3>⚠️ Stock bajo (≤ ${LOW_STOCK_THRESHOLD} uds.)</h3>` + listaBajos +
      `<h3>✏️ Modificados en las ultimas 24 h</h3>` + listaModificados +
      `<p style="color:#888;">Reporte automatico diario del catalogo NCS.</p>`
  });
}

// ─── 3. RESPALDO AUTOMATICO (02:00) ──────────────────────────────────────────
// Copia completa de la hoja de calculo a una carpeta "Respaldos" de tu Drive,
// con la fecha en el nombre. Borra automaticamente los respaldos con mas de
// BACKUP_KEEP_DAYS dias para no llenar tu Drive.
function respaldoDiario() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const original = DriveApp.getFileById(ss.getId());

  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER_NAME);

  const fecha = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  original.makeCopy(`Respaldo ${fecha} — ${ss.getName()}`, folder);

  // limpieza de respaldos viejos
  const limite = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().indexOf('Respaldo ') === 0 && f.getDateCreated().getTime() < limite) {
      f.setTrashed(true);
    }
  }
}

// ─── 4. REGISTRO DE PEDIDOS (llamado por el catalogo) ────────────────────────
// Cada vez que un cliente pulsa "Enviar Pedido por WhatsApp", el catalogo manda
// aqui el contenido del carrito. Se guarda una fila en la hoja "Pedidos" y te
// llega un correo con el detalle, aunque el cliente luego no complete el envio
// del mensaje de WhatsApp.
function registrarPedido_(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new Error('Pedido vacio.');

  const detalle = items.map(it =>
    `${Number(it.cantidad) || 1}x ${String(it.oem || '')} ${String(it.name || '')}`.trim()
  ).join(' | ');
  const total = Number(body.total) || 0;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ORDERS_SHEET_NAME) || ss.insertSheet(ORDERS_SHEET_NAME);
  if (!sheet.getLastRow()) {
    sheet.getRange(1, 1, 1, 4).setValues([['fecha', 'items', 'total_bob', 'detalle']]);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), items.length, total, detalle]);

  try {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: `🛒 Nuevo pedido desde el catalogo — ${total.toLocaleString('es-BO')} BOB`,
      htmlBody:
        `<p>Un cliente armo este pedido y esta por enviartelo por WhatsApp:</p>` +
        `<ul>` + items.map(it =>
          `<li>${Number(it.cantidad) || 1} x <b>${String(it.oem || '')}</b> ${String(it.name || '')} — ${Number(it.price) || 0} BOB c/u</li>`
        ).join('') + `</ul>` +
        `<p><b>Total: ${total.toLocaleString('es-BO')} BOB</b></p>` +
        `<p style="color:#888;">El pedido quedo registrado en la pestaña "${ORDERS_SHEET_NAME}" de tu hoja.</p>`
    });
  } catch (error) {
    // si falla el correo (cuota diaria agotada, etc.) el pedido igual queda en la hoja
  }

  return { ok: true };
}
