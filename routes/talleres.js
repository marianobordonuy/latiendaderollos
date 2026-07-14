import { Router } from "express"
import rateLimit from "express-rate-limit"
import { MercadoPagoConfig, Preference, Payment } from "mercadopago"
import { loadOrders, saveOrders, loadTalleres, saveTalleres } from "../lib/storage.js"
import { auth } from "../lib/auth.js"
import { verifyMpSignature } from "../lib/mp.js"
import { sendTallerConfirmado } from "../lib/email.js"

const router = Router()

const mp = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
})

const TALLER_STATUSES = ["PENDIENTE_PAGO", "CONFIRMADO", "COMPLETADO", "CANCELADO"]
const inscripcionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

/* LISTAR TALLERES (público) — incluye cupos_disponibles calculado */
router.get("/", (req, res) => {
    const talleres = loadTalleres()
    const orders   = loadOrders()
    res.json(talleres.map(t => ({
        ...t,
        cupos_disponibles: Math.max(0, t.cupo - cuposOcupados(orders, t.id))
    })))
})

/* ACTUALIZAR TALLERES: precio, lugar, ciudad, fecha, cupo, etc. (protegido) */
router.put("/", auth, (req, res) => {
    const talleres = req.body
    if (!Array.isArray(talleres) || talleres.length === 0) {
        return res.status(400).json({ error: "Se espera un array de talleres" })
    }
    for (const t of talleres) {
        if (!t.id || !t.nombre) {
            return res.status(400).json({ error: "Cada taller necesita id y nombre" })
        }
        if (typeof t.precio !== "number" || t.precio <= 0) {
            return res.status(400).json({ error: `Precio inválido para ${t.id}` })
        }
        if (typeof t.cupo !== "number" || t.cupo <= 0) {
            return res.status(400).json({ error: `Cupo inválido para ${t.id}` })
        }
        if (t.fecha_inicio && isNaN(Date.parse(t.fecha_inicio))) {
            return res.status(400).json({ error: `Fecha de inicio inválida para ${t.id}` })
        }
    }
    saveTalleres(talleres)
    res.json(talleres)
})

// Un checkout abandonado (nunca llega el pago) no debe ocupar el cupo para
// siempre — se libera pasado este tiempo si sigue en PENDIENTE_PAGO.
const CHECKOUT_ABANDONADO_MS = 30 * 60 * 1000 // 30 min

function cuposOcupados(orders, tallerId) {
    return orders.filter(o => {
        if (o.tipo !== "taller" || o.taller_id !== tallerId || o.status === "CANCELADO") return false
        if (o.status === "PENDIENTE_PAGO" && Date.now() - new Date(o.created_at).getTime() > CHECKOUT_ABANDONADO_MS) {
            return false
        }
        return true
    }).length
}

