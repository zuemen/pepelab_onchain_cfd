import { it, expect, describe } from 'vitest';

import { landingFeatureKeys } from './landingFeatures';

const ALL_ON = { copyTrading: true, gamefi: true, perpetuals: false };

describe('landingFeatureKeys', () => {
  it('平台站：社交交易、鏈上透明、ESG、GameFi，依序四張（#331）', () => {
    expect(landingFeatureKeys(ALL_ON)).toEqual(['social', 'transparency', 'esg', 'gamefi']);
  });

  it('跟單旗標關閉的租戶：第一張換回代幣化資產，不介紹看不到的跟單', () => {
    expect(landingFeatureKeys({ ...ALL_ON, copyTrading: false })).toEqual([
      'tokenized',
      'transparency',
      'esg',
      'gamefi',
    ]);
  });

  it('GameFi 旗標關閉時不放 GameFi 卡', () => {
    expect(landingFeatureKeys({ ...ALL_ON, gamefi: false })).toEqual(['social', 'transparency', 'esg']);
  });

  it('機構租戶（跟單與 GameFi 都未授權）仍有三張卡', () => {
    expect(landingFeatureKeys({ copyTrading: false, gamefi: false, perpetuals: false })).toEqual([
      'tokenized',
      'transparency',
      'esg',
    ]);
  });

  it('永續旗標打開時，永續卡接在最後', () => {
    expect(landingFeatureKeys({ ...ALL_ON, perpetuals: true })).toEqual([
      'social',
      'transparency',
      'esg',
      'gamefi',
      'perpetuals',
    ]);
  });
});
