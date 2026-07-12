import { Router } from "express"
import rateLimit from "express-rate-limit"
import { loadOrders } from "../lib/storage.js"

const router = Router()

const trackingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 })

/* PUBLIC TRACKING (sin datos de cliente) */
router.get("/:code", trackingLimiter, (req, res) => {
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

export default router
