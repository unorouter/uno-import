FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4-debian AS prod
WORKDIR /app

# puppeteer-real-browser drives a REAL chrome; the bundled headless shell is not
# enough, because the challenge these sites serve is what a stock headless build
# gets caught by. xvfb is what lets that chrome run without a display.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget curl gnupg ca-certificates xvfb dumb-init \
  && wget -q -O /etc/apt/keyrings/google.asc https://dl-ssl.google.com/linux/linux_signing_key.pub \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4000

# dumb-init reaps orphaned chrome children. Without a real init, PID 1 never
# wait()s on them and they accumulate as zombies until the container runs out of
# PIDs; one glm-proxy container measured 1062 defunct processes this way.
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "src/elysia.ts"]
