// Página de "gracias por tu pago" que ven los clientes al volver de MP —
// compartida entre impresión, talleres y servicios (antes era la misma
// plantilla copiada 3 veces, con solo los textos/colores distintos).
export function renderConfirmacionPage({ status, pedido, mensajes, volverA }) {
    const m = mensajes[status] || mensajes.failure
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${m.titulo} — La Tienda de Rollos</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:system-ui,sans-serif; background:#fff; color:#111; display:flex; align-items:center; justify-content:center; min-height:100vh; }
.box { max-width:480px; width:90%; text-align:center; padding:60px 0; }
.icon { font-size:48px; margin-bottom:24px; }
.titulo { font-size:28px; font-weight:700; margin-bottom:16px; }
.texto { font-size:15px; line-height:1.7; opacity:.6; margin-bottom:40px; }
.pedido { font-size:12px; letter-spacing:3px; opacity:.35; margin-bottom:40px; }
.btn { display:inline-block; border:1px solid #111; padding:14px 28px; text-decoration:none; color:#111; font-size:11px; letter-spacing:3px; text-transform:uppercase; transition:.2s; }
.btn:hover { background:#111; color:#fff; }
</style>
</head>
<body>
<div class="box">
    <div class="icon">${status === "success" ? "✓" : status === "pending" ? "◔" : "×"}</div>
    <div class="titulo" style="color:${m.color}">${m.titulo}</div>
    <div class="texto">${m.texto}</div>
    ${pedido ? `<div class="pedido">Pedido ${pedido}</div>` : ""}
    <a href="${volverA}" class="btn">Volver</a>
</div>
</body>
</html>`
}
