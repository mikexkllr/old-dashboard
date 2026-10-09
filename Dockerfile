# The app only uses Node's built-in modules, so there is no npm install step.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000
USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/index.js"]
