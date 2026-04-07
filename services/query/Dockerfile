FROM node:20-alpine

# Use standard non-root user that comes with the alpine image
USER node
WORKDIR /home/node/app

# Copy dependency files with correct permissions
COPY --chown=node:node package*.json ./

# Install exactly what is generated in package-lock.json
RUN npm ci --only=production

# Copy source code with correct permissions
COPY --chown=node:node . .

# Explicitly expose the query service port
EXPOSE 3003

# Use standard syntax to boot server
CMD ["npm", "start"]
