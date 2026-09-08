# Qué cambié y por qué — NCS-CORPORATION-SRL

Revisé los 3 archivos (`apps-script.gs`, `catalogo.html`, `admin.html`) de punta a
punta. Encontré **dos bugs reales** que explican los "cortes de información"
que mencionas, además de varias mejoras de velocidad y robustez. Abajo el
detalle, de más grave a menos grave.

## 🔴 Bug 1 (el más grave): editar un producto borraba datos

En `apps-script.gs`, la función que guarda un producto (`upsertProduct_`)
reescribía **toda la fila** cada vez que guardabas, y rellenaba con vacío
cualquier columna que el formulario del Admin no conociera (por ejemplo
`svg`). Resultado: si esa columna tenía algo escrito a mano en la hoja, una
simple edición desde el Admin la borraba sin avisar.

**Arreglado:** ahora solo se sobrescriben las columnas que el Admin realmente
envía. Las que no conoce se conservan tal cual estaban.

## 🔴 Bug 2 (el que probablemente más te afectaba): productos "invisibles" en el catálogo

En `catalogo.html` había un filtro oculto:

```js
const ALLOWED_CATEGORIES = ['correas', 'juntas'];
```

Cualquier producto con una `categoria` distinta de "correas" o "juntas" se
descargaba de la hoja... y se descartaba en silencio antes de mostrarse. Si
alguna vez agregaste un producto con categoría "frenos", "motor", "filtros",
etc., **nunca apareció en la web**, aunque estuviera perfecto en la hoja.

**Arreglado:** ese filtro ya no existe. Ahora se muestra cualquier producto
activo, sin importar su categoría. Como consecuencia, también hice que los
botones de filtro (Todos / Correas / Juntas / Bomba...) se generen
**automáticamente** según las categorías que realmente existan en tu hoja —
si escribes una categoría nueva en el Admin, su botón de filtro aparece solo
en el catálogo, sin tocar código.

## 🟡 Conectividad admin ↔ catálogo: más rápida y sin "cortes" visuales

- El catálogo pasó de revisar la hoja cada **15 segundos** a cada **6
  segundos**, y además se actualiza al instante si vuelves a la pestaña del
  navegador, o si tocas el nuevo botón "⟳ Actualizar" que agregué junto al
  contador de productos.
- Agregué un caché corto (8 segundos) en Apps Script que se borra
  automáticamente apenas guardas/ocultas/borras un producto. Esto evita que
  cientos de visitas simultáneas golpeen la hoja de cálculo a la vez, sin
  sacrificar velocidad de actualización.
- Agregué un `LockService` para que si guardas dos productos casi al mismo
  tiempo (o usas el Admin desde dos celulares a la vez), no se pisen los
  cambios entre sí.
- Si por algún motivo Apps Script no responde (caída momentánea, URL mal
  pegada, etc.), antes el catálogo se quedaba **vacío**. Ahora, en ese caso
  puntual, se muestra un catálogo de respaldo de muestra con un aviso claro,
  en vez de una página rota. En cuanto la hoja vuelve a responder, se
  reemplaza solo.
- Si una imagen subida falla al cargar (a veces pasa con enlaces de Drive),
  ahora se ve el ícono de la categoría en vez del típico ícono de "imagen
  rota".

## 🟢 Nuevo: el Admin ahora controla de verdad qué se ve en el catálogo

- Antes, el Admin y el catálogo público usaban la misma lista — si ocultabas
  un producto (`activo = NO`) directamente en la hoja, **también
  desaparecía del panel Admin**, así que no podías volver a mostrarlo sin
  editar la hoja a mano.
- Ahora el Admin tiene su propia vista (`action=admin_list`) que muestra
  **todos** los productos, incluidos los ocultos, marcados con una etiqueta
  gris "OCULTO".
- Agregué dos botones por producto en el Admin:
  - **Ocultar / Mostrar** — oculta o vuelve a mostrar el producto en la web
    sin borrar nada de la hoja.
  - **Eliminar** — borra la fila definitivamente (con confirmación).

