import { Router } from "express"
import multer from "multer"
import { MercadoPagoConfig, Preference, Payment } from "mercadopago"
import fs from "fs"
import crypto from "crypto"
import { loadOrders, saveOrders, loadPrecios } from "../lib/storage.js"
import { uploadToR2, BUCKETS } from "../lib/s3.js"
import { sendImpresionConfirmada, sendImpresionLista } from "../lib/email.js"

const router = Router()

const mp = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
})

const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 500 * 1024 * 1024, files: 50 }
})

/* VER FOTO (protegido en server.js) */
router.get("/foto/:key", (req, res) => {
    const key = decodeURIComponent(req.params.key)
    res.redirect(`${process.env.R2_PUBLIC_URL_PRINTS}/${key}`)
})

/* UPDATE STATUS (protegido en server.js) */
router.put("/:id/status", async (req, res) => {
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "impresion")
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" })

    const prevStatus = order.status
    order.status     = req.body.status
    order.updated_at = new Date()
    saveOrders(orders)

    if (req.body.status === "LISTO" && prevStatus !== "LISTO" && order.client.email) {
        try {
            await sendImpresionLista(order)
        } catch (e) {
            console.error("Error enviando email:", e.message)
        }
    }

    res.json(order)
})

/* DELETE (protegido en server.js) */
router.delete("/:id", (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.id === req.params.id && o.tipo === "impresion")
    if (index === -1) return res.status(404).json({ error: "Pedido no encontrado" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

/* CREAR PEDIDO */
router.post("/pedido", upload.array("fotos"), async (req, res) => {
    try {
        const body = JSON.parse(req.body.data)
        const { nombre, email, telefono, envio, nota, items } = body

        if (!nombre || !email || !items?.length) {
            return res.status(400).json({ error: "Faltan datos" })
        }

        // Calcular total y generar ID antes del upload
        const PRECIOS  = loadPrecios()
        const total    = items.reduce((sum, item) => sum + (PRECIOS[item.size] || 0) * item.qty, 0)
        const pedidoId = `IMP-${Date.now()}`

        // Subir fotos a R2 bucket film-prints organizadas por pedido
        const fotoLinks = []
        for (const file of req.files) {
            const ext = file.originalname.split(".").pop().toLowerCase()
            if (!["jpg","jpeg","png","tif","tiff"].includes(ext)) continue
            const key = `${pedidoId}/${file.originalname}`
            await uploadToR2({
                bucket:      BUCKETS.prints,
                key,
                body:        fs.createReadStream(file.path),
                contentType: file.mimetype
            })
            fotoLinks.push({ key, name: file.originalname })
        }

        // Guardar pedido
        const orders = loadOrders()
        orders.push({
            id:          pedidoId,
            tipo:        "impresion",
            public_code: pedidoId,
            client:      { nombre, email, telefono },
            items, fotos: fotoLinks, envio, nota, total,
            status:         "PENDIENTE_PAGO",
            payment_status: "UNPAID",
            mp_payment_id:  null,
            created_at:     new Date(),
            updated_at:     new Date()
        })
        saveOrders(orders)

        // Crear preferencia MP
        const preference = new Preference(mp)
        const mpItems    = items.map(item => ({
            id:          item.size,
            title:       `Copia ${item.size} cm`,
            quantity:    item.qty,
            unit_price:  PRECIOS[item.size],
            currency_id: "UYU"
        }))

        const prefResult = await preference.create({
            body: {
                items:      mpItems,
                payer:      { name: nombre, email },
                external_reference: pedidoId,
                back_urls: {
                    success: `${process.env.APP_URL}/imprimir/confirmacion?status=success&pedido=${pedidoId}`,
                    failure: `${process.env.APP_URL}/imprimir/confirmacion?status=failure&pedido=${pedidoId}`,
                    pending: `${process.env.APP_URL}/imprimir/confirmacion?status=pending&pedido=${pedidoId}`
                },
                auto_return:      "approved",
                notification_url: `${process.env.APP_URL}/api/imprimir/webhook`
            }
        })

        res.json({ init_point: prefResult.init_point })

    } catch (err) {
        console.error("Error creando pedido:", err.message)
        res.status(500).json({ error: "Error al crear el pedido" })
    } finally {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch {} })
    }
})

/* WEBHOOK MP */
router.post("/webhook", async (req, res) => {
    try {
        res.sendStatus(200)
        const { type, data } = req.body
        if (type !== "payment") return

        const payment  = new Payment(mp)
        const pagoData = await payment.get({ id: data.id })
        const pedidoId = pagoData.external_reference
        const estado   = pagoData.status

        const orders = loadOrders()
        const order  = orders.find(o => o.id === pedidoId)
        if (!order) return

        order.mp_payment_id  = data.id
        order.payment_status = estado === "approved" ? "PAID" : estado.toUpperCase()
        order.updated_at     = new Date()
        if (estado === "approved") order.status = "RECIBIDO"
        saveOrders(orders)

        if (estado === "approved" && order.client.email) {
            await sendImpresionConfirmada(order)
        }

    } catch (err) {
        console.error("Webhook error:", err.message)
    }
})

/* CONFIRMACIÓN */
router.get("/confirmacion", (req, res) => {
    const { status, pedido } = req.query
    const msgs = {
        success: { titulo: "¡Pago confirmado!", texto: "Recibimos tu pedido. Te avisamos cuando tus copias estén listas.", color: "#2a8a3e" },
        pending: { titulo: "Pago pendiente",    texto: "Tu pago está siendo procesado. Te confirmamos por email.", color: "#c07a00" },
        failure: { titulo: "Pago rechazado",    texto: "Hubo un problema con el pago. Podés intentarlo de nuevo.", color: "#c0392b" }
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
    <a href="/imprimir.html" class="btn">Volver</a>
</div>
</body>
</html>`)
})

export default router