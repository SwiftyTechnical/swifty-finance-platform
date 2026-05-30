# Base image pulled from the AWS ECR Public mirror of the Docker official
# node image (no Docker Hub dependency / rate limits, works unauthenticated in
# CodeBuild). Switch to a private ECR repo here if org policy requires it.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine

# Stage 1: install all deps and build the Vite frontend into /app/dist
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production image — server + built frontend + prod deps only
FROM ${NODE_IMAGE}
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
