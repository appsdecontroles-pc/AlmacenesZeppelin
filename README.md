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

## Inventario de todos los almacenes y "¿Dónde hay?"

- **Inventario > Todos los almacenes:** una columna por almacén y el total de cada producto. Lo ven todos los usuarios (sin costos para el cajero) y se exporta a CSV.
- **¿Dónde hay?** (en Inventario y en la Caja): busca un producto y muestra cuánto hay en cada almacén, con dirección y teléfono.
  - **Datos para el cliente:** imprime un papelito con la sucursal, dirección, teléfono y precio, para mandarlo a la otra sucursal.
  - **Pedir traspaso** (cajero y administrador de sucursal): crea una solicitud para que el otro almacén mande el producto a tu sucursal.
- **En la caja:** los productos que no hay en tu sucursal dicen "hay en otra", y el recuadro del producto muestra "En otros: …".
- **Las existencias de otros almacenes** son las de la última sincronización (cada 15 minutos o al tocar "En línea").

**Traspasos entre sucursales:** la solicitud llega a la sección **Pedidos** del almacén que surte, sea la bodega o una sucursal. Su administrador la acepta, la surte (sale de su inventario) y la sucursal que pidió confirma la entrega (entra a su inventario).

## Turnos y cortes de caja

**Cajas de cobro:** cada sucursal puede tener varias cajas (Caja 1, Caja 2, Caja rápida…). Se dan de alta en **Almacenes > (sucursal) > Administrar cajas**, o desde la pantalla de abrir caja (administradores). Si una sucursal no registra cajas, funciona como una sola caja.

**Abrir caja:**

- Se elige la caja. La app propone como fondo lo que dejó el turno anterior **de esa misma caja** ("Queda en caja") y avisa si lo contado no coincide.
- Si no coincide, pide confirmar y queda registrado.
- Si la caja ya está abierta por otra persona, avisa antes de abrirla.
- Cada equipo recuerda la última caja que usó.

**Cerrar caja (corte):**

1. Se cuenta todo el efectivo de la caja.
2. La app compara contra lo esperado (fondo + ventas en efectivo + abonos en efectivo) y marca la diferencia a favor o en contra.
3. Se anota el **retiro** (lo que se entrega o deposita). Lo demás es lo que **queda en caja** para el siguiente turno.
4. Al terminar aparece un mensaje: "¡Gracias por tu turno! Tu corte fue correcto", o el faltante o sobrante si lo hubo.

**Ventas > Turnos y cortes** (administradores):

- **Filtros:** fechas, sucursal y caja.
- **Resumen del día o del periodo:** venta total, efectivo, tarjeta, transferencias, crédito, retiros, faltantes y sobrantes, y productos vendidos.
- **Una tarjeta por turno:** cajero, caja, horario, inicio de caja (y si cuadra con lo que dejó el turno anterior), ventas por forma de pago, abonos, esperado, contado, diferencia, retiro y lo que quedó en caja.
- **Desgloses:** cada total abre su lista de ventas, cada venta muestra sus productos, y "← Volver" regresa a la lista.

## Productos más vendidos

