// 未連錢包也能進入的頁面。其他內頁在未連錢包時一律導回 landing（見 ./index.tsx 的 wallet gate）。
//
// /rwa、/oracle、/solvency 是唯讀揭露頁（公開節點讀鏈，不需錢包）；/lab 是策略實驗室，
// 資料是靜態檔、不讀鏈（issue #332）。

export const PUBLIC_PATHS: readonly string[] = ['/', '/x402', '/marketplace', '/rwa', '/oracle', '/solvency', '/lab'];

export const isPublicPath = (pathname: string): boolean => PUBLIC_PATHS.includes(pathname);