/* INSCRIPCIÓN + CREAR PREFERENCIA MP */
router.post("/inscripcion", inscripcionLimiter, async (req, res) => {
    try {
        const {
            taller_id, nombre, email, telefono,
            nivel, analogica, camara, prestamo, lab, detalle_lab, objetivo
        } = req.body

        if (!taller_id || !nombre || !email) {
            return res.status(400).json({ error: "Faltan datos" })
        }

        const taller = loadTalleres().find(t => t.id === taller_id && t.activo !== false)
        if (!taller) return res.status(404).json({ error: "Taller no encontrado" })

        const orders = loadOrders()
        if (cuposOcupados(orders, taller_id) >= taller.cupo) {
            return res.status(400).json({ error: "No quedan cupos disponibles para este taller" })
        }

        const pedidoId = `TALLER-${Date.now()}`

        orders.push({
            id:          pedidoId,
            tipo:        "taller",
            public_code: pedidoId,
            taller_id,
            taller_snapshot: {
                nombre:   taller.nombre,
                fecha:    taller.fecha,
                horario:  taller.horario,
                lugar:    taller.lugar,
                ciudad:   taller.ciudad,
                precio:   taller.precio,
                duracion: taller.duracion
            },
            client:      { nombre, email, telefono },
            inscripcion: { nivel, analogica, camara, prestamo, lab, detalle_lab, objetivo },
            total:          taller.precio,
            status:         "PENDIENTE_PAGO",
            payment_status: "UNPAID",
            mp_payment_id:  null,
            created_at:     new Date(),
            updated_at:     new Date()
        })
        saveOrders(orders)

        const preference = new Preference(mp)
        const prefResult  = await preference.create({
            body: {
                items: [{
                    id:          taller_id,
                    title:       `Taller: ${taller.nombre}`,
                    quantity:    1,
                    unit_price:  taller.precio,
                    currency_id: "UYU"
                }],
                payer: { name: nombre, email },
                external_reference: pedidoId,
                back_urls: {
                    success: `${process.env.APP_URL}/taller/confirmacion?status=success&pedido=${pedidoId}`,
                    failure: `${process.env.APP_URL}/taller/confirmacion?status=failure&pedido=${pedidoId}`,
                    pending: `${process.env.APP_URL}/taller/confirmacion?status=pending&pedido=${pedidoId}`
                },
                auto_return:      "approved",
                notification_url: `${process.env.APP_URL}/api/talleres/webhook`
            }
        })

        res.json({ init_point: prefResult.init_point })

    } catch (err) {
        console.error("Error creando inscripción:", err.message)
        res.status(500).json({ error: "Error al crear la inscripción" })
    }
})

/* LISTA DE ESPERA (sin pago, sin ocupar cupo) */
router.post("/lista-espera", inscripcionLimiter, (req, res) => {
    try {
        const {
            taller_id, nombre, email, telefono,
            nivel, analogica, camara, prestamo, lab, detalle_lab, objetivo
        } = req.body

        if (!taller_id || !nombre || !email) {
            return res.status(400).json({ error: "Faltan datos" })
        }

        const taller = loadTalleres().find(t => t.id === taller_id && t.activo !== false)
        if (!taller) return res.status(404).json({ error: "Taller no encontrado" })

        const orders   = loadOrders()
        const pedidoId = `ESPERA-${Date.now()}`

        orders.push({
            id:          pedidoId,
            tipo:        "taller_espera",
            public_code: pedidoId,
            taller_id,
            taller_snapshot: {
                nombre:   taller.nombre,
                fecha:    taller.fecha,
                horario:  taller.horario,
                lugar:    taller.lugar,
                ciudad:   taller.ciudad,
                precio:   taller.precio,
                duracion: taller.duracion
            },
            client:      { nombre, email, telefono },
            inscripcion: { nivel, analogica, camara, prestamo, lab, detalle_lab, objetivo },
            status:      "EN_ESPERA",
            created_at:  new Date(),
            updated_at:  new Date()
        })
        saveOrders(orders)

        res.json({ ok: true })

    } catch (err) {
        console.error("Error creando lista de espera:", err.message)
        res.status(500).json({ error: "Error al anotarte en la lista de espera" })
    }
})

