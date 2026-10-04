# 凍結演練輸出（2026-10-04，本機 anvil 分叉，未對公開鏈送出任何交易）

對應 `docs/RUNBOOK_FREEZE_LEGACY.md` §8。所有輸出已去識別化：持有人位址、部位編號、個人餘額、本機路徑都遮蔽。
攻擊手法不在此記錄（在凍結完成前不公開）。

## Sepolia
- `sepolia-1-plan-sim-broadcast.txt` — 計畫（68 筆）、模擬、分叉廣播；含 N1 的 setFeeRouter→renounce 相鄰、N2 nonce 對帳（1231+68=1299）
- `sepolia-2-readback.txt` — 盤點全集讀回（帶 LOGS_RPC）：外洩地址無權限、Upgraded 恰 3、可疑 0、exit 0
- `sepolia-3-exit-paths.txt` — 使用者提領／平倉／贖回／解除質押＋保留角色＋C1 feeRouter()==0，共 23/23
- `sepolia-4-N1-ordering-and-N2-nonce.txt` — N1 相鄰順序；N2「空窗期多送一筆」→ NonceMismatch 中止
- `sepolia-5-N2-upgrade-detection.txt` — N2「升級事件」：代理被額外 upgradeToAndCall → 事件掃描抓到（count≠3、cutoff 之後），exit 1
- `sepolia-6-M4-backdoor-detection.txt` — 凍結前插入 0xbEEF 後門 → 腳本 verify 看不到，但帶 LOGS_RPC 的 readback 抓到、exit 1

## Base
- `base-1-guards-M2-L1-L2-L3.txt` — 新 owner 檢查：L3 非寫死值被拒、L2 keeper 熱錢包被拒、L1 非允許清單的 7702 委派被拒、happy path 計畫
- `base-2-sim-broadcast-verify.txt` — 模擬／分叉廣播（移交 0x27C2，`--no-storage-caching`）／verify（帶 CONFIRM, I2）；adapter 管理權測試另見 exit-tests 7/7
