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
  return `${ADJ[h % ADJ.length]} ${NOUN[(h >> 5) % NOUN.length]}`;
}
