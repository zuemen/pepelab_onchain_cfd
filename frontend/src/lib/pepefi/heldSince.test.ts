import { it, expect, describe } from 'vitest';

import { streakStart, type TransferLike } from './heldSince';

const ME = '0x00000000000000000000000000000000000000Aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const ZERO = '0x0000000000000000000000000000000000000000';

const mint = (blockNumber: number, value: bigint, index = 0): TransferLike => ({
  blockNumber,
  index,
  from: ZERO,
  to: ME.toLowerCase(),
  value,
});
const burn = (blockNumber: number, value: bigint, index = 0): TransferLike => ({
  blockNumber,
  index,
  from: ME,
  to: ZERO,
  value,
});

describe('streakStart：現在這段連續持有從哪一塊開始', () => {
  it('只買過一次 → 起點是那一筆', () => {
    expect(streakStart(5n, ME, [mint(100, 5n)])).toEqual({ kind: 'found', blockNumber: 100 });
  });

  it('分批買進 → 起點是第一筆（持有沒有中斷過）', () => {
    expect(streakStart(8n, ME, [mint(300, 3n), mint(100, 5n)])).toEqual({
      kind: 'found',
      blockNumber: 100,
    });
  });

  it('部分贖回不中斷持有', () => {
    expect(streakStart(2n, ME, [mint(100, 5n), burn(200, 3n)])).toEqual({
      kind: 'found',
      blockNumber: 100,
    });
  });

  it('賣光再買回 → 起點是買回那一筆，不是最早那一次', () => {
    const txs = [mint(100, 5n), burn(200, 5n), mint(300, 2n)];
    expect(streakStart(2n, ME, txs)).toEqual({ kind: 'found', blockNumber: 300 });
  });

  it('同一塊內先賣光再買回，靠 log index 排序', () => {
    const txs = [mint(100, 5n), burn(200, 5n, 0), mint(200, 1n, 1)];
    expect(streakStart(1n, ME, txs)).toEqual({ kind: 'found', blockNumber: 200 });
  });

  it('錢包之間轉進來的也算持有（不只看金庫的 mint）', () => {
    const fromFriend: TransferLike = { blockNumber: 150, index: 0, from: OTHER, to: ME, value: 4n };
    expect(streakStart(4n, ME, [fromFriend])).toEqual({ kind: 'found', blockNumber: 150 });
  });

  it('自己轉給自己不影響餘額', () => {
    const self: TransferLike = { blockNumber: 250, index: 0, from: ME, to: ME, value: 4n };
    expect(streakStart(4n, ME, [mint(100, 4n), self])).toEqual({ kind: 'found', blockNumber: 100 });
  });

  it('掃描範圍內沒有歸零 → before（持有早於掃描起點，不猜）', () => {
    expect(streakStart(10n, ME, [mint(300, 3n)])).toEqual({ kind: 'before' });
    expect(streakStart(10n, ME, [])).toEqual({ kind: 'before' });
  });

  it('倒推出負餘額 → inconsistent（事件缺漏，不顯示）', () => {
    expect(streakStart(1n, ME, [mint(100, 5n)])).toEqual({ kind: 'inconsistent' });
  });

  it('沒有餘額就沒有持有起點', () => {
    expect(streakStart(0n, ME, [mint(100, 5n), burn(200, 5n)])).toEqual({ kind: 'inconsistent' });
  });
});
