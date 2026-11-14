/** WCAG relative luminance contrast for opaque sRGB colours.
 * Static palette checks and rendered browser checks share this arithmetic.
 * Browser callers resolve CSS colour syntax through their native renderer.
 */
export type ContrastRgb = readonly [number, number, number];
export type ContrastColor = string | ContrastRgb;

function channels(color: ContrastColor): readonly number[] {
  if (typeof color === "string") {
    if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new TypeError("Contrast needs a #rrggbb colour or an sRGB triplet");
    return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  }
  if (!Array.isArray(color) || color.length !== 3 || !Array.from(color).every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
    throw new TypeError("Contrast needs three finite sRGB channels between 0 and 255");
  }
  return color;
}

export function contrastRatio(foreground: ContrastColor, background: ContrastColor): number {
  const luminance = (color: ContrastColor): number => {
    const [r, g, b] = channels(color).map((channel) => channel / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}
