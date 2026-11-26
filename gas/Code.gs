/**
 * 盤後零股實戰看板 - Google Apps Script 後端程式 (Code.gs)
 * 整合「日本技術線股神理論」與「C01–C09 多維度選股濾網」
 * 支援：100檔全市場快速抓取、13:38精準排程與LINE推播、15:30法人補抓、週五週報、
 *       實戰/模擬練習倉(Paper Trading)、資金水位防呆、持股保姆、每日統計與獨立條件開關
 */

// ==================== 1. 基本設定區（部署前請依需求修改） ====================
const DEFAULT_SETTINGS = {
  ACCESS_PIN: '1340', // 請改成你自己的 4~8 碼安全密碼
  TOTAL_CAPITAL: 100000, // 預設總資金 10 萬元
  RISK_PCT: 0.01, // 單筆最大容忍虧損 1% (高波動極端不超過 1.5%)
  MAX_SINGLE_STOCK_PCT: 0.24, // 單一標的滿倉上限 24%
  MIN_CASH_RESERVE_PCT: 0.30, // 高波動期最低保留現金比例 30%
  MAX_HOLDINGS_COUNT: 4, // 同時持有上限 4 檔
  TRADING_MODE: 'PAPER', // 'PAPER' (模擬練習) 或 'REAL' (實戰)
  LINE_CHANNEL_ACCESS_TOKEN: '', // 填入 LINE Messaging API Channel Access Token
  LINE_USER_ID: '', // 填入你的 LINE User ID
  WEB_APP_URL: '' // 填入你的 GitHub Pages 網址，供 LINE 推播附帶連結
};

const SHEET_NAMES = {
  CONFIG: 'Config',
  WATCHLIST: 'Watchlist',
  HISTORY: 'History_Cache',
  INSTITUTIONAL: 'Institutional_Cache',
  DAILY_LOG: 'Daily_Log',
  STATS: 'Stats_Summary',
  HOLDINGS: 'Holdings',
  JOURNAL: 'Trade_Journal',
  FILTERS: 'Filter_Settings',
  MARKET_INDEX: 'Market_Index',
  AUTO_EQUITY: 'Auto_Equity_Curve',
  AUTO_TRADES: 'Auto_Trades'
};

// ==================== 2. 系統初始化（首次使用執行一次） ====================
function initSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Config
  const cfgSheet = getOrCreateSheet(ss, SHEET_NAMES.CONFIG, ['Key', 'Value', 'Description']);
  if (cfgSheet.getLastRow() <= 1) {
    const rows = [
      ['ACCESS_PIN', DEFAULT_SETTINGS.ACCESS_PIN, '網頁登入驗證 PIN 碼'],
      ['TOTAL_CAPITAL', DEFAULT_SETTINGS.TOTAL_CAPITAL, '總操作資金 (元)'],
      ['RISK_PCT', DEFAULT_SETTINGS.RISK_PCT, '單筆最大容忍虧損比例 (0.01 = 1%)'],
      ['MAX_SINGLE_STOCK_PCT', DEFAULT_SETTINGS.MAX_SINGLE_STOCK_PCT, '單一標的滿倉上限比例'],
      ['MIN_CASH_RESERVE_PCT', DEFAULT_SETTINGS.MIN_CASH_RESERVE_PCT, '最低保留現金比例'],
      ['MAX_HOLDINGS_COUNT', DEFAULT_SETTINGS.MAX_HOLDINGS_COUNT, '最大同時持股檔數'],
      ['TRADING_MODE', DEFAULT_SETTINGS.TRADING_MODE, '目前模式: PAPER(模擬) / REAL(實戰)'],
      ['LINE_CHANNEL_ACCESS_TOKEN', DEFAULT_SETTINGS.LINE_CHANNEL_ACCESS_TOKEN, 'LINE Messaging API Token'],
      ['LINE_USER_ID', DEFAULT_SETTINGS.LINE_USER_ID, '你的 LINE User ID'],
      ['WEB_APP_URL', DEFAULT_SETTINGS.WEB_APP_URL, 'GitHub Pages 網頁網址'],
      ['LAST_SCAN_TIME', '', '最後一次盤後掃描時間']
    ];
    cfgSheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  // 2. Filter_Settings (獨立條件開關)
  const fltSheet = getOrCreateSheet(ss, SHEET_NAMES.FILTERS, ['FilterId', 'Name', 'Category', 'Enabled', 'Description']);
  if (fltSheet.getLastRow() <= 1) {
    const filters = [
      ['C08', 'C08 成交量門檻 (>1,000張)', '必備底線', true, '當日整張成交量 > 1,000 張，確保流動性'],
      ['C09', 'C09 中長期均線多頭', '必備底線', true, '收盤站上 20 日線及 60 日線且兩線維持上彎'],
      ['C01', 'C01 強於大盤 (RS)', '必備底線', true, '相對加權指數展現抗跌或較強反彈漲幅'],
      ['C03', 'C03 以盤代跌結構', '結構加分', false, '近10日振幅收縮且守穩關鍵均線不破底'],
      ['C04', 'C04 均線糾結發散', '買點觸發', false, '5/10/20/60日線靠攏糾結後帶量向上發散'],
      ['C05', 'C05 KD 中低檔金叉', '動能驗證', false, '日KD於中低位階(K,D<=60)黃金交叉向上'],
      ['C06', 'C06 MACD 趨勢向上', '動能驗證', false, '日MACD柱狀體由負轉正或紅柱持續擴大'],
      ['C02', 'C02 財報與法人連買5日', '籌碼保護', false, '財報體質穩健且外資/投信連買5日以上'],
      ['C07', 'C07 市場熱門前百名', '熱度加分', false, '名列當日台股成交量前 100 名'],
      ['NAKED_K', '裸K雙重共振 (下半身/鳥嘴/吞噬/晨星)', '共振加分', false, '出現相場師朗下半身、鳥嘴或酒田轉折訊號'],
      ['EXCL_9DAY', '排除連漲過熱 (連漲>=2根)', '警訊排除', true, '自動排除連續上漲>=2根K線之短線過熱標的'],
      ['EXCL_UPPER_SHADOW', '排除爆量長上影線 / 夜星', '警訊排除', true, '自動排除高檔爆量留長上影線或夜星反轉標的'],
      ['SHOW_ANTI', '顯示空頭/高檔反指標對照組', '對照觀察', true, '在清單中標記逆PPP或高檔過熱股作為避雷參考']
    ];
    fltSheet.getRange(2, 1, filters.length, 5).setValues(filters);
  }

  // 3. Watchlist (預設 100 檔台股主流權值、龍頭、ETF 與高波動觀察股)
  const wlSheet = getOrCreateSheet(ss, SHEET_NAMES.WATCHLIST, ['Code', 'Name', 'Category', 'Market', 'C02_Status', 'C02_Note', 'Active']);
  if (wlSheet.getLastRow() <= 1) {
    const stocks = getDefault100Watchlist();
    wlSheet.getRange(2, 1, stocks.length, 7).setValues(stocks);
  }

  // 4. 其他資料表
  getOrCreateSheet(ss, SHEET_NAMES.HISTORY, ['Date', 'Code', 'Open', 'High', 'Low', 'Close', 'Volume', 'PE', 'Yield', 'PB']);
  getOrCreateSheet(ss, SHEET_NAMES.MARKET_INDEX, ['Date', 'Close', 'ChangePct', 'SMA5', 'SMA20', 'SMA60', 'Tone']);
  getOrCreateSheet(ss, SHEET_NAMES.INSTITUTIONAL, ['Code', 'Date', 'NetBuyShares', 'ConsecutiveDays', 'Top100Vol']);
  getOrCreateSheet(ss, SHEET_NAMES.DAILY_LOG, ['Date', 'Code', 'Name', 'Close', 'ChangePct', 'VolumeLots', 'Hits', 'Action', 'Reason', 'RecShares', 'LimitPrice', 'StopLoss', 'PE', 'Yield', 'InstDays', 'C02Status', 'TechJson']);
  getOrCreateSheet(ss, SHEET_NAMES.STATS, ['Code', 'Name', 'Category', 'TotalDays', 'BasePassDays', 'BuySignalDays', 'AlertDays', 'AvgVol20Lots', 'LastClose', 'LastAction', 'MonthlyReview']);
  getOrCreateSheet(ss, SHEET_NAMES.HOLDINGS, ['Id', 'Mode', 'Code', 'Name', 'Stage', 'Shares', 'AvgCost', 'StopLoss', 'HighestPrice', 'EntryDate', 'DaysHeld', 'Status']);
  getOrCreateSheet(ss, SHEET_NAMES.JOURNAL, ['Id', 'Date', 'Mode', 'Code', 'Name', 'Side', 'Stage', 'Shares', 'Price', 'Amount', 'PnL', 'Reason', 'DisciplineNote']);

  Logger.log('系統試算表初始化完成！請接著分批執行 initHistoricalData_Batch1 ~ 4 載入近3個月歷史K線。');
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f1f5f9');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

// ==================== 3. 初次歷史資料載入（分 4 批避免超時） ====================
function initHistoricalData_Batch1() { fetchHistoricalBatch(0, 25); }
function initHistoricalData_Batch2() { fetchHistoricalBatch(25, 50); }
function initHistoricalData_Batch3() { fetchHistoricalBatch(50, 75); }
function initHistoricalData_Batch4() { fetchHistoricalBatch(75, 100); }

function fetchHistoricalBatch(startIdx, endIdx) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wlSheet = ss.getSheetByName(SHEET_NAMES.WATCHLIST);
  const histSheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
  const mktSheet = ss.getSheetByName(SHEET_NAMES.MARKET_INDEX);

  // 第 1 批順便抓大盤歷史指數 (^TWII)
  if (startIdx === 0 && mktSheet.getLastRow() <= 1) {
    const twiiRows = fetchYahooHistory('^TWII', '4mo');
    if (twiiRows.length > 0) {
      const mktOut = twiiRows.map((r, i) => {
        const prev = i > 0 ? twiiRows[i - 1].close : r.close;
        const chg = prev > 0 ? ((r.close - prev) / prev) * 100 : 0;
        return [r.date, r.close, Number(chg.toFixed(2)), '', '', '', ''];
      });
      mktSheet.getRange(2, 1, mktOut.length, 7).setValues(mktOut);
    }
  }

  const wlData = wlSheet.getDataRange().getValues().slice(1);
  const slice = wlData.slice(startIdx, endIdx);
  const newRows = [];

  slice.forEach(row => {
    const code = String(row[0]).trim();
    const market = String(row[3]).trim();
    if (!code) return;
    const suffix = market === 'TPEX' ? '.TWO' : '.TW';
    const bars = fetchYahooHistory(code + suffix, '2y');
    bars.forEach(b => {
      newRows.push([b.date, code, b.open, b.high, b.low, b.close, b.volume, '', '', '']);
    });
    Utilities.sleep(150);
  });

  if (newRows.length > 0) {
    const lastRow = histSheet.getLastRow();
    histSheet.getRange(lastRow + 1, 1, newRows.length, 10).setValues(newRows);
  }
  Logger.log(`歷史資料批次 ${startIdx + 1} ~ ${Math.min(endIdx, wlData.length)} 載入完成，共寫入 ${newRows.length} 筆。`);
}

function fetchYahooHistory(symbol, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return [];
    const json = JSON.parse(res.getContentText());
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.timestamp) return [];

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      const d = new Date(ts[i] * 1000);
      const dateStr = Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
      out.push({
        date: dateStr,
        open: Number(q.open[i].toFixed(2)),
        high: Number(q.high[i].toFixed(2)),
        low: Number(q.low[i].toFixed(2)),
        close: Number(q.close[i].toFixed(2)),
        volume: Math.round((q.volume[i] || 0) / 1000) // 轉成「張」
      });
    }
    return out;
  } catch (e) {
    Logger.log('Yahoo fetch error for ' + symbol + ': ' + e.message);
    return [];
  }
}

