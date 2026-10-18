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

## Eliminar productos

En **Productos** (solo administrador general):

- **Selección:** marca las casillas de la lista, o filtra por categoría y usa "Seleccionar toda la categoría". También hay un botón **Eliminar** en la ficha de cada producto.
- **Qué se borra:** los productos sin historial se borran.
  - Los que ya tienen ventas, compras o pedidos se **desactivan** para no perder el historial; se ven con "Ver inactivos".
  - La casilla "Borrar también sus entradas, salidas y existencias" borra los que solo tienen movimientos de inventario (útil para un catálogo importado por error).
- **Confirmación:** hay que escribir ELIMINAR.

## Impresora de tickets

En **Caja > ⚙ Impresora** o **Mi cuenta > Configurar impresora**. Se guarda en cada equipo.

**Cómo se conecta:**

| Modo | Para qué | Notas |
|---|---|---|
| Ventana de impresión | Computadora o cualquier impresora con controlador | Para que no salga la ventana: impresora predeterminada en Windows y acceso directo con `--kiosk-printing` (las instrucciones vienen en el cuadro). |
| USB directo | Tablet Android con hub USB-C o cable OTG, o computadora con Chrome | Se elige la impresora una vez. Sin ventana. |
| Bluetooth directo | Impresoras Bluetooth de bajo consumo (BLE) | Cada vez que se abre la app hay que tocar "Conectar impresora" en la caja. Si la impresora no aparece en la lista, usa Bluetooth clásico: elige RawBT. |
| App RawBT | Bluetooth clásico, USB o red (IP, puerto 9100) | Instala RawBT desde Play Store y configura ahí la impresora. La app le pasa cada ticket. |

**Opciones:**

- **Papel:** ancho 58 u 80 mm.
- **Al cobrar:** no imprimir, ticket o ticket doble. La segunda copia sale marcada como COPIA, con corte entre una y otra.
- **Contenido:** logo y mensaje al pie.
- **Solo en modos directos:** abrir el cajón de dinero al cobrar en efectivo (el cajón va conectado a la impresora) y "Quitar acentos", si la impresora imprime símbolos raros.
- **Si falla la impresión directa:** se abre la ventana de impresión para no perder el ticket.

**Botones en la caja:**

- **Imprimir ticket:** imprime la última venta, sencilla o doble, o la envía por correo. En "Ventas del turno", el botón "Ticket" hace lo mismo con cualquier venta.
- **Abrir cajón:** aparece cuando está activada esa opción.

**Correo:** se puede escribir al cobrar. Si la venta se hizo sin internet, el correo sale solo cuando la venta llega al servidor.

## Varias cuentas abiertas en la caja

- **Nueva cuenta (F4):** deja la cuenta actual en espera y abre otra para atender al siguiente cliente. Las cuentas aparecen como pestañas arriba del ticket, con su total.
- **Cambiar de cuenta:** toca la pestaña. Con el lápiz ✎ le pones un nombre para reconocerla ("Señora de blusa azul").
- **Al cobrar:** se cierra solo la cuenta cobrada; las demás siguen abiertas.
- **Se guardan en el equipo:** no se pierden si se cierra la app o se va el internet. Al cerrar la caja, la app avisa si quedan cuentas sin cobrar.

## Imágenes y descripción de productos

- **En la ficha del producto:** "Agregar imagen" (foto o archivo; se reduce sola) y una descripción que verá el cajero. La descripción también se puede cargar desde Excel en la columna "Detalle para la caja".
- **Vista de la caja (botones arriba a la derecha de la búsqueda):**
  - **Con imágenes:** los productos salen con foto y, a la derecha, un recuadro con la imagen, descripción, precio y existencia del último producto registrado.
  - **Solo lista:** renglones sencillos sin imágenes, más rápido en equipos lentos o con internet débil.
- **Sin internet:** cada imagen se guarda en el equipo la primera vez que se ve. Para tenerlas todas antes, usa **Mi cuenta > Descargar imágenes de productos**.
- **Dónde se guardan:** en la carpeta "Imágenes de la app" de Google Drive.

## Apariencia

En **Mi cuenta > Cambiar apariencia** (administrador general). Se aplica en todos los equipos al sincronizar.

- Nombre de la app, logo (también sale en tickets y órdenes de compra), color principal, color de acento, tema claro u oscuro, tamaño de letra e imagen de fondo con su intensidad.
- Los cambios se ven al momento; "Cancelar" los deshace.
- Cada equipo puede ajustar su propio tamaño de letra en **Mi cuenta > Este equipo**.
- El ícono con el que se instala la app no cambia: es el de la carpeta `icons`.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez (agrega las columnas de imagen y descripción a Productos).

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
| Cliente | Portal: hacer pedidos, ver sus pedidos y su estado de cuenta |
