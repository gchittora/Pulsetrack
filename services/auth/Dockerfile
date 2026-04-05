# ──────────────────────────────────────────────
# Auth Service Dockerfile
#
# WHY multi-stage? We don't. This is a simple, single-stage build.
# For a Node.js service this small, multi-stage adds complexity
# without meaningful benefit. We'd use multi-stage if we had
# a TypeScript compile step or needed to minimize image size
# below ~150MB.
#
# WHY node:20-alpine?
# - Node 20 = LTS (Long Term Support) — stable, well-tested
# - Alpine = ~50MB base image vs ~350MB for regular Debian-based
# - Smaller image = faster pulls, less disk, smaller attack surface
# ──────────────────────────────────────────────
FROM node:20-alpine

# Create a non-root user for security.
# WHY? If an attacker exploits our app, they get the permissions
# of whatever user the app runs as. Running as root = full access
# to the container. Running as "appuser" = limited access.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files FIRST, then install, then copy source.
# WHY this order? Docker caches each layer. If only source code
# changes (not dependencies), Docker skips the npm install step
# entirely — saving minutes on every rebuild.
COPY package.json package-lock.json ./
RUN npm ci --production

# NOW copy the source code
COPY src/ ./src/

# Switch to non-root user
USER appuser

# Expose the port (documentation — doesn't actually open the port)
EXPOSE 3001

# Health check — Docker will restart the container if this fails
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start the application
CMD ["node", "src/index.js"]
