function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

/* Evita path traversal / zip-slip: se queda solo con el nombre de archivo,
   sin componentes de directorio ni "..". */
export function sanitizeFilename(name) {
    const base = String(name).replace(/\\/g, "/").split("/").pop().replace(/^\.+/, "")
    return base || "file"
}

function dosDateTime() {
    const d    = new Date()
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
    return { date, time }
}

function crc32(buf) {
    let crc = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i]
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
}

export function buildZipBuffer(files) {
    // files: [{ name: string, data: Buffer }]
    const localHeaders = []
    const centralDir   = []
    let offset = 0

    for (const file of files) {
        const name = Buffer.from(sanitizeFilename(file.name), "utf8")
        const data = file.data
        const crc  = crc32(data)
        const { date, time } = dosDateTime()

        const local = Buffer.concat([
            Buffer.from([0x50,0x4B,0x03,0x04]),
            u16(20), u16(0), u16(0),
            u16(time), u16(date),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(name.length),
            u16(0),
            name,
            data
        ])

        localHeaders.push(local)

        centralDir.push(Buffer.concat([
            Buffer.from([0x50,0x4B,0x01,0x02]),
            u16(20), u16(20), u16(0), u16(0),
            u16(time), u16(date),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(name.length),
            u16(0), u16(0), u16(0), u16(0),
            u32(0),
            u32(offset),
            name
        ]))

        offset += local.length
    }

    const cd   = Buffer.concat(centralDir)
    const eocd = Buffer.concat([
        Buffer.from([0x50,0x4B,0x05,0x06]),
        u16(0), u16(0),
        u16(files.length),
        u16(files.length),
        u32(cd.length),
        u32(offset),
        u16(0)
    ])

    return Buffer.concat([...localHeaders, cd, eocd])
}