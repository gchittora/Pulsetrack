FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Security: Explicitly create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy packages and install tightly mapped production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy all source files
COPY src ./src

# Grant the non-root user ownership over the working directory
RUN chown -R appuser:appgroup /usr/src/app

# Drop root privileges immediately
USER appuser

# Workers explicitly don't need EXPOSE since they don't listen on HTTP ports!
# They only initiate outbound connections to Redis/Mongo.

# Execute the start script
CMD ["npm", "start"]