// ==================== 4. 每日 13:38 盤後掃描、統計分析與 LINE 推播 ====================
function runDailyAfterHoursScan() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfigMap(ss);
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  // 0. 同步更新 Filter_Settings 的 EXCL_9DAY 文字說明 (>=2根)
  try {
    const fSheet = ss.getSheetByName(SHEET_NAMES.FILTERS);
    const fRows = fSheet.getDataRange().getValues();
    for (let i = 1; i < fRows.length; i++) {
      if (fRows[i][0] === 'EXCL_9DAY') {
        fSheet.getRange(i + 1, 2).setValue('排除連漲過熱 (連漲>=2根)');
        fSheet.getRange(i + 1, 5).setValue('自動排除連續上漲>=2根K線之短線過熱標的');
        break;
      }
    }
  } catch (e) {}

  // 1. 抓取估值(PE/Yield/PB) 與 TWSE/TPEx 總表(用於 C07 熱門前百名)
  const twseAll = fetchTwseAllQuotes(todayStr);
  const tpexAll = fetchTpexAllQuotes();
  const valuationAll = fetchTwseValuationAll();
  const top100Set = buildTop100VolumeSet(twseAll, tpexAll);

  // 2. 讀取 Watchlist 並用 Yahoo Finance 並發抓取 100 檔近5日最新K線 (最穩、無快取延遲)
  const wlRows = ss.getSheetByName(SHEET_NAMES.WATCHLIST).getDataRange().getValues().slice(1);
  const yahooLatestMap = fetchYahooLatestQuotesBatch(wlRows);

  // 3. 更新大盤加權指數
  const marketStatus = updateAndEvaluateMarketIndex(ss, todayStr, Object.keys(yahooLatestMap).length > 50);
  const scanDateStr = marketStatus.date || todayStr;

  // 4. 讀取 History, Institutional
  const histSheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
  const histRows = histSheet.getDataRange().getValues().slice(1);
  const instMap = getInstitutionalMap(ss);

  // 建立依代號分組的歷史陣列（用 Map 依日期去重並排序）
  const histByCode = {};
  const existingDateKeys = new Set();
  histRows.forEach(r => {
    const c = normCode(r[1]);
    const dStr = formatDateVal(r[0]);
    if (!c || !dStr) return;
    existingDateKeys.add(c + '_' + dStr);
    if (!histByCode[c]) histByCode[c] = {};
    histByCode[c][dStr] = {
      date: dStr,
      open: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      close: Number(r[5]),
      volume: Number(r[6])
    };
  });

  const appendHistRows = [];
  const dailyLogRows = [];
  const buyCandidates = [];
  const antiAlerts = [];
  let skippedShortHistory = 0;

  wlRows.forEach(w => {
    const code = normCode(w[0]);
    const name = String(w[1]).trim();
    const category = String(w[2]).trim();
    const market = String(w[3]).trim();
    const c02Status = String(w[4]).trim() || '穩健';
    const active = w[6] !== false && String(w[6]).toUpperCase() !== 'FALSE';
    if (!code || !active) return;

    const val = valuationAll[code] || { pe: '', yield: '', pb: '' };
    if (!histByCode[code]) histByCode[code] = {};

    // 將 Yahoo 近 5 日最新K線合併進 histByCode，確保今天與昨天 100% 連續且最新
    const yBars = yahooLatestMap[code] || [];
    yBars.forEach(b => {
      histByCode[code][b.date] = b;
      if (!existingDateKeys.has(code + '_' + b.date)) {
        existingDateKeys.add(code + '_' + b.date);
        appendHistRows.push([b.date, code, b.open, b.high, b.low, b.close, b.volume, val.pe, val.yield, val.pb]);
      }
    });

    const series = Object.values(histByCode[code]).sort((a, b) => a.date.localeCompare(b.date));
    histByCode[code] = series;
    if (series.length < 62) {
      skippedShortHistory++;
      return;
    }

    const latestBar = series[series.length - 1];
    const quote = latestBar;

    // 計算技術指標與規則判定
    const instInfo = instMap[code] || { consecutiveDays: 0 };
    const isTop100 = top100Set.has(code);
    const analysis = analyzeStockRules(series, marketStatus, instInfo, c02Status, isTop100, cfg);

    dailyLogRows.push([
      todayStr,
      code,
      name,
      quote.close,
      analysis.changePct,
      quote.volume,
      analysis.hits.join(','),
      analysis.action,
      analysis.reason,
      analysis.recShares,
      analysis.limitPrice,
      analysis.stopLoss,
      val.pe,
      val.yield,
      instInfo.consecutiveDays,
      c02Status,
      analysis.techJson
    ]);

    if (analysis.action === '試單買進') {
      buyCandidates.push({ code, name, close: quote.close, ...analysis });
    } else if (analysis.action === '反指標警戒') {
      antiAlerts.push({ code, name, close: quote.close, ...analysis });
    }
  });

  // 寫入新增的歷史K線與今日篩選明細
  if (appendHistRows.length > 0) {
    histSheet.getRange(histSheet.getLastRow() + 1, 1, appendHistRows.length, 10).setValues(appendHistRows);
  }
  if (dailyLogRows.length > 0) {
    const logSheet = ss.getSheetByName(SHEET_NAMES.DAILY_LOG);
    if (String(logSheet.getRange(1, 17).getValue()) !== 'TechJson') {
      logSheet.getRange(1, 17).setValue('TechJson');
    }
    // 清除同一天舊的掃描紀錄（若有手動重跑）
    removeRowsByDate(logSheet, todayStr);
    logSheet.getRange(logSheet.getLastRow() + 1, 1, dailyLogRows.length, 17).setValues(dailyLogRows);
  }

  // 4. 更新 Stats_Summary 累積統計
  updateStatsSummary(ss, wlRows, histByCode);

  // 5. 檢查現有持股與模擬倉（保姆提醒：硬停損 / 時間停損 / 加碼 / 移動停利）
  const holdingAlerts = evaluateHoldings(ss, twseAll, tpexAll, histByCode, cfg);

  // 5.5 執行全自動模擬操盤機器人 (AUTO_BOT，獨立 10 萬元資金池，跑三個月成效評估)
  const autoBotResult = runAutoBotTrading(ss, todayStr, marketStatus, dailyLogRows, histByCode, cfg);

  // 6. 記錄最後更新時間
  setConfigValue(ss, 'LAST_SCAN_TIME', Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'));

  // 7. 發送 LINE 行動建議推播
  sendDailyLineNotification(cfg, todayStr, marketStatus, buyCandidates, holdingAlerts, antiAlerts, autoBotResult);

  // 8. 預約明日 13:38 精準觸發（週一到週五）
  scheduleNextDailyTrigger();

  return { date: todayStr, count: dailyLogRows.length, skippedShortHistory, appendedHistory: appendHistRows.length };
}

// ==================== 5. 技術指標與手冊規則引擎 ====================
function analyzeStockRules(series, marketStatus, instInfo, c02Status, isTop100, cfg) {
  const n = series.length;
  const today = series[n - 1];
  const prev = series[n - 2];
  const changePct = prev.close > 0 ? Number((((today.close - prev.close) / prev.close) * 100).toFixed(2)) : 0;

  const sma5 = calcSMA(series, 5, n - 1);
  const sma5Prev = calcSMA(series, 5, n - 2);
  const sma10 = calcSMA(series, 10, n - 1);
  const sma20 = calcSMA(series, 20, n - 1);
  const sma20Prev = calcSMA(series, 20, n - 2);
  const sma60 = calcSMA(series, 60, n - 1);
  const sma60Prev = calcSMA(series, 60, n - 2);
  const sma100 = n >= 100 ? calcSMA(series, 100, n - 1) : 0;
  const sma300 = n >= 300 ? calcSMA(series, 300, n - 1) : 0;
  const isPPP = sma100 > 0 && sma300 > 0
    ? (sma5 > sma20 && sma20 > sma60 && sma60 > sma100 && sma100 > sma300)
    : (sma5 > sma20 && sma20 > sma60);

  // 9日連漲/連跌數算 (九日法則)
  let upStreak = 0;
  for (let i = n - 1; i > 0; i--) {
    if (series[i].close > series[i - 1].close) upStreak++;
    else break;
  }

  // 5日報酬率 vs 大盤 (C01)
  const ret5 = series[n - 6] && series[n - 6].close > 0 ? ((today.close - series[n - 6].close) / series[n - 6].close) * 100 : changePct;
  const c01 = (changePct >= marketStatus.changePct) && (ret5 >= marketStatus.ret5);

  // C08 成交量 > 1000 張
  const c08 = today.volume > 1000;

  // C09 站上20/60日線且兩線上彎
  const c09 = today.close > sma20 && today.close > sma60 && sma20 >= sma20Prev && sma60 >= sma60Prev;

  // C03 以盤代跌結構 (近10日振幅收斂且低點守住20日線附近)
  const atr10 = calcAvgRangePct(series, 10);
  const c03 = atr10 < 3.2 && today.low >= sma20 * 0.985;

  // C04 均線糾結發散 (5日前4條均線極度靠攏 < 2.8%，今日收紅放量站上所有均線)
  const prevMaxMa = Math.max(calcSMA(series, 5, n - 4), calcSMA(series, 10, n - 4), calcSMA(series, 20, n - 4), calcSMA(series, 60, n - 4));
  const prevMinMa = Math.min(calcSMA(series, 5, n - 4), calcSMA(series, 10, n - 4), calcSMA(series, 20, n - 4), calcSMA(series, 60, n - 4));
  const squeezeSpread = prevMinMa > 0 ? ((prevMaxMa - prevMinMa) / prevMinMa) * 100 : 99;
  const avgVol5 = calcAvgVol(series, 5, n - 2);
  const c04 = squeezeSpread <= 3.0 && today.close > today.open && today.close > Math.max(sma5, sma10, sma20, sma60) && today.volume > avgVol5 * 1.2;

  // C05 KD 中低檔黃金交叉 (K, D <= 60)
  const kd = calcKD(series);
  const c05 = kd.prevK <= kd.prevD && kd.k > kd.d && kd.k <= 60 && kd.d <= 60;

  // C06 MACD 趨勢向上
  const macd = calcMACD(series);
  const c06 = (macd.prevHist <= 0 && macd.hist > 0) || (macd.hist > 0 && macd.hist > macd.prevHist);

  // C02 基本面與籌碼
  const c02 = c02Status === '穩健' && instInfo.consecutiveDays >= 5;

  // C07 市場熱門前百名
  const c07 = isTop100;

  // 裸K與相場師朗訊號
  const body = Math.abs(today.close - today.open);
  const upperShadow = today.high - Math.max(today.close, today.open);
  const lowerShadow = Math.min(today.close, today.open) - today.low;
  const bodyMid = (today.open + today.close) / 2;

  // 下半身：陽線實體一半以上站上 5 日線且 5 日線上彎
  const isHalfBodyUp = today.close > today.open && bodyMid >= sma5 && today.close > sma5 && sma5 >= sma5Prev;
  // 反下半身：陰線實體一半以上跌破 5 日線且 5 日線下彎
  const isHalfBodyDown = today.close < today.open && bodyMid <= sma5 && today.close < sma5 && sma5 <= sma5Prev;
  // 鳥嘴：前2日5日線靠攏或回測20日線未破，今日再度上揚
  const isBirdBeak = sma5Prev <= sma20Prev * 1.015 && sma5 > sma5Prev && today.low >= sma20 * 0.985 && today.close > sma5;
  // 多頭吞噬
  const isBullEngulfing = prev.close < prev.open && today.close > today.open && today.open <= prev.close && today.close >= prev.open;
  // 晨星
  const prev2 = series[n - 3];
  const isMorningStar = prev2 && prev2.close < prev2.open && Math.abs(prev.close - prev.open) < Math.abs(prev2.close - prev2.open) * 0.4 && today.close > today.open && today.close > (prev2.open + prev2.close) / 2;
  // 長下影線
  const isLongLowerShadow = lowerShadow > body * 1.8 && lowerShadow > (today.high - today.low) * 0.5;
  // 爆量長上影線 / 高檔過熱警戒
  const isHighUpperShadow = upperShadow > body * 1.8 && today.volume > avgVol5 * 1.5;
  // 逆 PPP 空頭排列
  const isReversePPP = sma60 > sma20 && sma20 > sma5 && today.close < sma20;

  const hits = [];
  if (c08) hits.push('C08');
  if (c09) hits.push('C09');
  if (c01) hits.push('C01');
  if (c03) hits.push('C03');
  if (c04) hits.push('C04');
  if (c05) hits.push('C05');
  if (c06) hits.push('C06');
  if (c02) hits.push('C02');
  if (c07) hits.push('C07');
  if (isHalfBodyUp) hits.push('下半身');
  if (isBirdBeak) hits.push('鳥嘴');
  if (isBullEngulfing) hits.push('多頭吞噬');
  if (isMorningStar) hits.push('晨星');
  if (isLongLowerShadow) hits.push('長下影線');
  if (upStreak >= 2) hits.push('EXCL_9DAY');
  if (isHighUpperShadow) hits.push('EXCL_UPPER_SHADOW');
  if (isReversePPP) hits.push('逆PPP');
  if (isHalfBodyDown) hits.push('反下半身');

  // 計算停損價與可買零股股數
  const recentLow = Math.min(...series.slice(Math.max(0, n - 10), n).map(x => x.low));
  const rawStop = Math.max(recentLow, sma20 * 0.99);
  // 限制停損空間在 6%~8% 之間 (若太近就用 6%，若太遠就用 8%)
  const minStop = today.close * 0.92;
  const maxStop = today.close * 0.94;
  const stopLoss = roundToTick(Math.min(maxStop, Math.max(minStop, rawStop)));
  const limitPrice = roundToTick(today.close + getTickSize(today.close)); // 略高1個跳動點提高盤後零股成交率

  const maxRiskAmt = (cfg.TOTAL_CAPITAL || 100000) * (cfg.RISK_PCT || 0.01);
  const riskPerShare = Math.max(1, limitPrice - stopLoss);
  const maxByRisk = Math.floor(maxRiskAmt / riskPerShare);
  const maxByCapStage1 = Math.floor(((cfg.TOTAL_CAPITAL || 100000) * (cfg.MAX_SINGLE_STOCK_PCT || 0.24) / 3) / limitPrice);
  const recShares = Math.max(0, Math.min(maxByRisk, maxByCapStage1));

  // 預設動作與白話原因
  let action = '空手觀察';
  const reasons = [];

  const hasResonance = c04 || isHalfBodyUp || isBirdBeak || isBullEngulfing || isMorningStar;
  const hasExclusion = upStreak >= 2 || isHighUpperShadow;

  if (isReversePPP || (isHalfBodyDown && today.close < sma20)) {
    action = '反指標警戒';
    if (isReversePPP) reasons.push('均線呈空頭排列(逆PPP)且破月線，避開接刀');
    if (isHalfBodyDown) reasons.push('出現反下半身跌破5日線，短線轉弱');
  } else if (hasExclusion) {
    action = '反指標警戒';
    if (upStreak >= 2) reasons.push(`連漲第${upStreak}根K線(>=2根過熱)，短線不追高`);
    if (isHighUpperShadow) reasons.push('爆量留長上影線，高檔遇賣壓');
  } else if (c08 && c09 && c01 && hasResonance) {
    action = '試單買進';
    reasons.push('符合必備底線(量>1000張、站上20/60MA上彎、強於大盤)');
    if (c04) reasons.push('觸發C04均線糾結發散');
    if (isHalfBodyUp) reasons.push('出現相場師朗「下半身」轉強');
    if (isBirdBeak) reasons.push('出現「鳥嘴」回測20日線再上揚');
    if (isBullEngulfing || isMorningStar) reasons.push('出現酒田底部反轉訊號');
    if (c05) reasons.push('KD中低檔金叉');
    if (c06) reasons.push('MACD動能向上');
  } else if (c08 && c09 && c01) {
    action = '觀察追蹤';
    reasons.push('符合必備底線(C01/C08/C09)，等待下半身或均線發散買點');
  } else {
    reasons.push('未同時符合 C01/C08/C09 底線濾網');
  }

  const techJson = JSON.stringify({
    sma5: Number(sma5.toFixed(2)),
    sma20: Number(sma20.toFixed(2)),
    sma60: Number(sma60.toFixed(2)),
    sma100: sma100 ? Number(sma100.toFixed(2)) : null,
    sma300: sma300 ? Number(sma300.toFixed(2)) : null,
    ppp: isPPP ? 'PPP多頭排列' : (isReversePPP ? '逆PPP空頭' : '盤整糾結'),
    k: Number(kd.k.toFixed(1)),
    d: Number(kd.d.toFixed(1)),
    macdDir: macd.hist > macd.prevHist ? '紅柱擴大/翻正' : '動能收斂',
    upStreak
  });

  return {
    changePct,
    hits,
    action,
    reason: reasons.join('；'),
    recShares,
    limitPrice,
    stopLoss,
    upStreak,
    techJson,
    sma5: Number(sma5.toFixed(2)),
    sma20: Number(sma20.toFixed(2)),
    sma60: Number(sma60.toFixed(2)),
    k: Number(kd.k.toFixed(1)),
    d: Number(kd.d.toFixed(1))
  };
}

