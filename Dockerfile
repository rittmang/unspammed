ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node worker ./worker
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node scripts/setup-env.mjs ./scripts/setup-env.mjs
COPY --chown=node:node scripts/database-setup.ts ./scripts/database-setup.ts
COPY --chown=node:node scripts/setup.mjs scripts/setup-lib.mjs scripts/telegram-client.mjs scripts/telegram-setup.mjs scripts/telegram-mini-app.mjs ./scripts/
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
