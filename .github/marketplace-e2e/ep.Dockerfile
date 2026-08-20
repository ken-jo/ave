FROM oven/bun:1.3.14

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 ave \
    && useradd --create-home --uid 10001 --gid 10001 --shell /bin/bash ave \
    && mkdir -p /workspace/ave-plugin-orion /out \
    && chown -R 10001:10001 /workspace /out

COPY --chown=10001:10001 ave-plugin-orion/ /workspace/ave-plugin-orion/

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
WORKDIR /workspace/ave-plugin-orion
RUN bun install --frozen-lockfile \
    && bun run build \
    && test -f dist/hostPlugin.js \
    && bun -e 'const m = await Bun.file("plugin.json").json(); const declared = [...new Set(JSON.stringify(m.ui ?? []).match(/dist\/[A-Za-z0-9._\/-]+/g) ?? [])]; if (declared.length === 0) throw new Error("plugin.json ui[] declares no dist asset"); for (const p of declared) { if (!(await Bun.file(p).exists())) throw new Error("declared ui asset missing from build: " + p); } console.log("ui assets present: " + declared.join(", "));' \
    && zip -X -q -r "/out/ave-plugin-orion-${ORION_API_SHA}.zip" plugin.json dist skills \
    && test -s "/out/ave-plugin-orion-${ORION_API_SHA}.zip"

ENTRYPOINT ["/bin/true"]
