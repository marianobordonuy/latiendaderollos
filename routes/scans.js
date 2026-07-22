import { Router } from "express"
import multer from "multer"
import rateLimit from "express-rate-limit"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { streamZip } from "../lib/zip.js"
import { uploadToR2, BUCKETS } from "../lib/s3.js"
import { loadOrders, saveOrders } from "../lib/storage.js"
import { sendScansReady } from "../lib/email.js"
import { sendSms, formatearTelefonoUY } from "../lib/sms.js"
import { auth } from "../lib/auth.js"

const router = Router()

const UPLOAD_DIR = "uploads"

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR)
fs.readdirSync(UPLOAD_DIR).forEach(file => {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file)) } catch {}
})

const uploadLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })
const descargaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 })

// El zip ahora se arma en streaming (ver lib/zip.js) y no acumula el lote
// entero en memoria, así que este límite ya no es por RAM — es solo para
// que un solo request no tarde demasiado ni ocupe todo el disco de uploads/.
const MAX_TOTAL_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024 // 1GB

const upload = multer({
    dest: UPLOAD_DIR + "/",
    limits: { fileSize: 300 * 1024 * 1024, files: 160 }
})

const allowedExtensions = [
    "jpg","jpeg","png","tif","tiff",
    "dng","nef","cr2","arw","raf","rw2","txt"
]

/* LOGS */
const scanLogs = []

export function scanLog(...args) {
    const msg = args.join(" ")
    console.log(msg)
    scanLogs.push({ time: Date.now(), msg })
    if (scanLogs.length > 200) scanLogs.shift()
}

/* UPLOAD */
router.post("/", auth, uploadLimiter, upload.array("files"), async (req, res) => {
    try {
        scanLog("upload recibido")
        scanLog("files recibidos:", req.files.length)

        const totalSize = req.files.reduce((a, f) => a + f.size, 0)
        scanLog("total upload MB:", (totalSize / 1024 / 1024).toFixed(2))

        if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
            scanLog("upload demasiado grande")
            return res.status(400).send("upload demasiado grande")
        }

        // 16 bytes (128 bits) — a diferencia del id corto de antes, este debe
        // ser público (es el link que recibe el cliente), así que la entropía
        // tiene que alcanzar para que forzarlo por fuerza bruta sea inviable.
        const id = crypto.randomBytes(16).toString("hex")

        // Parsear data.txt
        let metadata = {}
        for (const file of req.files) {
            if (file.originalname.toLowerCase() === "data.txt") {
                const content = fs.readFileSync(file.path, "utf8")
                content.split("\n").forEach(line => {
                    if (!line.includes(":")) return
                    const parts = line.split(":")
                    const key   = parts[0].trim().toLowerCase()
                    const value = parts.slice(1).join(":").trim()
                    metadata[key] = value
                })
            }
        }

        const email     = metadata.email      || null
        const subject   = metadata.subject    || "Tus fotos están listas"
        const orderCode = metadata.order_code || null

        // Vincular a orden
        let linkedOrder = null
        if (orderCode) {
            const orders = loadOrders()
            linkedOrder  = orders.find(
                o => o.public_code === orderCode || o.twin_check === orderCode
            )
            if (!linkedOrder) scanLog("order_code no encontrado:", orderCode)
            else              scanLog("vinculado a orden:", linkedOrder.public_code)
        }

        // Construir ZIP — se arma en streaming, leyendo cada archivo del
        // disco a medida que se sube (ver lib/zip.js), sin acumular el lote
        // entero en memoria.
        const filesToZip = []
        for (const file of req.files) {
            const ext = file.originalname.split(".").pop().toLowerCase()
            if (!allowedExtensions.includes(ext)) {
                throw new Error("archivo no permitido: " + file.originalname)
            }
            if (file.originalname.toLowerCase() === "data.txt") continue
            filesToZip.push({ path: file.path, name: file.originalname })
        }

        scanLog("subiendo zip a R2")
        const archive = streamZip(filesToZip)
        await uploadToR2({ bucket: BUCKETS.scans, key: `${id}.zip`, body: archive, contentType: "application/zip" })
        scanLog("zip subido")

        // Link corto con nuestro dominio en vez de la URL larga de R2 — /d/:id
        // hace de redirect (ver más abajo).
        const link = `${process.env.APP_URL}/d/${id}`

        // Guardar link en orden y avanzar el estado: el revelado digital ya
        // está entregado, queda pendiente solo el retiro físico del negativo.
        let order = null
        if (linkedOrder) {
            const orders = loadOrders()
            order = orders.find(o => o.public_code === linkedOrder.public_code)
            if (order) {
                order.scan_link  = link
                order.updated_at = new Date()
                if (!["READY", "DELIVERED"].includes(order.status)) {
                    order.status = "READY"
                    order.timeline = order.timeline || []
                    order.timeline.push({ status: "READY", date: new Date() })
                }
                saveOrders(orders)
            }
        }

        // Email
        if (email) {
            scanLog("enviando email a", email)
            await sendScansReady(email, link, order)
            scanLog("email enviado")
        }

        // SMS (opcional — solo si la orden vinculada tiene teléfono cargado).
        // Sin await a propósito: no tiene que retrasar la respuesta del
        // upload, que ya terminó con éxito llegado a este punto.
        const telefono = order?.client?.phone ? formatearTelefonoUY(order.client.phone) : null
        if (telefono) {
            sendSms(telefono, "La Tienda de Rollos: Tus rollito ya está listo. Revisá tu correo para ver el link de descarga.")
                .then(() => scanLog("SMS enviado a", telefono))
                .catch(e => scanLog("error enviando SMS:", e.message))
        }

        res.json({ link, linkedOrder: linkedOrder ? linkedOrder.public_code : null })

    } catch (err) {
        scanLog("ERROR:", err.message)
        res.status(500).send("error en upload")
    } finally {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch {} })
    }
})

/* DESCARGA DIRECTA (pública — es el link que recibe el cliente por email).
   Segura por la entropía del id (16 bytes, ver arriba), no por auth; el
   rate limit es una capa extra, no la defensa principal. */
router.get("/d/:id", descargaLimiter, (req, res) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.id)) return res.status(404).send("no encontrado")
    res.redirect(`${process.env.R2_PUBLIC_URL}/${req.params.id}.zip`)
})

/* LOGS POLLING (protegido — el log incluye emails y códigos de pedido) */
router.get("/scan-status", auth, (req, res) => {
    const since = Number(req.query.since || 0)
    res.json({ logs: scanLogs.slice(since), next: scanLogs.length })
})

export default router