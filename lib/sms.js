// Envío de SMS vía la REST API de Twilio directo con fetch, sin agregar el
// SDK oficial como dependencia — para un solo POST no hace falta.

const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER
const ADMIN_PHONE = process.env.ADMIN_PHONE

const SMS_TIMEOUT_MS = 10000

// Aviso en el arranque si la config de Twilio quedó a medias — mejor
// enterarse acá que recién cuando falle el primer envío en producción.
const variablesTwilio = { TWILIO_ACCOUNT_SID: TWILIO_SID, TWILIO_AUTH_TOKEN: TWILIO_TOKEN, TWILIO_FROM_NUMBER: TWILIO_FROM }
const faltantes = Object.entries(variablesTwilio).filter(([, v]) => !v).map(([k]) => k)
if (faltantes.length > 0 && faltantes.length < Object.keys(variablesTwilio).length) {
    console.error(`[sms] Configuración de Twilio incompleta — falta: ${faltantes.join(", ")}`)
} else if (faltantes.length === Object.keys(variablesTwilio).length && ADMIN_PHONE) {
    console.error("[sms] ADMIN_PHONE está configurado pero Twilio no — los avisos por SMS no van a funcionar")
}

export async function sendSms(to, body) {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
        throw new Error("Twilio no está configurado (faltan variables de entorno)")
    }

    const url    = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body })
    const auth   = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")

    const res = await fetch(url, {
        method:  "POST",
        headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type":  "application/x-www-form-urlencoded"
        },
        body:   params,
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS)
    })

    if (!res.ok) {
        const detalle = await res.text().catch(() => "")
        throw new Error(`Twilio respondió ${res.status}: ${detalle}`)
    }
}

// Normaliza un teléfono cargado a mano al formato internacional E.164 que
// pide Twilio. Uruguay: +598 + el número sin el 0 inicial. Acepta tanto el
// "+" como el prefijo internacional "00" (ambos significan lo mismo). Si ya
// viene con "+" se respeta tal cual (por si algún día se admite otro país).
export function formatearTelefonoUY(telefono) {
    let limpio = String(telefono || "").replace(/[^\d+]/g, "")
    if (!limpio) return null
    if (limpio.startsWith("00")) limpio = "+" + limpio.slice(2)
    if (limpio.startsWith("+")) return limpio
    return `+598${limpio.replace(/^0+/, "")}`
}

// Aviso corto al celular del admin (vos) — no rompe el flujo si Twilio no
// está configurado o si el envío falla, solo lo deja en el log.
export async function notificarAdmin(mensaje) {
    if (!ADMIN_PHONE) {
        console.error("[sms] ADMIN_PHONE no configurado, salteando aviso")
        return
    }
    await sendSms(ADMIN_PHONE, mensaje)
}
