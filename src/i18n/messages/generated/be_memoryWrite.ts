// i18n. Source: src/tools/memory-write.ts.
export const en = {
  "be_memoryWrite.credentialRejected": "memory_write: title/content must not contain credentials, API keys, or tokens.",
  "be_memoryWrite.authorizationKeyRejected":
    "memory_write: title/content holds the value of an Authorization-like key (a key with \"authorization\" as a word, such as Authorization:, authorization_header= or authorization_url=). Such values are treated as credentials and are never stored, even when the value is a plain URL. Rephrase the fact without that key and value.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_memoryWrite.credentialRejected": "memory_write: title/content 에 자격 증명, API 키, 토큰을 넣을 수 없습니다.",
  "be_memoryWrite.authorizationKeyRejected":
    "memory_write: title/content 에 Authorization 류 키의 값이 들어 있습니다(\"authorization\" 을 단어로 가진 키, 예: Authorization:, authorization_header=, authorization_url=). 이런 값은 평범한 URL 이어도 자격 증명으로 취급해 저장하지 않습니다. 그 키와 값을 빼고 사실을 다시 적으세요.",
};
