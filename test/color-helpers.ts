import { convert, utils } from "@asamuzakjp/css-color";

/** Resolve computed CSS colors to exact sRGB bytes while preserving serialized alpha. */
export function normalizeCssColor(input: string): [number, number, number, number] {
  if (!utils.isColor(input) || input.trim().toLowerCase() === "currentcolor") {
    throw new Error(`Unsupported computed color: ${input}`);
  }
  const channels: number[] = convert.colorToRgb(input);
  const [red, green, blue, convertedAlpha] = channels;
  if (channels.length !== 4 || red === undefined || green === undefined || blue === undefined
    || convertedAlpha === undefined || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`Unresolved computed color: ${input}`);
  }
  const alphaSource = input.match(/\/\s*([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?%?)\s*\)$/i)?.[1]
    ?? input.match(/^rgba?\([^,]+,[^,]+,[^,]+,\s*([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?%?)\s*\)$/i)?.[1];
  let alpha = convertedAlpha;
  if (alphaSource !== undefined) {
    const [significand, exponent = "0"] = alphaSource.replace(/%$/, "").split(/e/i);
    alpha = Number(`${significand}e${Number(exponent) - (alphaSource.endsWith("%") ? 2 : 0)}`);
  }
  const toByte = (channel: number) => Math.round(Math.min(255, Math.max(0, channel)));
  return [toByte(red), toByte(green), toByte(blue), Math.min(1, Math.max(0, alpha))];
}
