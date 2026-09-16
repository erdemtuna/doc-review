export const MAX_EDIT_CHARACTERS = 200_000;

const EDIT_FIELDS = ["before", "after", "before_html", "after_html", "moved_after", "moved_before"];

export function limitEditFields(input) {
  const fields = {};
  const truncatedFields = [];
  for (const field of EDIT_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    let end = 0;
    let count = 0;
    // Count Unicode code points, not UTF-16 halves of an astral character.
    for (const character of value) {
      if (count === MAX_EDIT_CHARACTERS) break;
      end += character.length;
      count += 1;
    }
    fields[field] = value.slice(0, end);
    if (end < value.length) truncatedFields.push(field);
  }
  return { fields, truncated: truncatedFields.length > 0, truncated_fields: truncatedFields };
}
