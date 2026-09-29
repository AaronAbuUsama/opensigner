# Pinned by digest: a tag can be repointed at a different image at any time.
FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS build
RUN npm install -g pnpm@10.28.2
WORKDIR /app
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE ./
COPY packages/stellar-signer/package.json ./packages/stellar-signer/package.json
RUN pnpm install --frozen-lockfile
COPY packages/stellar-signer/src ./packages/stellar-signer/src
COPY packages/stellar-signer/scripts ./packages/stellar-signer/scripts
COPY iframe/sample ./iframe/sample
RUN cp node_modules/penpal/dist/penpal.js iframe/sample/penpal.js
RUN cp node_modules/penpal/LICENSE iframe/sample/penpal-LICENSE
RUN pnpm --filter @opensigner/stellar-signer build:browser

FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a
WORKDIR /app
COPY --from=build /app/iframe/sample .
USER node
ENTRYPOINT ["node", "server.mjs"]