/* ADMIN: ELIMINAR DE LISTA DE ESPERA */
router.delete("/espera/:id", auth, (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.id === req.params.id && o.tipo === "taller_espera")
    if (index === -1) return res.status(404).json({ error: "No encontrado" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

/* WEBHOOK MP */
router.post("/webhook", async (req, res) => {
    try {
        if (!verifyMpSignature(req)) {
            console.error("Webhook MP (talleres): firma inválida o ausente")
            return res.sendStatus(401)
        }
        res.sendStatus(200)

        const { type, data } = req.body
        if (type !== "payment") return

        const payment  = new Payment(mp)
        const pagoData = await payment.get({ id: data.id })
        const pedidoId = pagoData.external_reference
        const estado   = pagoData.status

        const orders = loadOrders()
        const order  = orders.find(o => o.id === pedidoId && o.tipo === "taller")
        if (!order) return

        if (estado === "approved" && pagoData.transaction_amount !== order.total) {
            console.error(`Webhook MP (talleres): monto no coincide para ${pedidoId} (esperado ${order.total}, recibido ${pagoData.transaction_amount})`)
            return
        }

        order.mp_payment_id  = data.id
        order.payment_status = estado === "approved" ? "PAID" : estado.toUpperCase()
        order.updated_at     = new Date()
        if (estado === "approved") order.status = "CONFIRMADO"
        saveOrders(orders)

        if (estado === "approved" && order.client.email) {
            await sendTallerConfirmado(order)
        }

    } catch (err) {
        console.error("Webhook error (talleres):", err.message)
    }
})

/* CONFIRMACIÓN */
router.get("/confirmacion", (req, res) => {
    const { status, pedido } = req.query
    const msgs = {
        success: { titulo: "¡Inscripción confirmada!", texto: "Recibimos tu pago. Te esperamos en el taller.", color: "#2a8a3e" },
        pending: { titulo: "Pago pendiente",           texto: "Tu pago está siendo procesado. Te confirmamos por email.", color: "#c07a00" },
        failure: { titulo: "Pago rechazado",           texto: "Hubo un problema con el pago. Podés intentarlo de nuevo.", color: "#c0392b" }
    }
    const m = msgs[status] || msgs.failure
    res.send(`<!DOCTYPE html>
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
    <a href="/taller.html" class="btn">Volver</a>
</div>
</body>
</html>`)
})

/* VERIFICAR PAGO CON MP (protegido) — re-consulta el pago directo en MP por
   external_reference. Sirve para inscripciones que quedaron UNPAID porque el
   webhook nunca llegó o falló la verificación de firma. */
router.post("/:id/verificar-pago", auth, async (req, res) => {
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "taller")
    if (!order) return res.status(404).json({ error: "Inscripción no encontrada" })

    try {
        const payment  = new Payment(mp)
        const result   = await payment.search({ options: { external_reference: order.id } })
        const results  = result.results || []
        const pagoData = results.find(p => p.status === "approved") || results[0]
        if (!pagoData) return res.status(404).json({ error: "MP no tiene ningún pago registrado para esta inscripción" })

        const estado = pagoData.status
        if (estado === "approved" && pagoData.transaction_amount !== order.total) {
            console.error(`Verificación MP (talleres): monto no coincide para ${order.id} (esperado ${order.total}, recibido ${pagoData.transaction_amount})`)
            return res.status(409).json({ error: "El monto del pago en MP no coincide con el total de la inscripción" })
        }

        order.mp_payment_id  = pagoData.id
        order.payment_status = estado === "approved" ? "PAID" : estado.toUpperCase()
        order.updated_at     = new Date()
        if (estado === "approved" && order.status === "PENDIENTE_PAGO") order.status = "CONFIRMADO"
        saveOrders(orders)

        if (estado === "approved" && order.client.email) {
            try { await sendTallerConfirmado(order) } catch (e) { console.error("Error enviando email:", e.message) }
        }

        res.json(order)
    } catch (err) {
        console.error("Error verificando pago en MP:", err.message)
        res.status(500).json({ error: "Error al consultar MP" })
    }
})

/* ADMIN: ACTUALIZAR ESTADO */
router.put("/:id/status", auth, (req, res) => {
    if (!TALLER_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: "status inválido" })
    }
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "taller")
    if (!order) return res.status(404).json({ error: "Inscripción no encontrada" })
    order.status     = req.body.status
    order.updated_at = new Date()
    saveOrders(orders)
    res.json(order)
})

/* ADMIN: ELIMINAR */
router.delete("/:id", auth, (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.id === req.params.id && o.tipo === "taller")
    if (index === -1) return res.status(404).json({ error: "Inscripción no encontrada" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

export default router
