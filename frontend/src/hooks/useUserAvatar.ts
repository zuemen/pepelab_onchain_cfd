import { useState, useEffect, useCallback } from 'react';
import { getUserAvatar, setUserAvatar, AVATAR_FILES } from 'src/lib/pepefi/pepeAvatar';

export function useUserAvatar(address: string | null | undefined) {
  const [src, setSrc] = useState(() => getUserAvatar(address));

  useEffect(() => {
    setSrc(getUserAvatar(address));
  }, [address]);

  // Sync avatar instantly when custom skin is equipped
  useEffect(() => {
    const handleSync = () => {
      setSrc(getUserAvatar(address));
    };
    window.addEventListener('pepefi:gamefi-updated', handleSync);
    return () => window.removeEventListener('pepefi:gamefi-updated', handleSync);
  }, [address]);

  const pick = useCallback(
    (newSrc: string) => {
      if (!address) return;
      setUserAvatar(address, newSrc);
      setSrc(newSrc);
      window.dispatchEvent(new CustomEvent('pepefi:gamefi-updated'));
    },
    [address],
  );

  return { src, pick, options: AVATAR_FILES };
}

