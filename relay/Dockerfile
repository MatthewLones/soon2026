FROM node:20-alpine
WORKDIR /app

# Install all deps (including tsx — the runtime executes server.ts directly).
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy source.
COPY . .

ENV PORT=4001
EXPOSE 4001

CMD ["npx", "tsx", "server.ts"]
