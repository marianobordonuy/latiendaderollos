import "dotenv/config"
import express from "express"
import path from "path"
import { fileURLToPath } from "url"

import ordersRouter   from "./routes/orders.js"
import trackingRouter from "./routes/tracking.js"
import scansRouter    from "./routes/scans.js"
import imprimirRouter from "./routes/imprimir.js"
import preciosRouter  from "./routes/precios.js"
import talleresRouter from "./routes/talleres.js"
import serviciosRouter from "./routes/servicios.js"
import estacionRouter from "./routes/estacion.js"
import { startBackupScheduler } from "./lib/backup.js"
import { auth } from "./lib/auth.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 8080

// Fly pone la app detrás de su proxy de borde, que agrega X-Forwarded-For.
// Sin esto, express-rate-limit tira ERR_ERL_UNEXPECTED_X_FORWARDED_FOR y
// cae la request en cualquier ruta con rate limit (pedido, webhook, upload).
app.set("trust proxy", 1)

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

/* =========================
   BASIC AUTH
   Las páginas HTML de admin se protegen acá. Las rutas de API se
   protegen dentro de cada router (viaja con la ruta sin importar
   en qué path se monte el router).
========================= */

app.use(["/dashboard.html", "/panel", "/panel.html"], auth)

/* =========================
   STATIC FILES
========================= */

app.use(express.static(path.join(__dirname, "public")))

/* =========================
   RUTAS PÁGINAS
========================= */

app.get("/dashboard.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"))
})

app.get(["/panel", "/panel.html"], (req, res) => {
    res.sendFile(path.join(__dirname, "public", "panel.html"))
})

/* =========================
   RUTAS API
========================= */

app.use("/api/orders",   ordersRouter)
app.use("/api/status",   trackingRouter)  // tracking público, solo lectura
app.use("/api/precios",  preciosRouter)
app.use("/upload",       scansRouter)
app.use("/api/imprimir", imprimirRouter)
app.use("/imprimir",     imprimirRouter)
app.use("/api/talleres", talleresRouter)
app.use("/taller",       talleresRouter)  // /taller/confirmacion (back_url de MP)
app.use("/api/servicios", serviciosRouter)
app.use("/servicio",      serviciosRouter)  // /servicio/confirmacion (back_url de MP)
app.use("/api/estacion", estacionRouter)
app.use("/",             scansRouter)  // /d/:id y /scan-status

/* =========================
   LOGOUT
========================= */

app.get("/logout", (req, res) => {
    res.set("WWW-Authenticate", 'Basic realm="Authorization Required"')
    res.status(401).send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px">
        <h1>Logged out</h1><a href="/">Return Home</a></body></html>`)
})

/* =========================
   ERROR HANDLERS
========================= */

// Manejador genérico: loguea el error completo en el server pero nunca
// expone el stack trace ni rutas internas al cliente.
app.use((err, req, res, next) => {
    console.error("Request error:", err)
    if (res.headersSent) return next(err)
    res.status(500).json({ error: "Error interno del servidor" })
})

process.on("uncaughtException",  err => console.error("UNCAUGHT:", err.message))
process.on("unhandledRejection", err => console.error("UNHANDLED:", err?.message || err))

/* =========================
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`)
    startBackupScheduler()
})