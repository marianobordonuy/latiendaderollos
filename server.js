import "dotenv/config"
import express from "express"
import path from "path"
import { fileURLToPath } from "url"
import basicAuth from "express-basic-auth"

import ordersRouter   from "./routes/orders.js"
import scansRouter    from "./routes/scans.js"
import imprimirRouter from "./routes/imprimir.js"
import preciosRouter  from "./routes/precios.js"
import { startBackupScheduler } from "./lib/backup.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 8080

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

/* =========================
   BASIC AUTH
========================= */

const auth = basicAuth({
    users:     { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true
})

app.use([
    "/dashboard.html",
    "/api/orders",
    "/panel",
    "/panel.html",
    "/upload",
    "/api/imprimir/foto",
    "/api/precios"
], auth)

// PUT de precios también protegido (GET es público)
app.put("/api/precios", auth)

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
app.use("/api/status",   ordersRouter)  // alias público para tracking
app.use("/api/precios",  preciosRouter)
app.use("/upload",       scansRouter)
app.use("/api/imprimir", imprimirRouter)
app.use("/imprimir",     imprimirRouter)
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

process.on("uncaughtException",  err => console.error("UNCAUGHT:", err.message))
process.on("unhandledRejection", err => console.error("UNHANDLED:", err?.message || err))

/* =========================
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`)
    startBackupScheduler()
})