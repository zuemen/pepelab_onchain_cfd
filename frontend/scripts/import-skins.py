# -*- coding: utf-8 -*-
"""Import per-stage skin artwork end to end.

Point it at the folder holding Stage0…Stage6 and it will, for every stage that
has PNGs in it:

  1. copy the originals to assets-src/pepe-skins/stageN/ (kept in the repo, not
     served — the source art is 1254px and ~1MB each),
  2. cut out the black backdrop and write a transparent 640px WebP to
     public/pepe-skins/stageN/,
  3. measure each one's contact line, and
  4. regenerate src/components/pepefi/pepeStageSkinsData.ts from what it found.

Step 4 rewrites the whole file rather than appending, so running it again after
adding a stage keeps every stage consistent. Ids are derived from SLUGS below
and stay stable across runs — they are persisted in players' localStorage as
the list of skins they own, so changing them would wipe people's collections.

    python scripts/import-skins.py --src "C:/Users/user/Desktop/造型"
    python scripts/import-skins.py --src "..." --only 0     # just Stage0
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, 'public', 'pepe-skins')
ARCHIVE = os.path.join(ROOT, 'assets-src', 'pepe-skins')
DATA = os.path.join(ROOT, 'src', 'components', 'pepefi', 'pepeStageSkinsData.ts')
# The display names live in the locale catalog, not in the data table, so this
# script writes three files: one table of data keyed by id, and one module of
# text per locale keyed by the same id. zh-TW always gets the original artwork
# filename; en always gets a lookup in EN_NAMES below, keyed by the same id.
LOCALES = os.path.join(ROOT, 'src', 'locales')
CATALOGS = {
    'zh-TW': os.path.join(LOCALES, 'zh-TW', 'pepeStageSkins.ts'),
    'en': os.path.join(LOCALES, 'en', 'pepeStageSkins.ts'),
}

# Readable filenames for the Chinese artwork names. Anything missing falls back
# to skin01…skinNN, which still works — it only makes the file on disk less
# self-describing. The display name always comes from the original filename.
SLUGS = {
    # Stage 0 — 神蛋
    'K線神蛋': 'candle', '小蛙神蛋': 'frog', '水晶神蛋': 'crystal', '宇宙神蛋': 'cosmic',
    '佩佩神蛋': 'pepe', '皇冠神蛋': 'crown', '胚胎神蛋': 'embryo', '破殼神蛋': 'hatching',
    '符文神蛋': 'rune', '葉片神蛋': 'leaf',
    # Stage 1 — 蝌蚪
    '休眠蝌蚪': 'sleepy', '哭泣蝌蚪': 'crying', '墨鏡蝌蚪': 'shades', '害羞蝌蚪': 'shy',
    '微笑蝌蚪': 'smile', '暈眩蝌蚪': 'dizzy', '潛水蝌蚪': 'diver', '調皮蝌蚪': 'cheeky',
    '雀躍蝌蚪': 'joyful', '驚訝蝌蚪': 'surprised',
    # Stage 2 — 寶寶
    '奶嘴寶寶': 'pacifier', '奶瓶寶寶': 'bottle', '泰迪寶寶': 'teddy', '爬行寶寶': 'crawling',
    '玩具寶寶': 'toy', '生日寶寶': 'birthday', '睡眠寶寶': 'sleeping', '酷炫寶寶': 'cool',
    '開心寶寶': 'happy', '零食寶寶': 'snack',
    # Stage 3 — 好X蛙
    '好看蛙': 'handsome', '好強蛙': 'strong', '好喝蛙': 'tasty', '好棒蛙': 'awesome',
    '好開心蛙': 'cheerful', '好滑蛙': 'smooth', '好酷蛙': 'cool', '好聰明蛙': 'clever',
    '好聽蛙': 'melodic', '好讚蛙': 'superb',
    # Stage 4 — 精品
    'Boss Elite': 'boss', 'Cyber Elite': 'cyber', '白色精品': 'white', '白金精品': 'platinum',
    '香檳金精品': 'champagne', '酒紅精品': 'burgundy', '深藍精品': 'navy', '紫晶精品': 'amethyst',
    '黑金皮衣': 'leather', '黑金精品': 'blackgold',
    # Stage 5 — 國王
    '北境國王': 'north', '冰雪國王': 'frost', '至尊國王': 'supreme', '法老國王': 'pharaoh',
    '海神國王': 'poseidon', '神聖國王': 'divine', '森林國王': 'forest', '黃金國王': 'golden',
    '暗黑國王': 'dark', '歐洲國王': 'europa',
    # Stage 6 — 大神
    '天使大神': 'angel', '光明大神': 'light', '冰月大神': 'moon', '宇宙大神': 'cosmos',
    '至高大神': 'almighty', '星空大神': 'starry', '時間大神': 'time', '烈焰大神': 'flame',
    '森林大神': 'sylvan', '雷霆大神': 'thunder',
}

EMOJI = {
    'candle': '📈', 'frog': '🐸', 'crystal': '💎', 'cosmic': '🌌', 'pepe': '🥚',
    'crown': '👑', 'embryo': '🧬', 'hatching': '🐣', 'rune': '🔮', 'leaf': '🍃',
    'sleepy': '😴', 'crying': '😭', 'shades': '😎', 'shy': '☺️', 'smile': '🙂',
    'dizzy': '😵', 'diver': '🤿', 'cheeky': '😜', 'joyful': '🤩', 'surprised': '😲',
    'pacifier': '🍼', 'bottle': '🥛', 'teddy': '🧸', 'crawling': '👶', 'toy': '🪀',
    'birthday': '🎂', 'sleeping': '💤', 'cool': '🕶️', 'happy': '😄', 'snack': '🍪',
    'handsome': '😏', 'strong': '💪', 'tasty': '🥤', 'awesome': '👍', 'cheerful': '😆',
    'smooth': '🛹', 'clever': '🧠', 'melodic': '🎧', 'superb': '🏅',
    'boss': '🎩', 'cyber': '🤖', 'white': '🤍', 'platinum': '💠', 'champagne': '🥂',
    'burgundy': '🍷', 'navy': '🌊', 'amethyst': '💜', 'leather': '🧥', 'blackgold': '🖤',
    'north': '❄️', 'frost': '🧊', 'supreme': '👑', 'pharaoh': '🏺', 'poseidon': '🔱',
    'divine': '🕊️', 'forest': '🌳', 'golden': '🥇', 'dark': '🌑', 'europa': '🏰',
    'angel': '👼', 'light': '🌟', 'moon': '🌙', 'cosmos': '🌌', 'almighty': '⚡',
    'starry': '✨', 'time': '⏳', 'flame': '🔥', 'sylvan': '🌲', 'thunder': '🌩️',
}

# English display names, keyed by the final skin id (`s{stage}_{slug}`), not by
# slug alone — a slug can repeat across stages (`cool` is both a Stage2 baby
# and a Stage3 frog) but the two need different English names, so slug alone
# is not a safe key. This is the only place `en/pepeStageSkins.ts` differs
# from `zh-TW/pepeStageSkins.ts`: zh-TW always gets the original artwork
# filename, en always gets a lookup here. Add an entry for every new skin
# before regenerating — a missing one fails the run instead of silently
# writing the Chinese name into `en` (see the `missing_en` check below).
#
# Names are translated for flavour, not literally, and kept short — they
# render inside gacha cards and the skin wall, both narrow.
EN_NAMES = {
    # Stage 0 — Egg
    's0_candle': 'Candle Egg', 's0_pepe': 'OG Pepe Egg', 's0_cosmic': 'Cosmic Egg',
    's0_frog': 'Froglet Egg', 's0_crystal': 'Crystal Egg', 's0_crown': 'Crown Egg',
    's0_hatching': 'Cracking Egg', 's0_rune': 'Rune Egg', 's0_embryo': 'Embryo Egg',
    's0_leaf': 'Leaf Egg',
    # Stage 1 — Tadpole
    's1_sleepy': 'Sleepy Tadpole', 's1_crying': 'Crying Tadpole', 's1_shades': 'Shades Tadpole',
    's1_shy': 'Shy Tadpole', 's1_smile': 'Smiley Tadpole', 's1_dizzy': 'Dizzy Tadpole',
    's1_diver': 'Diver Tadpole', 's1_cheeky': 'Cheeky Tadpole', 's1_joyful': 'Joyful Tadpole',
    's1_surprised': 'Surprised Tadpole',
    # Stage 2 — Baby
    's2_pacifier': 'Pacifier Baby', 's2_bottle': 'Bottle Baby', 's2_teddy': 'Teddy Baby',
    's2_crawling': 'Crawling Baby', 's2_toy': 'Toy Baby', 's2_birthday': 'Birthday Baby',
    's2_sleeping': 'Sleeping Baby', 's2_cool': 'Cool Baby', 's2_happy': 'Happy Baby',
    's2_snack': 'Snack Baby',
    # Stage 3 — "So ___ Frog" (the zh-TW names all share a 好 = "so" prefix; kept in English)
    's3_tasty': 'So Tasty Frog', 's3_strong': 'So Strong Frog', 's3_awesome': 'So Awesome Frog',
    's3_smooth': 'So Smooth Frog', 's3_handsome': 'So Handsome Frog', 's3_clever': 'So Clever Frog',
    's3_melodic': 'So Melodic Frog', 's3_superb': 'So Superb Frog', 's3_cool': 'So Cool Frog',
    's3_cheerful': 'So Cheerful Frog',
    # Stage 4 — Elite
    's4_boss': 'Boss Elite', 's4_cyber': 'Cyber Elite', 's4_navy': 'Navy Elite',
    's4_white': 'White Elite', 's4_platinum': 'Platinum Elite', 's4_amethyst': 'Amethyst Elite',
    's4_burgundy': 'Burgundy Elite', 's4_champagne': 'Champagne Elite',
    's4_leather': 'Black Gold Leather', 's4_blackgold': 'Black Gold Elite',
    # Stage 5 — King
    's5_frost': 'Frost King', 's5_north': 'North King', 's5_dark': 'Dark King',
    's5_forest': 'Forest King', 's5_europa': 'Europa King', 's5_pharaoh': 'Pharaoh King',
    's5_poseidon': 'Poseidon King', 's5_divine': 'Divine King', 's5_supreme': 'Supreme King',
    's5_golden': 'Golden King',
    # Stage 6 — God
    's6_light': 'Light God', 's6_moon': 'Moon God', 's6_angel': 'Angel God',
    's6_cosmos': 'Cosmos God', 's6_starry': 'Starry God', 's6_time': 'Time God',
    's6_sylvan': 'Sylvan God', 's6_flame': 'Flame God', 's6_almighty': 'Almighty God',
    's6_thunder': 'Thunder God',
}

# Rarity by position in the sorted pool, so a pool of ten is always
# 5 Common / 3 Rare / 1 Epic / 1 Legendary.
RARITY = ['Common'] * 5 + ['Rare'] * 3 + ['Epic'] + ['Legendary']
PRICE = {'Common': 150, 'Rare': 320, 'Epic': 650, 'Legendary': 1200}

HEADER = '''// Per-stage skin pools. The shop and the gacha only ever offer the pool that
// matches the player's current evolution stage — a Lv.0 egg is offered egg
// skins, a tadpole is offered tadpole skins, and so on.
//
// Stages with no artwork yet are simply absent from this map; the UI treats a
// missing pool as "coming soon" rather than erroring or falling back to another
// stage's art.
//
// GENERATED by scripts/import-skins.py — edit that, not this.

import { t } from 'src/locales';

export interface StageSkin {
  id: string;
  name: string;
  stage: number;
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  price: number;
  emoji: string;
  image: string;
  /** Contact line as a fraction of image height, measured from the WebP. */
  groundY: number;
}

/** id 以外全是資料；`name` 是顯示字串，住在 catalog。 */
type StageSkinData = Omit<StageSkin, 'name'> & { id: keyof typeof t.pepeStageSkins };

const STAGE_SKINS: Record<number, StageSkinData[]> = {
'''

FOOTER = '''};

export const PEPE_STAGE_SKINS: Record<number, StageSkin[]> = Object.fromEntries(
  Object.entries(STAGE_SKINS).map(([stage, skins]) => [
    Number(stage),
    skins.map((s) => ({ ...s, name: t.pepeStageSkins[s.id] })),
  ]),
);

/** The pool for a stage, or an empty array when that artwork does not exist yet. */
export function getStageSkins(stage: number): StageSkin[] {
  return PEPE_STAGE_SKINS[stage] || [];
}

/** Every skin across every stage — used to resolve an equipped skin by id. */
export const ALL_STAGE_SKINS: StageSkin[] = Object.values(PEPE_STAGE_SKINS).flat();

/** Resolve an owned skin by its id, whichever stage it came from. */
export function findStageSkin(id: string): StageSkin | undefined {
  return ALL_STAGE_SKINS.find((s) => s.id === id);
}
'''

# The catalog modules. `zh-TW` is the shape source; `en` is annotated with its
# type so a missing or extra id is a compile error rather than a runtime hole.
CATALOG_HEADER = {
    'zh-TW': [
        '/**',
        ' * 各進化階段造型的名稱。',
        ' *',
        ' * GENERATED by scripts/import-skins.py — edit that, not this.',
        ' * 名字來自畫稿的原始檔名，所以要改名字是改畫稿或腳本裡的對照表。',
        ' */',
        'export const pepeStageSkins = {',
    ],
    'en': [
        "import type { Catalog } from '../zh-TW';",
        '',
        '/**',
        ' * 見 `../zh-TW/pepeStageSkins.ts`。',
        ' *',
        ' * GENERATED by scripts/import-skins.py — edit that, not this. 英文名字住在',
        ' * 腳本的 EN_NAMES 表，用 skin id 當 key；新增造型卻沒有對應的英文名字，',
        ' * 產生腳本會直接失敗，不會把中文名字偷偷寫進這份 en catalog。',
        ' */',
        "export const pepeStageSkins: Catalog['pepeStageSkins'] = {",
    ],
}


def run(script: str, *args: str) -> str:
    out = subprocess.run([sys.executable, os.path.join(HERE, script), *args],
                         capture_output=True, text=True, encoding='utf-8')
    if out.returncode:
        sys.exit('%s failed:\n%s' % (script, out.stderr))
    return out.stdout


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='folder containing Stage0…Stage6')
    ap.add_argument('--only', type=int, default=None, help='import a single stage')
    ap.add_argument('--size', type=int, default=640)
    args = ap.parse_args()

    pools = {}
    for stage in range(7):
        if args.only is not None and stage != args.only:
            # Keep stages we are not touching, by reading what is already on disk.
            existing = os.path.join(PUBLIC, 'stage%d' % stage)
            if os.path.isdir(existing) and os.listdir(existing):
                pools[stage] = sorted(
                    f for f in os.listdir(existing) if f.endswith('.webp'))
            continue

        src_dir = os.path.join(args.src, 'Stage%d' % stage)
        if not os.path.isdir(src_dir):
            continue
        pngs = sorted(f for f in os.listdir(src_dir) if f.lower().endswith('.png'))
        if not pngs:
            continue

        out_dir = os.path.join(PUBLIC, 'stage%d' % stage)
        arc_dir = os.path.join(ARCHIVE, 'stage%d' % stage)
        os.makedirs(out_dir, exist_ok=True)
        os.makedirs(arc_dir, exist_ok=True)

        staged = []
        for i, f in enumerate(pngs):
            name = os.path.splitext(f)[0]
            slug = SLUGS.get(name, 'skin%02d' % (i + 1))
            shutil.copy2(os.path.join(src_dir, f), os.path.join(arc_dir, slug + '.png'))
            staged.append((slug, name))

        run('cutout-assets.py',
            *[os.path.join(arc_dir, s + '.png') for s, _ in staged],
            '--out', out_dir, '--size', str(args.size))
        print('Stage%d: %d skins -> public/pepe-skins/stage%d/' % (stage, len(staged), stage))
        pools[stage] = [(s, n) for s, n in staged]

    # Re-measure everything we are about to write out.
    lines = [HEADER]
    names_zh = []
    names_en = []
    missing_en = []
    for stage in sorted(pools):
        entries = pools[stage]
        if entries and isinstance(entries[0], str):        # untouched stage
            entries = [(os.path.splitext(e)[0], os.path.splitext(e)[0]) for e in entries]
        paths = [os.path.join(PUBLIC, 'stage%d' % stage, s + '.webp') for s, _ in entries]
        anchors = json.loads(run('measure-anchors.py', *paths))

        lines.append('  %d: [' % stage)
        for i, (slug, name) in enumerate(entries):
            rarity = RARITY[i % len(RARITY)]
            sid = 's%d_%s' % (stage, slug)
            lines.append(
                "    { id: '%s', stage: %d, rarity: '%s', "
                "price: %d, emoji: '%s', image: '/pepe-skins/stage%d/%s.webp', "
                "groundY: %s },"
                % (sid, stage, rarity, PRICE[rarity] + stage * 40,
                   EMOJI.get(slug, '🐸'), stage, slug, anchors[slug]['groundY']))
            names_zh.append("  %s: '%s'," % (sid, name))
            en_name = EN_NAMES.get(sid)
            if not en_name:
                missing_en.append(sid)
            else:
                names_en.append("  %s: '%s'," % (sid, en_name.replace("'", "\\'")))
        lines.append('  ],')
    lines.append(FOOTER)

    if missing_en:
        sys.exit(
            'import-skins.py: EN_NAMES has no English name for: %s\n'
            'Add an entry for each in EN_NAMES before the en/ catalog can be '
            'written — this stops a new skin from silently shipping with its '
            'Chinese name in the English build.' % ', '.join(missing_en))

    with open(DATA, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print('wrote %s (%d stages)' % (os.path.relpath(DATA, ROOT), len(pools)))

    catalog_names = {'zh-TW': names_zh, 'en': names_en}
    for loc, target in CATALOGS.items():
        with open(target, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(CATALOG_HEADER[loc] + catalog_names[loc] + ['};', '']))
        print('wrote %s' % os.path.relpath(target, ROOT))


if __name__ == '__main__':
    main()
