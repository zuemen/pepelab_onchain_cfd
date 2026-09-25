import { it, expect, describe } from 'vitest';

import { copyDeskVisibility } from './copyDeskVisibility';

describe('copyDeskVisibility', () => {
  it('shows the whole copy-trading desk in Expert Mode, even with no copies', () => {
    expect(copyDeskVisibility('expert', 0)).toEqual({ records: true, stats: false, performance: true });
    expect(copyDeskVisibility('expert', 2)).toEqual({ records: true, stats: true, performance: true });
  });

  it('shows no copy-trading UI in Simple Mode when the user copies nobody (#150)', () => {
    // 空狀態那張卡片帶著「瀏覽交易者 →」——那正是 #150 要收掉的入口。
    expect(copyDeskVisibility('simple', 0)).toEqual({ records: false, stats: false, performance: false });
  });

  it('still lets a Simple Mode user with existing copies see and close them', () => {
    // 收入口、不收既有部位：跟 SHOW_PERPETUALS 與 Open Positions 同一條原則。
    expect(copyDeskVisibility('simple', 1)).toEqual({ records: true, stats: false, performance: false });
  });
});
