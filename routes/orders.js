import { Router } from "express"
import { loadOrders, saveOrders, generateHexCode } from "../lib/storage.js"
import { sendOrdenRecibida } from "../lib/email.js"
import { auth } from "../lib/auth.js"
import { ORDER_STATUSES } from "../lib/orderStatuses.js"

const router = Router()

/* Todas las rutas de este router son de administración */
router.use(auth)

const DIAS_ENTREGA_DEFAULT = 7

function fechaEntregaDefault() {
    const d = new Date()
    d.setDate(d.getDate() + DIAS_ENTREGA_DEFAULT)
    return d.toISOString().slice(0, 10)
}

/* CREATE ORDER */
router.post("/", (req, res) => {
    const orders = loadOrders()
    const order  = {
        id:           `LAB-${Date.now()}`,
        twin_check:   req.body.twin_check,
        public_code:  generateHexCode(orders.map(o => o.public_code)),
        client: {
            name:  req.body.name,
            email: req.body.email,
            phone: req.body.phone
        },
        film: {
            roll:    req.body.roll,
            process: req.body.process,
            quality: req.body.quality
        },
        status:         "RECEIVED",
        payment_status: "UNPAID",
        delivery_date:  req.body.delivery_date || fechaEntregaDefault(),
        timeline:       [{ status: "RECEIVED", date: new Date() }],
        created_at:     new Date(),
        updated_at:     new Date()
    }
    orders.push(order)
    saveOrders(orders)

    // Email automático al cliente
    if (order.client.email) {
        sendOrdenRecibida(order).catch(err =>
            console.error("Error enviando email de orden:", err.message)
        )
    }

    res.json(order)
})

/* GET ALL ORDERS */
/* GET ALL ORDERS — ?tipo= filtra en el server en vez de traer toda la
   colección y filtrar en el navegador (impresion/taller/taller_espera/
   servicio filtran por el campo tipo; "rollo" son las órdenes de rollo,
   que no tienen tipo). Sin el parámetro, se comporta como antes: todo. */
router.get("/", (req, res) => {
    const orders = loadOrders()
    const { tipo } = req.query
    if (!tipo) return res.json(orders)
    const filtered = tipo === "rollo" ? orders.filter(o => !o.tipo) : orders.filter(o => o.tipo === tipo)
    res.json(filtered)
})

/* ACTUALIZACIÓN EN LOTE (debe ir antes de /:code/status para no colisionar con esa ruta) */
router.put("/bulk/status", (req, res) => {
    const { codes, status } = req.body

    if (!Array.isArray(codes) || codes.length === 0) {
        return res.status(400).json({ error: "Se espera un array de códigos" })
    }
    if (!ORDER_STATUSES.includes(status)) {
        return res.status(400).json({ error: "status inválido" })
    }

    const orders = loadOrders()
    let updated = 0

    for (const code of codes) {
        const order = orders.find(o => o.public_code === code)
        if (!order) continue
        order.status     = status
        order.updated_at = new Date()
        order.timeline    = order.timeline || []
        order.timeline.push({ status, date: new Date() })
        updated++
    }

    saveOrders(orders)
    res.json({ updated })
})

/* UPDATE STATUS */
router.put("/:code/status", (req, res) => {
    if (!ORDER_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: "status inválido" })
    }
    const orders = loadOrders()
    const order  = orders.find(o => o.public_code === req.params.code)
    if (!order) return res.status(404).json({ error: "Order not found" })
    order.status     = req.body.status
    order.updated_at = new Date()
    order.timeline    = order.timeline || []
    order.timeline.push({ status: req.body.status, date: new Date() })
    saveOrders(orders)
    res.json(order)
})

const VALID_PAYMENT_STATUSES = ["UNPAID", "PAID"]

/* UPDATE PAYMENT */
router.put("/:code/payment", (req, res) => {
    if (!VALID_PAYMENT_STATUSES.includes(req.body.payment_status)) {
        return res.status(400).json({ error: "payment_status inválido" })
    }
    const orders = loadOrders()
    const order  = orders.find(o => o.public_code === req.params.code)
    if (!order) return res.status(404).json({ error: "Order not found" })
    order.payment_status = req.body.payment_status
    order.updated_at     = new Date()
    saveOrders(orders)
    res.json(order)
})

/* DELETE ORDER */
router.delete("/:code", (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.public_code === req.params.code)
    if (index === -1) return res.status(404).json({ error: "Order not found" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

export default router