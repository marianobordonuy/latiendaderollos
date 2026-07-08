FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV PORT=8080

EXPOSE 8080

# Script de inicio que crea archivos por defecto si no existen
CMD ["sh", "-c", "\
    mkdir -p /data && \
    [ -f /data/orders.json ]  || echo '[]' > /data/orders.json && \
    [ -f /data/precios.json ] || echo '{\"10x15\":60,\"13x18\":90,\"15x21\":120,\"20x30\":180}' > /data/precios.json && \
    node server.js \
"]