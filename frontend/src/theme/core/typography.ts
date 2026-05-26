import type { Breakpoint, TypographyVariantsOptions } from '@mui/material/styles';

import { pxToRem, setFont } from 'minimal-shared/utils';

import { createTheme } from '@mui/material/styles';

import { themeConfig } from '../theme-config';

// ----------------------------------------------------------------------

/**
 * TypeScript extension for MUI theme augmentation.
 * @to {@link file://./../extend-theme-types.d.ts}
 */

export type TypographyVariantsExtend = {
  fontWeightSemiBold: React.CSSProperties['fontWeight'];
  fontWeightExtraBold: React.CSSProperties['fontWeight'];
  fontSecondaryFamily: React.CSSProperties['fontFamily'];
};

/**
 * Generates responsive font styles for given breakpoints
 * @param sizes - Object mapping breakpoints to font sizes in pixels
 * @returns CSS media query styles for responsive font sizes
 */
type FontSizesInput = Partial<Record<Breakpoint, number>>;
type FontSizesResult = Record<string, { fontSize: React.CSSProperties['fontSize'] }>;

function responsiveFontSizes(sizes: FontSizesInput): FontSizesResult {
  const {
    breakpoints: { keys, up },
  } = createTheme();

  return keys.reduce((styles, breakpoint) => {
    const size = sizes[breakpoint];

    if (size !== undefined && size >= 0) {
      styles[up(breakpoint)] = {
        fontSize: pxToRem(size),
      };
    }

    return styles;
  }, {} as FontSizesResult);
}

// ----------------------------------------------------------------------

const primaryFont = setFont(themeConfig.fontFamily.primary);
const secondaryFont = setFont(themeConfig.fontFamily.secondary);

const baseTypography: TypographyVariantsOptions = {
  fontFamily: primaryFont,
  fontSecondaryFamily: secondaryFont,
  fontWeightLight: 300,
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightSemiBold: 600,
  fontWeightBold: 700,
  fontWeightExtraBold: 800,
};

/* **********************************************************************
 * 📦 Final
 * **********************************************************************/
/**
 * Line height is set as a unitless ratio: 22 / 14 ≈ 1.57
 * - 22px is the desired visual line height
 * - 14px is the font size
 * This keeps the line height scalable and responsive.
 */
export const typography: TypographyVariantsOptions = {
  ...baseTypography,
  h1: {
    fontFamily: secondaryFont,
    fontWeight: baseTypography.fontWeightExtraBold,
    lineHeight: 80 / 64,
    fontSize: pxToRem(52),
    ...responsiveFontSizes({ sm: 66, md: 74, lg: 82 }),
  },
  h2: {
    fontFamily: secondaryFont,
    fontWeight: baseTypography.fontWeightExtraBold,
    lineHeight: 64 / 48,
    fontSize: pxToRem(40),
    ...responsiveFontSizes({ sm: 50, md: 54, lg: 60 }),
  },
  h3: {
    fontFamily: secondaryFont,
    fontWeight: baseTypography.fontWeightBold,
    lineHeight: 1.5,
    fontSize: pxToRem(32),
    ...responsiveFontSizes({ sm: 36, md: 40, lg: 46 }),
  },
  h4: {
    fontWeight: baseTypography.fontWeightBold,
    lineHeight: 1.5,
    fontSize: pxToRem(25),
    ...responsiveFontSizes({ md: 28 }),
  },
  h5: {
    fontWeight: baseTypography.fontWeightBold,
    lineHeight: 1.5,
    fontSize: pxToRem(22),
    ...responsiveFontSizes({ sm: 23 }),
  },
  h6: {
    fontWeight: baseTypography.fontWeightSemiBold,
    lineHeight: 28 / 18,
    fontSize: pxToRem(20),
    ...responsiveFontSizes({ sm: 21 }),
  },
  subtitle1: {
    fontWeight: baseTypography.fontWeightSemiBold,
    lineHeight: 1.5,
    fontSize: pxToRem(20),
  },
  subtitle2: {
    fontWeight: baseTypography.fontWeightSemiBold,
    lineHeight: 22 / 14,
    fontSize: pxToRem(17),
  },
  body1: {
    lineHeight: 1.5,
    fontSize: pxToRem(20),
  },
  body2: {
    lineHeight: 22 / 14,
    fontSize: pxToRem(18),
  },
  caption: {
    lineHeight: 1.5,
    fontSize: pxToRem(15),
  },
  overline: {
    fontWeight: baseTypography.fontWeightBold,
    lineHeight: 1.5,
    fontSize: pxToRem(15),
    textTransform: 'uppercase',
  },
  button: {
    fontWeight: baseTypography.fontWeightBold,
    lineHeight: 24 / 14,
    fontSize: pxToRem(18),
    textTransform: 'unset',
  },
};
