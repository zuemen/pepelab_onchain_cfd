"""PepeLab 鏈上 CFD 協議 Phase 1 金融風險模型。

模組：
- params：程式實際參數（原始碼與 Base Sepolia 鏈上）
- processes：GBM 與 Merton 跳躍擴散
- calibration：歷史資料抓取、快取與參數校準
- liquidation：清算價、破產價、首次穿越機率
- gap_risk：檢查點之間的跳空壞帳
- insurance：保險庫償付與破產機率
- funding：資金費率與 OI 失衡回復
- inverse：依風險目標反推參數
- plotting：繪圖共用設定
"""
