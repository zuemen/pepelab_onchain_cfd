/**
 * PepeLab Asset Helper Utility
 * Manages custom Pepe avatar rendering and gamified outfit/level mechanics.
 */

export interface PepeRank {
  label: string;
  color: string;
  gradient: string;
  borderColor: string;
  shadow: string;
}

/**
 * Deterministically retrieves a Pepe avatar based on on-chain reputation score.
 * Implements the professor's requirement: "等級越高的交易員，可以讓其專屬的 Pepe 頭像穿上越華麗的衣服"
 * 
 * - Diamond (Rep >= 80): Luxurious crowns, gold suits, space helmet (pepe_10, pepe_11)
 * - Gold (Rep >= 60): Sleek suits, cool shades, luxury vibes (pepe_1, pepe_2, pepe_7)
 * - Silver (Rep >= 40): Neat explorer suits, developers, wizards (pepe_3, pepe_6, pepe_8)
 * - Bronze (Rep < 40): Classic simple Pepe outfits (pepe_4, pepe_5, pepe_9)
 */
export const getPepeAvatar = (reputation: number | bigint | null, address: string): string => {
  if (!address) return '/assets/images/pepefi/pepe_1.png';
  
  const addrLower = address.toLowerCase();
  
  // Deterministic fallback hash from address
  let hash = 0;
  for (let i = 0; i < addrLower.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = addrLower.charCodeAt(i) + ((hash << 5) - hash);
  }
  const fallbackIndex = (Math.abs(hash) % 11) + 1;

  if (reputation === null) {
    return `/assets/images/pepefi/pepe_${fallbackIndex}.png`;
  }

  const score = Number(reputation);

  if (score >= 80) {
    // Diamond outfits: pepe_10, pepe_11
    const options = [10, 11];
    return `/assets/images/pepefi/pepe_${options[Math.abs(hash) % options.length]}.png`;
  } else if (score >= 60) {
    // Gold outfits: pepe_1, pepe_2, pepe_7
    const options = [1, 2, 7];
    return `/assets/images/pepefi/pepe_${options[Math.abs(hash) % options.length]}.png`;
  } else if (score >= 40) {
    // Silver outfits: pepe_3, pepe_6, pepe_8
    const options = [3, 6, 8];
    return `/assets/images/pepefi/pepe_${options[Math.abs(hash) % options.length]}.png`;
  } else {
    // Bronze outfits: pepe_4, pepe_5, pepe_9
    const options = [4, 5, 9];
    return `/assets/images/pepefi/pepe_${options[Math.abs(hash) % options.length]}.png`;
  }
};

/**
 * Returns rank metadata including styled metallic gradients and colors.
 */
export const getPepeRank = (reputation: number | bigint | null): PepeRank => {
  const score = reputation !== null ? Number(reputation) : 0;

  if (score >= 80) {
    return {
      label: 'Diamond 鑽石',
      color: '#00b8d9',
      gradient: 'linear-gradient(135deg, #00b8d9 0%, #003768 100%)',
      borderColor: 'rgba(0, 184, 217, 0.4)',
      shadow: '0 0 12px rgba(0, 184, 217, 0.3)',
    };
  }
  if (score >= 60) {
    return {
      label: 'Gold 黃金',
      color: '#ffab00',
      gradient: 'linear-gradient(135deg, #ffd666 0%, #7a4100 100%)',
      borderColor: 'rgba(255, 171, 0, 0.4)',
      shadow: '0 0 12px rgba(255, 171, 0, 0.3)',
    };
  }
  if (score >= 40) {
    return {
      label: 'Silver 白銀',
      color: '#c4cdd5',
      gradient: 'linear-gradient(135deg, #dfe3e8 0%, #637381 100%)',
      borderColor: 'rgba(196, 205, 213, 0.4)',
      shadow: '0 0 12px rgba(196, 205, 213, 0.2)',
    };
  }
  return {
    label: 'Bronze 青銅',
    color: '#ff5630',
    gradient: 'linear-gradient(135deg, #ffac82 0%, #7a0916 100%)',
    borderColor: 'rgba(255, 86, 48, 0.3)',
    shadow: '0 0 12px rgba(255, 86, 48, 0.2)',
  };
};
