# 凍結演練輸出（2026-10-04，本機 anvil 分叉，未對公開鏈送出任何交易）

對應 `docs/RUNBOOK_FREEZE_LEGACY.md` §8。所有輸出已去識別化：持有人位址、部位編號、個人餘額、本機路徑都遮蔽。
攻擊手法不在此記錄（見內部審查）。

- `sepolia-0-guards-M1-M3-and-plan.txt` — M1（廣播缺 FREEZE_CONFIRM 被拒）、M3（缺 V2_ADMIN_PROVEN 被拒）、計畫
- `sepolia-1..4` — 計畫／模擬／分叉廣播／verify
- `sepolia-5-readback.txt` — 盤點全集讀回（不帶、帶 LOGS_RPC 兩種）
- `sepolia-6-exit-paths-after-freeze.txt` — 使用者提領／平倉／贖回／解除質押＋保留角色＋C1 feeRouter()==0，共 23/23
- `sepolia-7-M4-backdoor-detection.txt` — 先插後門再凍結，readback(+LOGS_RPC) 抓到
- `base-0-guards-M2.txt` — M2 新 owner 五種非法輸入全部被拒 + happy path 計畫
- `base-1..4` — 計畫／模擬／分叉廣播（移交 0x27C2）／verify
- `base-5-readback.txt`、`base-6-after-freeze.txt` — 讀回與 adapter 管理權測試 7/7
