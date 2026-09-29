// 有上界的 LRU 快取（Map 保持插入順序：最舊的在最前面）。
//
// 為什麼需要：/candles 的快取鍵含使用者可控的 limit / end，以前的 Map 不淘汰——
// 任何人換著參數打，暖實例的記憶體就無上界成長。
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`LruCache max 必須是正整數（收到 ${max}）`);
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // 命中 → 移到最新
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
