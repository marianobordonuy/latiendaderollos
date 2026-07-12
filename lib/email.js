import nodemailer from "nodemailer"

export const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
})

const FROM = "La Tienda de Rollos <hola@latiendaderollos.com>"

export async function sendOrdenRecibida(order) {
    const trackingUrl = `${process.env.APP_URL}/#tracking`
    await transporter.sendMail({
        from:    FROM,
        to:      order.client.email,
        subject: "Recibimos tu rollo — La Tienda de Rollos",
        text:    `Hola ${order.client.name}!

Recibimos tu rollo para revelar. Podés seguir el estado de tu pedido en cualquier momento con el siguiente código:

Código de seguimiento: ${order.public_code}

Consultá el estado acá:
${trackingUrl}

Ingresá el código ${order.public_code} en el campo de búsqueda.

Rollo: ${order.film.roll}
Proceso: ${order.film.process}
Entrega estimada: ${order.delivery_date || "a confirmar"}

Gracias por elegirnos!
La Tienda de Rollos
Punta del Este, Uruguay`
    })
}

export async function sendScansReady(email, link, order = null) {
    const retiro = order
        ? `\n\nAdemás, ya podés pasar a retirar tu negativo revelado por Calle 24 esq. 28, Galería Paseo del Mar, local 114.${order.public_code ? `\nCódigo de tu pedido: ${order.public_code}` : ""}`
        : ""

    await transporter.sendMail({
        from:    FROM,
        to:      email,
        bcc:     process.env.BCC_EMAIL,
        subject: "Tus fotos están listas",
        text:    `Tus fotos están listas.\n\nDescargar:\n${link}\n\nTus fotos estarán disponibles por 2 semanas (14 días).${retiro}\n\nGracias por elegirnos!\nLa Tienda de Rollos\nPunta del Este, Uruguay`
    })
}

export async function sendImpresionConfirmada(order) {
    await transporter.sendMail({
        from:    FROM,
        to:      order.client.email,
        subject: "Pedido de copias confirmado",
        text:    `Hola ${order.client.nombre}!\n\nRecibimos tu pedido de copias fotográficas (${order.id}).\n\nCuando estén listas te avisamos.\n\nGracias!\nLa Tienda de Rollos\nPunta del Este, Uruguay`
    })
}

export async function sendTallerConfirmado(order) {
    const t = order.taller_snapshot
    await transporter.sendMail({
        from:    FROM,
        to:      order.client.email,
        subject: "Inscripción confirmada — Taller de Fotografía Analógica",
        text:    `Hola ${order.client.nombre}!

Tu inscripción al taller "${t.nombre}" quedó confirmada.

Fecha: ${t.fecha}
Horario: ${t.horario}
Lugar: ${t.lugar}, ${t.ciudad}

Te esperamos!
La Tienda de Rollos
Punta del Este, Uruguay`
    })
}

export async function sendImpresionLista(order) {
    const lugar = order.envio === "retiro"
        ? "Podés pasar a buscarlas por Calle 24 esq. 28, Galería Paseo del Mar, local 114."
        : "Nos ponemos en contacto para coordinar el envío."

    await transporter.sendMail({
        from:    FROM,
        to:      order.client.email,
        subject: "Tus copias están listas",
        text:    `Hola ${order.client.nombre}!\n\nTus copias fotográficas están listas.\n\nPedido: ${order.id}\n\n${lugar}\n\nGracias!\nLa Tienda de Rollos\nPunta del Este, Uruguay`
    })
}