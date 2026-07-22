import { Router } from "express"
import { MercadoPagoConfig, Preference } from "mercadopago"
import { loadOrders, saveOrders } from "../lib/storage.js"
import { auth } from "../lib/auth.js"
import { createWebhookHandler, createVerificarPagoHandler } from "../lib/mp.js"
import { sendServicioConfirmado } from "../lib/email.js"
import { renderConfirmacionPage } from "../lib/confirmacionPage.js"

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
router.post("/webhook", createWebhookHandler(mp, {
    tipo:           "servicio",
    estadoAprobado: "PAGADO",
    onAprobado:     sendServicioConfirmado,
    logPrefix:      "Webhook MP (servicios)"
}))

/* CONFIRMACIÓN */
router.get("/confirmacion", (req, res) => {
    const { status, pedido } = req.query
    res.send(renderConfirmacionPage({
        status, pedido,
        mensajes: {
            success: { titulo: "¡Pago confirmado!", texto: "Gracias por tu pago. Te enviamos la confirmación por email.", color: "#2a8a3e" },
            pending: { titulo: "Pago pendiente",     texto: "Tu pago está siendo procesado. Te confirmamos por email.", color: "#c07a00" },
            failure: { titulo: "Pago rechazado",     texto: "Hubo un problema con el pago. Podés intentarlo de nuevo con el mismo link.", color: "#c0392b" }
        },
        volverA: "/"
    }))
})

/* VERIFICAR PAGO CON MP (protegido) — re-consulta el pago directo en MP por
   external_reference. Sirve para links que quedaron UNPAID porque el
   webhook nunca llegó o falló la verificación de firma. */
router.post("/:id/verificar-pago", auth, createVerificarPagoHandler(mp, {
    tipo:           "servicio",
    estadoAprobado: "PAGADO",
    onAprobado:     sendServicioConfirmado,
    logPrefix:      "Verificación MP (servicios)",
    notFoundMsg:    "Servicio no encontrado",
    noPaymentMsg:   "MP no tiene ningún pago registrado para este servicio",
    mismatchMsg:    "El monto del pago en MP no coincide con el monto del servicio"
}))

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
