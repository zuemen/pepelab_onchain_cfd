import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';

import { tickerOf } from 'src/lib/pepefi/assetMeta';

interface Props {
  /** 鏈上 symbol（sETH）或畫面代號（ETH）都可以——一律先換成 ticker 再查圖。 */
  symbol: string;
  size?: number;
}

const LOGO_DIR = '/assets/images/pepefi/logos';

/**
 * 標的真實的品牌標誌，放在 public/assets/images/pepefi/logos/。來源是 Simple Icons
 * 與 svg-logos（皆 CC0）；黃金沒有品牌，用 Material Design Icons 的金條（Apache-2.0）。
 * `pad` 是圖案離圓邊的留白比例，`bg` 是圓底。
 */
const LOGOS: Record<string, { src: string; bg: string; pad: number }> = {
  AAPL: { src: `${LOGO_DIR}/aapl.svg`, bg: '#ffffff', pad: 0.22 },
  TSLA: { src: `${LOGO_DIR}/tsla.svg`, bg: '#ffffff', pad: 0.2 },
  NVDA: { src: `${LOGO_DIR}/nvda.svg`, bg: '#ffffff', pad: 0.18 },
  MSFT: { src: `${LOGO_DIR}/msft.svg`, bg: '#ffffff', pad: 0.24 },
  GOOGL: { src: `${LOGO_DIR}/googl.svg`, bg: '#ffffff', pad: 0.22 },
  XAU: { src: `${LOGO_DIR}/xau.svg`, bg: 'linear-gradient(135deg, #f5c542 0%, #b8860b 100%)', pad: 0.2 },
};

/** iShares 的三檔 ETF：沒有可自由使用的發行方標誌，用 iShares 的黑底白字代號。 */
const ISHARES_ETF = new Set(['ICLN', 'ESGU', 'BGRN']);

const ring = { border: '1px solid', borderColor: 'divider' } as const;

export default function AssetIcon({ symbol, size = 32 }: Props) {
  const ticker = tickerOf(symbol).toUpperCase();

  // BTC 與 ETH 的 SVG 本身就是滿版圓形標誌。
  if (ticker === 'BTC' || ticker === 'ETH') {
    return (
      <Avatar
        src={`/assets/images/pepefi/${ticker.toLowerCase()}.svg`}
        alt={ticker}
        sx={{
          width: size,
          height: size,
          bgcolor: ticker === 'BTC' ? '#f7931a' : '#627eea',
          border: '1px solid rgba(255,255,255,0.15)',
        }}
      />
    );
  }

  const logo = LOGOS[ticker];
  if (logo) {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: '50%',
          background: logo.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: `${size * logo.pad}px`,
          ...ring,
        }}
      >
        <Box
          component="img"
          src={logo.src}
          alt={ticker}
          sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </Box>
    );
  }

  // ETF 與其他沒有標誌的標的：代號本身就是辨識方式。字數越多字越小，才塞得進圓裡。
  const isEtf = ISHARES_ETF.has(ticker);
  const text = isEtf ? ticker : ticker[0] || '?';
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        bgcolor: isEtf ? '#000000' : 'grey.600',
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        fontSize: `${size * (text.length > 1 ? 1.1 / text.length : 0.5)}px`,
        lineHeight: 1,
        ...ring,
      }}
    >
      {text}
    </Box>
  );
}
