# Imagen base pineada a la MISMA versión del paquete `playwright` (1.61.1).
# Trae Chromium + todas las libs del sistema. Si actualizás playwright en
# package.json, actualizá también estas dos etiquetas.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage de validación para CI: instala TODAS las deps y corre typecheck + tests.
# El pipeline hace `docker build --target test` para fallar rápido.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run typecheck && npm test

FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# La imagen de Playwright trae el usuario no-root `pwuser`.
USER pwuser

EXPOSE 8080
CMD ["npm", "start"]
