/**
 * RHWP's `detect_lang_category` (renderer/style_resolver.rs, core 0.9.0): a character's reported font is the font its character shape
 * sets for this script category, so two characters of one shape can report different fonts.
 */
export function scriptCategory(codePoint: number): number {
  if (codePoint === 0x318d) return 6;
  if (codePoint >= 0xa1 && codePoint <= 0xac || codePoint >= 0xae && codePoint <= 0xbf || codePoint >= 0x2018 && codePoint <= 0x201f) return 1;
  if (codePoint === 0x2024 || codePoint === 0x2027 || codePoint >= 0xff01 && codePoint <= 0xff60 || codePoint >= 0xffe0 && codePoint <= 0xffe6 || codePoint >= 0x2160 && codePoint <= 0x2188) return 5;
  if (codePoint >= 0x1100 && codePoint <= 0x11ff || codePoint >= 0x3130 && codePoint <= 0x318f || codePoint >= 0xac00 && codePoint <= 0xd7af
    || codePoint >= 0xa960 && codePoint <= 0xa97f || codePoint >= 0xd7b0 && codePoint <= 0xd7ff) return 0;
  if (codePoint >= 0x41 && codePoint <= 0x5a || codePoint >= 0x61 && codePoint <= 0x7a || codePoint >= 0x30 && codePoint <= 0x39
    || codePoint >= 0xc0 && codePoint <= 0x24f || codePoint >= 0x1e00 && codePoint <= 0x1eff) return 1;
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff || codePoint >= 0x3400 && codePoint <= 0x4dbf || codePoint >= 0xf900 && codePoint <= 0xfaff
    || codePoint >= 0x20000 && codePoint <= 0x2a6df) return 2;
  if (codePoint >= 0x3040 && codePoint <= 0x30ff || codePoint >= 0x31f0 && codePoint <= 0x31ff) return 3;
  if (codePoint === 0x2015 || codePoint >= 0x2190 && codePoint <= 0x27bf || codePoint >= 0x2460 && codePoint <= 0x24ff || codePoint >= 0x3000 && codePoint <= 0x303f || codePoint >= 0x27c0 && codePoint <= 0x27ff || codePoint >= 0x2900 && codePoint <= 0x2bff) return 5;
  if (codePoint >= 0x391 && codePoint <= 0x3a1 || codePoint >= 0x3a3 && codePoint <= 0x3a9 || codePoint >= 0x3b1 && codePoint <= 0x3c9 || codePoint === 0x401 || codePoint >= 0x410 && codePoint <= 0x44f || codePoint === 0x451
    || codePoint >= 0x2013 && codePoint <= 0x2014 || codePoint === 0x2017 || codePoint >= 0x2020 && codePoint <= 0x2022 || codePoint >= 0x2025 && codePoint <= 0x2026 || codePoint === 0x2030 || codePoint >= 0x2032 && codePoint <= 0x2033 || codePoint >= 0x2039 && codePoint <= 0x203c || codePoint === 0x203e || codePoint === 0x2044 || codePoint === 0x2047 || codePoint >= 0x204e && codePoint <= 0x204f || codePoint >= 0x2053 && codePoint <= 0x205e
    || codePoint === 0x2074 || codePoint === 0x207f || codePoint >= 0x2081 && codePoint <= 0x2084 || codePoint >= 0x2090 && codePoint <= 0x2094 || codePoint >= 0x20a3 && codePoint <= 0x20a4 || codePoint === 0x20a7 || codePoint === 0x20a9 || codePoint === 0x20ac
    || [0x2103, 0x2105, 0x2109, 0x2113, 0x2116, 0x2126, 0x212b, 0x212e, 0x33d3, 0x33d6, 0x33d8].includes(codePoint) || codePoint >= 0x2121 && codePoint <= 0x2122 || codePoint >= 0x213b && codePoint <= 0x214e || codePoint >= 0x2153 && codePoint <= 0x2154 || codePoint >= 0x215b && codePoint <= 0x215e || codePoint >= 0x3200 && codePoint <= 0x321c || codePoint >= 0x3260 && codePoint <= 0x327b || codePoint === 0x327f || codePoint >= 0x3380 && codePoint <= 0x3384 || codePoint >= 0x3388 && codePoint <= 0x33ca || codePoint >= 0x33cf && codePoint <= 0x33d0 || codePoint >= 0x33db && codePoint <= 0x33dd) return 5;
  return 0;
}
