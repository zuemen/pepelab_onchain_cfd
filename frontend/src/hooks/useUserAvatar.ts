import { useState, useEffect, useCallback } from 'react';
import { getUserAvatar, setUserAvatar, AVATAR_FILES } from 'src/lib/pepefi/pepeAvatar';

export function useUserAvatar(address: string | null | undefined) {
  const [src, setSrc] = useState(() => getUserAvatar(address));

  useEffect(() => {
    setSrc(getUserAvatar(address));
  }, [address]);

  const pick = useCallback(
    (newSrc: string) => {
      if (!address) return;
      setUserAvatar(address, newSrc);
      setSrc(newSrc);
    },
    [address],
  );

  return { src, pick, options: AVATAR_FILES };
}
