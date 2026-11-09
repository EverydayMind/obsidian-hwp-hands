/** Match the first inserted line within the existing two-pixel tolerance. */
export class PositionedLines<T extends { page: number; column: number; y: number }> {
  private readonly buckets = new Map<string, Array<{ order: number; value: T }>>();
  private sequence = 0;
  private key(page: number, column: number, bucket: number): string { return `${page}:${column}:${bucket}`; }
  find(page: number, column: number, y: number): T | undefined {
    const bucket = Math.floor(y / 2);
    let best: { order: number; value: T } | undefined;
    for (let delta = -1; delta <= 1; delta++) for (const candidate of this.buckets.get(this.key(page, column, bucket + delta)) ?? []) {
      if (Math.abs(candidate.value.y - y) <= 2 && (!best || candidate.order < best.order)) best = candidate;
    }
    return best?.value;
  }
  add(value: T): void {
    const key = this.key(value.page, value.column, Math.floor(value.y / 2)), bucket = this.buckets.get(key) ?? [];
    bucket.push({ order: this.sequence++, value }); this.buckets.set(key, bucket);
  }
}
