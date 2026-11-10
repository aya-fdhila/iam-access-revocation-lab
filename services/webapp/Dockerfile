FROM node:26.13.0-alpine3.23@sha256:44a3247313f9bc069a4ec25d01b66254ed7dc4d0408727d8720dc827f0753423 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:26.13.0-alpine3.23@sha256:44a3247313f9bc069a4ec25d01b66254ed7dc4d0408727d8720dc827f0753423 AS runtime
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
