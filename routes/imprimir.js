import { Router } from "express"
import multer from "multer"
import rateLimit from "express-rate-limit"
import { MercadoPagoConfig, Preference, Payment } from "mercadopago"
import fs from "fs"
import { loadOrders, saveOrders, loadPrecios, precioUnitario } from "../lib/storage.js"
import { uploadToR2, BUCKETS } from "../lib/s3.js"
import { sendImpresionConfirmada, sendImpresionLista } from "../lib/email.js"
import { auth } from "../lib/auth.js"
import { sanitizeFilename } from "../lib/zip.js"
import { verifyMpSignature, applyPaymentResult } from "../lib/mp.js"
import { notificarAdmin } from "../lib/sms.js"

function avisoAdminImpresion(order) {
    return notificarAdmin(`Nuevo pedido de impresión pagado: ${order.client.nombre} — $${order.total} UYU (${order.id})`)
}

const router = Router()

const mp = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
})

const pedidoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

const IMPRESION_STATUSES = ["PENDIENTE_PAGO", "RECIBIDO", "EN_PROCESO", "LISTO", "ENTREGADO"]

const MAX_FOTOS_POR_PEDIDO = 250

// El límite por archivo (500MB) y por cantidad (250) no evitan que la suma
// del pedido entero sea enorme — cada foto se sube a R2 desde disco, así
// que el riesgo real es llenar el disco de uploads/, no la RAM.
const MAX_TOTAL_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2GB

const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 500 * 1024 * 1024, files: MAX_FOTOS_POR_PEDIDO }
})

/* Envuelve multer para devolver un mensaje claro en vez del error genérico
   del handler global cuando se supera la cantidad, el tamaño o el total
   permitido. */
function subirFotos(req, res, next) {
    upload.array("fotos")(req, res, (err) => {
        if (err) {
            if (err.code === "LIMIT_FILE_COUNT") {
                return res.status(400).json({ error: `Como máximo se pueden subir ${MAX_FOTOS_POR_PEDIDO} fotos por pedido` })
            }
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ error: "Una de las fotos supera el tamaño máximo permitido (500MB)" })
            }
            console.error("Error de upload:", err.message)
            return res.status(400).json({ error: "Error al subir las fotos" })
        }

        const totalSize = (req.files || []).reduce((sum, f) => sum + f.size, 0)
        if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
            req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch {} })
            return res.status(400).json({ error: "El pedido supera el tamaño total permitido (2GB)" })
        }

        next()
    })
}

// Sube varias fotos en paralelo (no de a una, no las 250 a la vez) para que
// un pedido grande no tarde varios minutos ni abra demasiadas conexiones a
// R2 al mismo tiempo.
const CONCURRENCIA_SUBIDA = 8

// Si un worker deja que su error se propague, Promise.all corta apenas
// rechaza el primero — pero los demás workers siguen corriendo en segundo
// plano, leyendo archivos temporales que el caller puede borrar apenas
// conConcurrencia "termina". Por eso cada worker atrapa su propio error y
// sigue: la función no vuelve hasta que TODOS terminaron de verdad, y recién
// ahí se relanza el primer error si hubo alguno.
async function conConcurrencia(items, concurrencia, fn) {
    const resultados = new Array(items.length)
    const errores = []
    let index = 0
    async function worker() {
        while (index < items.length) {
            const i = index++
            try {
                resultados[i] = await fn(items[i], i)
            } catch (err) {
                errores.push(err)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrencia, items.length) }, worker))
    if (errores.length > 0) throw errores[0]
    return resultados
}

/* VER FOTO (protegido) */
router.get("/foto/:key", auth, (req, res) => {
    const key = decodeURIComponent(req.params.key)
    res.redirect(`${process.env.R2_PUBLIC_URL_PRINTS}/${key}`)
})

/* UPDATE STATUS (protegido) */
router.put("/:id/status", auth, async (req, res) => {
    if (!IMPRESION_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: "status inválido" })
    }
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

/* DELETE (protegido) */
router.delete("/:id", auth, (req, res) => {
    const orders = loadOrders()
    const index  = orders.findIndex(o => o.id === req.params.id && o.tipo === "impresion")
    if (index === -1) return res.status(404).json({ error: "Pedido no encontrado" })
    orders.splice(index, 1)
    saveOrders(orders)
    res.json({ deleted: true })
})

