# ──────────────────────────────────────────────
# Ingestion Service Dockerfile
# Single-stage build using Node 20 LTS Alpine.
# ──────────────────────────────────────────────
FROM node:20-alpine

# Create a non-root user for security.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files FIRST, then install, then copy source.
COPY package.json package-lock.json ./
RUN npm ci --production

# NOW copy the source code
COPY src/ ./src/

# Switch to non-root user
USER appuser

# Expose the port (documentation — doesn't actually open the port)
EXPOSE 3002

# Health check — Docker will restart the container if this fails
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Start the application
CMD ["node", "src/index.js"]
