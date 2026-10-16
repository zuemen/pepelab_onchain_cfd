import { it, expect, describe } from 'vitest';

import { landingFeatureKeys } from './landingFeatures';

const ALL_ON = { copyTrading: true, gamefi: true, perpetuals: false };

describe('landingFeatureKeys', () => {
  it('平台站：六張平台特色，社交交易排第一（#331）', () => {
    expect(landingFeatureKeys(ALL_ON)).toEqual(['social', 'assets', 'transparency', 'esg', 'gamefi', 'agent']);
  });

  it('跟單旗標關閉的租戶：不介紹看不到的社交交易，整合四大資產排第一', () => {
    expect(landingFeatureKeys({ ...ALL_ON, copyTrading: false })).toEqual([
      'assets',
      'transparency',
      'esg',
      'gamefi',
      'agent',
    ]);
  });

  it('GameFi 旗標關閉時不放 GameFi 卡', () => {
    expect(landingFeatureKeys({ ...ALL_ON, gamefi: false })).toEqual([
      'social',
      'assets',
      'transparency',
      'esg',
      'agent',
    ]);
  });

  it('機構租戶（跟單與 GameFi 都未授權）仍有四張卡', () => {
    expect(landingFeatureKeys({ copyTrading: false, gamefi: false, perpetuals: false })).toEqual([
      'assets',
      'transparency',
      'esg',
      'agent',
    ]);
  });

  it('永續旗標打開時，永續卡接在最後', () => {
    expect(landingFeatureKeys({ ...ALL_ON, perpetuals: true }).at(-1)).toBe('perpetuals');
  });
});
