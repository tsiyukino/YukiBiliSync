FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# TLS certs and env vars are mounted/injected at runtime — not baked in.
# Required env vars: TURN_SECRET, TURN_HOST, TLS_CERT, TLS_KEY, PORT (optional, default 8443)

EXPOSE 8443

CMD ["node", "src/server.js"]
