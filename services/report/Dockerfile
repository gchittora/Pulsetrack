FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

RUN addgroup -g 1001 -S appuser && \
    adduser -S appuser -u 1001
USER appuser

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1

CMD ["npm", "start"]
