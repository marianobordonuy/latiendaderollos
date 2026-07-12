import fs from "fs"
import path from "path"
import crypto from "crypto"

export const DATA_DIR     = "/data"
export const ORDERS_FILE  = path.join(DATA_DIR, "orders.json")
export const PRECIOS_FILE = path.join(DATA_DIR, "precios.json")
export const TALLERES_FILE = path.join(DATA_DIR, "talleres.json")

export const PRECIOS_DEFAULT = {
    "10x15": { precio: 60,  activo: true  },
    "13x18": { precio: 90,  activo: true  },
    "15x21": { precio: 120, activo: true  },
    "20x30": { precio: 180, activo: false }
}

export const TALLERES_DEFAULT = [
    {
        id:       "taller-2026-06-27",
        nombre:   "Curso regular",
        fecha:    "27 de junio + 4, 11, 18 y 25 de julio",
        horario:  "10:00 a 13:00 hs",
        lugar:    "Galería Paseo del Mar, 1er piso, local 114",
        ciudad:   "Punta del Este",
        cupo:     4,
        duracion: "5 clases",
        incluye:  "2 rollos ByN + 1 rollo Cine/Color + químicos + papel fotográfico",
        precio:   8820,
        activo:   true
    }
]

export function ensureDataFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]")
}

export function loadOrders() {
    ensureDataFile()
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"))
}

export function saveOrders(data) {
    ensureDataFile()
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2))
}

export function loadPrecios() {
    ensureDataFile()
    if (!fs.existsSync(PRECIOS_FILE)) {
        fs.writeFileSync(PRECIOS_FILE, JSON.stringify(PRECIOS_DEFAULT, null, 2))
    }
    const data = JSON.parse(fs.readFileSync(PRECIOS_FILE, "utf8"))

    // Migración de formato viejo (tamaño -> número) a { precio, activo }
    let migrated = false
    for (const [size, val] of Object.entries(data)) {
        if (typeof val === "number") {
            data[size] = { precio: val, activo: true }
            migrated = true
        }
    }
    if (migrated) savePrecios(data)

    return data
}

export function savePrecios(data) {
    ensureDataFile()
    fs.writeFileSync(PRECIOS_FILE, JSON.stringify(data, null, 2))
}

export function loadTalleres() {
    ensureDataFile()
    if (!fs.existsSync(TALLERES_FILE)) {
        fs.writeFileSync(TALLERES_FILE, JSON.stringify(TALLERES_DEFAULT, null, 2))
    }
    return JSON.parse(fs.readFileSync(TALLERES_FILE, "utf8"))
}

export function saveTalleres(data) {
    ensureDataFile()
    fs.writeFileSync(TALLERES_FILE, JSON.stringify(data, null, 2))
}

export function generateHexCode(existingCodes = []) {
    let code
    do {
        code = crypto.randomBytes(3).toString("hex").toUpperCase()
    } while (existingCodes.includes(code))
    return code
}
