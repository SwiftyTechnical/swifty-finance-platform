# Stage 1: install all deps and build the Vite frontend into /app/dist
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production image — server + built frontend + prod deps only
FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Production dependencies only (express, pg, aws-sdk cognito, aws-jwt-verify, …)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server source and the built frontend the server serves from ../dist
COPY server ./server
COPY --from=build /app/dist ./dist

EXPOSE 3001

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.mjs"]
