FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV PORT=8080

EXPOSE 8080

# lib/storage.js crea /data, orders.json y precios.json por defecto en el primer uso
CMD ["node", "server.js"]