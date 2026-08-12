# Lettertrace — self-hostable image.
#
# The point of this file is that the resulting image is NOT tied to the Supabase
# project it was built against. Everything an operator needs to configure is read
# at runtime, including the values the browser needs (see lib/public-env.ts), so
# one published image works for everybody:
#
#   docker run -p 3000:3000 --env-file .env ghcr.io/letterstory/lettertrace
#
# Node 22 to match package.json engines (>=20 <23). Node 24 is deliberately
# avoided: an undici regression there intermittently drops LLM connections
# mid-response, which is most of what this app does.

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Copied on their own so this layer is only rebuilt when the lockfile moves,
# not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------- builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No NEXT_PUBLIC_* build args on purpose. Supplying them here would bake one
# Supabase project into the bundle and silently override whatever the operator
# passes to `docker run` — the exact failure this image exists to avoid.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------- runtime
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runs unprivileged. The image needs no write access to its own filesystem.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# `standalone` carries its own minimal node_modules; static/ and public/ are not
# included in it and have to come across separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Fails the healthcheck on anything but a real HTTP response, so an orchestrator
# restarts a wedged container rather than leaving it in the load balancer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/login'},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