## 🟢 Seguridad opcional (no rompe nada si no la usas)

Agregué un campo opcional `ADMIN_TOKEN` en `apps-script.gs` y un campo
"Token admin" en `admin.html`. Hoy en día, cualquiera que tenga la URL del
Apps Script podría editar tu catálogo sin pasar por tu panel — si más
adelante quieres cerrar esa puerta, escribe cualquier palabra secreta en
`ADMIN_TOKEN` (dentro del script) y pega la misma palabra en el campo
"Token admin" del Admin. Si lo dejas vacío, todo sigue funcionando igual
que antes.

## Limpieza de código

`catalogo.html` tenía **4 funciones duplicadas** (`renderProducts`,
`openModal`, `agregarAlCarrito`, `cambiarCantidad`): una versión vieja que
quedaba "muerta" porque una versión más nueva, más abajo en el archivo, la
sobrescribía. No causaba bugs visibles, pero hacía el archivo más pesado y
peligroso de mantener (cualquiera que editara la versión equivocada por
error perdía tiempo). Las quité y dejé solo la versión que realmente se
usa.

---

## Cómo aplicar estos cambios (importante)

1. **Apps Script:** abre tu proyecto de Apps Script (el de tu Google Sheet),
   reemplaza todo el contenido del archivo `.gs` por el nuevo
   `apps-script.gs`, guarda, y luego ve a **Implementar → Gestionar
   implementaciones → ✏️ Editar → Nueva versión → Implementar**. Es
   importante usar "Nueva versión" sobre la implementación que ya
   tienes, y NO crear una implementación nueva desde cero, así la URL
   `.../exec` que ya está pegada en `catalogo.html` y guardada en el
   Admin sigue funcionando sin que tengas que actualizarla en todos
   lados.
2. **catalogo.html:** sube el archivo nuevo reemplazando el actual donde
   tengas alojada tu web. La URL de Apps Script ya viene incluida igual
   que antes.
3. **admin.html:** sube el archivo nuevo. La URL y el token (si configuras
   uno) se guardan en el navegador igual que antes, no tienes que
   volver a escribir nada salvo el token si decides usarlo.
4. Abre el Admin, guarda cualquier producto de prueba con una categoría que
   antes no usabas (por ejemplo "frenos") y confirma que aparece en el
   catálogo en pocos segundos.

---

## Ronda de conectividad (Admin ↔ Apps Script ↔ Drive ↔ Catálogo)

Revisé toda la cadena y corregí los puntos donde se rompía:

### 🔴 Bug crítico: el catálogo no conectaba porque faltaba `CONFIG`
En una edición anterior se eliminó por accidente el objeto `CONFIG` del
catálogo (vivía junto a un bloque de SVGs que se borró). Sin él,
`CONFIG.SHEETS_API_URL` lanzaba error y el script moría antes de pedir nada a
la hoja. **Restaurado**, y ahora la URL es editable/persistente: si la pegas
en el panel Admin, el catálogo (en el mismo dominio) la toma solo.

### 🔴 CORS / preflight en el Admin
El `fetch` POST enviaba JSON con cabecera `application/json`, lo que hace que
el navegador mande primero una petición `OPTIONS` (preflight) que Apps Script
no sabe responder → la petición se bloqueaba ("no conecta"). **Arreglado:**
ahora el POST va como `text/plain`, que no dispara preflight; el backend igual
lee el cuerpo como JSON. Es la causa #1 de fallos de conexión con Apps Script.

### 🟡 Imágenes de Drive
- Unifiqué la lógica en Admin y Catálogo: cualquier formato de enlace de Drive
  (`/file/d/ID/view`, `?id=ID`, `open?id=ID`, `lh3...`, `uc?export`) se
  reconoce y se convierte al formato `thumbnail` que es el más estable hoy.
