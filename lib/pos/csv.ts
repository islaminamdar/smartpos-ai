/** Escape a text cell for spreadsheet export, including imported/untrusted values. */
export function csvTextCell(value: string): string {
  // Quotes alone do not prevent spreadsheet formula execution. Include whitespace
  // and control-prefixed formulas; never mutate the stored source identifier.
  const text =
    /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${text.replaceAll('"', '""')}"`
}
