import { join } from 'node:path';
import { it, expect, describe } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { HERO_PHOTOS, heroPhotoFor, traderAvatarSrc, traderAvatarImgSx } from './pepefi-assets';

// 英雄榜的真人照片以交易者名稱對應。名稱或檔案一改，對應就會靜靜地失效（退回 Pepe 圖），
// 所以這裡把兩邊都釘住：每個名稱都要出現在兩條鏈的模擬交易者資料裡，每張照片都要真的存在。

const PUBLIC = join(__dirname, '../../public');
const heroNames = (chainId: number): string[] => {
  const index = JSON.parse(readFileSync(join(PUBLIC, `data/heroes/${chainId}/index.json`), 'utf-8')) as {
    traders: { name: string }[];
  };
  return index.traders.map((h) => h.name.trim().toLowerCase());
};

describe('英雄榜真人照片', () => {
  it.each([31337, 84532])('每個名稱都是 %i 上的模擬交易者', (chainId) => {
    const names = heroNames(chainId);
    for (const name of Object.keys(HERO_PHOTOS)) expect(names, name).toContain(name);
  });

  it('每張照片都在 public/ 裡', () => {
    for (const src of Object.values(HERO_PHOTOS)) expect(existsSync(join(PUBLIC, src)), src).toBe(true);
  });

  it('名稱比對不分大小寫、忽略前後空白；不在表上的交易者照舊用 Pepe 圖', () => {
    expect(heroPhotoFor('Carbon Zero')).toBe('/avatars/heroes/carbon-zero.jpg');
    expect(heroPhotoFor('  STEADY EDDIE ')).toBe('/avatars/heroes/steady-eddie.jpg');
    expect(heroPhotoFor('Crypto Degen')).toBeUndefined();
    expect(heroPhotoFor(undefined)).toBeUndefined();
    expect(traderAvatarSrc(80, '0xabc', 'Crypto Degen')).toBe(traderAvatarSrc(80, '0xabc'));
  });

  it('照片填滿圓框、不留內距；Pepe 插圖照舊整張放進去並留內距', () => {
    expect(traderAvatarImgSx('Trend Rider', '4px')).toEqual({ objectFit: 'cover', padding: 0 });
    expect(traderAvatarImgSx('Crypto Degen', '4px')).toEqual({ objectFit: 'contain', padding: '4px' });
    expect(traderAvatarImgSx(undefined, '2px')).toEqual({ objectFit: 'contain', padding: '2px' });
  });
});
