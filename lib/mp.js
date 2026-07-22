import crypto from "crypto"
import { Payment } from "mercadopago"
import { loadOrders, saveOrders } from "./storage.js"

/* Verifica la firma x-signature enviada por Mercado Pago.
   Requiere MP_WEBHOOK_SECRET (secreto de la integración, panel de MP). */
export function verifyMpSignature(req) {
    const signature = req.headers["x-signature"]
    const requestId = req.headers["x-request-id"]
    const secret    = process.env.MP_WEBHOOK_SECRET

    if (!secret) {
        console.error("[MP signature] MP_WEBHOOK_SECRET no está configurado en el server")
        return false
    }
    if (!signature || !requestId) {
        console.error("[MP signature] falta header x-signature o x-request-id (notificación legacy/de prueba sin firma)")
        return false
    }

    const parts = Object.fromEntries(
        signature.split(",").map(p => p.trim().split("=").map(s => s.trim()))
    )
    const { ts, v1 } = parts
    if (!ts || !v1) {
        console.error("[MP signature] x-signature con formato inesperado:", signature)
        return false
    }

    const dataId = String(req.query["data.id"] || req.body?.data?.id || "").toLowerCase()
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
    const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex")

    const a = Buffer.from(expected)
    const b = Buffer.from(v1)
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (!valid) console.error("[MP signature] firma no coincide — MP_WEBHOOK_SECRET incorrecto para esta integración")
    return valid
}

/* Aplica el resultado de un pago de MP a una orden (webhook o verificación
   manual usan esta misma lógica): valida el monto, actualiza payment_status/
   status/mp_payment_id, guarda y dispara el email de confirmación si
   corresponde. Devuelve false si el monto no coincide (la orden no se toca). */
export async function applyPaymentResult(orders, order, pagoData, { estadoAprobado, onAprobado, onAdmin, logPrefix }) {
    const estado = pagoData.status

    // Comparación con tolerancia: los pedidos de impresión/talleres siempre
    // calculan totales enteros, pero servicios.js ahora permite montos con
    // decimales ingresados a mano — una diferencia de centésimos por
    // redondeo no debería trabar un pago que en la práctica sí coincide.
    // El margen es 0.02 (no 0.01) a propósito: el ruido de punto flotante de
    // JS puede hacer que una diferencia real de "un centavo" caiga
    // fracciones por encima de 0.01 (ej. 3500.01 - 3500 = 0.010000000000218).
    if (estado === "approved" && Math.abs(pagoData.transaction_amount - order.total) > 0.02) {
        console.error(`${logPrefix}: monto no coincide para ${order.id} (esperado ${order.total}, recibido ${pagoData.transaction_amount})`)
        return false
    }

    // Idempotencia: MP puede reentregar el mismo webhook, y el admin puede
    // apretar "verificar pago" más de una vez — no hay que reenviar el email
    // de confirmación si la orden ya estaba PAID de antes.
    const yaEstabaPagado = order.payment_status === "PAID"

    order.mp_payment_id  = pagoData.id
    order.payment_status = estado === "approved" ? "PAID" : estado.toUpperCase()
    order.updated_at     = new Date()
    if (estado === "approved" && order.status === "PENDIENTE_PAGO") order.status = estadoAprobado
    saveOrders(orders)

    if (estado === "approved" && !yaEstabaPagado) {
        if (order.client.email) {
            try { await onAprobado(order) } catch (e) { console.error("Error enviando email:", e.message) }
        }
        if (onAdmin) {
            try { await onAdmin(order) } catch (e) { console.error("Error notificando al admin:", e.message) }
        }
    }

    return true
}

/* Crea el handler de POST /webhook para un tipo de orden dado (impresión,
   taller, servicio, etc.) — antes cada router repetía este mismo bloque
   (verificar firma, parsear el payload, buscar la orden, aplicar el
   resultado) con solo el "tipo" y los callbacks cambiando. */
export function createWebhookHandler(mp, { tipo, estadoAprobado, onAprobado, onAdmin, logPrefix }) {
    return async (req, res) => {
        try {
            if (!verifyMpSignature(req)) {
                console.error(`${logPrefix}: firma inválida o ausente`)
                return res.sendStatus(401)
            }
            res.sendStatus(200)

            const { type, data } = req.body
            if (type !== "payment") return

            const payment  = new Payment(mp)
            const pagoData = await payment.get({ id: data.id })

            const orders = loadOrders()
            const order  = orders.find(o => o.id === pagoData.external_reference && o.tipo === tipo)
            if (!order) return

            await applyPaymentResult(orders, order, pagoData, { estadoAprobado, onAprobado, onAdmin, logPrefix })

        } catch (err) {
            console.error(`${logPrefix} — error:`, err.message)
        }
    }
}

/* Crea el handler de POST /:id/verificar-pago (reconciliación manual desde
   el dashboard) para un tipo de orden dado. Mismo motivo que el de arriba. */
export function createVerificarPagoHandler(mp, { tipo, estadoAprobado, onAprobado, onAdmin, logPrefix, notFoundMsg, noPaymentMsg, mismatchMsg }) {
    return async (req, res) => {
        const orders = loadOrders()
        const order  = orders.find(o => o.id === req.params.id && o.tipo === tipo)
        if (!order) return res.status(404).json({ error: notFoundMsg })

        try {
            const payment  = new Payment(mp)
            const result   = await payment.search({ options: { external_reference: order.id } })
            const results  = result.results || []
            // Puede haber más de un intento de pago (uno rechazado y otro aprobado);
            // priorizamos el aprobado en vez de tomar el primero de la lista.
            const pagoData = results.find(p => p.status === "approved") || results[0]
            if (!pagoData) return res.status(404).json({ error: noPaymentMsg })

            const applied = await applyPaymentResult(orders, order, pagoData, { estadoAprobado, onAprobado, onAdmin, logPrefix })
            if (!applied) return res.status(409).json({ error: mismatchMsg })

            res.json(order)
        } catch (err) {
            console.error("Error verificando pago en MP:", err.message)
            res.status(500).json({ error: "Error al consultar MP" })
        }
    }
}
