# One image, any host: Railway, Render, Fly, a VPS, or the machine under your desk.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY public ./public
COPY README.md ./
EXPOSE 3000
CMD ["node", "src/server.js"]
