FROM node:20-alpine

# Playwright deps
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Find and verify chromium binary location
RUN which chromium-browser || which chromium || echo "Chromium not found"

# Set Playwright to use system chromium and skip download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

ARG AGENT_DIR
ENV AGENT_DIR=${AGENT_DIR}

WORKDIR /app

# Copy shared package.json and install deps
COPY shared/package*.json ./shared/
RUN cd shared && npm install

# Copy agent package.json and install deps inside the agent directory
# This ensures Node.js ESM resolution finds packages correctly
COPY ${AGENT_DIR}/package*.json ./${AGENT_DIR}/
RUN cd ${AGENT_DIR} && npm install

# Now copy the actual source code (this won't invalidate the npm install cache above unless package.json changed)
COPY shared ./shared
COPY ${AGENT_DIR} ./${AGENT_DIR}

# Create symlink so shared imports resolve correctly from agent dir
RUN ln -sf /app/shared /app/${AGENT_DIR}/shared 2>/dev/null || true

WORKDIR /app/${AGENT_DIR}

CMD ["node", "index.js"]
