import type { Theme, CSSObject, Components, ComponentsVariants } from '@mui/material/styles';

import { varAlpha } from 'minimal-shared/utils';

import { buttonClasses } from '@mui/material/Button';

import { colorKeys } from '../palette';

// ----------------------------------------------------------------------

/**
 * TypeScript extension for MUI theme augmentation.
 * @to {@link file://./../../extend-theme-types.d.ts}
 */
export type ButtonExtendSize = { xLarge: true };
export type ButtonExtendVariant = { soft: true };
export type ButtonExtendColor = { black: true; white: true };

type ButtonVariants = ComponentsVariants<Theme>['MuiButton'];

const baseColors = ['inherit'] as const;
const allColors = [...baseColors, ...colorKeys.palette, ...colorKeys.common] as const;

const DIMENSIONS: Record<'small' | 'medium' | 'large' | 'xLarge', CSSObject> = {
  small: { '--padding-y': '4px', '--padding-x': '8px', minHeight: 30, lineHeight: 22 / 13 },
  medium: { '--padding-y': '6px', '--padding-x': '12px', minHeight: 36, lineHeight: 24 / 14 },
  large: { '--padding-y': '8px', '--padding-x': '16px', minHeight: 48, lineHeight: 26 / 15 },
  xLarge: { minHeight: 56 },
};

/* **********************************************************************
 * 🗳️ Variants
 * **********************************************************************/
const containedVariants = [
  {
    props: (props) => props.variant === 'contained' && props.color === 'inherit',
    style: ({ theme }) => ({
      ...theme.mixins.filledStyles(theme, 'inherit', {
        hover: {
          boxShadow: theme.vars.customShadows.z8,
        },
      }),
    }),
  },
  ...(colorKeys.common.map((colorKey) => ({
    props: (props) => props.variant === 'contained' && props.color === colorKey,
    style: ({ theme }) => ({
      ...theme.mixins.filledStyles(theme, colorKey, {
        hover: {
          boxShadow: theme.vars.customShadows.z8,
        },
      }),
    }),
  })) satisfies ButtonVariants),
  ...(colorKeys.palette.map((colorKey) => ({
    props: (props) => props.variant === 'contained' && props.color === colorKey,
    style: ({ theme }) => ({
      '&:hover': {
        boxShadow: theme.vars.customShadows[colorKey],
      },
    }),
  })) satisfies ButtonVariants),
] satisfies ButtonVariants;

const outlinedVariants = [
  {
    props: (props) => props.variant === 'outlined',
    style: ({ theme }) => ({
      borderColor: varAlpha('currentColor', theme.vars.opacity.outlined.border),
      '&:hover': {
        borderColor: 'currentColor',
        boxShadow: '0 0 0 0.75px currentColor',
        backgroundColor: varAlpha('currentColor', theme.vars.palette.action.hoverOpacity),
      },
    }),
  },
  {
    props: (props) => props.variant === 'outlined' && props.color === 'inherit',
    style: ({ theme }) => ({
      borderColor: theme.vars.palette.shared.buttonOutlined,
      '&:hover': {
        backgroundColor: theme.vars.palette.action.hover,
      },
    }),
  },
  ...(colorKeys.common.map((colorKey) => ({
    props: (props) => props.variant === 'outlined' && props.color === colorKey,
    style: ({ theme }) => ({
      color: theme.vars.palette.common[colorKey],
    }),
  })) satisfies ButtonVariants),
] satisfies ButtonVariants;

const textVariants = [
  {
    props: (props) => props.variant === 'text',
    style: ({ theme }) => ({
      '&:hover': {
        backgroundColor: varAlpha('currentColor', theme.vars.palette.action.hoverOpacity),
      },
    }),
  },
  {
    props: (props) => props.variant === 'text' && props.color === 'inherit',
    style: ({ theme }) => ({
      '&:hover': {
        backgroundColor: theme.vars.palette.action.hover,
      },
    }),
  },
  ...(colorKeys.common.map((colorKey) => ({
    props: (props) => props.variant === 'text' && props.color === colorKey,
    style: ({ theme }) => ({
      color: theme.vars.palette.common[colorKey],
    }),
  })) satisfies ButtonVariants),
] satisfies ButtonVariants;

