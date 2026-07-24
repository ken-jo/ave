ARG CANDIDATE_IMAGE
FROM ${CANDIDATE_IMAGE}

USER root
COPY server/scripts/seed_e2e_keys.py /app/e2e/scripts/seed_e2e_keys.py
COPY server/scripts/print_test_poc_signer_env.py /app/e2e/scripts/print_test_poc_signer_env.py
COPY server/tests/__init__.py /app/e2e/tests/__init__.py
COPY server/tests/support/ /app/e2e/tests/support/
COPY schemas/keys/poc-v1.pub /app/e2e/schemas/keys/poc-v1.pub
RUN chmod -R a=rX /app/e2e

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
