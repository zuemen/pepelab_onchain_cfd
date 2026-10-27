import { it, expect, describe } from 'vitest';

import { getAddresses } from './addresses';
import { LEGACY_COPY_TRACKERS, legacyCopyTrackersFor } from './legacyCopyTrackers';

describe('legacy CopyTrackers', () => {
  it('skips the tracker that is current, so nobody is counted twice', () => {
    for (const t of LEGACY_COPY_TRACKERS) {
      expect(legacyCopyTrackersFor(t.chainId, t.address.toLowerCase())).not.toContain(t.address);
    }
  });

  it('only lists trackers of the chain asked for', () => {
    expect(legacyCopyTrackersFor(null, null)).toEqual([]);
    expect(legacyCopyTrackersFor(11155111, null)).toEqual([]);
    expect(legacyCopyTrackersFor(84532, null)).toEqual(LEGACY_COPY_TRACKERS.filter((t) => t.chainId === 84532).map((t) => t.address));
  });

  it('never lists the CopyTracker that addresses.ts currently uses', () => {
    for (const t of LEGACY_COPY_TRACKERS) {
      const current = getAddresses(t.chainId)?.CopyTracker;
      if (current) expect(legacyCopyTrackersFor(t.chainId, current)).not.toContain(current);
    }
  });
});
