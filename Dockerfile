FROM node:22-alpine

# Install system dependencies: ffmpeg-free runtime (crypto/torrent/buddy
# need only HTTPS fetch + CA certs; SVGs are generated, not transcoded)
RUN apk add --no-cache \
    curl \
    ca-certificates

WORKDIR /app

# Copy dependency specifications and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Default environment variables
ENV NODE_ENV=production
ENV GUPT_RELAY="https://1.rabta.space"
ENV POLL_INTERVAL_MS=2500

CMD ["node", "src/index.js"]
