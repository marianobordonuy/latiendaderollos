import fs from "fs"
import path from "path"
import { s3, BUCKETS } from "./s3.js"
import { Upload } from "@aws-sdk/lib-storage"
import { PRECIOS_FILE, DATA_DIR, loadOrders } from "./storage.js"

// Fly apaga la máquina cuando no hay tráfico (auto_stop_machines) y la
// vuelve a prender con cada visita — cada arranque llama a runBackup() de
// nuevo. Este marcador persiste en el volumen /data entre reinicios y guarda
// la fecha (no una ventana de horas) del último backup: como mucho uno por
// día calendario, sin aritmética de reloj que se pueda desalinear.
const LAST_BACKUP_FILE = path.join(DATA_DIR, ".last_backup")

// Uruguay es UTC-3 todo el año (sin horario de verano). Si compráramos la
// fecha en UTC puro, el "día" cambiaría a las 21:00 hora local en vez de a
// medianoche, y dos backups disparados cerca de ese horario (ej. un reinicio
// del server) podrían caer en fechas UTC distintas y correr los dos.
const UY_OFFSET_MS = 3 * 60 * 60 * 1000

function hoy() {
    return new Date(Date.now() - UY_OFFSET_MS).toISOString().slice(0, 10) // YYYY-MM-DD (hora UY)
}

function backupHoy() {
    if (!fs.existsSync(LAST_BACKUP_FILE)) return false
    return fs.readFileSync(LAST_BACKUP_FILE, "utf8").trim() === hoy()
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

    if (backupHoy()) {
        console.log("[backup] ya se corrió hoy, salteando")
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

        fs.writeFileSync(LAST_BACKUP_FILE, hoy())
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