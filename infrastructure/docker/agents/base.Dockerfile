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

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

ARG AGENT_DIR
ENV AGENT_DIR=${AGENT_DIR}

WORKDIR /app

# Copy agent package.json and install deps at root level
COPY ${AGENT_DIR}/package*.json ./
RUN npm install

# Copy shared module
COPY shared ./shared
RUN cd shared && npm install

# Copy agent source
COPY ${AGENT_DIR} ./${AGENT_DIR}

# Create symlinks so imports resolve correctly
RUN ln -sf /app/shared /app/${AGENT_DIR}/shared 2>/dev/null || true

WORKDIR /app/${AGENT_DIR}

CMD ["node", "index.js"]