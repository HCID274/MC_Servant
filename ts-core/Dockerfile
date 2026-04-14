FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json tsconfig.json biome.json README.md ./
COPY src ./src

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV="production"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile
COPY --from=build /app/dist/src ./dist/src

CMD ["node", "dist/src/main.js"]
