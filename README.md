# 盤後零股實戰看板 (`tw-oddlot-board`)

專為不看盤、台股「盤後零股（13:40–14:30 掛單、14:30 單次撮合）」設計的響應式戰情網頁。  
結合 **「日本技術線股神理論」** 與 **「C01–C09 多維度選股濾網」**，採用 **GitHub Pages（前端看板）＋ Google Apps Script（後端運算與排程）＋ Google 試算表（資料庫）＋ LINE Messaging API（推播通知）** 架構，**每日運作 0 AI Token 消耗**。

---

## 一、 核心功能特色
1. **100 檔全市場快速盤後掃描**：每日 **13:38** 自動透過證交所／櫃買中心公開總表 API 抓取 100 檔觀察清單收盤價量，20 秒內完成均線、KD、MACD、裸 K 與 C01–C09 判定。
2. **LINE 行動建議推播**：13:38 掃描完成後立即整合推播至 LINE（含大盤定調、試單股數與限價、持股保姆提醒、反指標警戒）。
3. **15:30 法人補抓 ＋ 週五覆盤週報**：自動補齊三大法人連買天數與成交量前百名統計，每週五寄送 1 分鐘覆盤週報。
4. **獨立篩選條件開關**：網頁內可隨時開啟／關閉 C01–C09、裸 K 共振與排除條件，即時重算名單。
5. **模擬練習倉（Paper Trading）＆ 實戰雙模式**：支援先不花真錢模擬練習，並內建資金水位防呆（上限 4 檔、保留 30%～50% 現金）與 15 分鐘檢核表。
6. **PIN 碼隱私保護**：個人持股、資金與日誌需輸入 PIN 碼才能從 GAS 讀取。

---

## 二、 5 步驟上線教學

### 步驟 1：建立 Google 試算表與 GAS 後端
1. 到 Google 雲端硬碟新增一個 **Google 試算表**（例如命名為 `盤後零股實戰資料庫`）。
2. 點擊上方選單 **擴充功能 → Apps Script**。
3. 將本專案 [`gas/Code.gs`](gas/Code.gs) 的內容**全部複製貼上**覆蓋原本的 `Code.gs`。
4. 修改程式最上方的 `DEFAULT_SETTINGS`：
   * `ACCESS_PIN`: 改成你自己的 4～8 碼密碼（預設 `'1340'`）。
   * `WEB_APP_URL`: 填入你的 GitHub Pages 網址（例如 `https://sawblademft-coder.github.io/tw-oddlot-board/`）。

### 步驟 2：初始化資料庫與 100 檔歷史 K 線
在 Apps Script 編輯器上方的函式下拉選單，依序點擊「執行」以下函式（首次會跳出 Google 授權視窗，請點進階 → 允許）：
1. 執行 `initSystem`（自動建立 10 個工作表與預設 100 檔台股清單）。
2. 依序分批執行以下 4 個函式，載入近 4 個月歷史 K 線（每批約 20～30 秒）：
   * `initHistoricalData_Batch1`
   * `initHistoricalData_Batch2`
   * `initHistoricalData_Batch3`
   * `initHistoricalData_Batch4`

### 步驟 3：申請免費 LINE Messaging API（每月 200 則免費）
1. 前往 [LINE Developers](https://developers.line.biz/) 登入並建立一個 **Messaging API** Channel。
2. 在 **Basic settings** 頁籤底部找到 **Your user ID**（`U` 開頭的一串字）複製起來。
3. 在 **Messaging API** 頁籤底部點擊 **Issue** 產生 **Channel access token** 並複製起來，並掃描 QR Code 把這個官方帳號加為好友。
4. 回到 Google 試算表的 `Config` 工作表，將這兩欄貼進 `LINE_CHANNEL_ACCESS_TOKEN` 與 `LINE_USER_ID` 的 `Value` 欄位（或直接寫在 `Code.gs`）。

### 步驟 4：部署 GAS Web App 並啟動自動排程
1. 在 Apps Script 右上角點擊 **部署 → 新增部署作業**。
2. 類型選擇 **網頁應用程式（Web App）**：
   * 執行身分：**我（Me）**
   * 誰可以存取：**任何人（Anyone）**（前端才能跨網域呼叫，資料有 PIN 碼保護）
3. 部署完成後，複製產生的 **Web App 網址（`.../exec`）**。
4. 在 Apps Script 上方函式選單執行一次 `setupTriggers`，即完成每日 **13:38 盤後掃描推播**、**15:30 法人補抓**、**週五週報**排程。

### 步驟 5：打開網頁連線
1. 用手機或電腦打開你的 GitHub Pages 網址。
2. 首次進入會跳出設定視窗，貼上剛剛複製的 **GAS Web App 網址** 與你的 **PIN 碼**，即可開始使用！（手機可點「加入主畫面」當成 App 開啟）