const softVariants = [
  ...(allColors.map((colorKey) => ({
    props: (props) => props.variant === 'soft' && props.color === colorKey,
    style: ({ theme }) => ({
      ...theme.mixins.softStyles(theme, colorKey, { hover: true }),
    }),
  })) satisfies ButtonVariants),
] satisfies ButtonVariants;

/* Touch-target floor, scoped to where it actually applies.
 *
 * DIMENSIONS gives small=30px and medium=36px, and `medium` is MUI's default —
 * so most buttons in the app sat under the 44px touch minimum. Measured on the
 * landing page, the three quick-links rendered at exactly 36px.
 *
 * Raising every button to 44px unconditionally would be the wrong fix. 44px is
 * Apple's HIG figure for *fingers*; WCAG 2.5.8 asks for 24x24 CSS px, and 36px
 * is comfortable under a mouse on the dense desktop dashboard this scale was
 * drawn for. Scoping to coarse pointers gives touch devices the room they need
 * without inflating the desktop layout. */
const touchTargetVariants = [
  {
    props: {},
    style: {
      '@media (pointer: coarse)': { minHeight: 44 },
    },
  },
];

const sizeVariants = [
  {
    props: {},
    style: { padding: 'var(--padding-y) var(--padding-x)' },
  },
  {
    props: (props) => props.size === 'small',
    style: { ...DIMENSIONS.small },
  },
  {
    props: (props) => props.size === 'medium',
    style: { ...DIMENSIONS.medium },
  },
  {
    props: (props) => props.size === 'large' || props.size === 'xLarge',
    style: { ...DIMENSIONS.large },
  },
  {
    props: (props) => props.size === 'xLarge',
    style: ({ theme }) => ({ ...DIMENSIONS.xLarge, fontSize: theme.typography.pxToRem(15) }),
  },
  {
    props: (props) => props.variant === 'outlined',
    style: {
      paddingTop: 'calc(var(--padding-y) - 4px)',
      paddingBottom: 'calc(var(--padding-y) - 4px)',
    },
  },
  {
    props: (props) => props.variant === 'text',
    style: {
      paddingLeft: 'calc(var(--padding-x) - 4px)',
      paddingRight: 'calc(var(--padding-x) - 4px)',
    },
  },
] satisfies ButtonVariants;

const disabledVariants = [
  {
    props: (props) => props.variant === 'soft',
    style: ({ theme }) => ({
      [`&.${buttonClasses.disabled}`]: {
        backgroundColor: theme.vars.palette.action.disabledBackground,
      },
    }),
  },
] satisfies ButtonVariants;

/* **********************************************************************
 * 🧩 Components
 * **********************************************************************/
const MuiButtonBase: Components<Theme>['MuiButtonBase'] = {
  // ▼▼▼▼▼▼▼▼ 🎨 STYLE ▼▼▼▼▼▼▼▼
  styleOverrides: {
    root: ({ theme }) => ({
      fontFamily: theme.typography.fontFamily,
    }),
  },
};

const MuiButton: Components<Theme>['MuiButton'] = {
  // ▼▼▼▼▼▼▼▼ ⚙️ PROPS ▼▼▼▼▼▼▼▼
  defaultProps: {
    color: 'inherit',
    disableElevation: true,
  },
  // ▼▼▼▼▼▼▼▼ 🎨 STYLE ▼▼▼▼▼▼▼▼
  styleOverrides: {
    root: {
      variants: [
        ...containedVariants,
        ...outlinedVariants,
        ...textVariants,
        ...softVariants,
        ...sizeVariants,
        ...disabledVariants,
        // Must come after sizeVariants: those set minHeight 30/36/48, and at
        // equal specificity the later declaration wins. Putting this in `root`
        // instead would lose to them.
        ...touchTargetVariants,
      ],
    },
  },
};

/* **********************************************************************
 * 🚀 Export
 * **********************************************************************/
export const button: Components<Theme> = {
  MuiButton,
  MuiButtonBase,
};
