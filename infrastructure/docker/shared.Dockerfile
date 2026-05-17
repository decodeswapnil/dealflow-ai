FROM node:20-alpine

WORKDIR /app

COPY shared/package*.json ./shared/
RUN cd shared && npm install

# Copy actual source files so they're available in the volume
COPY shared/ ./shared/

CMD ["echo", "Shared module built"]
