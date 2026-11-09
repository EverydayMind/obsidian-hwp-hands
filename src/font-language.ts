/**
 * RHWP's `detect_lang_category` (renderer/style_resolver.rs, core 0.8.7): a character's reported font is the font its character shape
 * sets for this script category, so two characters of one shape can report different fonts.
 */
export function scriptCategory(codePoint: number): number {
  if (codePoint === 0x318d) return 6;
  if (codePoint >= 0x1100 && codePoint <= 0x11ff || codePoint >= 0x3130 && codePoint <= 0x318f || codePoint >= 0xac00 && codePoint <= 0xd7af
    || codePoint >= 0xa960 && codePoint <= 0xa97f || codePoint >= 0xd7b0 && codePoint <= 0xd7ff) return 0;
  if (codePoint >= 0x41 && codePoint <= 0x5a || codePoint >= 0x61 && codePoint <= 0x7a || codePoint >= 0x30 && codePoint <= 0x39
    || codePoint >= 0xc0 && codePoint <= 0x24f || codePoint >= 0x1e00 && codePoint <= 0x1eff) return 1;
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff || codePoint >= 0x3400 && codePoint <= 0x4dbf || codePoint >= 0xf900 && codePoint <= 0xfaff
    || codePoint >= 0x20000 && codePoint <= 0x2a6df) return 2;
  if (codePoint >= 0x3040 && codePoint <= 0x30ff || codePoint >= 0x31f0 && codePoint <= 0x31ff) return 3;
  if (codePoint >= 0x2190 && codePoint <= 0x27bf || codePoint >= 0x2460 && codePoint <= 0x24ff || codePoint >= 0x3000 && codePoint <= 0x303f) return 5;
  return 0;
}
