import { Router } from "express"
import { loadPrecios, savePrecios } from "../lib/storage.js"
import { auth } from "../lib/auth.js"

const router = Router()

/* GET PRECIOS (público) */
router.get("/", (req, res) => {
    res.json(loadPrecios())
})

/* UPDATE PRECIOS (protegido) */
router.put("/", auth, (req, res) => {
    const precios = req.body
    if (!precios || typeof precios !== "object" || Array.isArray(precios)) {
        return res.status(400).json({ error: "Body inválido" })
    }
    const entries = Object.entries(precios)
    if (entries.length === 0) {
        return res.status(400).json({ error: "No se recibieron precios" })
    }
    const TIERS = ["precio_1_20", "precio_21_50", "precio_51_mas"]
    for (const [size, info] of entries) {
        if (!info || typeof info !== "object") {
            return res.status(400).json({ error: `Precio inválido para ${size}` })
        }
        for (const tier of TIERS) {
            if (typeof info[tier] !== "number" || info[tier] <= 0) {
                return res.status(400).json({ error: `Precio inválido (${tier}) para ${size}` })
            }
        }
        if (typeof info.activo !== "boolean") {
            return res.status(400).json({ error: `Falta el estado 'activo' para ${size}` })
        }
    }
    savePrecios(precios)
    res.json(precios)
})

export default router