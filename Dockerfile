FROM node:22-alpine

# Install system dependencies: python3, py3-pip, ffmpeg, curl, ca-certificates
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    curl \
    ca-certificates

# Install latest yt-dlp into a virtual environment
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -U yt-dlp

# Make yt-dlp available on PATH
ENV PATH="/opt/venv/bin:$PATH"

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
