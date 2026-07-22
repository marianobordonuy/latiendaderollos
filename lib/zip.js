import { ZipArchive } from "archiver"
import { PassThrough } from "stream"

/* Evita path traversal / zip-slip: se queda solo con el nombre de archivo,
   sin componentes de directorio ni "..". */
export function sanitizeFilename(name) {
    const base = String(name).replace(/\\/g, "/").split("/").pop().replace(/^\.+/, "")
    return base || "file"
}

// Arma el zip en streaming, leyendo cada archivo del disco a medida que se
// sube — antes se armaba un buffer completo del lote a mano (y esa
// implementación llegaba a copiar los datos ~3 veces en memoria en el pico).
// ZipArchive no es un stream real de Node (no pasa instanceof Readable, cosa
// que el SDK de AWS valida), así que lo canalizamos a través de un
// PassThrough real antes de devolverlo — eso sí lo acepta como Body.
export function streamZip(files) {
    // files: [{ path: string, name: string }]
    const archive = new ZipArchive({ zlib: { level: 0 } }) // sin compresión: son fotos, ya vienen comprimidas
    const output  = new PassThrough()

    archive.on("warning", err => { if (err.code !== "ENOENT") throw err })
    archive.on("error", err => output.destroy(err))
    archive.pipe(output)

    for (const file of files) {
        archive.file(file.path, { name: sanitizeFilename(file.name) })
    }
    archive.finalize()

    return output
}
