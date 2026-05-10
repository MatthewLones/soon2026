let counter = 0;

export function nextPlacementId(prefix = 'p'): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}
