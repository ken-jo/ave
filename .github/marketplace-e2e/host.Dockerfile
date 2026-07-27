FROM node:22-bookworm-slim AS node-runtime

FROM oven/bun:1.3.14

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libxcomposite1 \
      libxrandr2 \
      libxshmfence1 \
      libxss1 \
      python3 \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# Bun provides a `node` shim, but it does not implement Node's `--test`
# runner. Keep the test runtime within the app's supported Node 22 line.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN /usr/local/bin/node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 4)) process.exit(1)"

RUN groupadd --gid 10001 ave \
    && useradd --create-home --uid 10001 --gid 10001 --shell /bin/bash ave \
    && mkdir -p /workspace/ave /workspace/ave-plugin-sdk /evidence \
    && chown -R 10001:10001 /workspace /evidence

COPY --chown=10001:10001 ave/ /workspace/ave/
COPY --chown=10001:10001 ave-plugin-sdk/ /workspace/ave-plugin-sdk/

ARG E2E_NONCE
ARG HOST_SHA
ARG MARKETPLACE_SHA
ARG SDK_SHA
ARG ORION_API_SHA
LABEL org.ave.marketplace-e2e.nonce="${E2E_NONCE}" \
      org.ave.marketplace-e2e.host-sha="${HOST_SHA}" \
      org.ave.marketplace-e2e.marketplace-sha="${MARKETPLACE_SHA}" \
      org.ave.marketplace-e2e.sdk-sha="${SDK_SHA}" \
      org.ave.marketplace-e2e.orion-api-sha="${ORION_API_SHA}"

USER 10001:10001
ENV HOME=/home/ave
WORKDIR /workspace/ave
RUN bun install --frozen-lockfile \
    && /usr/local/bin/node --test scripts/plugin-bundle-e2e-inputs.test.mjs \
    && bun run build

ENTRYPOINT ["/bin/bash"]
