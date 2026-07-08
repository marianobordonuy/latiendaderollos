import fs from "fs"
import { s3, BUCKETS } from "./s3.js"
import { Upload } from "@aws-sdk/lib-storage"
import { ORDERS_FILE, PRECIOS_FILE } from "./storage.js"

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

    try {
        const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"))

        const filmOrders  = orders.filter(o => !o.tipo || o.tipo !== "impresion")
        const printOrders = orders.filter(o => o.tipo === "impresion")

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