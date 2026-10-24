// SaintTrading 下單提醒（靜態網頁）：只顯示提醒與圖表，不會下單。
// 資料：data.js（window.SAINT_DATA，由 web_export.py 產生）。
// 下單數量：依使用者輸入的帳戶餘額，在瀏覽器計算；planOrder / allocate 移植自 risk/sizing.py、risk/allocation.py。
(function () {
  "use strict";

  let DATA = null; // 解鎖（或明文）後才有
  const BALANCE_KEY = "saint.balance";
  const PASSWORD_KEY = "saint.password"; // 勾「記住這台裝置」時存在這台瀏覽器
  const MAX_HISTORY = 50;
  const TZ_SHIFT = -new Date().getTimezoneOffset() * 60; // 圖表用當地時間顯示
  const $ = (id) => document.getElementById(id);

  // ---------- 格式 ----------
  function priceDecimals(price) {
    if (!(price > 0) || !isFinite(price)) return 2;
    return Math.max(2, 4 - Math.floor(Math.log10(price)));
  }
  function fmtPrice(v, d) {
    if (v === null || v === undefined) return "-";
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtU(v) {
    const sign = v > 0 ? "+" : v < 0 ? "-" : "+";
    const a = Math.abs(v);
    return sign + (a < 100 ? a.toFixed(2) : a.toLocaleString("en-US", { maximumFractionDigits: 0 })) + "U";
  }
  function fmtPct(v, digits) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(digits) + "%"; }
  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function decimalsOf(unit) {
    const s = unit.toFixed(10).replace(/0+$/, "");
    return s.includes(".") ? s.split(".")[1].length : 0;
  }
  function fmtQty(plan) {
    if (plan.qtyDecimals !== null) return plan.quantity.toLocaleString("en-US", {
      minimumFractionDigits: plan.qtyDecimals, maximumFractionDigits: plan.qtyDecimals });
    return Number(plan.quantity.toPrecision(4)).toString();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- 下單金額（移植 risk/sizing.py） ----------
  function safeLeverage(rule, dist) {
    let lev = rule.leverage;
    while (lev > 1 && (1 / lev - rule.maintenance_margin) < dist * rule.liq_buffer) lev -= 1;
    return Math.max(lev, 1);
  }

  function planOrder(rule, side, entry, stop, available, lot) {
    if (!(entry > 0) || !(stop > 0)) return null;
    const long = side === "LONG";
    if (long ? stop >= entry : stop <= entry) return null;
    const dist = Math.abs(entry - stop) / entry;
    const full = (rule.balance * rule.risk_pct) / (dist + rule.fee_rate);
    const lev = safeLeverage(rule, dist);
    let notional = available === null ? full : Math.min(full, Math.max(available, 0) * lev);
    const limited = notional < full * (1 - 1e-9);
    if (limited && notional < rule.min_shrunk_notional) notional = 0;
    let tooSmall = false;
    if (lot && notional > 0) {
      const qty = Math.floor(notional / entry / lot.step + 1e-9) * lot.step;
      if (qty < lot.min_qty - 1e-12 || qty * entry < lot.min_notional) { tooSmall = true; notional = 0; }
      else notional = qty * entry;
    }
    const liq = 1 / lev - rule.maintenance_margin;
    return {
      side, entry, stop, dist, notional, full, limited, tooSmall,
      quantity: notional / entry, leverage: lev, margin: notional / lev,
      maxLoss: notional * (dist + rule.fee_rate),
      liquidation: long ? entry * (1 - liq) : entry * (1 + liq),
      fee: rule.fee_rate, qtyDecimals: lot ? decimalsOf(lot.step) : null,
    };
  }
  const pnl = (plan, move) => plan.notional * (move - plan.fee);
  function pnlAt(plan, price) {
    const move = (price - plan.entry) / plan.entry;
    return pnl(plan, plan.side === "LONG" ? move : -move);
  }

  // 保證金分配（移植 risk/allocation.py）：持倉先佔，下一根開盤的新訊號依時間用剩下的
  function allocate(alerts, rule) {
    const order = (a, b) => a.time_ms - b.time_ms || a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval);
    const holding = alerts.filter((a) => a.action === "open" && a.holding && !a.pending).sort(order);
    const pending = alerts.filter((a) => a.action === "open" && a.pending).sort(order);
    const plans = {};
    const used = { holding: 0, pending: 0 };
    for (const [group, items] of [["holding", holding], ["pending", pending]]) {
      for (const a of items) {
        if (a.stop === null) continue;
        const plan = planOrder(rule, a.side, a.price, a.stop, rule.balance - used.holding - used.pending, DATA.lots[a.symbol]);
        if (!plan) continue;
        plans[a.id] = plan;
        used[group] += plan.margin;
      }
    }
    return { plans, holding: used.holding, pending: used.pending };
  }

  // ---------- 狀態 ----------
  let rule = null; // init() 時才從 DATA 建立（加密版要先解鎖才有 DATA）
  let budget = { plans: {}, holding: 0, pending: 0 };
  let chart, candleSeries, volumeSeries;
  let levelSeries = []; // 每筆交易各自一條線（移動止損 / 止損 / 止盈），重畫時清掉
  let currentPair = null;

  function loadBalance() {
    try {
      const v = parseFloat(localStorage.getItem(BALANCE_KEY));
      if (v > 0) return v;
    } catch (e) { /* 私密瀏覽等：用預設值 */ }
    return DATA.rule.balance;
  }
  function saveBalance(v) { try { localStorage.setItem(BALANCE_KEY, String(v)); } catch (e) { /* 忽略 */ } }

  // ---------- 提醒卡片 ----------
  function cardHtml(a) {
    const long = a.side === "LONG";
    const d = priceDecimals(a.price);
    const side = long ? "多" : "空";
    const head = (title, cls, badge) =>
      `<div class="head"><span class="act ${cls}">${title}</span><span class="sym">${esc(a.symbol)}</span>` +
      `<span class="badge dim">${esc(a.interval)}</span>${badge}<span class="time">${fmtTime(a.time_ms)}</span></div>`;
    const stats = `<div class="dim">${esc(a.strategy)}　勝率 ${a.win_rate === null ? "-" : Math.round(a.win_rate * 100) + "%"}` +
      `　回測 <span class="${a.total_return > 0 ? "up" : "down"}">${fmtPct(a.total_return, 1)}</span></div>`;

    if (a.action === "open") {
      const plan = budget.plans[a.id] || planOrder(rule, a.side, a.price, a.stop, null, DATA.lots[a.symbol]);
      const badge = `<span class="badge accent">${a.pending ? "下一根開盤進場" : "持倉中"}</span>`;
      let html = head(`開${side}`, long ? "up" : "down", badge);
      let line = `${a.pending ? "參考價" : "進場"} ${fmtPrice(a.price, d)}`;
      if (plan) line += `　<span class="dim">停損距離 ${(plan.dist * 100).toFixed(2)}%</span>`;
      if (a.holding && plan && a.move_pct !== null) {
        const p = pnl(plan, a.move_pct);
        line += `　浮動 <span class="${p > 0 ? "up" : "down"}">${fmtU(p)}</span>`;
      }
      html += `<div>${line}</div>`;
      if (plan && plan.tooSmall) html += `<div class="warn">⚠ 低於交易所最小下單量，這筆無法開倉（照規則約 ${Math.round(plan.full)}U 部位）</div>`;
      else if (plan && plan.limited) {
        html += plan.notional <= 0
          ? `<div class="warn">⚠ 可用保證金不足，這筆無法開倉（需要保證金 ${(plan.full / plan.leverage).toFixed(1)}U）</div>`
          : `<div class="warn">⚠ 可用保證金不足：原本 ${Math.round(plan.full)}U → 縮小為 ${Math.round(plan.notional)}U（打到停損只虧 ${plan.maxLoss.toFixed(1)}U）</div>`;
      }
      if (plan && plan.notional > 0) {
        const coin = a.symbol.replace(/USDT$/, "");
        html += `<div class="order">👉 下單：數量 ${fmtQty(plan)} ${esc(coin)}｜${plan.leverage}x 逐倉｜停損 ${fmtPrice(a.stop, d)}</div>`;
        html += `<div>用掉保證金 ${plan.margin.toFixed(1)}U（部位 ${Math.round(plan.notional).toLocaleString("en-US")}U）｜停損虧 ${plan.maxLoss.toFixed(1)}U（帳戶 ${Math.round(rule.risk_pct * 100)}%）</div>`;
        html += `<div class="dim">強平 ≈ ${fmtPrice(plan.liquidation, d)}｜送出前確認交易所顯示的成本 ≈ ${plan.margin.toFixed(1)}U</div>`;
      }
      if (a.holding && !a.pending) {
        if (a.trail_stop !== null) {
          let t = `🔒 移動止損（兼止盈）→ ${fmtPrice(a.trail_stop, d)}`;
          if (plan && plan.notional > 0) {
            const p = pnlAt(plan, a.trail_stop);
            t += `｜打到約 ${fmtU(p)} ${p > 0 ? "✅已鎖利" : "（尚未鎖利）"}`;
          }
          html += `<div class="accent">${t}</div>`;
          html += `<div class="dim">原始止損 ${fmtPrice(a.stop, d)}｜每根 4h 收盤後手動改停損單</div>`;
        }
        if (a.target_price !== null) {
          let t = `🎯 止盈 ${fmtPrice(a.target_price, d)}`;
          if (plan && plan.notional > 0) t += `｜打到約 ${fmtU(pnlAt(plan, a.target_price))}`;
          html += `<div class="up">${t}</div>`;
        }
      }
      return `<div class="card ${long ? "long" : "short"}" data-id="${esc(a.id)}">${html}${stats}</div>`;
    }

    // 平倉
    const plan = planOrder(rule, a.side, a.entry_price, a.stop, null, null);
    const p = plan && a.move_pct !== null ? pnl(plan, a.move_pct) : null;
    const amount = p !== null ? fmtU(p) : fmtPct(a.trade_return || 0, 2);
    const badge = `<span class="badge ${(p !== null ? p : a.trade_return) > 0 ? "up" : "down"}">${a.pending ? "下一根開盤" : ""}${esc(a.exit_reason)} ${amount}</span>`;
    let html = head(`平${side}`, "dim", badge);
    if (a.entry_time_ms !== null) html += `<div class="dim">${fmtTime(a.entry_time_ms)} → ${a.pending ? "下一根開盤" : fmtTime(a.time_ms)}</div>`;
    let line = `開倉 ${fmtPrice(a.entry_price, d)} → ${a.pending ? "參考價" : "平倉"} ${fmtPrice(a.price, d)}`;
    if (plan) line += `　<span class="dim">部位 ${Math.round(plan.notional).toLocaleString("en-US")}U</span>`;
    html += `<div>${line}</div>`;
    return `<div class="card closed" data-id="${esc(a.id)}">${html}${stats}</div>`;
  }

  const latest = (list) => list.slice().sort((x, y) => y.time_ms - x.time_ms || (y.action === "close") - (x.action === "close"));

  function renderAlerts() {
    budget = allocate(DATA.alerts, rule);
    const pending = latest(DATA.alerts.filter((a) => a.pending));
    const holding = latest(DATA.alerts.filter((a) => a.action === "open" && a.holding && !a.pending));
    const history = latest(DATA.alerts.filter((a) => a.action === "close" && !a.pending)).slice(0, MAX_HISTORY);
    const fill = (el, list, empty) => { el.innerHTML = list.length ? list.map(cardHtml).join("") : `<div class="empty">${empty}</div>`; };
    fill($("pending"), pending, "目前沒有新訊號");
    fill($("holding"), holding, "目前沒有持倉");
    fill($("history"), history, "沒有歷史訂單");
    $("holding-count").textContent = `(${holding.length})`;
    $("history-count").textContent = `(${history.length})`;
    $("rule").textContent = `每筆最多虧 帳戶 ${Math.round(rule.risk_pct * 100)}% = ${(rule.balance * rule.risk_pct).toFixed(2)}U｜預設 ${rule.leverage}x 逐倉`;
    let m = `保證金：持倉已用 ${budget.holding.toFixed(1)}U｜可用 ${(rule.balance - budget.holding).toFixed(1)}U`;
    if (budget.pending >= 0.01) m += `｜待進場再用 ${budget.pending.toFixed(1)}U`;
    $("margin").textContent = m;
    document.querySelectorAll(".card").forEach((el) => el.addEventListener("click", () => {
      focusAlert(el.dataset.id);
      history.replaceState(null, "", "#alert=" + encodeURIComponent(el.dataset.id)); // 網址可以分享這則提醒
    }));
  }

  // ---------- 圖表 ----------
  const toTime = (ms) => Math.floor(ms / 1000) + TZ_SHIFT;

  function initChart() {
    const LW = window.LightweightCharts;
    chart = LW.createChart($("chart"), {
      layout: { background: { type: "solid", color: "#161a1e" }, textColor: "#848e9c" },
      grid: { vertLines: { color: "#2b3139" }, horzLines: { color: "#2b3139" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2b3139" },
      rightPriceScale: { borderColor: "#2b3139" },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: "#0ecb81", downColor: "#f6465d", borderVisible: false, wickUpColor: "#0ecb81", wickDownColor: "#f6465d",
    });
    volumeSeries = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }

  // 每筆交易各自一條線：不同交易之間不會被連起來
  const LINE_STYLE = {
    trail: { color: "#3d7bd9", lineWidth: 2, lineStyle: 0, lineType: 1 }, // 移動止損：實線階梯
    stop: { color: "#f6465d", lineWidth: 1, lineStyle: 1, lineType: 0 }, // 止損：點線
    target: { color: "#0ecb81", lineWidth: 1, lineStyle: 1, lineType: 0 }, // 止盈：點線
  };
  function addLevel(kind, points) {
    if (points.length < 1) return;
    const series = chart.addLineSeries({
      ...LINE_STYLE[kind], lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    series.setData(points);
    levelSeries.push(series);
  }

  function tradePlan(t) { return t.stop === null ? null : planOrder(rule, t.side, t.entry_price, t.stop, null, null); }

  function drawPair(pair, focus) {
    currentPair = pair;
    const c = DATA.charts[pair];
    $("pair").value = pair;
    const bar = c.candles.length > 1 ? c.candles[1][0] - c.candles[0][0] : 0;
    candleSeries.setData(c.candles.map((k) => ({ time: toTime(k[0]), open: k[1], high: k[2], low: k[3], close: k[4] })));
    volumeSeries.setData(c.candles.map((k) => ({ time: toTime(k[0]), value: k[5], color: k[4] >= k[1] ? "rgba(14,203,129,.35)" : "rgba(246,70,93,.35)" })));
    const first = c.candles.length ? c.candles[0][0] : 0;
    const last = c.candles.length ? c.candles[c.candles.length - 1][0] : 0;
    const inView = (ms) => ms >= first && ms <= last;
    const trades = focus && focus.trade ? [focus.trade] : c.trades;

    // 標記：進場箭頭、出場圓點
    const markers = [];
    for (const t of trades) {
      const long = t.side === "LONG";
      const plan = tradePlan(t);
      if (inView(t.entry_ms)) markers.push({
        time: toTime(t.entry_ms), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown",
        color: long ? "#0ecb81" : "#f6465d", text: `開${long ? "多" : "空"} ${plan ? plan.leverage + "x" : ""}`,
      });
      if (!t.open && inView(t.exit_ms)) {
        const p = plan ? pnl(plan, (long ? 1 : -1) * (t.exit_price - t.entry_price) / t.entry_price) : 0;
        markers.push({
          time: toTime(t.exit_ms), position: long ? "aboveBar" : "belowBar", shape: "circle",
          color: p > 0 ? "#0ecb81" : "#f6465d", text: `${t.exit_reason} ${fmtU(p)}`,
        });
      }
    }
    if (focus && focus.pendingMs) markers.push({
      time: toTime(focus.pendingMs), position: focus.long ? "belowBar" : "aboveBar", shape: focus.long ? "arrowUp" : "arrowDown",
      color: "#3d7bd9", text: focus.text,
    });
    candleSeries.setMarkers(markers.sort((a, b) => a.time - b.time));

    // 移動止損（每根一段階梯）；單獨看一筆時再畫止損、止盈
    levelSeries.forEach((s) => chart.removeSeries(s));
    levelSeries = [];
    for (const t of trades) {
      if (t.trail_path) {
        // 每根的止損畫成一階；最後多一個點讓最後一階有寬度。持倉中再加上下一根的價位
        const steps = t.trail_path.concat(t.open && t.trail_stop !== null ? [t.trail_stop] : []);
        const pts = steps.map((v, i) => ({ time: toTime(t.entry_ms + i * bar), value: v }));
        pts.push({ time: toTime(t.entry_ms + steps.length * bar), value: steps[steps.length - 1] });
        addLevel("trail", pts.filter((p) => p.time >= toTime(first) && p.time <= toTime(last + bar)));
      }
      if (focus && focus.trade) {
        const from = toTime(Math.max(t.entry_ms, first));
        const to = toTime(Math.min(t.exit_ms + bar, last));
        if (t.stop !== null) addLevel("stop", [{ time: from, value: t.stop }, { time: to, value: t.stop }]);
        if (t.target !== null) addLevel("target", [{ time: from, value: t.target }, { time: to, value: t.target }]);
      }
    }

    // 畫面範圍
    if (focus && (focus.trade || focus.pendingMs)) {
      const from = focus.trade ? focus.trade.entry_ms : focus.pendingMs;
      const to = focus.trade ? focus.trade.exit_ms : focus.pendingMs;
      chart.timeScale().setVisibleRange({ from: toTime(Math.max(first, from - 25 * bar)), to: toTime(Math.min(last, to + 25 * bar)) });
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, c.candles.length - 150), to: c.candles.length + 3 });
    }
    $("show-all").classList.toggle("hidden", !focus);

    // 策略與統計（金額依帳戶餘額等比例換算：每筆風險 = 餘額 × 風險 %）
    const scale = rule.balance / DATA.rule.balance;
    $("strategy").textContent = `策略：${c.name}`;
    $("stats").innerHTML = `3 年回測：已平倉 ${c.trades_closed} 筆｜勝率 ${c.win_rate === null ? "-" : Math.round(c.win_rate * 100) + "%"}` +
      `｜照目前規則 <span class="${c.rule_total > 0 ? "up" : "down"}">${fmtU(c.rule_total * scale)}</span>（回撤 ${fmtU(c.rule_drawdown * scale)}，不複利）` +
      `｜策略原設定 ${fmtPct(c.backtest_pct, 1)}`;
    $("rules").textContent = c.rules;
  }

  function focusAlert(id) {
    const a = DATA.alerts.find((x) => x.id === id);
    if (!a) return;
    const pair = `${a.symbol} ${a.interval}`;
    const c = DATA.charts[pair];
    if (!c) return;
    const bar = c.candles.length > 1 ? c.candles[1][0] - c.candles[0][0] : 0;
    if (a.action === "open" && a.pending) {
      drawPair(pair, { pendingMs: a.time_ms - bar, long: a.side === "LONG", text: `下一根開盤開${a.side === "LONG" ? "多" : "空"}` });
      return;
    }
    const entry = a.action === "open" ? a.time_ms : a.entry_time_ms;
    const trade = c.trades.find((t) => t.side === a.side && t.entry_ms === entry);
    drawPair(pair, trade ? { trade } : null);
    window.scrollTo({ top: $("chart-section").offsetTop - 8, behavior: "smooth" });
  }

  // ---------- 初始化 ----------
  function init() {
    rule = { ...DATA.rule };
    $("updated").textContent = `更新：${fmtTime(DATA.generated_ms)}（每根 4h 收盤後更新｜行情：${DATA.source || "幣安"}）`;
    $("scope").textContent = DATA.scope + (DATA.skipped.length ? `｜沒有可用策略、不提醒：${DATA.skipped.join(", ")}` : "");
    const input = $("balance");
    // 網址參數：?balance=1234 只套用這次（不存）；#alert=<id> 直接打開某則提醒
    const urlBalance = parseFloat(new URLSearchParams(location.search).get("balance"));
    rule.balance = urlBalance > 0 ? urlBalance : loadBalance();
    input.value = rule.balance;
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!(v > 0)) return;
      rule.balance = v;
      saveBalance(v);
      renderAlerts();
      if (currentPair) drawPair(currentPair, null);
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
      $("holding").classList.toggle("hidden", b.dataset.tab !== "holding");
      $("history").classList.toggle("hidden", b.dataset.tab !== "history");
    }));
    $("pending-section").classList.toggle("hidden", !DATA.alerts.some((a) => a.pending));

    const select = $("pair");
    for (const pair of Object.keys(DATA.charts)) select.add(new Option(pair, pair));
    select.addEventListener("change", () => drawPair(select.value, null));
    $("show-all").addEventListener("click", () => drawPair(currentPair, null));
    if (window.SAINT_ENCRYPTED) {
      $("logout").classList.remove("hidden");
      $("logout").addEventListener("click", () => { forgetPassword(); location.reload(); });
    }

    renderAlerts();
    if (window.LightweightCharts) {
      initChart();
      const pairs = Object.keys(DATA.charts);
      if (pairs.length) drawPair(pairs[0], null);
      if (location.hash.startsWith("#alert=")) focusAlert(decodeURIComponent(location.hash.slice(7)));
    } else {
      $("chart").innerHTML = '<p class="dim">圖表載入失敗（需要網路連線到 unpkg.com）。提醒內容不受影響。</p>';
    }
  }

  // ---------- 密碼解鎖 ----------
  // data.js 是 window.SAINT_ENCRYPTED 時：AES-256-GCM 加密，金鑰 = PBKDF2-SHA256(密碼, salt, iterations)
  // （由 web/export.py 的 encrypt_payload 產生）。密碼錯時 AES-GCM 驗證會失敗。
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function decrypt(enc, password) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: fromB64(enc.salt), iterations: enc.iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(enc.iv) }, key, fromB64(enc.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function savedPassword() { try { return localStorage.getItem(PASSWORD_KEY); } catch (e) { return null; } }
  function rememberPassword(pw) { try { localStorage.setItem(PASSWORD_KEY, pw); } catch (e) { /* 忽略 */ } }
  function forgetPassword() { try { localStorage.removeItem(PASSWORD_KEY); } catch (e) { /* 忽略 */ } }

  function unlocked(data) {
    DATA = data;
    document.body.classList.remove("locked");
    $("lock").classList.add("hidden");
    init();
  }

  async function showLock(enc) {
    document.body.classList.add("locked");
    $("lock").classList.remove("hidden");
    if (!(window.crypto && crypto.subtle)) {
      $("lock-error").textContent = "這個瀏覽器不支援解密（需要 https 或較新的瀏覽器）";
      return;
    }
    const saved = savedPassword();
    if (saved) {
      $("lock-error").textContent = "解鎖中…";
      try { unlocked(await decrypt(enc, saved)); return; } catch (e) { forgetPassword(); $("lock-error").textContent = ""; }
    }
    $("lock-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const pw = $("lock-password").value;
      if (!pw) return;
      $("lock-error").textContent = "解鎖中…";
      try {
        const data = await decrypt(enc, pw);
        if ($("lock-remember").checked) rememberPassword(pw);
        unlocked(data);
      } catch (e) {
        $("lock-error").textContent = "密碼錯誤";
        $("lock-password").select();
      }
    });
    $("lock-password").focus();
  }

  function boot() {
    if (window.SAINT_DATA) { DATA = window.SAINT_DATA; init(); return; }
    if (window.SAINT_ENCRYPTED) { showLock(window.SAINT_ENCRYPTED); return; }
    document.body.innerHTML = '<p style="padding:16px">找不到提醒資料（data.js）。</p>';
  }

  window.SaintTrading = { planOrder, allocate, priceDecimals }; // 測試 / 除錯用
  boot();
})();
