import Box from '@mui/material/Box';
import { t, interpolate } from 'src/locales';

import type { PepeMount } from 'src/components/pepefi/pepeMountsData';

// ── Pepe Evolution Stages (Lv.0 ~ Lv.6) ───────────────────────────────────────
// The GameFi frog visually evolves as the player levels up. The artwork lives
// in /public/pepe-evolution as stage_0…stage_6.webp — transparent, 640px,
// produced from the 1254px source PNGs in assets-src/ by
// scripts/cutout-assets.py. Referenced as files rather than transcribed into
// JSX, so re-rendering the art only means dropping in a replacement image.

export interface PepeEvolutionStage {
  /** Evolution index 0..6 — matches the artwork set. */
  stage: number;
  /** Player level at which this form is reached. */
  minLevel: number;
  /** Title shown in the stats bar. */
  title: string;
  /** Short label used on the roadmap strip. */
  label: string;
  desc: string;
  /** Accent colour used for glow / borders at this stage. */
  color: string;
  emoji: string;
  /** Artwork, served from /public. */
  image: string;
  /**
   * Where the character's feet / base sit in the artwork, as a fraction of the
   * image height (measured from the art, not guessed). The images were drawn
   * independently, so this varies from 0.821 (the tadpole, which floats) to
   * 0.968 (the god's robe) — a 15pp spread that made the character jump up and
   * down as it evolved. Everything that renders a stage anchors on this so the
   * ground line stays put.
   */
  groundY: number;
}

export const PEPE_EVOLUTION_STAGES: PepeEvolutionStage[] = [
  { stage: 0, minLevel: 1, title: t.pepe.evolution.stage0.title, label: t.pepe.evolution.stage0.label, desc: t.pepe.evolution.stage0.desc, color: '#8fe33d', emoji: '🥚', image: '/pepe-evolution/stage_0.webp', groundY: 0.747 },
  { stage: 1, minLevel: 2, title: t.pepe.evolution.stage1.title, label: t.pepe.evolution.stage1.label, desc: t.pepe.evolution.stage1.desc, color: '#6ab04c', emoji: '🐟', image: '/pepe-evolution/stage_1.webp', groundY: 0.75 },
  { stage: 2, minLevel: 5, title: t.pepe.evolution.stage2.title, label: t.pepe.evolution.stage2.label, desc: t.pepe.evolution.stage2.desc, color: '#8bc34a', emoji: '🐸', image: '/pepe-evolution/stage_2.webp', groundY: 0.825 },
  { stage: 3, minLevel: 8, title: t.pepe.evolution.stage3.title, label: t.pepe.evolution.stage3.label, desc: t.pepe.evolution.stage3.desc, color: '#4caf50', emoji: '📈', image: '/pepe-evolution/stage_3.webp', groundY: 0.85 },
  { stage: 4, minLevel: 15, title: t.pepe.evolution.stage4.title, label: t.pepe.evolution.stage4.label, desc: t.pepe.evolution.stage4.desc, color: '#b0873a', emoji: '🕶️', image: '/pepe-evolution/stage_4.webp', groundY: 0.859 },
  { stage: 5, minLevel: 23, title: t.pepe.evolution.stage5.title, label: t.pepe.evolution.stage5.label, desc: t.pepe.evolution.stage5.desc, color: '#f2c744', emoji: '👑', image: '/pepe-evolution/stage_5.webp', groundY: 0.823 },
  { stage: 6, minLevel: 30, title: t.pepe.evolution.stage6.title, label: t.pepe.evolution.stage6.label, desc: t.pepe.evolution.stage6.desc, color: '#ffe89a', emoji: '😇', image: '/pepe-evolution/stage_6.webp', groundY: 0.75 },
];

/** Highest stage whose level requirement the player has met. */
export function getEvolutionStage(level: number): PepeEvolutionStage {
  let current = PEPE_EVOLUTION_STAGES[0];
  PEPE_EVOLUTION_STAGES.forEach((s) => {
    if (level >= s.minLevel) current = s;
  });
  return current;
}

/** Next form the player is working towards, or null once fully evolved. */
export function getNextEvolutionStage(level: number): PepeEvolutionStage | null {
  return PEPE_EVOLUTION_STAGES.find((s) => level < s.minLevel) || null;
}

/** Where a thumbnail puts the ground line, as a fraction of the tile height. */
const THUMB_GROUND = 0.9;

/** Where the hero puts the ground line, as a fraction of the wrapper height. */
const HERO_GROUND = 0.8;

/** Wrapper aspect for the hero: the art is square, plus room for the podium. */
const HERO_ASPECT = 1.25;

