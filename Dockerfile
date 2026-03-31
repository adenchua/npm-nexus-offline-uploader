FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN mkdir -p input
CMD ["npx", "tsx", "src/index.ts"]
