// 尊貴坐騎 (Mounts) — replaces the old emoji-only wardrobe. Each mount is a
// 1254×1254 PNG on black, served from /public/pepe-mounts, and unlocks on the
// same level cadence the wardrobe used (1 / 5 / 15 / 30).

import { t } from 'src/locales';

export interface PepeMount {
  id: string;
  name: string;
  desc: string;
  /** Player level required to ride it. */
  levelRequired: number;
  emoji: string;
  image: string;
  /**
   * Base line as a fraction of image height, measured from the PNG — the hero
   * uses it to sit the mount on the golden stage and the frog on the mount.
   */
  groundY: number;
  /**
   * The deck / saddle line as a fraction of image height — measured as the
   * mount's widest row, which is where a rider would actually sit. The frog's
   * own ground line is placed here.
   */
  seatY: number;
  /** Mount width as a fraction of the hero width. */
  width: number;
  /** Frog width as a fraction of the hero width while riding this mount. */
  frogScale: number;
}

/** id 以外全是資料；`name` / `desc` 是顯示字串，住在 catalog。 */
type MountData = Omit<PepeMount, 'name' | 'desc'> & { id: keyof typeof t.pepe.mount };

const MOUNTS: MountData[] = [
  {
    id: 'leaf',
    levelRequired: 1,
    emoji: '🍃',
    image: '/pepe-mounts/leaf.webp',
    groundY: 0.731,
    seatY: 0.412,
    width: 0.95,
    frogScale: 0.58,
  },
  {
    id: 'carpet',
    levelRequired: 5,
    emoji: '🧞',
    image: '/pepe-mounts/carpet.webp',
    groundY: 0.622,
    seatY: 0.322,
    width: 0.95,
    frogScale: 0.56,
  },
  {
    id: 'bitcoin',
    levelRequired: 15,
    emoji: '🪙',
    image: '/pepe-mounts/bitcoin.webp',
    groundY: 0.664,
    seatY: 0.365,
    width: 0.95,
    frogScale: 0.56,
  },
  {
    id: 'whale',
    levelRequired: 30,
    emoji: '🐋',
    image: '/pepe-mounts/whale.webp',
    groundY: 0.787,
    seatY: 0.401,
    width: 1.0,
    frogScale: 0.5,
  },
];

export const PEPE_MOUNTS: PepeMount[] = MOUNTS.map((m) => ({
  ...m,
  name: t.pepe.mount[m.id].name,
  desc: t.pepe.mount[m.id].desc,
}));

export function getMount(id: string): PepeMount | undefined {
  return PEPE_MOUNTS.find((m) => m.id === id);
}

/** The next mount the player has not unlocked yet, or null once all are ridden. */
export function getNextMount(level: number): PepeMount | null {
  return PEPE_MOUNTS.find((m) => level < m.levelRequired) || null;
}