En **Productos**, el selector "Ordenar" permite ver los más vendidos por **piezas** o por **importe**, en los últimos 7 días, esta semana, este mes, los últimos 30 días o el mes pasado. Muestra el lugar (#), lo vendido y el importe, sin contar ventas canceladas. Disponible para el administrador general, el administrador de sucursal y control de inventarios.

Al actualizar el servidor a esta versión hay que ejecutar **instalar** otra vez (agrega la hoja Cajas y las columnas de caja, retiro y "queda en caja" a los cortes).

## Ventanas ajustadas a la pantalla

Las ventanas (cobro, producto, impresora, corte, apariencia, etc.) nunca son más altas que la pantalla:

- En pantallas anchas acomodan sus campos en dos columnas.
- En laptops y tablets usan un modo compacto.
- Si algo no cabe (por ejemplo en celular), solo se desplaza el contenido y los botones de Confirmar o Guardar quedan siempre visibles abajo.

## Actualizar a la versión 5.7.1 (Personal, bonos, Análisis, portal público, autocobro, verificador y avisos al cliente)

1. Pega el nuevo `Codigo-gs.html` en Apps Script y guarda.
2. Ejecuta otra vez la función **instalar**. Crea las hojas nuevas (Empleados, Horarios, Asistencias, Incidencias, Adelantos, Vacaciones, Nominas, Temporadas, Bonos, Autocobros, Notificaciones) y las columnas nuevas. No borra nada.
3. **Implementar > Administrar implementaciones > lápiz > Nueva versión**.
4. Sube los archivos de la app (sin tocar tu `config.js`) y abre la app dos veces para que tome la versión nueva.
5. En **Personal > Horarios y reglas**, revisa que la zona horaria sea **Mazatlan (Sinaloa…)**. De ella dependen las horas de checada, los cortes y los reportes.

## Personal y nómina

Menú **Personal** (administrador general y de sucursal; cada sucursal ve solo a su gente).

- **Horarios y reglas:** horario de entrada y salida, días de trabajo, minutos de tolerancia (a tiempo) y minutos después de los cuales la llegada cuenta como falta. Entre ambos es **retardo**.
- **Reglas de pago** (solo el administrador general):
  - tope de adelanto (20 %, 30 %, 50 %… del sueldo del periodo), cuántos adelantos por periodo y días mínimos de trabajo para pedirlo;
  - prima vacacional (25 % por ley);
  - descuento por cada retardo y cuántos retardos equivalen a una falta;
  - los bonos ya no están aquí: son opcionales y se arman en la pestaña **Bonos**.
- **Empleados:** número, sucursal, área (Caja, Almacén…), fecha de ingreso, pago diario, semanal o quincenal, salario diario, horario, NIP y su usuario de caja (para bonos por sus ventas).
  - **No usa checador:** cobra su salario fijo completo y no aparece con faltas ni retardos.
- **Cómo se paga:**
  - Diario: solo los días trabajados (más vacaciones y permisos).
  - Semanal o quincenal: salario fijo de todos los días del periodo, incluido el descanso semanal; las faltas se descuentan.
- **Asistencia:** tabla de la quincena por sucursal, persona y día.
  - Colores: verde a tiempo, rojo retardo (con minutos), rojo oscuro falta, gris descanso, azul vacaciones, amarillo permiso, morado incapacidad.
  - Al final de cada fila: salario fijo, descuentos, bonos y prima, y salario final.
  - Toca un día para justificarlo o corregir horas. Toca un nombre para ver el desglose y agregar bonos o descuentos.
- **Nómina:** por tipo de pago y periodo.
  - **Cerrar nómina** fija los importes y marca los adelantos como descontados.
  - Después marca quién ya cobró, imprime recibos para firma o exporta a Excel.
  - Se puede reabrir mientras no haya pagos marcados.
- **Solicitudes:** aprobar o rechazar vacaciones y adelantos, o registrarlos a nombre del empleado.
  - Los días de vacaciones siguen la ley (reforma 2023): 12 el primer año, +2 por año hasta 20, luego +2 cada 5 años.
  - Las vacaciones aprobadas se pagan con prima vacacional.

## Checador

Menú **Checador**, en cualquier equipo de la sucursal (también los cajeros). El empleado escribe su número y su NIP en el teclado de la pantalla. Después puede:

- registrar su entrada o salida (mensaje verde si llegó a tiempo, rojo si llegó tarde);
- ver su quincena en colores;
- pedir vacaciones, con los días que le quedan;
- pedir un adelanto, con el máximo permitido.

Notas:
- Tras 5 NIP equivocados, ese número se bloquea 10 minutos.
- Sin internet, la checada se guarda en el equipo con su hora real y se envía sola al volver la conexión (hasta 48 horas).

## Análisis y temporadas

Menú **Análisis** (administradores y control de inventarios).

- **Más vendidos:** top 50 por piezas o por importe en el periodo que elijas, con opción de ordenarlo por categoría, y el top 10 de cada categoría.
- **Rotación y sugerencias:** cada producto tiene su clase A, B o C según lo que vende y estas señales:
  - **Tener más:** se vende bien y alcanza para menos de 15 días.
  - **Promocionar ya:** caduca en menos de 1 mes y lleva más de 2 meses en inventario (descuento, regalo o degustación).
  - **Sin ventas en 2 meses:** propuesta para retirar.
  - **Demasiado inventario:** hay para más de 4 meses.
  - **No aguanta a su temporada:** producto de temporada que caduca antes de la siguiente.
  - Selecciona productos para marcarlos **descontinuados** (ya no se sugieren en compras) o **de temporada**.
- **Temporadas:** Navidad, 14 de febrero, Semana Santa (se calcula sola), etc.
  - Cada una avisa 1, 2 o 3 meses antes, en el Inicio y por correo a la empresa.
  - El detalle muestra lo vendido la temporada anterior y la de hace dos años, la existencia actual, cuánto tener (con el % de crecimiento) y cuánto comprar.
  - Incluye ideas automáticas y tus propuestas de productos nuevos, dinámicas y promociones.
  - El botón **Orden de compra con lo sugerido** arma la orden.
- **Productos de temporada:** se destacan en su temporada y no se marcan "sin ventas" el resto del año, pero sí avisan si caducan antes de la siguiente.

## Caducidad

- Al registrar una **Entrada** o al **recibir una orden de compra** puedes capturar la caducidad del lote.
- En la ficha del producto también puedes poner la caducidad del inventario actual.
- El análisis toma la más próxima.

## Bonos (opcionales)

En **Personal > Bonos** creas los que quieras. Cada bono tiene:

- **Tipo:**
  - Puntualidad: llegar a tiempo, sin faltas ni retardos. No aplica a quien no usa checador.
  - Meta de ventas: monto de venta a alcanzar.
  - Promover un producto: meta en piezas o en $ vendido de ese producto.
- **Cuenta la venta de:** la sucursal completa, o cada persona (lo que cobró con su usuario de caja).
- **Monto:** a cada persona que cumple, o repartido entre quienes cumplen.
- **Se mide y se paga:** por día, por semana o por quincena. Se paga en la nómina donde termina ese periodo.
- **Aplica a:** una persona, un grupo de personas, todos los presentes o un turno completo (horario).
- **Sucursal y área:** una o todas. Con "todas las sucursales", cada sucursal tiene que llegar a su meta.
- **Solo participan:** quienes no faltaron, quienes no tuvieron retardos, quienes tienen al menos X meses, o todas las anteriores.
- **Vigencia** opcional (por ejemplo, una promoción de dos semanas).

En la misma pestaña ves el avance de cada meta en barras y cuánto lleva ganado cada quien. En el checador, cada empleado ve su avance.

## Pedidos de clientes con día y horario

- **Sin cuenta:** el cliente abre la app y toca **Hacer un pedido sin cuenta**, o entra directo con la dirección terminada en `#pedir` (por ejemplo `https://appsdecontroles-pc.github.io/AlmacenesZeppelin/#pedir`). Ponla en un código QR, en WhatsApp o en redes.
  - Solo deja su nombre, teléfono y dirección (o la tienda donde recoge), el día y el horario.
  - **Paga al recibir o al recoger.** El pedido llega a Pedidos como cualquier otro, con sus datos en las notas.
- **Con cuenta:** con **Crear mi cuenta de cliente** (o `#registro`) elige usuario y contraseña, sin confirmar nada. Guarda sus datos y sus pedidos anteriores (si ya pidió sin cuenta con ese teléfono, los ve).
- **Crédito:** lo da el negocio en Ventas > Clientes (límite y días).
  - Sin crédito, el cliente no elige forma de pago: solo programa la entrega o la recolección.
  - Con crédito, ve en todo momento su saldo, su crédito disponible y cuándo vence cada pedido. Cada pedido vence a los días de crédito contados desde el día en que lo pidió (30 días naturales: un pedido del 15 de mayo vence el 14 de junio).
  - Una semana antes ve el aviso de "por vencer". Si tiene algo vencido, ya no puede pedir a crédito, solo pagando al recibir.
- **Horario de entregas:** en **Datos de la empresa** pones la hora de inicio y la de fin. El cliente elige una franja de 2 horas dentro de ese horario (por ejemplo, de 8:00 a 15:00 salen 8–10, 10–12, 12–14 y 14–15).
- Para ocultar los botones públicos en la pantalla de entrada, agrega `PORTAL_PUBLICO: false` en `config.js`.

## Avisos al cliente

El cliente recibe un aviso cuando:
- se recibe su pedido;
- queda programado (con día y horario);
- va en camino;
- se entrega;
- se cancela;
- se cobra su autocobro;
- le autorizan o cambian el crédito;
- un pago está por vencer o ya venció.

Cómo le llega:

- **En su portal:** menú **Avisos**, con burbuja de no leídos y el último aviso en el Inicio.
- **Como notificación del teléfono:** si toca **🔔 Avísame en este teléfono** y lo permite. Llega cuando abre la app o mientras la tiene abierta en segundo plano; con la app cerrada por completo no llega hasta que la vuelve a abrir.
- **Por correo:** si registró su correo.
- **Sin cuenta:** al volver a abrir la página `#pedir` en su teléfono ve el estado y los avisos de sus pedidos.
- **WhatsApp:** en el detalle de cada pedido hay un botón **WhatsApp** que abre el chat del cliente con un mensaje listo según cómo va su pedido.

## Autocobro (el cliente escanea con su teléfono)

1. El cliente con cuenta toca **Estoy en la tienda**, elige la sucursal y escanea los productos con la cámara de su teléfono (o los busca). Ve sus precios y el total.
2. Al terminar toca **Terminar y pagar en caja**. Recibe un código de barras **AC 123 456**, que vale solo ese día.
3. En la **Caja**, la cajera escanea ese código con el lector (o lo escribe en el buscador, o usa el botón **Autocobro**). Se abre una cuenta con los productos y el cliente.
4. La cajera revisa la mercancía y cobra normal. La venta entra al corte de esa caja como cualquier otra, el autocobro queda marcado como cobrado con el folio del ticket y al cliente le llega el aviso.

También puede **verificar un precio** sin agregarlo.

## Menú y verificar precio

- El menú está agrupado por áreas: **Vender** (Caja, Ventas y cortes, Clientes, Por cobrar, Pedidos), **Inventario**, **Compras**, **Personal** y **Ajustes**. Cada área abre su lista y muestra la burbuja de pendientes.
- **Verificar precio:** botón flotante abajo a la derecha (o la tecla **F2**) en cualquier pantalla menos la Caja. Aceptas el lector de códigos, escribir el nombre o usar la cámara. Muestra precio, mayoreo, existencia aquí y en todas las sucursales (y costo y margen para administradores). El botón se hace pequeño y transparente si no lo usas y se esconde al bajar por la página.

## Verificador de precios (tablet en la pared)

1. Hay dos formas:
   - Desde cualquier equipo con tu usuario: **Vender > Verificador de precios**. El equipo se queda en esa pantalla aunque se recargue, hasta que un colaborador lo saque.
   - Con una cuenta propia para la tablet: en **Usuarios** crea un usuario con rol **Verificador de precios** (no pide cambiar contraseña y su sesión no vence).
2. Entra con ese usuario en la tablet. La pantalla queda fija con un solo botón: **Verificar un precio**. Al tocarlo se abre la cámara frontal; el cliente acerca el código y ve el nombre, el precio (y el de mayoreo) en grande.
   - También sirve un lector USB o Bluetooth.
   - Funciona sin internet con los precios guardados.
3. Al entrar se elige un **código de bloqueo** (4 a 8 números). En la pantalla solo quedan el botón **Verificar un precio** y un candado pequeño 🔒. No se sale con Atrás ni recargando; solo con el candado y el código. Ahí se puede actualizar precios, cambiar el código o salir. Si olvidan el código, un administrador desbloquea con su usuario y contraseña (opción "¿Olvidaste el código?").
4. Para que tampoco puedan salir de Chrome, activa en Android **Fijar aplicación** (Ajustes > Seguridad > Fijar aplicación) y fija la app instalada.

La cámara usa el lector del propio Chrome en Android. En iPhone se descarga un lector de internet la primera vez.

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
| Administrador de sucursal | Ver su sucursal, registrar movimientos, crear cajeros y personal de inventarios, pedir y surtir traspasos con otras sucursales |
| Control de inventarios | Editar catálogo y registrar movimientos en su almacén |
| Cajero | Vender, consultar productos y existencias (sin costos), ver dónde hay un producto, pedir traspasos y usar el checador |
| Cliente | Portal: hacer pedidos con día y horario, comprar en tienda con autocobro, ver sus pedidos, su crédito y sus vencimientos |
| Verificador de precios | Solo la pantalla de verificar precios (tablet fija) |
