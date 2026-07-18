import { Router } from "express"
import { MercadoPagoConfig, Preference, Payment } from "mercadopago"
import { loadOrders, saveOrders } from "../lib/storage.js"
import { auth } from "../lib/auth.js"
import { verifyMpSignature, applyPaymentResult } from "../lib/mp.js"
import { sendServicioConfirmado } from "../lib/email.js"

const router = Router()

const mp = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
})

const SERVICIO_STATUSES = ["PENDIENTE_PAGO", "PAGADO", "COMPLETADO", "CANCELADO"]

// Techo de seguridad contra un error de tipeo del admin (ej. un cero de más)
// que generaría un link de pago real por un monto muy superior al querido.
// Ajustable — no es una regla de negocio, es una red de contención.
const MONTO_MAXIMO = 500000

/* ADMIN: CREAR LINK DE PAGO POR MONTO LIBRE (protegido) */
router.post("/crear-link", auth, async (req, res) => {
    try {
        const nombre   = (req.body.nombre || "").trim()
        const email    = (req.body.email || "").trim()
        const telefono = (req.body.telefono || "").trim()
        const concepto = (req.body.concepto || "").trim()
        // Redondeado a centésimos: evita que un monto con decimales largos
        // nunca coincida con lo que MP reporta como transaction_amount.
        const monto = Math.round(Number(req.body.monto) * 100) / 100

        if (!nombre || !email || !concepto || !Number.isFinite(monto) || monto <= 0) {
            return res.status(400).json({ error: "Faltan datos o el monto es inválido" })
        }
        if (monto > MONTO_MAXIMO) {
            return res.status(400).json({ error: `El monto máximo por link es $${MONTO_MAXIMO} UYU` })
        }

        const pedidoId = `SERV-${Date.now()}`

        const orders = loadOrders()
        orders.push({
            id:          pedidoId,
            tipo:        "servicio",
            public_code: pedidoId,
            client:      { nombre, email, telefono },
            concepto,
            total:          monto,
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
                    id:          pedidoId,
                    title:       concepto,
                    quantity:    1,
                    unit_price:  monto,
                    currency_id: "UYU"
                }],
                payer: { name: nombre, email },
                external_reference: pedidoId,
                back_urls: {
                    success: `${process.env.APP_URL}/servicio/confirmacion?status=success&pedido=${pedidoId}`,
                    failure: `${process.env.APP_URL}/servicio/confirmacion?status=failure&pedido=${pedidoId}`,
                    pending: `${process.env.APP_URL}/servicio/confirmacion?status=pending&pedido=${pedidoId}`
                },
                auto_return:      "approved",
                notification_url: `${process.env.APP_URL}/api/servicios/webhook`
            }
        })

        res.json({ init_point: prefResult.init_point, id: pedidoId })

    } catch (err) {
        console.error("Error creando link de servicio:", err.message)
        res.status(500).json({ error: "Error al crear el link de pago" })
    }
})

/* WEBHOOK MP */
router.post("/webhook", async (req, res) => {
    try {
        if (!verifyMpSignature(req)) {
            console.error("Webhook MP (servicios): firma inválida o ausente")
            return res.sendStatus(401)
        }
        res.sendStatus(200)

        const { type, data } = req.body
        if (type !== "payment") return

        const payment  = new Payment(mp)
        const pagoData = await payment.get({ id: data.id })

        const orders = loadOrders()
        const order  = orders.find(o => o.id === pagoData.external_reference && o.tipo === "servicio")
        if (!order) return

        await applyPaymentResult(orders, order, pagoData, {
            estadoAprobado: "PAGADO",
            onAprobado:     sendServicioConfirmado,
            logPrefix:      "Webhook MP (servicios)"
        })

    } catch (err) {
        console.error("Webhook error (servicios):", err.message)
    }
})

/* CONFIRMACIÓN */
router.get("/confirmacion", (req, res) => {
    const { status, pedido } = req.query
    const msgs = {
        success: { titulo: "¡Pago confirmado!", texto: "Gracias por tu pago. Te enviamos la confirmación por email.", color: "#2a8a3e" },
        pending: { titulo: "Pago pendiente",     texto: "Tu pago está siendo procesado. Te confirmamos por email.", color: "#c07a00" },
        failure: { titulo: "Pago rechazado",     texto: "Hubo un problema con el pago. Podés intentarlo de nuevo con el mismo link.", color: "#c0392b" }
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
    <a href="/" class="btn">Volver</a>
</div>
</body>
</html>`)
})

/* VERIFICAR PAGO CON MP (protegido) — re-consulta el pago directo en MP por
   external_reference. Sirve para links que quedaron UNPAID porque el
   webhook nunca llegó o falló la verificación de firma. */
router.post("/:id/verificar-pago", auth, async (req, res) => {
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "servicio")
    if (!order) return res.status(404).json({ error: "Servicio no encontrado" })

    try {
        const payment  = new Payment(mp)
        const result   = await payment.search({ options: { external_reference: order.id } })
        const results  = result.results || []
        const pagoData = results.find(p => p.status === "approved") || results[0]
        if (!pagoData) return res.status(404).json({ error: "MP no tiene ningún pago registrado para este servicio" })

        const applied = await applyPaymentResult(orders, order, pagoData, {
            estadoAprobado: "PAGADO",
            onAprobado:     sendServicioConfirmado,
            logPrefix:      "Verificación MP (servicios)"
        })
        if (!applied) return res.status(409).json({ error: "El monto del pago en MP no coincide con el monto del servicio" })

        res.json(order)
    } catch (err) {
        console.error("Error verificando pago en MP:", err.message)
        res.status(500).json({ error: "Error al consultar MP" })
    }
})

/* ADMIN: ACTUALIZAR ESTADO */
router.put("/:id/status", auth, (req, res) => {
    if (!SERVICIO_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: "status inválido" })
    }
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "servicio")
    if (!order) return res.status(404).json({ error: "Servicio no encontrado" })
    order.status     = req.body.status
    order.updated_at = new Date()
    saveOrders(orders)
    res.json(order)
})

/* ADMIN: ELIMINAR */
router.delete("/:id", auth, (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.id === req.params.id && o.tipo === "servicio")
    if (index === -1) return res.status(404).json({ error: "Servicio no encontrado" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

export default router
