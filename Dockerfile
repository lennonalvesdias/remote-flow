FROM node:20-slim

WORKDIR /app

# Instala o opencode CLI globalmente no container Linux
RUN npm install -g opencode-ai@latest

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || 9090) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
