function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const AVATAR_FILES: string[] = [
  '/avatars/pepe-01.png',
  '/avatars/pepe-02.png',
  '/avatars/pepe-03.png',
  '/avatars/pepe-04.png',
  '/avatars/pepe-05.png',
  '/avatars/pepe-06.png',
  '/avatars/pepe-07.png',
  '/avatars/pepe-08.png',
  '/avatars/pepe-09.png',
  '/avatars/pepe-10.png',
  '/avatars/pepe-11.png',
  '/avatars/pepe-12.jpg',
];

export function avatarFor(address: string | null | undefined): string {
  if (!address) return AVATAR_FILES[0];
  return AVATAR_FILES[djb2(address.toLowerCase()) % AVATAR_FILES.length];
}
