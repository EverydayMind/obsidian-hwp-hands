export interface CharacterTableEntry { character: string; category: string; codePoint: string }

const groups: ReadonlyArray<readonly [string, string]> = [
  ['기호', '©®™§¶†‡•※℃℉№℡⁂'],
  ['문장 부호', '–—―…‘’“”‹›«»¿¡'],
  ['그리스 문자', 'αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'],
  ['수학', '±×÷≠≈≤≥∞√∛∜∑∏∫∬∂∆∇∈∉∋∅⊂⊃⊆⊇∪∩⊕⊗∧∨¬∀∃∴∵∝'],
  ['화살표', '←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓⇔⇕↩↪↵'],
  ['통화', '¢£¤¥₩€₹₽₺₫₴₦₱'],
  ['도형', '●○◉◎■□▣▢▲△▼▽◆◇◈★☆♠♡♢♣♤♥♦♧♨'],
  ['단위·분수', '¹²³⁴⁵⁶⁷⁸⁹⁰₀₁₂₃₄₅₆₇₈₉½⅓⅔¼¾⅛⅜⅝⅞'],
  ['괘선', '─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬'],
];

export const CHARACTER_TABLE_ENTRIES: readonly CharacterTableEntry[] = groups.flatMap(([category, characters]) =>
  Array.from(characters, character => ({
    character,
    category,
    codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
  })),
);
export const CHARACTER_TABLE_CATEGORIES = ['전체', ...groups.map(([category]) => category)];

export function filterCharacterTable(query: string, category = '전체'): CharacterTableEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return CHARACTER_TABLE_ENTRIES.filter(entry => (category === '전체' || entry.category === category)
    && terms.every(term => `${entry.character} ${entry.category} ${entry.codePoint}`.toLocaleLowerCase().includes(term)));
}
