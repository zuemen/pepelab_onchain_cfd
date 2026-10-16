// 未連錢包也能進入的頁面。其他內頁在未連錢包時一律導回 landing（見 ./index.tsx 的 wallet gate）。
//
// /rwa、/oracle、/solvency 是唯讀揭露頁（公開節點讀鏈，不需錢包）；/lab 是策略實驗室，
// 資料是靜態檔、不讀鏈（issue #332）。/feed 要讀鏈，但未連錢包時頁面自己顯示「連接錢包」的提示，
// 不導回首頁——直接打開連結的人才知道這一頁在等什麼。

export const PUBLIC_PATHS: readonly string[] = ['/', '/x402', '/marketplace', '/rwa', '/oracle', '/solvency', '/lab', '/feed'];

export const isPublicPath = (pathname: string): boolean => PUBLIC_PATHS.includes(pathname);
