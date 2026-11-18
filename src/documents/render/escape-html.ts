const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * The single place where document text becomes HTML. Every value that comes
 * from the JSON goes through here, in text and in attribute position alike.
 * Rich text (e.g. KaTeX) should be plugged in here later.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