- El catálogo mantiene una **cascada de respaldo**: si un host de Drive falla,
  prueba los otros automáticamente y, si todos fallan, muestra un ícono en vez
  de "imagen rota".
- El backend ahora devuelve la imagen subida también en formato `thumbnail`.

### 🟡 Robustez del backend
- `doGet` ya no se rompe si llega sin parámetros.
- Mensajes de error más claros en el Admin (sin internet, URL mal pegada,
  implementación no pública, etc.).

> Recordatorio al desplegar el `.gs`: usa **Implementar → Gestionar
> implementaciones → Editar → Nueva versión**, con acceso **"Cualquier
> usuario"**, para que la URL `/exec` no cambie.

---

# 🤖 Automatizaciones de la empresa (nuevo)

Se agregaron 4 automatizaciones al negocio. Todas viven en `apps-script.gs`
(junto a tu Google Sheet) y funcionan solas una vez activadas.

## 1. ⚠️ Alerta de stock bajo (cada hora)
El sistema revisa tu hoja cada hora. Cuando un producto activo baja a
**5 unidades o menos** (configurable en `LOW_STOCK_THRESHOLD`), te llega un
correo con la tabla de productos por reponer. Para no llenarte el buzón,
**no repite el aviso** del mismo producto: solo avisa cuando un producto
*entra* en zona de stock bajo o cuando pasa de "quedan pocas" a "agotado".
Si repones stock y vuelve a bajar, avisa de nuevo.

## 2. 🛒 Pedidos por WhatsApp con registro automático
El botón "Enviar Pedido por WhatsApp" del catálogo ahora, además de abrir
WhatsApp con el pedido armado:
- Incluye el **código OEM** de cada repuesto en el mensaje (antes solo la
  descripción, y era fácil confundir piezas parecidas).
- **Registra el pedido** en una pestaña nueva `Pedidos` de tu hoja (fecha,
  cantidad de ítems, total y detalle), aunque el cliente al final no envíe
  el mensaje — así ves también los pedidos "abandonados".
- Te manda un **correo al instante** con el detalle del pedido.
- Si Apps Script no responde, el cliente ni se entera: WhatsApp se abre
  igual (el registro es en segundo plano y nunca bloquea la venta).

## 3. 📋 Reporte diario (07:00)
Cada mañana te llega un correo con: productos visibles y ocultos, unidades
totales en stock, **valor del inventario en BOB**, lista de productos con
stock bajo y qué productos se modificaron en las últimas 24 horas.

## 4. 💾 Respaldo automático (02:00)
Cada madrugada se guarda una **copia completa de tu hoja** en una carpeta
de Drive llamada `Respaldos - Catalogo NCS` (se crea sola), con la fecha en
el nombre. Se conservan los últimos **30 días** y los más viejos se borran
solos para no llenar tu Drive.

## Cómo activarlas (una sola vez, 2 minutos)

1. Pega el nuevo `apps-script.gs` en tu proyecto de Apps Script (reemplaza
   todo) y guarda.
2. Verifica arriba del archivo que `NOTIFY_EMAIL` sea el correo donde
   quieres recibir los avisos (ya viene con `villegasmejia321@gmail.com`).
3. En el editor de Apps Script, en el menú desplegable de funciones (arriba,
   al lado de "Depurar"), elige **`instalarAutomatizaciones`** y pulsa
   **▶ Ejecutar**.
4. Google te pedirá autorización (correo + Drive). Acepta con tu cuenta.
5. Vuelve a desplegar: **Implementar → Gestionar implementaciones → ✏️
   Editar → Nueva versión → Implementar** (igual que siempre, para que el
   registro de pedidos funcione desde la web).
6. Sube el nuevo `catalogo.html` a tu hosting.

Para pausarlas todas: ejecuta la función `desinstalarAutomatizaciones` de la
misma manera.

> Nota: Gmail permite ~100 correos automáticos al día en cuentas gratuitas,
> más que suficiente para alertas, reportes y avisos de pedidos.
