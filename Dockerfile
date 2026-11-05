# Aurora Cloud Relay — free-tier deploy image
# Works on: Render (free web service), Koyeb, Railway, Fly.io, HF Spaces, any Docker host.
# Node (not Bun) because Baileys' websocket stack is battle-tested on Node.
FROM node:20-alpine

WORKDIR /app
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Install git and build essentials needed for git dependencies (e.g. libsignal-node)
RUN apk add --no-cache git python3 make g++

# install deps first (cached layer)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
RUN mkdir -p /app/data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
