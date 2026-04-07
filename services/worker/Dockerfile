FROM node:20-alpine
USER node
WORKDIR /home/node/app
COPY --chown=node:node package*.json ./
RUN npm ci --only=production
COPY --chown=node:node . .
CMD ["npm", "start"]
