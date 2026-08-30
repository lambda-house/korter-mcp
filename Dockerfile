# Build stage: pnpm via corepack; python3/make/g++ for better-sqlite3's native build.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
ENV NODE_ENV=production
# 8080: /api + /mcp; 9095: /startup /alive /ready /metrics
EXPOSE 8080 9095
CMD ["node", "dist/main.js", "serve"]
