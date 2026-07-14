import fs from "fs"
import path from "path"
import crypto from "crypto"

export const DATA_DIR     = "/data"
export const ORDERS_FILE  = path.join(DATA_DIR, "orders.json")
export const PRECIOS_FILE = path.join(DATA_DIR, "precios.json")
export const TALLERES_FILE = path.join(DATA_DIR, "talleres.json")

export const PRECIOS_DEFAULT = {
    "10x15": { precio_1_20: 60,  precio_21_50: 60,  precio_51_mas: 60,  activo: true  },
    "13x18": { precio_1_20: 90,  precio_21_50: 90,  precio_51_mas: 90,  activo: true  },
    "15x21": { precio_1_20: 120, precio_21_50: 120, precio_51_mas: 120, activo: true  },
    "20x30": { precio_1_20: 180, precio_21_50: 180, precio_51_mas: 180, activo: false }
}

// Precio por unidad según la cantidad total pedida de ese tamaño (todo el
// lote paga el precio del tramo que corresponde a la cantidad, no escalonado).
export function precioUnitario(info, qty) {
    if (qty > 50) return info.precio_51_mas
    if (qty > 20) return info.precio_21_50
    return info.precio_1_20
}

export const TALLERES_DEFAULT = [
    {
        id:           "taller-2026-06-27",
        nombre:       "Curso regular",
        fecha:        "27 de junio + 4, 11, 18 y 25 de julio",
        fecha_inicio: "2026-06-27",
        horario:      "10:00 a 13:00 hs",
        lugar:        "Galería Paseo del Mar, 1er piso, local 114",
        ciudad:       "Punta del Este",
        cupo:         4,
        duracion:     "5 clases",
        incluye:      "2 rollos ByN + 1 rollo Cine/Color + químicos + papel fotográfico",
        precio:       8820,
        activo:       true
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

    // Migración de precio único a precio por tramo de cantidad
    for (const [size, val] of Object.entries(data)) {
        if (typeof val.precio_1_20 !== "number") {
            data[size] = {
                precio_1_20:   val.precio,
                precio_21_50:  val.precio,
                precio_51_mas: val.precio,
                activo:        val.activo
            }
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
