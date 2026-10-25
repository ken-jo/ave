/** Re-export pure stream helpers through the shared layer; renderers must not import engine modules. */
export { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
