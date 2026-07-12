import fs from "fs"
import path from "path"
import { s3, BUCKETS } from "./s3.js"
import { Upload } from "@aws-sdk/lib-storage"
import { PRECIOS_FILE, DATA_DIR, loadOrders } from "./storage.js"

// Fly apaga la máquina cuando no hay tráfico (auto_stop_machines) y la
// vuelve a prender con cada visita — cada arranque llama a runBackup() de
// nuevo, así que sin este freno se hacían varios backups por día en vez de
// uno. Este marcador persiste en el volumen /data entre reinicios.
const LAST_BACKUP_FILE = path.join(DATA_DIR, ".last_backup")
const MIN_INTERVAL_MS  = 20 * 60 * 60 * 1000 // ~20hs

function backupReciente() {
    if (!fs.existsSync(LAST_BACKUP_FILE)) return false
    const last = Number(fs.readFileSync(LAST_BACKUP_FILE, "utf8"))
    return Boolean(last) && (Date.now() - last) < MIN_INTERVAL_MS
}

async function uploadBackup(bucket, key, data) {
    const task = new Upload({
        client: s3,
        params: {
            Bucket:      bucket,
            Key:         key,
            Body:        Buffer.from(data),
            ContentType: "application/json"
        }
    })
    await task.done()
}

export async function runBackup() {

    const now       = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const bucket    = BUCKETS.backups

    if (!bucket) {
        console.log("[backup] R2_BUCKET_BACKUPS no configurado, salteando")
        return
    }

    if (backupReciente()) {
        console.log("[backup] ya se corrió hace menos de 20hs, salteando")
        return
    }

    try {
        // loadOrders() (a diferencia de leer el archivo directo) crea /data y
        // orders.json si todavía no existen — importante en el primer arranque.
        const orders = loadOrders()

        const filmOrders  = orders.filter(o => !o.tipo)
        const printOrders = orders.filter(o => o.tipo === "impresion")
        const tallerOrders = orders.filter(o => o.tipo === "taller" || o.tipo === "taller_espera")

        // /film-orders/
        await uploadBackup(
            bucket,
            `film-orders/${timestamp}.json`,
            JSON.stringify(filmOrders, null, 2)
        )
        console.log(`[backup] film-orders OK — ${filmOrders.length} órdenes`)

        // /print-orders/
        await uploadBackup(
            bucket,
            `print-orders/${timestamp}.json`,
            JSON.stringify(printOrders, null, 2)
        )
        console.log(`[backup] print-orders OK — ${printOrders.length} pedidos`)

        // /taller-orders/
        await uploadBackup(
            bucket,
            `taller-orders/${timestamp}.json`,
            JSON.stringify(tallerOrders, null, 2)
        )
        console.log(`[backup] taller-orders OK — ${tallerOrders.length} inscripciones`)

        // /other/ — precios
        if (fs.existsSync(PRECIOS_FILE)) {
            const precios = fs.readFileSync(PRECIOS_FILE, "utf8")
            await uploadBackup(
                bucket,
                `other/precios-${timestamp}.json`,
                precios
            )
            console.log("[backup] precios OK")
        }

        fs.writeFileSync(LAST_BACKUP_FILE, String(Date.now()))
        console.log(`[backup] completado — ${timestamp}`)

    } catch (err) {
        console.error("[backup] ERROR:", err.message)
    }
}

export function startBackupScheduler() {

    // Correr una vez al arrancar
    runBackup()

    // Después cada 24 horas
    const INTERVAL = 24 * 60 * 60 * 1000

    setInterval(runBackup, INTERVAL)

    console.log("[backup] scheduler iniciado — cada 24hs")
}