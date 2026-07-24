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
// PAID solo lo puede poner MP (webhook o "verificar pago"). Este es el único
// estado que un admin puede setear a mano, para cuando el cliente abona en
// efectivo o por transferencia fuera de MercadoPago.
const TALLER_PAYMENT_STATUSES = ["UNPAID", "PAID_CASH"]
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

/* ADMIN: MARCAR PAGO EN EFECTIVO/TRANSFERENCIA (protegido) — el estado PAID
   verificado por MercadoPago lo pone únicamente el webhook o "verificar pago
   con MP"; esto es para reflejar a mano un pago que llegó por fuera de MP. */
router.put("/:id/payment", auth, async (req, res) => {
    const nuevoEstado = req.body.payment_status
    if (!TALLER_PAYMENT_STATUSES.includes(nuevoEstado)) {
        return res.status(400).json({ error: "payment_status inválido" })
    }
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "taller")
    if (!order) return res.status(404).json({ error: "Inscripción no encontrada" })

    // Un pago ya verificado por MP nunca se pisa a mano — si hace falta
    // corregirlo, que sea desde MP, no desde este endpoint.
    if (order.payment_status === "PAID") {
        return res.status(409).json({ error: "Este pago ya está verificado por MercadoPago, no se puede sobrescribir a mano" })
    }
    if (nuevoEstado === "PAID_CASH" && order.status === "CANCELADO") {
        return res.status(400).json({ error: "No se puede marcar como pagada una inscripción cancelada" })
    }

    // Idempotencia: no reenviar el email si ya estaba marcada como pagada
    // en efectivo (ej. doble click, o reenvío del mismo valor).
    const yaEstabaPagadoCash = order.payment_status === "PAID_CASH"

    order.payment_status = nuevoEstado
    order.updated_at     = new Date()

    if (nuevoEstado === "PAID_CASH" && order.status === "PENDIENTE_PAGO") {
        order.status = "CONFIRMADO"
    }
    // Si se corrige un pago en efectivo marcado por error, se libera el
    // cupo de vuelta — de lo contrario la inscripción queda CONFIRMADO sin
    // haber pagado, ocupando un lugar para siempre.
    if (nuevoEstado === "UNPAID" && order.status === "CONFIRMADO") {
        order.status = "PENDIENTE_PAGO"
    }

    saveOrders(orders)

    if (nuevoEstado === "PAID_CASH" && !yaEstabaPagadoCash && order.client.email) {
        try { await sendTallerConfirmado(order) } catch (e) { console.error("Error enviando email:", e.message) }
    }

    res.json(order)
})

/* ADMIN: MOVER INSCRIPCIÓN A OTRO TALLER (protegido) — por si alguien se
   quiere cambiar de taller después de anotarse. No ajusta el pago: si el
   precio del taller nuevo es distinto, el total se actualiza pero hay que
   revisar la diferencia a mano. */
router.put("/:id/mover", auth, async (req, res) => {
    const { taller_id } = req.body
    if (!taller_id) return res.status(400).json({ error: "Falta taller_id" })

    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "taller")
    if (!order) return res.status(404).json({ error: "Inscripción no encontrada" })

    // No-op: si es el mismo taller que ya tenía, no hace falta reescribir
    // nada (evita pisar total/snapshot por accidente si el admin aprieta
    // "Mover" sin cambiar la selección).
    if (taller_id === order.taller_id) return res.json(order)

    const taller = loadTalleres().find(t => t.id === taller_id)
    if (!taller) return res.status(404).json({ error: "Taller no encontrado" })
    if (taller.activo === false) return res.status(400).json({ error: "Ese taller no está activo" })

    if (cuposOcupados(orders, taller_id) >= taller.cupo) {
        return res.status(400).json({ error: "No quedan cupos disponibles en ese taller" })
    }

    const yaPagado       = order.payment_status === "PAID" || order.payment_status === "PAID_CASH"
    const precioAnterior = order.total

    order.taller_id        = taller_id
    order.taller_snapshot  = {
        nombre:   taller.nombre,
        fecha:    taller.fecha,
        horario:  taller.horario,
        lugar:    taller.lugar,
        ciudad:   taller.ciudad,
        precio:   taller.precio,
        duracion: taller.duracion
    }
    order.total      = taller.precio
    order.updated_at = new Date()
    saveOrders(orders)

    // Si ya había pagado, avisarle por email del taller/fecha nuevo — si no
    // pagó todavía, no hace falta (todavía no está "confirmado" nada).
    if (yaPagado && order.client.email) {
        try { await sendTallerConfirmado(order) } catch (e) { console.error("Error enviando email:", e.message) }
    }

    const aviso = (yaPagado && precioAnterior !== taller.precio)
        ? `El precio del taller nuevo ($${taller.precio}) es distinto al que ya pagó ($${precioAnterior}) — revisá la diferencia con el cliente.`
        : undefined

    res.json({ ...order, aviso })
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
