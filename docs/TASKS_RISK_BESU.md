# 進度表：風險模型＋Besu 部署計畫

> 狀態：`完成`／`進行中`／`待開始`。Phase 1–4 的子項是依計畫名稱先列的草稿，開工時依任務書修正。
> 原則：修改既有合約不新增方法；`PerpetualExchange` 大小預算餘裕 0 B（見 [`PARAMS_INVENTORY.md`](PARAMS_INVENTORY.md) §8）。

| Phase | 子項 | 狀態 | 產出檔 | 日期 |
|---|---|---|---|---|
| 0 | 0.1 槓桿、IMR／MMR、清算不等式與清算價封閉式 | 完成 | `docs/PARAMS_INVENTORY.md` §1 | 2026-10-05 |
| 0 | 0.2 資金費率（`_pokeFunding`／`settleFunding`）與借貸費 | 完成 | `docs/PARAMS_INVENTORY.md` §2 | 2026-10-05 |
| 0 | 0.3 Oracle 介面、maxPriceAge（原始碼與鏈上）、GuardedOracle、keeper 實際推價間隔 | 完成 | `docs/PARAMS_INVENTORY.md` §3 | 2026-10-05 |
| 0 | 0.4 清算流程、獎勵分配、壞帳瀑布、保險庫資金來源 | 完成 | `docs/PARAMS_INVENTORY.md` §4 | 2026-10-05 |
| 0 | 0.5 抵押品、對手方、OI 上限 | 完成 | `docs/PARAMS_INVENTORY.md` §5 | 2026-10-05 |
| 0 | 0.6 測試框架、測試數量、覆蓋推估 | 完成 | `docs/PARAMS_INVENTORY.md` §6 | 2026-10-05 |
| 0 | 0.7 任務書假設 vs 程式實際 | 完成 | `docs/PARAMS_INVENTORY.md` §7 | 2026-10-05 |
| 0 | 0.8 constant／setter／部署參數清單 | 完成 | `docs/PARAMS_INVENTORY.md` §8 | 2026-10-05 |
| 1 | 1.1 風險模型：以本程式的線性清算式（含 f、β、φ）推導 | 待開始 | — | — |
| 1 | 1.2 MMR、槓桿、OI 上限、獲利上限的校準方法 | 待開始 | — | — |
| 1 | 1.3 keeper 間隔與 maxPriceAge 的關係（價格過期風險） | 待開始 | — | — |
| 2 | 2.1 模擬／壓力測試（價格跳空、壞帳瀑布、ADL） | 待開始 | — | — |
| 2 | 2.2 以 Foundry 測試對照封閉式（只加測試，不改合約） | 待開始 | — | — |
| 3 | 3.1 Besu 網路設定（hard fork／evm_version、contractSizeLimit） | 待開始 | — | — |
| 3 | 3.2 以 `DeployTenant.s.sol`＋租戶設定部署到 Besu | 待開始 | — | — |
| 3 | 3.3 Besu 上的 keeper 與清算 bot | 待開始 | — | — |
| 4 | 4.1 架構：鏈下風險引擎／鏈上 setter／風控＋法遵多簽＋timelock、QBFT 驗證者、許可制 | 完成（設計） | `docs/DESIGN_BESU.md` §1 | 2026-10-05 |
| 4 | 4.2 隱私：Tessera 現況、承諾、ZK 保證金證明、privacy plugin 取捨 | 完成（設計） | `docs/DESIGN_BESU.md` §2 | 2026-10-05 |
| 4 | 4.3 身分准入：合格投資人 VC × 既有 `kyc()`／`rwaAsset` 閘門、撤銷（ADR-016） | 完成（設計） | `docs/DESIGN_BESU.md` §3 | 2026-10-05 |
| 4 | 4.4 結算資產：代幣化存款／穩定幣（對照 ADR-011） | 完成（設計） | `docs/DESIGN_BESU.md` §4 | 2026-10-05 |
| 4 | 4.5 監理定位（需法遵確認） | 完成（設計） | `docs/DESIGN_BESU.md` §5 | 2026-10-05 |
| 4 | 4.6 延伸研究：QAE 估計期望壞帳（只寫文字） | 完成（設計） | `docs/DESIGN_BESU.md` §6 | 2026-10-05 |
| 4 | 4.7 與 Phase 1–3 銜接（`RISK_MODEL.md`／`BESU_CALIBRATION.md` 待填位置） | 進行中（等 Phase 1、3 產出後回填） | `docs/DESIGN_BESU.md` §7 | 2026-10-05 |
