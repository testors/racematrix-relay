FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data && chown node:node /app/data
COPY src ./src
COPY bin ./bin
COPY examples ./examples
USER node
ENV RELAY_HOST=0.0.0.0 RELAY_DATA_DIR=/app/data
EXPOSE 8787/tcp 8677/udp
CMD ["node", "src/main.js"]