// ==================== 6. 持股保姆引擎 (硬停損 / 時間停損 / 加碼 / 移動停利) ====================
function evaluateHoldings(ss, twseAll, tpexAll, histByCode, cfg) {
  const hSheet = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
  const rows = hSheet.getDataRange().getValues();
  if (rows.length <= 1) return [];

  const alerts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[11]).toUpperCase() !== 'OPEN' || String(r[1]) === 'AUTO_BOT') continue;

    const id = r[0];
    const mode = r[1];
    const code = String(r[2]).trim();
    const name = String(r[3]).trim();
    const stage = Number(r[4]);
    const shares = Number(r[5]);
    const avgCost = Number(r[6]);
    const stopLoss = Number(r[7]);
    const highest = Math.max(Number(r[8]) || avgCost, avgCost);
    const daysHeld = Number(r[10] || 0) + 1;

    const quote = twseAll[code] || tpexAll[code];
    const series = histByCode[code] || [];
    if (!quote || series.length < 25) continue;

    const close = quote.close;
    const newHighest = Math.max(highest, close);
    const pnlPct = ((close - avgCost) / avgCost) * 100;
    const n = series.length;
    const sma5 = calcSMA(series, 5, n - 1);
    const sma5Prev = calcSMA(series, 5, n - 2);
    const sma20 = calcSMA(series, 20, n - 1);
    const macd = calcMACD(series);

    // 更新持有天數與最高價
    hSheet.getRange(i + 1, 9).setValue(newHighest);
    hSheet.getRange(i + 1, 11).setValue(daysHeld);

    let msg = '';
    let level = 'HOLD';

    // 1. 硬停損檢查
    if (close <= stopLoss || close < sma20 * 0.995) {
      level = 'STOP_LOSS';
      msg = `收盤 ${close} 跌破停損/20日線(${stopLoss})，依鐵律於14:30前無條件限價全數出清`;
    }
    // 2. 三段式移動停利檢查
    else if (pnlPct >= 15) {
      level = 'TAKE_PROFIT';
      msg = `波段獲利達 ${pnlPct.toFixed(1)}% (>=15%)，依三段式移動停利先賣出 1/3 落袋`;
    }
    // 3. 時間停損 (5~7天橫盤不動)
    else if (daysHeld >= 5 && Math.abs(pnlPct) < 2.5 && Math.abs(sma5 - sma5Prev) / sma5 < 0.002 && macd.hist < macd.prevHist) {
      level = 'TIME_STOP';
      msg = `已持有 ${daysHeld} 日橫盤不動且動能縮短，建議減碼一半或換股`;
    }
    // 4. 第二批 / 第三批加碼檢查
    else if (stage === 1 && pnlPct >= 4.0 && close > sma5 && sma5 > sma5Prev) {
      level = 'ADD_STAGE';
      msg = `已脫離成本區(+${pnlPct.toFixed(1)}%)且均線上彎，可準備第二批加碼並上移停損`;
    } else if (stage === 2 && pnlPct >= 8.0 && close > sma5) {
      level = 'ADD_STAGE';
      msg = `順勢多頭排列(+${pnlPct.toFixed(1)}%)，可執行第三批加碼並將停損上移至總成本保本`;
    }

    if (msg) {
      alerts.push({ id, mode, code, name, close, pnlPct: Number(pnlPct.toFixed(2)), level, msg });
    }
  }
  return alerts;
}

// ==================== 7. LINE Messaging API 推播與週報 ====================
function sendDailyLineNotification(cfg, dateStr, marketStatus, buyCandidates, holdingAlerts, antiAlerts, autoBotResult) {
  if (!cfg.LINE_CHANNEL_ACCESS_TOKEN || !cfg.LINE_USER_ID) {
    Logger.log('尚未設定 LINE Token 或 User ID，跳過推播。');
    return;
  }

  const lines = [];
  lines.push(`📊 【盤後零股實戰看板】${dateStr}`);
  lines.push(`大盤定調：${marketStatus.tone} (${marketStatus.close} / ${marketStatus.changePct >= 0 ? '+' : ''}${marketStatus.changePct}%)`);
  lines.push(`建議現金水位：${marketStatus.cashAdvice}`);
  lines.push('━━━━━━━━━━━━━━');

  if (holdingAlerts.length > 0) {
    lines.push('🛡️ 【持股保姆提醒】');
    holdingAlerts.slice(0, 4).forEach(h => {
      lines.push(`• ${h.code} ${h.name} (${h.mode === 'PAPER' ? '模擬' : '實戰'}): ${h.msg}`);
    });
    lines.push('');
  }

  if (buyCandidates.length > 0) {
    lines.push(`🎯 【今日試單候選 (${buyCandidates.length}檔)】`);
    buyCandidates.slice(0, 5).forEach(b => {
      lines.push(`• ${b.code} ${b.name} @${b.close}`);
      lines.push(`  建議：試單 ${b.recShares} 股｜限價 ${b.limitPrice}｜停損 ${b.stopLoss}`);
      lines.push(`  原因：${b.reason}`);
    });
  } else {
    lines.push('🎯 【今日試單候選】無符合共振標的，依紀律「空手觀察」。');
  }

  if (antiAlerts.length > 0) {
    lines.push('');
    lines.push(`⚠️ 【高檔/空頭反指標警戒 (${antiAlerts.length}檔)】`);
    lines.push(antiAlerts.slice(0, 5).map(a => `${a.code}${a.name}`).join('、'));
  }

  if (autoBotResult) {
    const sign = autoBotResult.returnPct >= 0 ? '+' : '';
    lines.push('');
    lines.push(`🤖 【自動模擬倉】淨值 $${autoBotResult.equity.toLocaleString()} (${sign}${autoBotResult.returnPct.toFixed(2)}%)｜${autoBotResult.summaryText}`);
  }

  if (cfg.WEB_APP_URL) {
    lines.push('');
    lines.push(`👉 開啟看板檢核與記帳：${cfg.WEB_APP_URL}`);
  }

  pushLineText(cfg.LINE_CHANNEL_ACCESS_TOKEN, cfg.LINE_USER_ID, lines.join('\n'));
}

function sendWeeklyLineReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfigMap(ss);
  if (!cfg.LINE_CHANNEL_ACCESS_TOKEN || !cfg.LINE_USER_ID) return;

  const statsRows = ss.getSheetByName(SHEET_NAMES.STATS).getDataRange().getValues().slice(1);
  const sortedStrong = [...statsRows].sort((a, b) => Number(b[5]) - Number(a[5])).slice(0, 5);
  const sortedAlert = [...statsRows].sort((a, b) => Number(b[6]) - Number(a[6])).slice(0, 5);

  const lines = [
    '📅 【盤後零股實戰看板 - 本週覆盤週報】',
    '━━━━━━━━━━━━━━',
    '🔥 本週買點觸發最多 Top 5：',
    sortedStrong.map(r => `• ${r[0]} ${r[1]} (買點${r[5]}次 / 底線${r[4]}天)`).join('\n'),
    '',
    '⚠️ 反指標警戒最頻繁 Top 5：',
    sortedAlert.map(r => `• ${r[0]} ${r[1]} (警戒${r[6]}次)`).join('\n'),
    '',
    '💡 週末提醒：記得檢視觀察清單，剔除長期破底與量縮 <1000張標的！'
  ];
  if (cfg.WEB_APP_URL) lines.push(`\n👉 查看完整統計：${cfg.WEB_APP_URL}`);

  pushLineText(cfg.LINE_CHANNEL_ACCESS_TOKEN, cfg.LINE_USER_ID, lines.join('\n'));
}

function pushLineText(token, userId, text) {
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      payload: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: text.slice(0, 4900) }]
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('LINE push error: ' + e.message);
  }
}