/* VERIFICAR PAGO CON MP (protegido) — re-consulta el pago directo en MP por
   external_reference. Sirve para pedidos que quedaron UNPAID porque el
   webhook nunca llegó o falló la verificación de firma. */
router.post("/:id/verificar-pago", auth, async (req, res) => {
    const orders = loadOrders()
    const order  = orders.find(o => o.id === req.params.id && o.tipo === "impresion")
    if (!order) return res.status(404).json({ error: "Pedido no encontrado" })

    try {
        const payment  = new Payment(mp)
        const result   = await payment.search({ options: { external_reference: order.id } })
        const results  = result.results || []
        // Puede haber más de un intento de pago (uno rechazado y otro aprobado);
        // priorizamos el aprobado en vez de tomar el primero de la lista.
        const pagoData = results.find(p => p.status === "approved") || results[0]
        if (!pagoData) return res.status(404).json({ error: "MP no tiene ningún pago registrado para este pedido" })

        const applied = await applyPaymentResult(orders, order, pagoData, {
            estadoAprobado: "RECIBIDO",
            onAprobado:     sendImpresionConfirmada,
            onAdmin:        avisoAdminImpresion,
            logPrefix:      "Verificación MP"
        })
        if (!applied) return res.status(409).json({ error: "El monto del pago en MP no coincide con el total del pedido" })

        res.json(order)
    } catch (err) {
        console.error("Error verificando pago en MP:", err.message)
        res.status(500).json({ error: "Error al consultar MP" })
    }
})

/* CREAR PEDIDO */
router.post("/pedido", pedidoLimiter, subirFotos, async (req, res) => {
    try {
        const body = JSON.parse(req.body.data)
        const { nombre, email, telefono, envio, nota, items } = body

        if (!nombre || !email || !items?.length) {
            return res.status(400).json({ error: "Faltan datos" })
        }

        // Calcular total y generar ID antes del upload
        const PRECIOS = loadPrecios()
        for (const item of items) {
            const info = PRECIOS[item.size]
            if (!info || info.activo === false) {
                return res.status(400).json({ error: `Tamaño no disponible: ${item.size}` })
            }
        }

        // El precio por unidad depende de la cantidad TOTAL pedida de ese
        // tamaño (no por foto individual) — todo el tramo paga el mismo precio.
        const qtyPorTamanio = {}
        for (const item of items) {
            qtyPorTamanio[item.size] = (qtyPorTamanio[item.size] || 0) + item.qty
        }
        const unitPriceBySize = {}
        for (const [size, qty] of Object.entries(qtyPorTamanio)) {
            unitPriceBySize[size] = precioUnitario(PRECIOS[size], qty)
        }
        const total    = Object.entries(qtyPorTamanio).reduce((sum, [size, qty]) => sum + unitPriceBySize[size] * qty, 0)
        const pedidoId = `IMP-${Date.now()}`

        // Subir fotos a R2 bucket film-prints organizadas por pedido
        const resultados = await conConcurrencia(req.files, CONCURRENCIA_SUBIDA, async (file) => {
            const ext = file.originalname.split(".").pop().toLowerCase()
            if (!["jpg","jpeg","png","tif","tiff"].includes(ext)) return null
            const key = `${pedidoId}/${sanitizeFilename(file.originalname)}`
            await uploadToR2({
                bucket:      BUCKETS.prints,
                key,
                body:        fs.createReadStream(file.path),
                contentType: file.mimetype
            })
            return { key, name: file.originalname }
        })
        const fotoLinks = resultados.filter(Boolean)

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
            unit_price:  unitPriceBySize[item.size],
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
        if (!verifyMpSignature(req)) {
            console.error("Webhook MP: firma inválida o ausente")
            return res.sendStatus(401)
        }
        res.sendStatus(200)

        const { type, data } = req.body
        if (type !== "payment") return

        const payment  = new Payment(mp)
        const pagoData = await payment.get({ id: data.id })

        const orders = loadOrders()
        const order  = orders.find(o => o.id === pagoData.external_reference && o.tipo === "impresion")
        if (!order) return

        await applyPaymentResult(orders, order, pagoData, {
            estadoAprobado: "RECIBIDO",
            onAprobado:     sendImpresionConfirmada,
            onAdmin:        avisoAdminImpresion,
            logPrefix:      "Webhook MP"
        })

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