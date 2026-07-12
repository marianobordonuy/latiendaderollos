import { Router } from "express"
import crypto from "crypto"
import rateLimit from "express-rate-limit"
import { loadOrders, saveOrders } from "../lib/storage.js"
import { ORDER_STATUSES } from "../lib/orderStatuses.js"

const router = Router()

const STATUSES = ORDER_STATUSES
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000 // 12hs, dura un turno de laboratorio

/* =========================
   SESIÓN POR PIN (cookie firmada, sin dependencias nuevas)
========================= */

function getCookie(req, name) {
    const header = req.headers.cookie
    if (!header) return null
    const found = header.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="))
    return found ? decodeURIComponent(found.slice(name.length + 1)) : null
}

function safeCompare(a, b) {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

function signSession(exp) {
    return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(String(exp)).digest("hex")
}

function estacionAuth(req, res, next) {
    const token = getCookie(req, "estacion_session")
    if (!token) return res.status(401).json({ error: "PIN requerido" })

    const [expStr, sig] = token.split(".")
    const exp = Number(expStr)
    if (!exp || Date.now() > exp || !sig || !safeCompare(sig, signSession(exp))) {
        return res.status(401).json({ error: "Sesión vencida, ingresá el PIN de nuevo" })
    }
    next()
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 })

router.post("/login", loginLimiter, (req, res) => {
    if (!process.env.STATION_PIN || !process.env.SESSION_SECRET) {
        return res.status(503).json({ error: "Estación no configurada (falta STATION_PIN o SESSION_SECRET)" })
    }
    if (!safeCompare(String(req.body.pin || ""), process.env.STATION_PIN)) {
        return res.status(401).json({ error: "PIN incorrecto" })
    }

    const exp = Date.now() + SESSION_MAX_AGE
    res.cookie("estacion_session", `${exp}.${signSession(exp)}`, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: SESSION_MAX_AGE
    })
    res.json({ ok: true })
})

router.post("/logout", (req, res) => {
    res.clearCookie("estacion_session")
    res.json({ ok: true })
})

router.get("/session", estacionAuth, (req, res) => {
    res.json({ ok: true })
})

/* =========================
   BÚSQUEDA Y AVANCE DE ESTADO
========================= */

// Solo pedidos de rollo (sin tipo) tienen twin_check; se ignoran impresión/taller.
function buscarOrden(orders, twin) {
    const candidatos = orders.filter(o =>
        !o.tipo && (o.twin_check === twin || o.public_code === twin)
    )
    if (candidatos.length === 0) return null
    return candidatos.find(o => o.status !== "DELIVERED") || candidatos[candidatos.length - 1]
}

router.get("/orden/:twin", estacionAuth, (req, res) => {
    const order = buscarOrden(loadOrders(), req.params.twin.trim())
    if (!order) return res.status(404).json({ error: "No encontrado" })

    const idx = STATUSES.indexOf(order.status)
    res.json({
        public_code: order.public_code,
        twin_check:  order.twin_check,
        client_name: order.client?.name,
        roll:        order.film?.roll,
        process:     order.film?.process,
        quality:     order.film?.quality,
        status:      order.status,
        next_status: idx >= 0 && idx < STATUSES.length - 1 ? STATUSES[idx + 1] : null
    })
})

router.put("/orden/:twin/avanzar", estacionAuth, (req, res) => {
    const orders = loadOrders()
    const order  = buscarOrden(orders, req.params.twin.trim())
    if (!order) return res.status(404).json({ error: "No encontrado" })

    const idx = STATUSES.indexOf(order.status)
    if (idx === -1 || idx === STATUSES.length - 1) {
        return res.status(400).json({ error: "Ya está en el último estado" })
    }

    order.status     = STATUSES[idx + 1]
    order.updated_at = new Date()
    order.timeline    = order.timeline || []
    order.timeline.push({ status: order.status, date: new Date() })
    saveOrders(orders)

    const idx2 = STATUSES.indexOf(order.status)
    res.json({
        public_code: order.public_code,
        client_name: order.client?.name,
        roll:        order.film?.roll,
        status:      order.status,
        next_status: idx2 < STATUSES.length - 1 ? STATUSES[idx2 + 1] : null
    })
})

export default router