// ==================== 8. 15:30 補抓三大法人買賣超 ====================
function fetchAfternoonInstitutional() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${todayStr}&selectType=ALLBUT0999&response=json`;
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
    if (json.stat !== 'OK' || !json.data) return;

    const instSheet = ss.getSheetByName(SHEET_NAMES.INSTITUTIONAL);
    const oldRows = instSheet.getDataRange().getValues().slice(1);
    const oldMap = {};
    oldRows.forEach(r => { oldMap[String(r[0]).trim()] = Number(r[3]) || 0; });

    const wlCodes = new Set(ss.getSheetByName(SHEET_NAMES.WATCHLIST).getDataRange().getValues().slice(1).map(r => String(r[0]).trim()));
    const newInstRows = [];
    const isoDate = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

    json.data.forEach(row => {
      const code = String(row[0]).trim();
      if (!wlCodes.has(code)) return;
      const netShares = parseInt(String(row[18] || '0').replace(/,/g, ''), 10) || 0;
      const prevDays = oldMap[code] || 0;
      const newDays = netShares > 0 ? (prevDays > 0 ? prevDays + 1 : 1) : (netShares < 0 ? (prevDays < 0 ? prevDays - 1 : -1) : 0);
      newInstRows.push([code, isoDate, Math.round(netShares / 1000), newDays, '']);
    });

    if (newInstRows.length > 0) {
      instSheet.getRange(2, 1, Math.max(1, instSheet.getLastRow() - 1), 5).clearContent();
      instSheet.getRange(2, 1, newInstRows.length, 5).setValues(newInstRows);
    }
  } catch (e) {
    Logger.log('Institutional fetch error: ' + e.message);
  }
}

// ==================== 9. 精準排程設定 (13:38 / 15:30 / 週五週報) ====================
function setupTriggers() {
  // 清除舊觸發
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 1. 每天中午 12:30 預約當天 13:38 的精準單次觸發
  ScriptApp.newTrigger('scheduleNextDailyTrigger').timeBased().everyDays(1).atHour(12).create();
  // 2. 每天 15:30~16:00 補抓三大法人
  ScriptApp.newTrigger('fetchAfternoonInstitutional').timeBased().everyDays(1).atHour(15).create();
  // 3. 每週五 15:00~16:00 發送週報
  ScriptApp.newTrigger('sendWeeklyLineReport').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(15).create();

  scheduleNextDailyTrigger();
  Logger.log('所有自動排程設定完成！');
}

function scheduleNextDailyTrigger() {
  // 移除舊的單次 runDailyAfterHoursScan 觸發
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDailyAfterHoursScan') ScriptApp.deleteTrigger(t);
  });

  const now = new Date();
  const target = new Date(now);
  target.setHours(13, 38, 0, 0);
  if (now.getTime() >= target.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const day = target.getDay();
  if (day !== 0 && day !== 6) {
    ScriptApp.newTrigger('runDailyAfterHoursScan').timeBased().at(target).create();
  }
}

// ==================== 10. Web App API (供 GitHub Pages 呼叫) ====================
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfigMap(ss);
  const pin = (e && e.parameter && e.parameter.pin) ? String(e.parameter.pin) : '';

  if (pin !== String(cfg.ACCESS_PIN)) {
    return jsonResponse({ ok: false, error: 'INVALID_PIN' });
  }

  // 單檔 K 線與均線圖表查詢
  if (e && e.parameter && e.parameter.action === 'getChart') {
    const code = String(e.parameter.code || '').trim();
    const bars = getStockChartBars(ss, code, 100);
    return jsonResponse({ ok: true, code, bars });
  }

  return jsonResponse({
    ok: true,
    config: {
      totalCapital: Number(cfg.TOTAL_CAPITAL),
      riskPct: Number(cfg.RISK_PCT),
      maxSinglePct: Number(cfg.MAX_SINGLE_STOCK_PCT),
      minCashPct: Number(cfg.MIN_CASH_RESERVE_PCT),
      maxHoldings: Number(cfg.MAX_HOLDINGS_COUNT),
      tradingMode: cfg.TRADING_MODE,
      lastScanTime: cfg.LAST_SCAN_TIME
    },
    market: getLatestMarketStatus(ss),
    filters: getSheetObjects(ss, SHEET_NAMES.FILTERS),
    dailyLogs: getLatestDailyLogs(ss),
    holdings: getSheetObjects(ss, SHEET_NAMES.HOLDINGS),
    journal: getSheetObjects(ss, SHEET_NAMES.JOURNAL).slice(-50).reverse(),
    stats: getSheetObjects(ss, SHEET_NAMES.STATS),
    watchlist: getSheetObjects(ss, SHEET_NAMES.WATCHLIST),
    autoBot: getAutoBotDashboardData(ss)
  });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cfg = getConfigMap(ss);

    if (String(body.pin || '') !== String(cfg.ACCESS_PIN)) {
      return jsonResponse({ ok: false, error: 'INVALID_PIN' });
    }

    const action = body.action;
    if (action === 'saveFilters') {
      const fSheet = ss.getSheetByName(SHEET_NAMES.FILTERS);
      const rows = fSheet.getDataRange().getValues();
      const map = body.filters || {};
      for (let i = 1; i < rows.length; i++) {
        const id = rows[i][0];
        if (map.hasOwnProperty(id)) {
          fSheet.getRange(i + 1, 4).setValue(Boolean(map[id]));
        }
      }
      return jsonResponse({ ok: true });
    }

    if (action === 'addTrade') {
      const t = body.trade;
      const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
      const id = 'T' + Date.now();
      const jSheet = ss.getSheetByName(SHEET_NAMES.JOURNAL);
      const hSheet = ss.getSheetByName(SHEET_NAMES.HOLDINGS);

      const amount = Math.round(Number(t.shares) * Number(t.price));
      let pnl = 0;

      if (t.side === 'BUY') {
        // 檢查是否已有同模式同代號 OPEN 持股 (加碼或新建)
        const hRows = hSheet.getDataRange().getValues();
        let foundIdx = -1;
        for (let i = 1; i < hRows.length; i++) {
          if (hRows[i][1] === t.mode && String(hRows[i][2]) === String(t.code) && hRows[i][11] === 'OPEN') {
            foundIdx = i + 1;
            break;
          }
        }
        if (foundIdx > 0) {
          const oldShares = Number(hSheet.getRange(foundIdx, 6).getValue());
          const oldCost = Number(hSheet.getRange(foundIdx, 7).getValue());
          const newShares = oldShares + Number(t.shares);
          const newAvg = Number((((oldShares * oldCost) + amount) / newShares).toFixed(2));
          const oldStage = Number(hSheet.getRange(foundIdx, 5).getValue());
          hSheet.getRange(foundIdx, 5).setValue(Math.min(3, oldStage + 1));
          hSheet.getRange(foundIdx, 6).setValue(newShares);
          hSheet.getRange(foundIdx, 7).setValue(newAvg);
          hSheet.getRange(foundIdx, 8).setValue(Number(t.stopLoss));
        } else {
          hSheet.appendRow([id, t.mode, t.code, t.name, 1, Number(t.shares), Number(t.price), Number(t.stopLoss), Number(t.price), nowStr, 0, 'OPEN']);
        }
      } else if (t.side === 'SELL') {
        const hRows = hSheet.getDataRange().getValues();
        for (let i = 1; i < hRows.length; i++) {
          if (hRows[i][1] === t.mode && String(hRows[i][2]) === String(t.code) && hRows[i][11] === 'OPEN') {
            const oldShares = Number(hRows[i][5]);
            const avgCost = Number(hRows[i][6]);
            const sellShares = Math.min(oldShares, Number(t.shares));
            pnl = Math.round((Number(t.price) - avgCost) * sellShares);
            if (sellShares >= oldShares) {
              hSheet.getRange(i + 1, 6).setValue(0);
              hSheet.getRange(i + 1, 12).setValue('CLOSED');
            } else {
              hSheet.getRange(i + 1, 6).setValue(oldShares - sellShares);
            }
            break;
          }
        }
      }

      jSheet.appendRow([id, nowStr, t.mode, t.code, t.name, t.side, t.stage || 1, Number(t.shares), Number(t.price), amount, pnl, t.reason || '', t.note || '']);
      return jsonResponse({ ok: true });
    }

    if (action === 'updateConfig') {
      if (body.totalCapital) setConfigValue(ss, 'TOTAL_CAPITAL', Number(body.totalCapital));
      if (body.riskPct) setConfigValue(ss, 'RISK_PCT', Number(body.riskPct));
      if (body.tradingMode) setConfigValue(ss, 'TRADING_MODE', body.tradingMode);
      return jsonResponse({ ok: true });
    }

    if (action === 'manualScan') {
      const summary = runDailyAfterHoursScan();
      return jsonResponse({ ok: true, summary });
    }

    if (action === 'resetAutoBot') {
      resetAutoBotExperiment(ss);
      return jsonResponse({ ok: true });
    }

    if (action === 'runBacktest') {
      const bt = runThreeMonthBacktest(ss, body.params || {});
      return jsonResponse({ ok: true, backtest: bt });
    }

    return jsonResponse({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ==================== 11. 資料抓取與技術運算輔助函式 ====================
function fetchYahooLatestQuotesBatch(wlRows) {
  const resultMap = {};
  const targets = [];
  wlRows.forEach(w => {
    const code = normCode(w[0]);
    const market = String(w[3]).trim();
    const active = w[6] !== false && String(w[6]).toUpperCase() !== 'FALSE';
    if (code && active) {
      targets.push({ code, symbol: code + (market === 'TPEX' ? '.TWO' : '.TW') });
    }
  });

  // 每批 25 檔使用 fetchAll 並發抓取近 5 日K線
  for (let i = 0; i < targets.length; i += 25) {
    const chunk = targets.slice(i, i + 25);
    const reqs = chunk.map(t => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.symbol)}?range=5d&interval=1d`,
      muteHttpExceptions: true
    }));
    try {
      const responses = UrlFetchApp.fetchAll(reqs);
      responses.forEach((res, idx) => {
        if (res.getResponseCode() !== 200) return;
        const json = JSON.parse(res.getContentText());
        const r = json.chart && json.chart.result && json.chart.result[0];
        if (!r || !r.timestamp) return;
        const ts = r.timestamp;
        const q = r.indicators.quote[0];
        const bars = [];
        for (let j = 0; j < ts.length; j++) {
          if (q.close[j] == null || q.open[j] == null) continue;
          const dStr = Utilities.formatDate(new Date(ts[j] * 1000), 'Asia/Taipei', 'yyyy-MM-dd');
          bars.push({
            date: dStr,
            open: Number(q.open[j].toFixed(2)),
            high: Number(q.high[j].toFixed(2)),
            low: Number(q.low[j].toFixed(2)),
            close: Number(q.close[j].toFixed(2)),
            volume: Math.round((q.volume[j] || 0) / 1000)
          });
        }
        resultMap[chunk[idx].code] = bars;
      });
    } catch (e) { Logger.log('fetchAll batch error: ' + e.message); }
    Utilities.sleep(100);
  }
  return resultMap;
}

