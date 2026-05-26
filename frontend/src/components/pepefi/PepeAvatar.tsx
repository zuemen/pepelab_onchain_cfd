import { avatarFor } from 'src/lib/pepefi/pepeAvatar';

export function PepeAvatar({ address, size = 64 }: { address?: string; size?: number }) {
  const src = avatarFor(address);
  return (
    <img
      src={src}
      alt="pepe avatar"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
        border: '2px solid #7cc14a',
        background: '#0e1420',
      }}
      onError={(e) => {
        (e.target as HTMLImageElement).style.opacity = '0.3';
      }}
    />
  );
}
