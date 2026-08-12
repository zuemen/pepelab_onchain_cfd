const ADJ = ['Whale','Diamond','Lucky','Mega','Cosmic','Based','Smug','Crypto',
             'Moon','Apex','Stoned','Frenly','Drippy','Hodler','Degen','Smol'];
const NOUN = ['Pepe','Frog','Sage','King','Trader','Wizard','Knight','Lord',
              'Baron','Prince','Pilot','Ronin','Shogun','Tycoon','Mystic','Sensei'];

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

export function pepeNameFor(addr?: string | null): string {
  if (!addr) return 'Anon Pepe';
  const h = djb2(addr.toLowerCase());
  // `>>>` 而不是 `>>`：djb2 用 `>>> 0` 收尾，所以 h 可以大到 2^32-1，但 `>>` 是
  // **有號**位移，會先把 h 轉成 int32。top bit 一被設起來，h >> 5 就是負數，
  // 負數 % 16 在 JS 裡也是負的，於是 NOUN[-13] === undefined —— 畫面上就出現
  // 「Lucky undefined」。大約一半的位址會踩到（實際在 whale tracker 上看到了）。
  return `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 5) % NOUN.length]}`;
}
