import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';

interface Props {
  symbol: string;
  size?: number;
}

export default function AssetIcon({ symbol, size = 32 }: Props) {
  const sym = symbol.toUpperCase().replace(/^S/, ''); // e.g. sBTC -> BTC

  // 1. Check if we have our custom SVG files for BTC and ETH
  if (sym === 'BTC') {
    return (
      <Avatar
        src="/assets/images/pepefi/btc.svg"
        alt="BTC"
        sx={{ width: size, height: size, bgcolor: '#f7931a', border: '1px solid rgba(255,255,255,0.15)' }}
      />
    );
  }
  if (sym === 'ETH') {
    return (
      <Avatar
        src="/assets/images/pepefi/eth.svg"
        alt="ETH"
        sx={{ width: size, height: size, bgcolor: '#627eea', border: '1px solid rgba(255,255,255,0.15)' }}
      />
    );
  }

  // 2. Custom styled items
  if (sym === 'GOLD') {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #ffd700 0%, #b8860b 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: `${size * 0.55}px`,
          boxShadow: '0 0 12px rgba(255, 215, 0, 0.4)',
          border: '1px solid rgba(255, 215, 0, 0.5)',
        }}
      >
        🥇
      </Box>
    );
  }

  // Brands & other categories
  const getBrandStyle = () => {
    switch (sym) {
      case 'AAPL':
        return { bg: 'linear-gradient(135deg, #ffffff 0%, #8e8e93 100%)', color: '#111111', char: '🍎' };
      case 'TSLA':
        return { bg: 'linear-gradient(135deg, #e82127 0%, #8b0000 100%)', color: '#ffffff', char: '⚡' };
      case 'NVDA':
        return { bg: 'linear-gradient(135deg, #76b900 0%, #1a3000 100%)', color: '#ffffff', char: '🖥' };
      case 'MSFT':
        return { bg: 'linear-gradient(135deg, #00a4ef 0%, #005f8a 100%)', color: '#ffffff', char: '🪟' };
      case 'GOOGL':
        return { bg: 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)', color: '#ffffff', char: '🔍' };
      case 'ICLN':
        return { bg: 'linear-gradient(135deg, #10b981 0%, #047857 100%)', color: '#ffffff', char: '🌿' };
      case 'ESGU':
        return { bg: 'linear-gradient(135deg, #34d399 0%, #065f46 100%)', color: '#ffffff', char: '🌱' };
      case 'BOND':
        return { bg: 'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)', color: '#ffffff', char: '📜' };
      default:
        return { bg: 'linear-gradient(135deg, #919eab 0%, #454f5b 100%)', color: '#ffffff', char: sym[0] || '?' };
    }
  };

  const style = getBrandStyle();

  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: style.bg,
        color: style.color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 'bold',
        fontSize: `${size * 0.5}px`,
        border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      {style.char}
    </Box>
  );
}
