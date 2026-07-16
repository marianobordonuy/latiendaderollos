import crypto from "crypto"
import { saveOrders } from "./storage.js"

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
export async function applyPaymentResult(orders, order, pagoData, { estadoAprobado, onAprobado, logPrefix }) {
    const estado = pagoData.status

    if (estado === "approved" && pagoData.transaction_amount !== order.total) {
        console.error(`${logPrefix}: monto no coincide para ${order.id} (esperado ${order.total}, recibido ${pagoData.transaction_amount})`)
        return false
    }

    order.mp_payment_id  = pagoData.id
    order.payment_status = estado === "approved" ? "PAID" : estado.toUpperCase()
    order.updated_at     = new Date()
    if (estado === "approved" && order.status === "PENDIENTE_PAGO") order.status = estadoAprobado
    saveOrders(orders)

    if (estado === "approved" && order.client.email) {
        try { await onAprobado(order) } catch (e) { console.error("Error enviando email:", e.message) }
    }

    return true
}
