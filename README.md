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
