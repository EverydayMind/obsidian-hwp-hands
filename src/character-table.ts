import { L } from './i18n/locale';
export interface CharacterTableEntry { character: string; category: string; codePoint: string }

const groups: ReadonlyArray<readonly [string, string]> = [
  [L({ ko: '기호', en: "Symbols" }), '©®™§¶†‡•※℃℉№℡⁂'],
  [L({ ko: '문장 부호', en: "Punctuation" }), '–—―…‘’“”‹›«»¿¡'],
  [L({ ko: '그리스 문자', en: "Greek letters" }), 'αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'],
  [L({ ko: '수학', en: "Mathematics" }), '±×÷≠≈≤≥∞√∛∜∑∏∫∬∂∆∇∈∉∋∅⊂⊃⊆⊇∪∩⊕⊗∧∨¬∀∃∴∵∝'],
  [L({ ko: '화살표', en: "Arrows" }), '←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓⇔⇕↩↪↵'],
  [L({ ko: '통화', en: "Currency" }), '¢£¤¥₩€₹₽₺₫₴₦₱'],
  [L({ ko: '도형', en: "Shapes" }), '●○◉◎■□▣▢▲△▼▽◆◇◈★☆♠♡♢♣♤♥♦♧♨'],
  [L({ ko: '단위·분수', en: "Units and fractions" }), '¹²³⁴⁵⁶⁷⁸⁹⁰₀₁₂₃₄₅₆₇₈₉½⅓⅔¼¾⅛⅜⅝⅞'],
  [L({ ko: '괘선', en: "Box drawing" }), '─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬'],
];

export const CHARACTER_TABLE_ENTRIES: readonly CharacterTableEntry[] = groups.flatMap(([category, characters]) =>
  Array.from(characters, character => ({
    character,
    category,
    codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
  })),
);
export const CHARACTER_TABLE_CATEGORIES = [L({ ko: '전체', en: "All" }), ...groups.map(([category]) => category)];

export function filterCharacterTable(query: string, category = L({ ko: '전체', en: "All" })): CharacterTableEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return CHARACTER_TABLE_ENTRIES.filter(entry => (category === L({ ko: '전체', en: "All" }) || entry.category === category)
    && terms.every(term => `${entry.character} ${entry.category} ${entry.codePoint}`.toLocaleLowerCase().includes(term)));
}
