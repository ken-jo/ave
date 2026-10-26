/**
 * The fixed endpoints and request constants of plan-usage sign-in and
 * inference. Discovery is fetched at sign-in and sign-out and must name these
 * exact values: the egress policy admits nothing else, so a discovery document
 * that moved an endpoint fails sign-in instead of widening egress.
 */

export const CHATGPT_PLAN_ISSUER = "https://auth.openai.com";
export const CHATGPT_PLAN_DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const CHATGPT_PLAN_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_PLAN_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_PLAN_REVOCATION_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
export const CHATGPT_PLAN_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_PLAN_MODELS_URL = "https://api.openai.com/v1/models";
export const CHATGPT_PLAN_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** The Responses API base the SDK appends `/responses` to. */
export const CHATGPT_PLAN_API_BASE_URL = "https://api.openai.com/v1";
/** The `resource` every authorization, exchange and refresh names. */
export const CHATGPT_PLAN_RESOURCE = "https://api.openai.com/v1";

/** First-time registration entrypoint; never saved and never used for token exchange. */
export const CHATGPT_PLAN_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** The app's name, sent only with first-time registration and the same on every install. */
export const CHATGPT_PLAN_AGENT_NAME_HINT = "Ave";
/** The permission that authorizes plan-usage inference. */
export const CHATGPT_PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
/** The complete requested scope set: identity plus plan usage. */
export const CHATGPT_PLAN_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_PLAN_USAGE_SCOPE,
]);

/** Loopback callback: only the port may vary between attempts. */
export const CHATGPT_PLAN_CALLBACK_HOST = "127.0.0.1";
export const CHATGPT_PLAN_CALLBACK_PATH = "/auth/callback";
