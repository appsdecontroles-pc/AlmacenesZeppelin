# Control de Inventario — Fase 1

App instalable que trabaja con internet o sin él. Los datos centrales viven en una Hoja de cálculo de Google, y Apps Script funciona como servidor.

## 1. Servidor (Apps Script)

1. Crea una Hoja de cálculo de Google nueva. Será la base de datos.
2. En la hoja, abre **Extensiones > Apps Script**, borra lo que tenga `Código.gs` y pega el contenido de `Codigo-gs.html`.
3. Si quieres, cambia `ADMIN_PASSWORD_INICIAL` y guarda.
4. Elige la función **instalar** y presiona **Ejecutar**. Acepta los permisos. Se crean las hojas, la BODEGA PRINCIPAL y el usuario `admin`.
5. Ve a **Implementar > Nueva implementación > Aplicación web**, con **Ejecutar como: Yo** y **Quién tiene acceso: Cualquier usuario**.
6. Copia la URL que termina en `/exec`.

Si después cambias el código, ve a **Implementar > Administrar implementaciones**, edita la implementación (lápiz), elige **Nueva versión** e implementa. Así la URL no cambia.

## 2. App (GitHub Pages)

1. Abre `config.js` y pega la URL en `API_URL`.
2. Sube todos los archivos de esta carpeta a un repositorio de GitHub, conservando la carpeta `icons`.
3. En el repositorio ve a **Settings > Pages > Deploy from a branch**, elige `main` y la carpeta `/ (root)`.
4. Abre la dirección que te da GitHub en Chrome o Edge y presiona el botón **Instalar** de la barra de direcciones.

Cuando publiques cambios a la app, sube el número de `CACHE` en `sw.js` (por ejemplo, `inventario-v2`) para que los equipos descarguen la versión nueva.

## Primer uso

- Entra con `admin` / `Cambiar.123`. La app te pide cambiar la contraseña.
- Cada usuario necesita internet la primera vez que entra en un equipo. Después ya puede entrar sin conexión.

## Importar productos desde Excel

En **Productos > Importar Excel** (administrador general y control de inventarios):

1. Descarga la **plantilla vacía**, o el **catálogo actual** si quieres cambiar precios en bloque.
2. Llena la hoja "Productos". Solo el nombre es obligatorio.
3. Sube el archivo (.xlsx o .csv). La app muestra cuántos productos son nuevos, cuántos se actualizan y qué filas tienen errores, antes de guardar nada.
4. Si el archivo trae la columna Existencia, eliges el almacén y si se suma a lo que hay o se reemplaza.

Reglas:

- Si el código de barras o el código interno ya existen, el producto se actualiza. Las celdas vacías conservan el dato anterior.
- Las categorías que no existen se crean.
- Si se corta el internet a medio importar, puedes reintentar con el mismo archivo: las existencias no se duplican.
- El formato .xls antiguo no es compatible; guarda como .xlsx o .csv.

## Compras (fase 2)

En **Compras** (administrador general y control de inventarios):

- **Proveedores:** nombre, RFC, contacto, correo y días de crédito.
- **Órdenes de compra:** folio automático (OC-00001), IVA 0/8/16 %, y un botón que agrega los productos bajo mínimo.
- **Enviar:** genera el PDF con el logo de la empresa, lo guarda en la carpeta "Órdenes de compra" de Google Drive y, si se elige, lo manda por correo al proveedor. También se puede descargar para enviarlo por otro medio.
- **Recibir:** se captura lo que llegó; admite entregas parciales. Suma al inventario del almacén y puede actualizar el costo de los productos.
- **Pedidos programados:** semanal, quincenal o mensual. Cada mañana se crea la orden en borrador o se envía sola por correo.
- **Tablero:** próximas, enviadas, por recibir (marca las atrasadas) y recibidas del mes.

Los datos de la empresa y el logo del PDF se capturan en **Mi cuenta > Datos de la empresa**.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez. Crea las hojas nuevas y la tarea diaria, y Google pedirá permisos nuevos para Drive y correo. No borra nada.

## Cuentas por pagar (fase 3)

En **Por pagar** (solo administrador general):

- Al recibir mercancía de una orden se crea su cuenta: lo recibido más IVA, a contado o a crédito según los días del proveedor.
- La factura (PDF, XML o foto) se adjunta al recibir o después. Se guarda en la carpeta "Facturas de proveedores" de Drive.
- Pagos completos o abonos, con fecha, método y referencia, y botón "Liquidar saldo". Un pago capturado por error se puede eliminar.
- Facturas sin orden (servicios, fletes, gastos) con "Nueva cuenta".
- Resumen del mes: compras, pagos, saldo, vencido y por vencer, más saldos por proveedor. "Exportar mes a Excel" descarga cuentas, pagos y saldos.
- Avisos: Inicio y el menú muestran lo vencido y lo que vence en 5 días. Cada mañana llega un correo al correo de la empresa (Mi cuenta > Datos de la empresa), una sola vez por cuenta al faltar 5 días y otra cuando se vence.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez. Crea las hojas CuentasPagar y Pagos, y las cuentas de las órdenes que ya estaban recibidas.

