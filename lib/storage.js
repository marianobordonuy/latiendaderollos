import fs from "fs"
import path from "path"
import crypto from "crypto"

export const DATA_DIR    = "/data"
export const ORDERS_FILE = path.join(DATA_DIR, "orders.json")
export const PRECIOS_FILE = path.join(DATA_DIR, "precios.json")

export const PRECIOS_DEFAULT = {
    "10x15": 60,
    "13x18": 90,
    "15x21": 120,
    "20x30": 180
}

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
    return JSON.parse(fs.readFileSync(PRECIOS_FILE, "utf8"))
}

export function savePrecios(data) {
    ensureDataFile()
    fs.writeFileSync(PRECIOS_FILE, JSON.stringify(data, null, 2))
}

export function generateHexCode() {
    return Math.random().toString(16).slice(2, 8).toUpperCase()
}