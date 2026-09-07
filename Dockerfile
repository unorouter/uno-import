FROM oven/bun:1.4-debian AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# Declarations only (emitDeclarationOnly). fromTypes reads dist/elysia.d.ts at
# runtime; without it the OpenAPI document ships with empty `responses` and
# every generated client type is `unknown`.
RUN bun run build
ARG TARGETARCH
RUN bun build --compile --production --target=bun-linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) src/elysia.ts --outfile /app/uno-import

# Runtime: one compiled binary, no bun, no node_modules. Not distroless: this drives
# a REAL chrome under xvfb (the challenge these sites serve is what a stock headless
# build gets caught by), and Chrome's package only exists for amd64.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS prod
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget curl gnupg ca-certificates xvfb dumb-init \
  && wget -q -O /etc/apt/keyrings/google.asc https://dl-ssl.google.com/linux/linux_signing_key.pub \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/uno-import ./uno-import
COPY --from=builder /app/dist/elysia.d.ts ./dist/elysia.d.ts

ENV NODE_ENV=production
EXPOSE 4000

# dumb-init reaps orphaned chrome children. Without a real init, PID 1 never
# wait()s on them and they accumulate as zombies until the container runs out of
# PIDs; one glm-proxy container measured 1062 defunct processes this way.
ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/uno-import"]
