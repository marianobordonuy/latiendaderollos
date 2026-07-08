import { Router } from "express"
import { loadOrders, saveOrders, generateHexCode } from "../lib/storage.js"
import { sendOrdenRecibida } from "../lib/email.js"

const router = Router()

/* CREATE ORDER */
router.post("/", (req, res) => {
    const orders = loadOrders()
    const order  = {
        id:           `LAB-${Date.now()}`,
        twin_check:   req.body.twin_check,
        public_code:  generateHexCode(),
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
        delivery_date:  req.body.delivery_date,
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
router.get("/", (req, res) => {
    res.json(loadOrders())
})

/* PUBLIC TRACKING */
router.get("/status/:code", (req, res) => {
    const order = loadOrders().find(o => o.public_code === req.params.code)
    if (!order) return res.status(404).json({ error: "Order not found" })
    res.json({
        public_code:   order.public_code,
        status:        order.status,
        film:          order.film,
        delivery_date: order.delivery_date,
        timeline:      order.timeline
    })
})

/* UPDATE STATUS */
router.put("/:code/status", (req, res) => {
    const orders = loadOrders()
    const order  = orders.find(o => o.public_code === req.params.code)
    if (!order) return res.status(404).json({ error: "Order not found" })
    order.status     = req.body.status
    order.updated_at = new Date()
    order.timeline.push({ status: req.body.status, date: new Date() })
    saveOrders(orders)
    res.json(order)
})

/* UPDATE PAYMENT */
router.put("/:code/payment", (req, res) => {
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