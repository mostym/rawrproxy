FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache \
    openssl \
    curl \
    bash

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/logs /app/data /app/certs

EXPOSE 8080 8081

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "src/server.js"]