function fetchTwseAllQuotes(todayStr) {
  const map = {};
  const ymd = (todayStr || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd')).replace(/-/g, '');
  // 1. 優先呼叫帶明確日期的 TWSE MI_INDEX，確保一定是今日最新收盤價量
  try {
    const miUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`;
    const res = UrlFetchApp.fetch(miUrl, { muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
    if (json.stat === 'OK' && Array.isArray(json.tables)) {
      const targetTable = json.tables.find(t => t.data && t.fields && t.fields.includes('證券代號') && t.fields.includes('收盤價'));
      if (targetTable) {
        targetTable.data.forEach(row => {
          const code = String(row[0]).trim();
          const close = parseFloat(String(row[8] || '').replace(/,/g, ''));
          if (!isNaN(close) && close > 0) {
            const open = parseFloat(String(row[5] || '').replace(/,/g, '')) || close;
            const high = parseFloat(String(row[6] || '').replace(/,/g, '')) || close;
            const low = parseFloat(String(row[7] || '').replace(/,/g, '')) || close;
            const shares = parseInt(String(row[2] || '0').replace(/,/g, ''), 10) || 0;
            map[code] = { open, high, low, close, volume: Math.round(shares / 1000) };
          }
        });
      }
    }
  } catch (e) { Logger.log('MI_INDEX error: ' + e.message); }

  if (Object.keys(map).length > 50) return map;

  // 2. 備援：TWSE STOCK_DAY_ALL (檢查 Date 欄位是否為今日)
  try {
    const res = UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { muteHttpExceptions: true });
    const arr = JSON.parse(res.getContentText());
    const rocYear = Number(ymd.slice(0, 4)) - 1911;
    const rocDate = String(rocYear) + ymd.slice(4);
    arr.forEach(item => {
      if (item.Date && String(item.Date) !== rocDate) return;
      const close = parseFloat(item.ClosingPrice);
      if (!isNaN(close) && close > 0) {
        map[item.Code] = {
          open: parseFloat(item.OpeningPrice) || close,
          high: parseFloat(item.HighestPrice) || close,
          low: parseFloat(item.LowestPrice) || close,
          close: close,
          volume: Math.round((parseInt(item.TradeVolume, 10) || 0) / 1000)
        };
      }
    });
  } catch (e) { Logger.log('TWSE ALL error: ' + e.message); }
  return map;
}

function fetchTpexAllQuotes() {
  const map = {};
  try {
    const res = UrlFetchApp.fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', { muteHttpExceptions: true });
    const arr = JSON.parse(res.getContentText());
    arr.forEach(item => {
      const close = parseFloat(item.Close);
      if (!isNaN(close) && close > 0) {
        map[item.SecuritiesCompanyCode] = {
          open: parseFloat(item.Open) || close,
          high: parseFloat(item.High) || close,
          low: parseFloat(item.Low) || close,
          close: close,
          volume: Math.round((parseInt(String(item.TradingShares || '0').replace(/,/g, ''), 10) || 0) / 1000)
        };
      }
    });
  } catch (e) { Logger.log('TPEX ALL error: ' + e.message); }
  return map;
}

function fetchTwseValuationAll() {
  const map = {};
  try {
    const res = UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', { muteHttpExceptions: true });
    const arr = JSON.parse(res.getContentText());
    arr.forEach(item => {
      map[item.Code] = {
        pe: item.PEratio || '-',
        yield: item.DividendYield || '-',
        pb: item.PBratio || '-'
      };
    });
  } catch (e) { Logger.log('BWIBBU error: ' + e.message); }
  return map;
}

function buildTop100VolumeSet(twseAll, tpexAll) {
  const list = [];
  Object.keys(twseAll).forEach(c => { if (/^\d{4}$/.test(c)) list.push({ code: c, vol: twseAll[c].volume }); });
  Object.keys(tpexAll).forEach(c => { if (/^\d{4}$/.test(c)) list.push({ code: c, vol: tpexAll[c].volume }); });
  list.sort((a, b) => b.vol - a.vol);
  return new Set(list.slice(0, 100).map(x => x.code));
}

function updateAndEvaluateMarketIndex(ss, todayStr, forceTodayIfTwseOk) {
  const bars = fetchYahooHistory('^TWII', '1mo');
  if (bars.length === 0) return { isTradingDay: false };
  const latest = bars[bars.length - 1];
  // 若抓到的最新日期不是今天且 TWSE 也沒有今日資料，代表非交易日或尚未收盤
  if (latest.date !== todayStr && !forceTodayIfTwseOk) return { isTradingDay: false };

  const mktSheet = ss.getSheetByName(SHEET_NAMES.MARKET_INDEX);
  const rows = mktSheet.getDataRange().getValues().slice(1);
  if (rows.length === 0 || String(rows[rows.length - 1][0]) !== todayStr) {
    const prevClose = rows.length > 0 ? Number(rows[rows.length - 1][1]) : latest.close;
    const chg = prevClose > 0 ? ((latest.close - prevClose) / prevClose) * 100 : 0;
    mktSheet.appendRow([todayStr, latest.close, Number(chg.toFixed(2)), '', '', '', '']);
  }

  const allRows = mktSheet.getDataRange().getValues().slice(1);
  const closes = allRows.map(r => Number(r[1]));
  const n = closes.length;
  const sma5 = avgArr(closes.slice(-5));
  const sma20 = avgArr(closes.slice(-20));
  const sma60 = avgArr(closes.slice(-60));
  const changePct = Number(allRows[n - 1][2]);
  const ret5 = n >= 6 ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100 : changePct;

  let tone = '震盪整理';
  let cashAdvice = '30% ~ 40%';
  if (latest.close > sma5 && latest.close > sma20 && sma20 > sma60) {
    tone = '偏多格局';
    cashAdvice = '30% 以上';
  } else if (latest.close < sma20 && changePct <= -1.5) {
    tone = '空頭警戒';
    cashAdvice = '50% 以上 (減倉防禦)';
  }

  const lastRowIdx = mktSheet.getLastRow();
  mktSheet.getRange(lastRowIdx, 4, 1, 4).setValues([[Number(sma5.toFixed(1)), Number(sma20.toFixed(1)), Number(sma60.toFixed(1)), tone]]);

  return { isTradingDay: true, close: latest.close, changePct, ret5, tone, cashAdvice };
}

function updateStatsSummary(ss, wlRows, histByCode) {
  const allLogRows = ss.getSheetByName(SHEET_NAMES.DAILY_LOG).getDataRange().getValues().slice(1);
  // 近 20 個交易日滾動視窗
  const uniqueDates = [...new Set(allLogRows.map(r => formatDateVal(r[0])))].sort();
  const rollingDates = new Set(uniqueDates.slice(-20));
  const logRows = allLogRows.filter(r => rollingDates.has(formatDateVal(r[0])));

  const statMap = {};
  logRows.forEach(r => {
    const c = String(r[1]).trim();
    if (!statMap[c]) statMap[c] = { total: 0, base: 0, buy: 0, alert: 0, lastClose: 0, lastAction: '' };
    statMap[c].total++;
    const hits = String(r[6]);
    if (hits.includes('C01') && hits.includes('C08') && hits.includes('C09')) statMap[c].base++;
    if (r[7] === '試單買進') statMap[c].buy++;
    if (r[7] === '反指標警戒') statMap[c].alert++;
    statMap[c].lastClose = r[3];
    statMap[c].lastAction = r[7];
  });

  const out = [];
  wlRows.forEach(w => {
    const code = normCode(w[0]);
    const name = String(w[1]).trim();
    const cat = String(w[2]).trim();
    const s = statMap[code] || { total: 0, base: 0, buy: 0, alert: 0, lastClose: 0, lastAction: '尚無紀錄' };
    const series = histByCode[code] || [];
    const avgVol20 = series.length > 0 ? Math.round(avgArr(series.slice(-20).map(x => x.volume))) : 0;
    const sma60 = series.length >= 60 ? avgArr(series.slice(-60).map(x => x.close)) : 0;
    let review = '觀察中';
    if (avgVol20 > 0 && avgVol20 < 1000) review = '建議汰除(量縮<1000張)';
    else if (sma60 > 0 && s.lastClose > 0 && s.lastClose < sma60 * 0.92 && s.base === 0) review = '建議汰除(長期破底)';
    else if (s.buy > 0) review = '核心強勢';

    out.push([code, name, cat, s.total, s.base, s.buy, s.alert, avgVol20, s.lastClose, s.lastAction, review]);
  });

  const statSheet = ss.getSheetByName(SHEET_NAMES.STATS);
  if (statSheet.getLastRow() > 1) statSheet.getRange(2, 1, statSheet.getLastRow() - 1, 11).clearContent();
  if (out.length > 0) statSheet.getRange(2, 1, out.length, 11).setValues(out);
}

// 數學與技術指標計算
function calcSMA(series, period, idx) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) { sum += series[i].close; cnt++; }
  return cnt > 0 ? sum / cnt : 0;
}
function calcAvgVol(series, period, idx) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) { sum += series[i].volume; cnt++; }
  return cnt > 0 ? sum / cnt : 0;
}
function calcAvgRangePct(series, period) {
  const slice = series.slice(-period);
  const sum = slice.reduce((acc, b) => acc + ((b.high - b.low) / Math.max(1, b.close)) * 100, 0);
  return sum / Math.max(1, slice.length);
}
function calcKD(series) {
  let k = 50, d = 50, prevK = 50, prevD = 50;
  const start = Math.max(8, series.length - 30);
  for (let i = start; i < series.length; i++) {
    prevK = k; prevD = d;
    const win = series.slice(i - 8, i + 1);
    const high9 = Math.max(...win.map(x => x.high));
    const low9 = Math.min(...win.map(x => x.low));
    const rsv = high9 === low9 ? 50 : ((series[i].close - low9) / (high9 - low9)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }
  return { k, d, prevK, prevD };
}
function calcMACD(series) {
  let ema12 = series[0].close, ema26 = series[0].close, dem = 0, hist = 0, prevHist = 0;
  for (let i = 1; i < series.length; i++) {
    ema12 = series[i].close * (2 / 13) + ema12 * (11 / 13);
    ema26 = series[i].close * (2 / 27) + ema26 * (25 / 27);
    const dif = ema12 - ema26;
    dem = dif * (2 / 10) + dem * (8 / 10);
    prevHist = hist;
    hist = dif - dem;
  }
  return { hist, prevHist };
}
function getTickSize(p) {
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}
function roundToTick(p) {
  const t = getTickSize(p);
  return Number((Math.round(p / t) * t).toFixed(2));
}
function avgArr(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// 讀取與寫入輔助
function getConfigMap(ss) {
  const rows = ss.getSheetByName(SHEET_NAMES.CONFIG).getDataRange().getValues().slice(1);
  const map = {};
  rows.forEach(r => { map[String(r[0]).trim()] = r[1]; });
  return map;
}
function setConfigValue(ss, key, val) {
  const sheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) { sheet.getRange(i + 1, 2).setValue(val); return; }
  }
  sheet.appendRow([key, val, '']);
}
function getInstitutionalMap(ss) {
  const rows = ss.getSheetByName(SHEET_NAMES.INSTITUTIONAL).getDataRange().getValues().slice(1);
  const map = {};
  rows.forEach(r => { map[String(r[0]).trim()] = { consecutiveDays: Number(r[3]) || 0 }; });
  return map;
}
function normCode(val) {
  const s = String(val || '').trim();
  if (/^\d{1,3}$/.test(s)) return s.padStart(4, '0');
  return s;
}
function formatDateVal(val) {
  if (val instanceof Date) return Utilities.formatDate(val, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(val || '').slice(0, 10);
}
function getStockChartBars(ss, code, limit) {
  const rows = ss.getSheetByName(SHEET_NAMES.HISTORY).getDataRange().getValues().slice(1);
  const byTime = {};
  rows.forEach(r => {
    if (normCode(r[1]) === normCode(code)) {
      const t = formatDateVal(r[0]);
      if (!t || isNaN(Number(r[5]))) return;
      byTime[t] = {
        time: t,
        open: Number(r[2]),
        high: Number(r[3]),
        low: Number(r[4]),
        close: Number(r[5]),
        volume: Number(r[6])
      };
    }
  });
  const list = Object.values(byTime).sort((a, b) => a.time.localeCompare(b.time));
  // 計算 5/20/60 日線後截取最後 limit 筆
  const withMa = list.map((b, idx) => ({
    ...b,
    sma5: idx >= 4 ? Number(calcSMA(list, 5, idx).toFixed(2)) : null,
    sma20: idx >= 19 ? Number(calcSMA(list, 20, idx).toFixed(2)) : null,
    sma60: idx >= 59 ? Number(calcSMA(list, 60, idx).toFixed(2)) : null
  }));
  return withMa.slice(-(limit || 100));
}
function getSheetObjects(ss, name) {
  const rows = ss.getSheetByName(name).getDataRange().getValues();
  if (rows.length <= 1) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] instanceof Date) ? formatDateVal(r[i]) : r[i];
    });
    return obj;
  });
}
function getLatestMarketStatus(ss) {
  const rows = ss.getSheetByName(SHEET_NAMES.MARKET_INDEX).getDataRange().getValues().slice(1);
  if (rows.length === 0) return { date: '-', close: 0, changePct: 0, tone: '尚無資料', cashAdvice: '30%~50%' };
  const last = rows[rows.length - 1];
  const tone = String(last[6] || '震盪整理');
  const cashAdvice = tone === '空頭警戒' ? '50% 以上' : (tone === '偏多格局' ? '30% 以上' : '35%~45%');
  return { date: formatDateVal(last[0]), close: last[1], changePct: last[2], sma5: last[3], sma20: last[4], sma60: last[5], tone, cashAdvice };
}
function getLatestDailyLogs(ss) {
  const rows = ss.getSheetByName(SHEET_NAMES.DAILY_LOG).getDataRange().getValues();
  if (rows.length <= 1) return [];
  const latestDate = formatDateVal(rows[rows.length - 1][0]);
  const headers = rows[0];
  return rows.slice(1).filter(r => formatDateVal(r[0]) === latestDate).map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] instanceof Date) ? formatDateVal(r[i]) : r[i];
    });
    return obj;
  });
}
function removeRowsByDate(sheet, dateStr) {
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (formatDateVal(rows[i][0]) === dateStr) sheet.deleteRow(i + 1);
  }
}

// ==================== 12. 預設 100 檔台股觀察清單 ====================
function getDefault100Watchlist() {
  return [
    // 原型 ETF (10)
    ['0050', '元大台灣50', '原型ETF', 'TWSE', '穩健', '台股大型權值指標', true],
    ['006208', '富邦台50', '原型ETF', 'TWSE', '穩健', '低內扣台灣50 ETF', true],
    ['0056', '元大高股息', '原型ETF', 'TWSE', '穩健', '高股息代表ETF', true],
    ['00878', '國泰永續高股息', '原型ETF', 'TWSE', '穩健', 'ESG高股息人氣王', true],
    ['00919', '群益台灣精選高息', '原型ETF', 'TWSE', '穩健', '高息動能ETF', true],
    ['00713', '元大台灣高息低波', '原型ETF', 'TWSE', '穩健', '低波動防禦ETF', true],
    ['00929', '復華台灣科技優息', '原型ETF', 'TWSE', '穩健', '月配科技高息', true],
    ['0052', '富邦科技', '原型ETF', 'TWSE', '穩健', '高含積量科技ETF', true],
    ['00881', '國泰台灣5G+', '原型ETF', 'TWSE', '穩健', '台灣科技龍頭', true],
    ['00631L', '元大台灣50正2', '槓桿觀察', 'TWSE', '觀察', '高波動大盤溫度計(不建議長抱)', true],
    // 半導體與IC設計 (20)
    ['2330', '台積電', '半導體', 'TWSE', '穩健', '全球晶圓代工龍頭', true],
    ['2454', '聯發科', '半導體', 'TWSE', '穩健', '手機與AI晶片龍頭', true],
    ['2303', '聯電', '半導體', 'TWSE', '穩健', '成熟製程指標', true],
    ['3711', '日月光投控', '半導體', 'TWSE', '穩健', '全球封測龍頭', true],
    ['3034', '聯詠', '半導體', 'TWSE', '穩健', '驅動IC龍頭', true],
    ['2379', '瑞昱', '半導體', 'TWSE', '穩健', '網通IC龍頭', true],
    ['3008', '大立光', '光學鏡頭', 'TWSE', '穩健', '高階光學鏡頭龍頭', true],
    ['2408', '南亞科', '記憶體', 'TWSE', '觀察', '景氣循環記憶體(反指標對照)', true],
    ['3443', '創意', 'IC設計', 'TWSE', '穩健', 'ASIC高價熱門股', true],
    ['3661', '世芯-KY', 'IC設計', 'TWSE', '穩健', 'AI ASIC高波動指標', true],
    ['5274', '信驊', 'IC設計', 'TPEX', '穩健', '伺服器BMC股王', true],
    ['6669', '緯穎', 'AI伺服器', 'TWSE', '穩健', '雲端伺服器大廠', true],
    ['3037', '欣興', 'PCB載板', 'TWSE', '觀察', 'ABF載板龍頭', true],
    ['2344', '華邦電', '記憶體', 'TWSE', '觀察', '利基型記憶體', true],
    ['2337', '旺宏', '記憶體', 'TWSE', '觀察', 'NOR Flash觀察', true],
    ['3189', '景碩', 'PCB載板', 'TWSE', '觀察', 'ABF載板波動股', true],
    ['8046', '南電', 'PCB載板', 'TWSE', '觀察', '載板景氣指標', true],
    ['3529', '力旺', 'IP矽智財', 'TPEX', '穩健', '嵌入式記憶體IP龍頭', true],
    ['6415', '矽力*-KY', '電源IC', 'TWSE', '觀察', '高波動電源管理IC', true],
    ['2449', '京元電子', '半導體封測', 'TWSE', '穩健', 'AI測試受惠股', true],
    // AI伺服器 / 電子代工 / 電腦週邊 (20)
    ['2317', '鴻海', '電子代工', 'TWSE', '穩健', '全球EMS與AI伺服器龍頭', true],
    ['2382', '廣達', 'AI伺服器', 'TWSE', '穩健', 'AI伺服器代工龍頭', true],
    ['3231', '緯創', 'AI伺服器', 'TWSE', '穩健', '高人氣AI伺服器概念', true],
    ['2356', '英業達', 'AI伺服器', 'TWSE', '穩健', '伺服器代工', true],
    ['2376', '技嘉', 'AI伺服器', 'TWSE', '穩健', '主機板與AI伺服器', true],
    ['2377', '微星', '電腦週邊', 'TWSE', '穩健', '電競筆電顯卡', true],
    ['2308', '台達電', '電源散熱', 'TWSE', '穩健', '電源與能源管理龍頭', true],
    ['2301', '光寶科', '電源管理', 'TWSE', '穩健', 'AI電源供應器', true],
    ['2324', '仁寶', '電子代工', 'TWSE', '穩健', '筆電與伺服器代工', true],
    ['2357', '華碩', '電腦品牌', 'TWSE', '穩健', '主機板與AIPC品牌', true],
    ['2395', '研華', '工業電腦', 'TWSE', '穩健', '全球工業電腦龍頭', true],
    ['3017', '奇鋐', '散熱模組', 'TWSE', '穩健', 'AI水冷散熱龍頭', true],
    ['3324', '雙鴻', '散熱模組', 'TPEX', '穩健', '水冷散熱高波動股', true],
    ['2421', '建準', '散熱風扇', 'TWSE', '穩健', '伺服器散熱風扇', true],
    ['6239', '力成', '封測', 'TWSE', '穩健', '記憶體封測大廠', true],
    ['4938', '和碩', '電子代工', 'TWSE', '穩健', '蘋果與電動車代工', true],
    ['2353', '宏碁', '電腦品牌', 'TWSE', '穩健', 'PC品牌指標', true],
    ['2385', '群光', '電腦週邊', 'TWSE', '穩健', '高殖利率電子股', true],
    ['3533', '嘉澤', '連接器', 'TWSE', '穩健', '伺服器插槽龍頭', true],
    ['2059', '川湖', '伺服器導軌', 'TWSE', '穩健', 'AI伺服器導軌龍頭', true],
    // 網通 / 電信 / 面板 / 零組件 (15)
    ['2345', '智邦', '網通設備', 'TWSE', '穩健', '高階白牌交換器龍頭', true],
    ['2412', '中華電', '電信防禦', 'TWSE', '穩健', '抗跌防禦型龍頭', true],
    ['3045', '台灣大', '電信防禦', 'TWSE', '穩健', '防禦型電信股', true],
    ['4904', '遠傳', '電信防禦', 'TWSE', '穩健', '防禦型電信股', true],
    ['3481', '群創', '面板', 'TWSE', '觀察', '景氣循環面板(反指標對照)', true],
    ['2409', '友達', '面板', 'TWSE', '觀察', '景氣循環面板(反指標對照)', true],
    ['2327', '國巨', '被動元件', 'TWSE', '穩健', '被動元件龍頭', true],
    ['2492', '華新科', '被動元件', 'TWSE', '觀察', '被動元件波動指標', true],
    ['3036', '文曄', 'IC通路', 'TWSE', '穩健', '全球IC通路龍頭', true],
    ['3702', '大聯大', 'IC通路', 'TWSE', '穩健', '高殖利率IC通路', true],
    ['2313', '華通', 'PCB', 'TWSE', '穩健', '低軌衛星與蘋果PCB', true],
    ['2368', '金像電', 'PCB', 'TWSE', '穩健', 'AI伺服器PCB龍頭', true],
    ['6269', '台郡', '軟板PCB', 'TWSE', '觀察', '消費性電子波動股', true],
    ['6213', '聯茂', '銅箔基板', 'TWSE', '觀察', 'CCL材料股', true],
    ['3376', '新日興', '軸承', 'TWSE', '穩健', '折疊機與筆電軸承', true],
    // 重電 / 航運 / 傳產龍頭 (20)
    ['1513', '中興電', '重電能源', 'TWSE', '穩健', 'GIS重電設備龍頭', true],
    ['1519', '華城', '重電能源', 'TWSE', '穩健', '高波動變壓器龍頭', true],
    ['1503', '士電', '重電能源', 'TWSE', '穩健', '重電指標股', true],
    ['1504', '東元', '電機機械', 'TWSE', '穩健', '馬達與重電工程', true],
    ['1605', '華新', '電線電纜', 'TWSE', '觀察', '線纜與不鏽鋼', true],
    ['2603', '長榮', '航運', 'TWSE', '穩健', '貨櫃航運龍頭', true],
    ['2609', '陽明', '航運', 'TWSE', '觀察', '貨櫃航運高波動', true],
    ['2615', '萬海', '航運', 'TWSE', '觀察', '貨櫃航運高波動', true],
    ['2618', '長榮航', '航空', 'TWSE', '穩健', '航空客貨運龍頭', true],
    ['2610', '華航', '航空', 'TWSE', '穩健', '航空指標股', true],
    ['2002', '中鋼', '鋼鐵', 'TWSE', '觀察', '鋼鐵龍頭(景氣對照)', true],
    ['1101', '台泥', '水泥綠能', 'TWSE', '觀察', '水泥儲能(反指標對照)', true],
    ['1216', '統一', '食品消費', 'TWSE', '穩健', '內需消費龍頭', true],
    ['1301', '台塑', '塑化', 'TWSE', '觀察', '塑化龍頭(弱勢對照)', true],
    ['1303', '南亞', '塑化', 'TWSE', '觀察', '塑化電子材料', true],
    ['1326', '台化', '塑化', 'TWSE', '觀察', '塑化指標(弱勢對照)', true],
    ['2912', '統一超', '零售百貨', 'TWSE', '穩健', '防禦型超商龍頭', true],
    ['9910', '豐泰', '製鞋', 'TWSE', '穩健', '運動鞋代工龍頭', true],
    ['1476', '儒鴻', '紡織', 'TWSE', '穩健', '機能布料成衣龍頭', true],
    ['2207', '和泰車', '汽車', 'TWSE', '穩健', '台灣車市龍頭', true],
    // 金融金控 (10)
    ['2881', '富邦金', '金融', 'TWSE', '穩健', '金控獲利王', true],
    ['2882', '國泰金', '金融', 'TWSE', '穩健', '壽險金控龍頭', true],
    ['2891', '中信金', '金融', 'TWSE', '穩健', '消金與高息指標', true],
    ['2886', '兆豐金', '金融', 'TWSE', '穩健', '官股金控龍頭', true],
    ['2884', '玉山金', '金融', 'TWSE', '穩健', '民營穩健金控', true],
    ['2885', '元大金', '金融', 'TWSE', '穩健', '證券龍頭受惠成交量', true],
    ['2892', '第一金', '金融', 'TWSE', '穩健', '官股防禦金控', true],
    ['5880', '合庫金', '金融', 'TWSE', '穩健', '官股穩健金控', true],
    ['2880', '華南金', '金融', 'TWSE', '穩健', '官股金控', true],
    ['2883', '凱基金', '金融', 'TWSE', '穩健', '高殖利率金控', true],
    // 生技與熱門高波動 (5)
    ['6446', '藥華藥', '生技', 'TWSE', '穩健', '新藥龍頭高波動', true],
    ['1795', '美時', '生技', 'TWSE', '穩健', '學名藥外銷指標', true],
    ['4743', '合一', '生技', 'TPEX', '觀察', '高波動生技(反指標對照)', true],
    ['6472', '保瑞', '生技', 'TWSE', '穩健', 'CDMO生技代工龍頭', true],
    ['1760', '寶齡富錦', '生技', 'TWSE', '觀察', '中小型生技波動觀察', true]
  ];
}


// ==================== 13. 全自動模擬操盤機器人 (AUTO_BOT 三個月成效評估) ====================
function calcBotFee(amount) {
  return Math.max(1, Math.round(amount * 0.001425 * 0.6));
}

function calcBotTax(code, amount) {
  const rate = /^00/.test(String(code)) ? 0.001 : 0.003;
  return Math.round(amount * rate);
}

function runAutoBotTrading(ss, todayStr, marketStatus, dailyLogRows, histByCode, cfg) {
  const BOT_INIT_CAP = 100000;
  const eqSheet = getOrCreateSheet(ss, SHEET_NAMES.AUTO_EQUITY, ['Date', 'Cash', 'MarketValue', 'TotalEquity', 'BotReturnPct', 'TwiiClose', 'TwiiReturnPct', 'ActionsSummary', 'MktTone', 'HoldingsSnapshot']);
  if (String(eqSheet.getRange(1, 9).getValue()) !== 'MktTone') {
    eqSheet.getRange(1, 9, 1, 2).setValues([['MktTone', 'HoldingsSnapshot']]);
  }
  const trSheet = getOrCreateSheet(ss, SHEET_NAMES.AUTO_TRADES, ['Id', 'Date', 'Code', 'Name', 'Side', 'Stage', 'Shares', 'Price', 'Amount', 'Fee', 'Tax', 'NetPnL', 'Reason']);
  const hSheet = ss.getSheetByName(SHEET_NAMES.HOLDINGS);

  // 初始化機器人起跑基準
  let cash = cfg.AUTO_BOT_CASH !== undefined && cfg.AUTO_BOT_CASH !== '' ? Number(cfg.AUTO_BOT_CASH) : BOT_INIT_CAP;
  let startDate = String(cfg.AUTO_BOT_START_DATE || '');
  let startTwii = Number(cfg.AUTO_BOT_START_TWII || 0);
  if (!startDate || !startTwii) {
    startDate = todayStr;
    startTwii = Number(marketStatus.close || 1);
    setConfigValue(ss, 'AUTO_BOT_START_DATE', startDate);
    setConfigValue(ss, 'AUTO_BOT_START_TWII', startTwii);
    setConfigValue(ss, 'AUTO_BOT_CASH', cash);
  }

  // 建立今日掃描結果 Map
  const logMap = {};
  dailyLogRows.forEach(r => {
    logMap[String(r[1])] = {
      code: String(r[1]), name: String(r[2]), close: Number(r[3]), changePct: Number(r[4]),
      volume: Number(r[5]), hits: String(r[6]).split(',').filter(Boolean),
      action: String(r[7]), reason: String(r[8]), recShares: Number(r[9]),
      limitPrice: Number(r[10]), stopLoss: Number(r[11]), instDays: Number(r[14]), c02Status: String(r[15])
    };
  });

  const actionsTaken = [];
  const hRows = hSheet.getDataRange().getValues();

  // --- 步驟 A：檢查現有 AUTO_BOT 持股 (出場與加碼) ---
  for (let i = 1; i < hRows.length; i++) {
    const r = hRows[i];
    if (String(r[1]) !== 'AUTO_BOT' || String(r[11]).toUpperCase() !== 'OPEN') continue;

    const rowIdx = i + 1;
    const code = normCode(r[2]);
    const name = String(r[3]);
    let stage = Number(r[4]);
    let shares = Number(r[5]);
    let avgCost = Number(r[6]);
    let stopLoss = Number(r[7]);
    const entryDate = formatDateVal(r[9]);
    const daysHeld = Number(r[10] || 0) + (entryDate === todayStr ? 0 : 1);

    const series = histByCode[code] || [];
    const todayInfo = logMap[code];
    if (!todayInfo || series.length < 25) continue;

    const close = todayInfo.close;
    const pnlPct = ((close - avgCost) / avgCost) * 100;
    const n = series.length;
    const sma5 = calcSMA(series, 5, n - 1);
    const sma5Prev = calcSMA(series, 5, n - 2);
    const sma20 = calcSMA(series, 20, n - 1);
    const macd = calcMACD(series);
    const isHalfBodyDown = todayInfo.hits.includes('反下半身');

    hSheet.getRange(rowIdx, 9).setValue(Math.max(Number(r[8]) || avgCost, close));
    if (entryDate !== todayStr) hSheet.getRange(rowIdx, 11).setValue(daysHeld);

    // 若今日剛買進同一檔，當日不觸發隔日出場
    if (entryDate === todayStr) continue;

    let sellShares = 0;
    let sellReason = '';

    if (close <= stopLoss || close < sma20 * 0.995) {
      sellShares = shares;
      sellReason = `硬停損出場 (收盤${close}<=防守${stopLoss})`;
    } else if (pnlPct >= 15 && shares >= 3) {
      sellShares = Math.max(1, Math.floor(shares / 3));
      sellReason = `移動停利一 (獲利${pnlPct.toFixed(1)}%先落袋1/3)`;
    } else if (isHalfBodyDown && shares >= 2) {
      sellShares = Math.max(1, Math.floor(shares / 2));
      sellReason = `移動停利二 (反下半身跌破5日線減碼)`;
    } else if (daysHeld >= 5 && Math.abs(pnlPct) < 2.5 && Math.abs(sma5 - sma5Prev) / Math.max(1, sma5) < 0.002 && macd.hist < macd.prevHist) {
      sellShares = Math.max(1, Math.floor(shares / 2));
      sellReason = `時間停損 (橫盤${daysHeld}日動能衰竭減半)`;
    }

    if (sellShares > 0) {
      const amount = Math.round(sellShares * close);
      const fee = calcBotFee(amount);
      const tax = calcBotTax(code, amount);
      const netProceeds = amount - fee - tax;
      const buyFeeEst = calcBotFee(Math.round(sellShares * avgCost));
      const netPnL = Math.round(netProceeds - (sellShares * avgCost) - buyFeeEst);

      cash += netProceeds;
      const leftShares = shares - sellShares;
      hSheet.getRange(rowIdx, 6).setValue(leftShares);
      if (leftShares <= 0) {
        hSheet.getRange(rowIdx, 12).setValue('CLOSED');
      } else {
        // 移動停利後上移停損至成本保本線
        hSheet.getRange(rowIdx, 8).setValue(Math.max(stopLoss, avgCost));
      }
      trSheet.appendRow(['B' + Date.now(), todayStr, code, name, 'SELL', stage, sellShares, close, amount, fee, tax, netPnL, sellReason]);
      actionsTaken.push(`賣${name}${sellShares}股`);
    }
    // 檢查加碼 (第2批 / 第3批)
    else if (stage < 3 && cash >= BOT_INIT_CAP * 0.30) {
      const canAdd2 = stage === 1 && pnlPct >= 4 && close > sma5 && sma5 > sma5Prev;
      const canAdd3 = stage === 2 && pnlPct >= 8 && close > sma5;
      if (canAdd2 || canAdd3) {
        const addBudget = (BOT_INIT_CAP * 0.24) / 3;
        const execPrice = todayInfo.limitPrice;
        const addShares = Math.floor(addBudget / execPrice);
        const amount = Math.round(addShares * execPrice);
        const fee = calcBotFee(amount);
        if (addShares >= 1 && (cash - amount - fee) >= BOT_INIT_CAP * 0.30) {
          cash -= (amount + fee);
          const newShares = shares + addShares;
          const newAvg = Number((((shares * avgCost) + amount) / newShares).toFixed(2));
          const newStage = stage + 1;
          const newStop = newStage === 3 ? newAvg : roundToTick((newAvg * 0.95));
          hSheet.getRange(rowIdx, 5).setValue(newStage);
          hSheet.getRange(rowIdx, 6).setValue(newShares);
          hSheet.getRange(rowIdx, 7).setValue(newAvg);
          hSheet.getRange(rowIdx, 8).setValue(Math.max(stopLoss, newStop));
          trSheet.appendRow(['B' + Date.now(), todayStr, code, name, 'BUY', newStage, addShares, execPrice, amount, fee, 0, 0, `第${newStage}批順勢加碼(+${pnlPct.toFixed(1)}%)並上移停損`]);
          actionsTaken.push(`加碼${name}${addShares}股`);
        }
      }
    }
  }

  // --- 步驟 B：檢查新進場試單 (嚴守最多4檔、保留30%現金、空頭警戒不開新倉) ---
  const updatedHoldings = hSheet.getDataRange().getValues().slice(1).filter(r => String(r[1]) === 'AUTO_BOT' && String(r[11]).toUpperCase() === 'OPEN');
  const heldCodes = new Set(updatedHoldings.map(r => normCode(r[2])));
  const minCashKeep = marketStatus.tone === '空頭警戒' ? BOT_INIT_CAP * 0.50 : BOT_INIT_CAP * 0.30;

  if (marketStatus.tone !== '空頭警戒' && updatedHoldings.length < 4 && cash > minCashKeep) {
    const candidates = Object.values(logMap)
      .filter(x => x.action === '試單買進' && !heldCodes.has(x.code) && x.recShares >= 1)
      .sort((a, b) => {
        if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
        const aC02 = a.hits.includes('C02') ? 1 : 0;
        const bC02 = b.hits.includes('C02') ? 1 : 0;
        if (bC02 !== aC02) return bC02 - aC02;
        return b.volume - a.volume;
      });

    let openSlots = 4 - updatedHoldings.length;
    for (let k = 0; k < candidates.length && openSlots > 0; k++) {
      const c = candidates[k];
      const execPrice = c.limitPrice;
      const buyShares = c.recShares;
      const amount = Math.round(buyShares * execPrice);
      const fee = calcBotFee(amount);
      if ((cash - amount - fee) >= minCashKeep) {
        cash -= (amount + fee);
        hSheet.appendRow(['B' + Date.now() + k, 'AUTO_BOT', c.code, c.name, 1, buyShares, execPrice, c.stopLoss, execPrice, todayStr, 0, 'OPEN']);
        trSheet.appendRow(['B' + Date.now() + k, todayStr, c.code, c.name, 'BUY', 1, buyShares, execPrice, amount, fee, 0, 0, `第1批試單：${c.reason}`]);
        actionsTaken.push(`買${c.name}${buyShares}股`);
        openSlots--;
      }
    }
  }

  // --- 步驟 C：結算當日淨值並寫入 Auto_Equity_Curve (含當日持股快照) ---
  setConfigValue(ss, 'AUTO_BOT_CASH', Math.round(cash));
  const finalOpen = hSheet.getDataRange().getValues().slice(1).filter(r => String(r[1]) === 'AUTO_BOT' && String(r[11]).toUpperCase() === 'OPEN');
  let marketValue = 0;
  const holdingsSnapshot = finalOpen.map(r => {
    const code = normCode(r[2]);
    const name = String(r[3]);
    const stage = Number(r[4]);
    const shares = Number(r[5]);
    const avgCost = Number(r[6]);
    const stopLoss = Number(r[7]);
    const daysHeld = Number(r[10] || 0);
    const curClose = logMap[code] ? logMap[code].close : avgCost;
    marketValue += Math.round(shares * curClose);
    const pnlPct = Number((((curClose - avgCost) / Math.max(1, avgCost)) * 100).toFixed(2));
    return { code, name, stage, shares, avgCost, curPrice: curClose, stopLoss, daysHeld, pnlPct };
  });

  const totalEquity = Math.round(cash + marketValue);
  const botReturnPct = Number((((totalEquity - BOT_INIT_CAP) / BOT_INIT_CAP) * 100).toFixed(2));
  const twiiClose = Number(marketStatus.close || startTwii);
  const twiiReturnPct = Number((((twiiClose - startTwii) / startTwii) * 100).toFixed(2));
  const summaryText = actionsTaken.length > 0 ? actionsTaken.join('、') : '今日無交易 (持有觀察)';

  removeRowsByDate(eqSheet, todayStr);
  eqSheet.appendRow([todayStr, Math.round(cash), marketValue, totalEquity, botReturnPct, twiiClose, twiiReturnPct, summaryText, marketStatus.tone || '震盪整理', JSON.stringify(holdingsSnapshot)]);

  return { equity: totalEquity, returnPct: botReturnPct, twiiReturnPct, summaryText };
}

function resetAutoBotExperiment(ss) {
  const hSheet = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
  const hRows = hSheet.getDataRange().getValues();
  for (let i = hRows.length - 1; i >= 1; i--) {
    if (String(hRows[i][1]) === 'AUTO_BOT') hSheet.deleteRow(i + 1);
  }
  const eqSheet = ss.getSheetByName(SHEET_NAMES.AUTO_EQUITY);
  if (eqSheet && eqSheet.getLastRow() > 1) eqSheet.getRange(2, 1, eqSheet.getLastRow() - 1, 8).clearContent();
  const trSheet = ss.getSheetByName(SHEET_NAMES.AUTO_TRADES);
  if (trSheet && trSheet.getLastRow() > 1) trSheet.getRange(2, 1, trSheet.getLastRow() - 1, 13).clearContent();

  setConfigValue(ss, 'AUTO_BOT_CASH', 100000);
  setConfigValue(ss, 'AUTO_BOT_START_DATE', '');
  setConfigValue(ss, 'AUTO_BOT_START_TWII', 0);
}

function getAutoBotDashboardData(ss) {
  const eqSheet = ss.getSheetByName(SHEET_NAMES.AUTO_EQUITY);
  const trSheet = ss.getSheetByName(SHEET_NAMES.AUTO_TRADES);
  const cfg = getConfigMap(ss);
  return {
    startDate: String(cfg.AUTO_BOT_START_DATE || ''),
    cash: cfg.AUTO_BOT_CASH !== undefined && cfg.AUTO_BOT_CASH !== '' ? Number(cfg.AUTO_BOT_CASH) : 100000,
    equityCurve: eqSheet ? getSheetObjects(ss, SHEET_NAMES.AUTO_EQUITY).slice(-65) : [],
    trades: trSheet ? getSheetObjects(ss, SHEET_NAMES.AUTO_TRADES).slice(-100).reverse() : []
  };
}


// ==================== 14. 近三個月歷史回測引擎 (純記憶體運算，不寫入試算表) ====================
function runThreeMonthBacktest(ss, params) {
  const months = Number(params.months || 2);
  const daysMap = { 1: 22, 2: 44, 3: 65, 6: 130, 9: 195, 12: 250 };
  const targetDays = daysMap[months] || 44;
  const maxUpStreak = Number(params.maxUpStreak || 2);
  const triggerMode = String(params.triggerMode || 'STRICT'); // 'STRICT' | 'RELAXED'
  const maxHoldings = Number(params.maxHoldings || 4);
  const maxSinglePct = maxHoldings >= 6 ? 0.16 : 0.24;
  const INIT_CAP = 100000;
  const RISK_PCT = 0.01;

  // 1. 讀取 Watchlist & History_Cache
  const wlRows = ss.getSheetByName(SHEET_NAMES.WATCHLIST).getDataRange().getValues().slice(1);
  const activeMeta = {};
  wlRows.forEach(w => {
    const code = normCode(w[0]);
    const active = w[6] !== false && String(w[6]).toUpperCase() !== 'FALSE';
    if (code && active) activeMeta[code] = { name: String(w[1]).trim(), c02Status: String(w[4]).trim() || '穩健' };
  });

  const histRows = ss.getSheetByName(SHEET_NAMES.HISTORY).getDataRange().getValues().slice(1);
  const byCode = {};
  const allDatesSet = new Set();
  histRows.forEach(r => {
    const c = normCode(r[1]);
    const dStr = formatDateVal(r[0]);
    if (!c || !dStr || !activeMeta[c]) return;
    allDatesSet.add(dStr);
    if (!byCode[c]) byCode[c] = {};
    byCode[c][dStr] = {
      date: dStr, open: Number(r[2]), high: Number(r[3]), low: Number(r[4]), close: Number(r[5]), volume: Number(r[6])
    };
  });

  const sortedAllDates = Array.from(allDatesSet).sort();
  if (sortedAllDates.length < 70) {
    return { error: '歷史資料天數不足（需至少 70 個交易日才能進行回測），請先確認 Batch1~4 已執行 2y 載入。' };
  }
  const actualDays = Math.min(targetDays, Math.max(20, sortedAllDates.length - 62));
  const btDates = sortedAllDates.slice(-actualDays);
  const btStartDate = btDates[0];

  // 將每檔股票轉為依日期升序陣列與日期索引 Map
  const stockSeries = {};
  const stockDateIdx = {};
  Object.keys(byCode).forEach(c => {
    const arr = Object.values(byCode[c]).sort((a, b) => a.date.localeCompare(b.date));
    stockSeries[c] = arr;
    const idxMap = {};
    arr.forEach((b, i) => { idxMap[b.date] = i; });
    stockDateIdx[c] = idxMap;
  });

  // 2. 取得大盤歷史 (^TWII 2y 以覆蓋 12 個月回測 + 前 60 日均線)
  const twiiBars = fetchYahooHistory('^TWII', '2y');
  const twiiByDate = {};
  twiiBars.forEach(b => { twiiByDate[b.date] = b; });
  const twiiSorted = Object.values(twiiByDate).sort((a, b) => a.date.localeCompare(b.date));
  const twiiIdxMap = {};
  twiiSorted.forEach((b, i) => { twiiIdxMap[b.date] = i; });
  const startTwiiClose = (twiiByDate[btStartDate] && twiiByDate[btStartDate].close) || (twiiSorted.length > 0 ? twiiSorted[0].close : 1);

  // 3. 逐日回測模擬
  let cash = INIT_CAP;
  const openPos = {}; // code -> { code, name, stage, shares, avgCost, stopLoss, entryDate, daysHeld }
  const equityCurve = [];
  const trades = [];

  btDates.forEach(dateStr => {
    // 大盤當日定調
    const ti = twiiIdxMap[dateStr];
    let mktChg = 0, mktRet5 = 0, mktTone = '震盪整理', twiiClose = startTwiiClose;
    if (ti !== undefined && ti >= 1) {
      twiiClose = twiiSorted[ti].close;
      const prevTwii = twiiSorted[ti - 1].close;
      mktChg = prevTwii > 0 ? ((twiiClose - prevTwii) / prevTwii) * 100 : 0;
      const prev5 = ti >= 5 ? twiiSorted[ti - 5].close : prevTwii;
      mktRet5 = prev5 > 0 ? ((twiiClose - prev5) / prev5) * 100 : mktChg;
      const mSma5 = calcSMA(twiiSorted, 5, ti);
      const mSma20 = calcSMA(twiiSorted, 20, ti);
      const mSma60 = calcSMA(twiiSorted, 60, ti);
      if (twiiClose > mSma5 && twiiClose > mSma20 && mSma20 > mSma60) mktTone = '偏多格局';
      else if (twiiClose < mSma20 && mktChg <= -1.5) mktTone = '空頭警戒';
    }

    const dayCandidates = [];
    const todayCloses = {};

    // 掃描所有股票截至 dateStr 的技術面
    Object.keys(stockSeries).forEach(code => {
      const idx = stockDateIdx[code][dateStr];
      if (idx === undefined || idx < 61) return;
      const series = stockSeries[code].slice(0, idx + 1);
      const n = series.length;
      const today = series[n - 1];
      const prev = series[n - 2];
      todayCloses[code] = today.close;

      const changePct = prev.close > 0 ? ((today.close - prev.close) / prev.close) * 100 : 0;
      const ret5 = series[n - 6] && series[n - 6].close > 0 ? ((today.close - series[n - 6].close) / series[n - 6].close) * 100 : changePct;
      const sma5 = calcSMA(series, 5, n - 1);
      const sma5Prev = calcSMA(series, 5, n - 2);
      const sma10 = calcSMA(series, 10, n - 1);
      const sma20 = calcSMA(series, 20, n - 1);
      const sma20Prev = calcSMA(series, 20, n - 2);
      const sma60 = calcSMA(series, 60, n - 1);
      const sma60Prev = calcSMA(series, 60, n - 2);

      let upStreak = 0;
      for (let k = n - 1; k > 0; k--) {
        if (series[k].close > series[k - 1].close) upStreak++;
        else break;
      }

      const c08 = today.volume > 1000;
      const c09 = today.close > sma20 && today.close > sma60 && sma20 >= sma20Prev && sma60 >= sma60Prev;
      const c01 = changePct >= mktChg && ret5 >= mktRet5;

      const prevMaxMa = Math.max(calcSMA(series, 5, n - 4), calcSMA(series, 10, n - 4), calcSMA(series, 20, n - 4), calcSMA(series, 60, n - 4));
      const prevMinMa = Math.min(calcSMA(series, 5, n - 4), calcSMA(series, 10, n - 4), calcSMA(series, 20, n - 4), calcSMA(series, 60, n - 4));
      const squeezeSpread = prevMinMa > 0 ? ((prevMaxMa - prevMinMa) / prevMinMa) * 100 : 99;
      const avgVol5 = calcAvgVol(series, 5, n - 2);
      const c04 = squeezeSpread <= 3.0 && today.close > today.open && today.close > Math.max(sma5, sma10, sma20, sma60) && today.volume > avgVol5 * 1.2;

      const kd = calcKD(series);
      const c05 = kd.prevK <= kd.prevD && kd.k > kd.d && kd.k <= 60 && kd.d <= 60;
      const macd = calcMACD(series);
      const c06 = (macd.prevHist <= 0 && macd.hist > 0) || (macd.hist > 0 && macd.hist > macd.prevHist);

      const body = Math.abs(today.close - today.open);
      const upperShadow = today.high - Math.max(today.close, today.open);
      const bodyMid = (today.open + today.close) / 2;
      const isHalfBodyUp = today.close > today.open && bodyMid >= sma5 && today.close > sma5 && sma5 >= sma5Prev;
      const isHalfBodyDown = today.close < today.open && bodyMid <= sma5 && today.close < sma5 && sma5 <= sma5Prev;
      const isBirdBeak = sma5Prev <= sma20Prev * 1.015 && sma5 > sma5Prev && today.low >= sma20 * 0.985 && today.close > sma5;
      const isBullEngulfing = prev.close < prev.open && today.close > today.open && today.open <= prev.close && today.close >= prev.open;
      const prev2 = series[n - 3];
      const isMorningStar = prev2 && prev2.close < prev2.open && Math.abs(prev.close - prev.open) < Math.abs(prev2.close - prev2.open) * 0.4 && today.close > today.open && today.close > (prev2.open + prev2.close) / 2;
      const isHighUpperShadow = upperShadow > body * 1.8 && today.volume > avgVol5 * 1.5;

      // 檢查目前持倉出場與加碼
      if (openPos[code]) {
        const pos = openPos[code];
        pos.daysHeld++;
        const pnlPct = ((today.close - pos.avgCost) / pos.avgCost) * 100;
        let sellShares = 0, sellReason = '';

        if (today.close <= pos.stopLoss || today.close < sma20 * 0.995) {
          sellShares = pos.shares;
          sellReason = `硬停損 (${today.close}<=${pos.stopLoss})`;
        } else if (pnlPct >= 15 && pos.shares >= 3) {
          sellShares = Math.max(1, Math.floor(pos.shares / 3));
          sellReason = `移動停利一 (+${pnlPct.toFixed(1)}%賣1/3)`;
        } else if (isHalfBodyDown && pos.shares >= 2) {
          sellShares = Math.max(1, Math.floor(pos.shares / 2));
          sellReason = `移動停利二 (反下半身減碼)`;
        } else if (pos.daysHeld >= 5 && Math.abs(pnlPct) < 2.5 && Math.abs(sma5 - sma5Prev) / Math.max(1, sma5) < 0.002 && macd.hist < macd.prevHist) {
          sellShares = Math.max(1, Math.floor(pos.shares / 2));
          sellReason = `時間停損 (${pos.daysHeld}日橫盤減半)`;
        }

        if (sellShares > 0) {
          const amount = Math.round(sellShares * today.close);
          const fee = calcBotFee(amount);
          const tax = calcBotTax(code, amount);
          const netProceeds = amount - fee - tax;
          const buyFeeEst = calcBotFee(Math.round(sellShares * pos.avgCost));
          const netPnL = Math.round(netProceeds - (sellShares * pos.avgCost) - buyFeeEst);
          cash += netProceeds;
          pos.shares -= sellShares;
          trades.push({ date: dateStr, code, name: pos.name, side: 'SELL', stage: pos.stage, shares: sellShares, price: today.close, fee, tax, netPnL, reason: sellReason });
          if (pos.shares <= 0) delete openPos[code];
          else pos.stopLoss = Math.max(pos.stopLoss, pos.avgCost);
        } else if (pos.stage < 3 && cash >= INIT_CAP * 0.30) {
          const canAdd2 = pos.stage === 1 && pnlPct >= 4 && today.close > sma5 && sma5 > sma5Prev;
          const canAdd3 = pos.stage === 2 && pnlPct >= 8 && today.close > sma5;
          if (canAdd2 || canAdd3) {
            const execPrice = roundToTick(today.close + getTickSize(today.close));
            const addShares = Math.floor(((INIT_CAP * maxSinglePct) / 3) / execPrice);
            const amount = Math.round(addShares * execPrice);
            const fee = calcBotFee(amount);
            if (addShares >= 1 && (cash - amount - fee) >= INIT_CAP * 0.30) {
              cash -= (amount + fee);
              const newShares = pos.shares + addShares;
              pos.avgCost = Number((((pos.shares * pos.avgCost) + amount) / newShares).toFixed(2));
              pos.shares = newShares;
              pos.stage++;
              const newStop = pos.stage === 3 ? pos.avgCost : roundToTick(pos.avgCost * 0.95);
              pos.stopLoss = Math.max(pos.stopLoss, newStop);
              trades.push({ date: dateStr, code, name: pos.name, side: 'BUY', stage: pos.stage, shares: addShares, price: execPrice, fee, tax: 0, netPnL: 0, reason: `第${pos.stage}批加碼(+${pnlPct.toFixed(1)}%)` });
            }
          }
        }
        return;
      }

      // 評估新進場候選
      const hasResonance = c04 || isHalfBodyUp || isBirdBeak || isBullEngulfing || isMorningStar;
      const hasMomentum = triggerMode === 'RELAXED' && (c05 || c06);
      const isExcluded = (upStreak >= maxUpStreak) || isHighUpperShadow;

      if (c08 && c09 && c01 && !isExcluded && (hasResonance || hasMomentum)) {
        let score = 3;
        const reasons = ['C01/C08/C09'];
        if (c04) { score++; reasons.push('均線發散'); }
        if (isHalfBodyUp) { score++; reasons.push('下半身'); }
        if (isBirdBeak) { score++; reasons.push('鳥嘴'); }
        if (isBullEngulfing || isMorningStar) { score++; reasons.push('酒田反轉'); }
        if (c05) { score++; reasons.push('KD金叉'); }
        if (c06) { score++; reasons.push('MACD向上'); }

        const recentLow = Math.min(...series.slice(Math.max(0, n - 10), n).map(x => x.low));
        const stopLoss = roundToTick(Math.min(today.close * 0.94, Math.max(today.close * 0.92, Math.max(recentLow, sma20 * 0.99))));
        const limitPrice = roundToTick(today.close + getTickSize(today.close));
        const maxByRisk = Math.floor((INIT_CAP * RISK_PCT) / Math.max(1, limitPrice - stopLoss));
        const maxByCap = Math.floor(((INIT_CAP * maxSinglePct) / 3) / limitPrice);
        const recShares = Math.max(0, Math.min(maxByRisk, maxByCap));

        if (recShares >= 1) {
          dayCandidates.push({
            code, name: activeMeta[code].name, score, c02: activeMeta[code].c02Status === '穩健' ? 1 : 0,
            volume: today.volume, recShares, limitPrice, stopLoss, reason: reasons.join('+')
          });
        }
      }
    });

    // 執行當日新進場
    const minCashKeep = mktTone === '空頭警戒' ? INIT_CAP * 0.50 : INIT_CAP * 0.30;
    const heldCnt = Object.keys(openPos).length;
    if (mktTone !== '空頭警戒' && heldCnt < maxHoldings && cash > minCashKeep) {
      dayCandidates.sort((a, b) => (b.score - a.score) || (b.c02 - a.c02) || (b.volume - a.volume));
      let slots = maxHoldings - heldCnt;
      for (let i = 0; i < dayCandidates.length && slots > 0; i++) {
        const c = dayCandidates[i];
        const amount = Math.round(c.recShares * c.limitPrice);
        const fee = calcBotFee(amount);
        if ((cash - amount - fee) >= minCashKeep) {
          cash -= (amount + fee);
          openPos[c.code] = { code: c.code, name: c.name, stage: 1, shares: c.recShares, avgCost: c.limitPrice, stopLoss: c.stopLoss, entryDate: dateStr, daysHeld: 0 };
          trades.push({ date: dateStr, code: c.code, name: c.name, side: 'BUY', stage: 1, shares: c.recShares, price: c.limitPrice, fee, tax: 0, netPnL: 0, reason: `第1批試單：${c.reason}` });
          slots--;
        }
      }
    }

    // 結算當日淨值與當日持股快照
    let mv = 0;
    const holdingsSnapshot = Object.values(openPos).map(p => {
      const curPrice = todayCloses[p.code] || p.avgCost;
      mv += Math.round(p.shares * curPrice);
      const pnlPct = Number((((curPrice - p.avgCost) / p.avgCost) * 100).toFixed(2));
      return { code: p.code, name: p.name, stage: p.stage, shares: p.shares, avgCost: p.avgCost, curPrice, stopLoss: p.stopLoss, daysHeld: p.daysHeld, pnlPct };
    });
    const equity = Math.round(cash + mv);
    const botRet = Number((((equity - INIT_CAP) / INIT_CAP) * 100).toFixed(2));
    const twiiRet = Number((((twiiClose - startTwiiClose) / startTwiiClose) * 100).toFixed(2));
    equityCurve.push({ date: dateStr, mktTone, equity, cash: Math.round(cash), botReturnPct: botRet, twiiReturnPct: twiiRet, holdingsSnapshot });
  });

  // 4. 彙整回測統計指標
  const lastEq = equityCurve[equityCurve.length - 1] || { equity: INIT_CAP, botReturnPct: 0, twiiReturnPct: 0 };
  const closed = trades.filter(t => t.side === 'SELL');
  const wins = closed.filter(t => t.netPnL > 0);
  const losses = closed.filter(t => t.netPnL < 0);
  const sumWin = wins.reduce((a, b) => a + b.netPnL, 0);
  const sumLoss = Math.abs(losses.reduce((a, b) => a + b.netPnL, 0));

  let peak = INIT_CAP, mdd = 0;
  equityCurve.forEach(e => {
    if (e.equity > peak) peak = e.equity;
    const dd = ((e.equity - peak) / peak) * 100;
    if (dd < mdd) mdd = dd;
  });

  return {
    startDate: btDates[0],
    endDate: btDates[btDates.length - 1],
    daysCount: btDates.length,
    finalEquity: lastEq.equity,
    totalReturnPct: lastEq.botReturnPct,
    twiiReturnPct: lastEq.twiiReturnPct,
    alpha: Number((lastEq.botReturnPct - lastEq.twiiReturnPct).toFixed(2)),
    winRate: closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(1)) : null,
    profitFactor: sumLoss > 0 ? Number((sumWin / sumLoss).toFixed(2)) : (sumWin > 0 ? '∞' : '-'),
    mdd: Number(mdd.toFixed(2)),
    totalTrades: trades.length,
    closedTrades: closed.length,
    openRemaining: Object.keys(openPos).length,
    equityCurve,
    trades: trades.slice().reverse()
  };
}