## Punto de venta (fase 4)

**Caja** (cajero, administrador de sucursal y administrador general):

- **Apertura y venta:** se abre la caja con un fondo inicial. Los productos se buscan por nombre, categoría o código de barras; Enter agrega, y `3*7501…` agrega 3 piezas.
- **Cliente y precios:** público en general (menudeo), cliente de mayoreo o precio especial por cliente. Al elegir el cliente se recalculan los precios.
- **Cobro:** efectivo con cambio, tarjeta, transferencia, crédito o una mezcla. F2 abre el cobro.
- **Ticket:** para impresora térmica de 58/80 mm, con reimpresión.
- **Abonos y corte:** "Cobrar abono" para clientes con saldo. "Cerrar caja" compara el efectivo esperado (fondo + ventas en efectivo + abonos en efectivo) con lo contado.
- **Sin internet:** ventas, abonos y corte se guardan en el equipo y se envían en orden al volver la conexión. Los clientes nuevos sí necesitan conexión.
- **Reglas del crédito:** solo para clientes con crédito autorizado, sin saldo vencido y dentro de su límite. Sin conexión se permite con confirmación y queda anotado.

**Ventas** (administradores):

- **Ventas:** por periodo y sucursal, con total, utilidad bruta, formas de pago, detalle, cancelación (regresa la mercancía al inventario) y exportación a Excel.
- **Cortes de caja:** con su diferencia.
- **Clientes:** menudeo o mayoreo, crédito con límite de monto y días, y precios especiales.
- **Por cobrar:** saldos, vencimientos y registro de abonos.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez para crear las hojas nuevas.

## Pedidos y portal de clientes (fase 5)

**Pedidos** (administrador general, control de inventarios y administrador de sucursal):

- **Origen del pedido:**
  - Para un **cliente externo** (con sus precios y su crédito) o para una **sucursal** (traspaso valuado a costo).
  - La sucursal lo **solicita** con "Solicitar mercancía"; el cliente, desde su portal.
- **Tablero:** solicitados, programados (marca hoy y atrasados), en proceso y entregados.
- **Aceptar y programar:** fecha de surtido y entrega.
- **Lotear / surtir:** genera un envío (EN-00001), completo o parcial, que sale del inventario de la bodega e imprime la remisión.
- **Confirmar entrega:** se captura lo recibido; lo que no llegó regresa a la bodega y queda pendiente para otro envío.
  - **Sucursal:** entra a su inventario.
  - **Cliente a crédito:** se suma a su crédito.
  - **Cliente de contado:** se registra el cobro.
- **Ajustes:**
  - "Cancelar envío" regresa la mercancía a la bodega.
  - "Cerrar con faltante" termina un pedido que ya no se completará.
- **Reglas del crédito:**
  - El cliente no puede pedir a crédito si rebasa su límite o tiene saldo vencido.
  - La bodega sí puede capturarlo, con aviso, pero solo el administrador general autoriza el envío.

**Portal del cliente** (usuario con rol "Cliente", ligado a un cliente en Usuarios):

- **Inicio:** saldo, crédito disponible y vencido.
- **Hacer pedido:** catálogo con sus precios y disponibilidad (sin mostrar existencias ni costos).
- **Mis pedidos:** estado, envíos y remisiones.
- **Estado de cuenta:** documentos, vencimientos y pagos, imprimible.

**Avisos por correo:**

- A la empresa: pedido nuevo, y cada mañana la agenda de pedidos por surtir y la cobranza vencida.
- Al cliente (si tiene correo): pedido en camino, pedido entregado, recordatorio 5 días antes del vencimiento y aviso de vencido.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez.

## Cómo funciona sin internet

- Al entrar y cada 15 minutos, la app descarga catálogo, precios y existencias, y los guarda en el equipo.
- Sin conexión, los movimientos se guardan en una cola local. Al volver el internet se envían solos.
- Cada movimiento lleva un ID único, así que aunque se reenvíe nunca se aplica dos veces.
- Las salidas y traspasos capturados sin conexión pueden dejar existencia negativa. El servidor los acepta y muestra un aviso.
- Editar catálogo, almacenes y usuarios requiere conexión.

## Roles

| Rol | Puede |
|---|---|
| Administrador general | Todo, en todos los almacenes |
| Administrador de sucursal | Ver su sucursal, registrar movimientos, crear cajeros y personal de inventarios |
| Control de inventarios | Editar catálogo y registrar movimientos en su almacén |
| Cajero | Consultar productos, precios y existencias de su sucursal (sin costos) |
| Cliente | Reservado para la fase 5 |
