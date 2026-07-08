import { Router } from "express"
import multer from "multer"
import rateLimit from "express-rate-limit"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { buildZipBuffer } from "../lib/zip.js"
import { uploadToR2, BUCKETS } from "../lib/s3.js"
import { loadOrders, saveOrders } from "../lib/storage.js"
import { sendScansReady } from "../lib/email.js"

const router = Router()

const UPLOAD_DIR = "uploads"

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR)
fs.readdirSync(UPLOAD_DIR).forEach(file => {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file)) } catch {}
})

const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

const upload = multer({
    dest: UPLOAD_DIR + "/",
    limits: { fileSize: 6 * 1024 * 1024 * 1024, files: 160 }
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
router.post("/", uploadLimiter, upload.array("files"), async (req, res) => {
    try {
        scanLog("upload recibido")
        scanLog("files recibidos:", req.files.length)

        const totalSize = req.files.reduce((a, f) => a + f.size, 0)
        scanLog("total upload MB:", (totalSize / 1024 / 1024).toFixed(2))

        if (totalSize > 6 * 1024 * 1024 * 1024) {
            scanLog("upload demasiado grande")
            return res.status(400).send("upload demasiado grande")
        }

        const id = crypto.randomBytes(3).toString("hex")

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

        // Construir ZIP
        const zipFiles = []
        for (const file of req.files) {
            const ext = file.originalname.split(".").pop().toLowerCase()
            if (!allowedExtensions.includes(ext)) {
                throw new Error("archivo no permitido: " + file.originalname)
            }
            if (file.originalname.toLowerCase() === "data.txt") continue
            zipFiles.push({ name: file.originalname, data: fs.readFileSync(file.path) })
        }

        const zipBuffer = buildZipBuffer(zipFiles)
        scanLog("subiendo zip a R2")
        const link = await uploadToR2({ bucket: BUCKETS.scans, key: `${id}.zip`, body: zipBuffer, contentType: "application/zip" })
        scanLog("zip subido")

        // Guardar link en orden
        if (linkedOrder) {
            const orders = loadOrders()
            const order  = orders.find(o => o.public_code === linkedOrder.public_code)
            if (order) {
                order.scan_link  = link
                order.updated_at = new Date()
                saveOrders(orders)
            }
        }

        // Email
        if (email) {
            scanLog("enviando email a", email)
            await sendScansReady(email, link)
            scanLog("email enviado")
        }

        res.json({ link, linkedOrder: linkedOrder ? linkedOrder.public_code : null })

    } catch (err) {
        scanLog("ERROR:", err.message)
        res.status(500).send("error en upload")
    } finally {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch {} })
    }
})

/* DESCARGA DIRECTA */
router.get("/d/:id", (req, res) => {
    res.redirect(`${process.env.R2_PUBLIC_URL}/${req.params.id}.zip`)
})

/* LOGS POLLING */
router.get("/scan-status", (req, res) => {
    const since = Number(req.query.since || 0)
    res.json({ logs: scanLogs.slice(since), next: scanLogs.length })
})

export default router