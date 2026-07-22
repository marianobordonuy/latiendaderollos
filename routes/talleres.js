import { Router } from "express"
import rateLimit from "express-rate-limit"
import { MercadoPagoConfig, Preference } from "mercadopago"
import { loadOrders, saveOrders, loadTalleres, saveTalleres } from "../lib/storage.js"
import { auth } from "../lib/auth.js"
import { createWebhookHandler, createVerificarPagoHandler } from "../lib/mp.js"
import { sendTallerConfirmado } from "../lib/email.js"
import { notificarAdmin } from "../lib/sms.js"
import { renderConfirmacionPage } from "../lib/confirmacionPage.js"

function avisoAdminTaller(order) {
    return notificarAdmin(`Nueva inscripción pagada: ${order.client.nombre} — ${order.taller_snapshot?.nombre || order.taller_id} ($${order.total} UYU)`)
}

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
router.post("/webhook", createWebhookHandler(mp, {
    tipo:           "taller",
    estadoAprobado: "CONFIRMADO",
    onAprobado:     sendTallerConfirmado,
    onAdmin:        avisoAdminTaller,
    logPrefix:      "Webhook MP (talleres)"
}))

/* CONFIRMACIÓN */
router.get("/confirmacion", (req, res) => {
    const { status, pedido } = req.query
    res.send(renderConfirmacionPage({
        status, pedido,
        mensajes: {
            success: { titulo: "¡Inscripción confirmada!", texto: "Recibimos tu pago. Te esperamos en el taller.", color: "#2a8a3e" },
            pending: { titulo: "Pago pendiente",           texto: "Tu pago está siendo procesado. Te confirmamos por email.", color: "#c07a00" },
            failure: { titulo: "Pago rechazado",           texto: "Hubo un problema con el pago. Podés intentarlo de nuevo.", color: "#c0392b" }
        },
        volverA: "/taller.html"
    }))
})

/* VERIFICAR PAGO CON MP (protegido) — re-consulta el pago directo en MP por
   external_reference. Sirve para inscripciones que quedaron UNPAID porque el
   webhook nunca llegó o falló la verificación de firma. */
router.post("/:id/verificar-pago", auth, createVerificarPagoHandler(mp, {
    tipo:           "taller",
    estadoAprobado: "CONFIRMADO",
    onAprobado:     sendTallerConfirmado,
    onAdmin:        avisoAdminTaller,
    logPrefix:      "Verificación MP (talleres)",
    notFoundMsg:    "Inscripción no encontrada",
    noPaymentMsg:   "MP no tiene ningún pago registrado para esta inscripción",
    mismatchMsg:    "El monto del pago en MP no coincide con el total de la inscripción"
}))

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
