import { Router } from "express"
import { loadPrecios, savePrecios } from "../lib/storage.js"

const router = Router()

/* GET PRECIOS (público) */
router.get("/", (req, res) => {
    res.json(loadPrecios())
})

/* UPDATE PRECIOS (protegido en server.js) */
router.put("/", (req, res) => {
    const precios = req.body
    for (const [size, precio] of Object.entries(precios)) {
        if (typeof precio !== "number" || precio <= 0) {
            return res.status(400).json({ error: `Precio inválido para ${size}` })
        }
    }
    savePrecios(precios)
    res.json(precios)
})

export default router