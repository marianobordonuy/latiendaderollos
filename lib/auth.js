import basicAuth from "express-basic-auth"

const { ADMIN_USER, ADMIN_PASS } = process.env

if (!ADMIN_USER || !ADMIN_PASS) {
    console.error("FATAL: las variables de entorno ADMIN_USER y ADMIN_PASS deben estar configuradas")
    process.exit(1)
}

export const auth = basicAuth({
    users:     { [ADMIN_USER]: ADMIN_PASS },
    challenge: true
})
