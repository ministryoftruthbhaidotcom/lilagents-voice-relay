# Minimal container for the voice relay. Works on Fly.io, Render, Railway, Cloud Run, etc.
FROM node:20-alpine
WORKDIR /app

# Install only production deps first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source. NOTE: .env and codes.json are gitignored / not copied — provide secrets
# as host environment variables, and manage codes via codes.json mounted at runtime or
# the INVITE_CODES env var.
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.js"]