interface PepeEvolutionProps {
  /** Player level — the stage is derived from it. Ignored when `stage` is given. */
  level?: number;
  /** Render a specific stage directly (used by the roadmap strip). */
  stage?: number;
  /** Rendered box size in px (square). */
  size?: number;
  /**
   * Not yet reached. The artwork is withheld entirely — a silhouette stands in,
   * so a future form is never spoiled before the player earns it.
   */
  locked?: boolean;
  /** Gentle idle bobbing — off for the small roadmap thumbnails. */
  animated?: boolean;
  /** Corner rounding of the artwork card. `'50%'` for the circular avatars. */
  radius?: number | string;
}

export default function PepeEvolution({
  level = 1,
  stage,
  size = 140,
  locked = false,
  animated = true,
  radius = 2,
}: PepeEvolutionProps) {
  const resolved =
    stage !== undefined
      ? PEPE_EVOLUTION_STAGES[
          Math.max(0, Math.min(PEPE_EVOLUTION_STAGES.length - 1, stage))
        ]
      : getEvolutionStage(level);

  if (locked) {
    return (
      <Box
        aria-label={interpolate(t.pepe.evolution.lockedAria, { level: resolved.minLevel })}
        sx={{
          width: size,
          height: size,
          mx: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius,
          bgcolor: 'rgba(255,255,255,0.03)',
          border: '1px dashed rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.28)',
          fontSize: size * 0.34,
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        ❔
      </Box>
    );
  }

  // Shift the artwork so every stage's ground line lands on the same row of the
  // tile, instead of each one sitting wherever its source image happened to put
  // it. The tile is black and clips the overflow, so the shift is invisible.
  const shift = (THUMB_GROUND - resolved.groundY) * 100;

  return (
    <Box
      sx={{
        width: size,
        height: size,
        mx: 'auto',
        overflow: 'hidden',
        borderRadius: radius,
        bgcolor: '#000',
        filter: `drop-shadow(0 6px 18px ${resolved.color}55)`,
        animation: animated ? 'pepeThumbFloat 3.4s ease-in-out infinite' : 'none',
        '@keyframes pepeThumbFloat': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      }}
    >
      <Box
        component="img"
        src={resolved.image}
        alt={interpolate(t.pepe.evolution.imageAlt, { label: resolved.label, stage: resolved.stage })}
        sx={{
          width: '100%',
          height: '100%',
          display: 'block',
          // The art is already square, so `cover` fills the slot without cropping.
          objectFit: 'cover',
          transform: `translateY(${shift.toFixed(1)}%)`,
        }}
      />
    </Box>
  );
}

// ── Hero: the enlarged character on its golden stage ──────────────────────────

interface PepeEvolutionHeroProps {
  level: number;
  /** Rendered width in px; the artwork is square. */
  size?: number;
  /** Overrides the evolution artwork — used when a gacha skin is equipped. */
  skinImage?: string;
  /** Ground line of `skinImage`, when it is known. */
  skinGroundY?: number;
  /** Plays the burst + scale-up entrance instead of the idle bob. */
  evolving?: boolean;
  /** Equipped mount. The frog is scaled down and seated on it. */
  mount?: PepeMount | null;
}

/**
 * The frog stands on the golden podium, or rides its mount and the mount stands
 * on the podium. Layering works because the artwork carries a real alpha channel
 * — see scripts/cutout-assets.py, which removes the generated black backdrop.
 * (Before that, each image was an opaque black square and the frog's rectangle
 * simply covered the mount.)
 *
 * Every layer is offset by its measured `groundY` so its base lands exactly on
 * the line it should: HERO_GROUND for whatever touches the podium, the mount's
 * `seatY` for the rider. Without that the tadpole (0.821) hovered above the
 * podium while the god (0.968) pushed through it.
 */
export function PepeEvolutionHero({
  level,
  size = 300,
  skinImage,
  skinGroundY,
  evolving = false,
  mount = null,
}: PepeEvolutionHeroProps) {
  const resolved = getEvolutionStage(level);
  const src = skinImage || resolved.image;

  // Everything is expressed as a fraction of the wrapper, which is square-plus-
  // podium (HERO_ASPECT). The art itself is square, so a full-width image is
  // `1 / HERO_ASPECT` of the wrapper tall.
  const fullImgH = 1 / HERO_ASPECT;
  const frogGround = skinImage ? (skinGroundY ?? 1) : resolved.groundY;

  // Riding: the mount's own ground line goes on the podium, and the frog —
  // scaled down — stands on the mount's seat line rather than on the podium.
  const frogW = mount ? mount.frogScale : 1;
  const frogH = fullImgH * frogW;
  const mountH = mount ? fullImgH * mount.width : 0;
  const mountTop = mount ? HERO_GROUND - mount.groundY * mountH : 0;
  const frogBaseline = mount ? mountTop + mount.seatY * mountH : HERO_GROUND;
  const frogTop = frogBaseline - frogGround * frogH;
  const topPct = frogTop * 100;

  return (
    // Fluid rather than a fixed `size` px: on a narrow dialog the panel is only
    // ~290px wide, so the hero has to shrink instead of overflowing.
    <Box sx={{ position: 'relative', width: '100%', maxWidth: size, aspectRatio: `1 / ${HERO_ASPECT}`, mx: 'auto' }}>
      {/* Ambient glow in the stage's accent colour */}
      <Box
        sx={{
          position: 'absolute',
          inset: `${topPct + 6}% 0 24%`,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${resolved.color}33 0%, transparent 68%)`,
          filter: 'blur(6px)',
          pointerEvents: 'none',
        }}
      />

      {/* Golden stage, concentric with the artwork's own ground ring */}
      <Box
        sx={{
          position: 'absolute',
          left: '4%',
          right: '4%',
          top: `${HERO_GROUND * 100}%`,
          // translateY, not a negative margin: percentage margins resolve
          // against the container's *width*, which left the podium 6px low.
          // Safe to own `transform` here — the shimmer only animates opacity.
          transform: 'translateY(-50%)',
          height: '16%',
          borderRadius: '50%',
          background:
            'radial-gradient(ellipse at 50% 42%, #fff3c4 0%, #ffe07a 26%, #f2c744 48%, #c8912a 68%, rgba(140,96,20,0) 76%)',
          boxShadow: '0 0 46px rgba(242,199,68,0.5), 0 0 90px rgba(242,199,68,0.22)',
          animation: 'pepeStageShimmer 3.6s ease-in-out infinite',
          '@keyframes pepeStageShimmer': {
            '0%, 100%': { opacity: 0.85, filter: 'brightness(1)' },
            '50%': { opacity: 1, filter: 'brightness(1.18)' },
          },
        }}
      />

      {/*
        Mount and rider bob as one group. Two sibling animations with the same
        period would be free to drift out of phase, which reads as the frog
        sliding off its mount. Centring is done with left/right offsets rather
        than translateX(-50%), because the bob owns `transform` — and because
        `@keyframes` names are global in CSS, so a same-named rule elsewhere in
        the app can silently replace this one. That is exactly what knocked the
        whole group off-centre before: the thumbnail's `pepeFloat` (translateY
        only) won, and the -50% centring vanished.
      */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          animation: 'pepeHeroFloat 3.8s ease-in-out infinite',
          '@keyframes pepeHeroFloat': {
            '0%, 100%': { transform: 'translateY(0)' },
            '50%': { transform: 'translateY(-10px)' },
          },
        }}
      >
        {mount && (
          <Box
            component="img"
            src={mount.image}
            alt={mount.name}
            sx={{
              position: 'absolute',
              top: `${(mountTop * 100).toFixed(2)}%`,
              left: `${((1 - mount.width) * 50).toFixed(2)}%`,
              width: `${(mount.width * 100).toFixed(1)}%`,
              height: `${(mountH * 100).toFixed(2)}%`,
              objectFit: 'cover',
              filter: 'drop-shadow(0 10px 26px rgba(242,199,68,0.35))',
            }}
          />
        )}

        <Box
          component="img"
          src={src}
          alt={interpolate(t.pepe.evolution.imageAlt, { label: resolved.label, stage: resolved.stage })}
          sx={{
            position: 'absolute',
            top: `${topPct.toFixed(2)}%`,
            left: `${((1 - frogW) * 50).toFixed(2)}%`,
            width: `${(frogW * 100).toFixed(1)}%`,
            height: `${(frogH * 100).toFixed(2)}%`,
            objectFit: 'cover',
            filter: `drop-shadow(0 10px 26px ${resolved.color}66)`,
            animation: evolving ? 'pepeHeroEvolve 1.1s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
            transformOrigin: '50% 90%',
            '@keyframes pepeHeroEvolve': {
              '0%': { transform: 'scale(0.4)', opacity: 0, filter: 'brightness(3)' },
              '55%': { transform: 'scale(1.12)', opacity: 1, filter: 'brightness(1.6)' },
              '100%': { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
            },
          }}
        />
      </Box>
    </Box>
  );
}
