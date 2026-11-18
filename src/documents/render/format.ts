// Pure pt-BR formatting helpers shared by the block renderers, the layout and
// the header. No imports on purpose: blocks use this, so it must not depend on them.

/** 0 → "a", 1 → "b"... */
export function alternativeLabel(index: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + index);
}

export function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** "0,5 ponto", "1 ponto", "2 pontos". */
export function formatPoints(points: number): string {
  return `${formatNumber(points)} ${points < 2 ? 'ponto' : 'pontos'}`;
}
