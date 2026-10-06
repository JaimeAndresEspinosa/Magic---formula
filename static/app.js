"use strict";

const POLL_MS = 10000;
const UNIVERSE_ORDER = ["sp500", "ndx", "ibex", "sx5e"];
const CUR_SYM = { USD: "$", EUR: "€", GBP: "£", CHF: "CHF", DKK: "kr" };

const $ = (s) => document.querySelector(s);
const state = {
  universe: "sp500",
  data: null,
  ranked: [],
  excluded: [],
  sort: { k: "mf", dir: "asc" },
  lastPrices: new Map(),
  drawerSym: null,
  range: "1y",
  history: [],
};

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

// ------------------------------------------------------------------ formato
const nf = (min, max) => new Intl.NumberFormat("es-ES", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: "always" });
const NF0 = nf(0, 0), NF1 = nf(1, 1), NF2 = nf(2, 2);
const sym = (c) => CUR_SYM[c] ?? c ?? "";

function fmtPrice(v, cur) {
  if (v == null) return "—";
  return `${(v >= 1000 ? NF2 : v < 1 ? nf(2, 4) : NF2).format(v)} ${sym(cur)}`;
}
function fmtBig(v, cur) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(a >= 1e11 ? NF0 : NF1).format(v / 1e9)} mil M${sym(cur)}`;
  if (a >= 1e6) return `${NF0.format(v / 1e6)} M${sym(cur)}`;
  return `${NF0.format(v)} ${sym(cur)}`;
}
function fmtPct(v, signed = false, d = 1) {
  if (v == null || !isFinite(v)) return "—";
  const s = nf(d, d).format(v * 100) + " %";
  return signed && v > 0 ? "+" + s : s;
}
function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const median = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ------------------------------------------------------------------ ranking
const withGoodwill = () => $("#f-roc").value === "gw";

function rank(rows) {
  const minCap = +$("#f-mcap").value;
  const gw = withGoodwill();
  const elig = [], excl = [];
  for (const src of rows) {
    // rocx = ROC usado en el ranking según el método elegido
    const r = { ...src, rocx: gw ? src.roc_gw : src.roc };
    if (!r.eligible) excl.push(r);
    else if (gw && r.rocx == null) excl.push({ ...r, reason: "Fondo de comercio no disponible" });
    else if ((r.mcap_usd ?? 0) < minCap) excl.push({ ...r, reason: "Capitalización inferior al mínimo" });
    else elig.push(r);
  }
  [...elig].sort((a, b) => b.ey - a.ey).forEach((r, i) => (r.r_ey = i + 1));
  [...elig].sort((a, b) => b.rocx - a.rocx).forEach((r, i) => (r.r_roc = i + 1));
  elig.forEach((r) => (r.score = r.r_ey + r.r_roc));
  elig.sort((a, b) => a.score - b.score || b.ey - a.ey).forEach((r, i) => (r.mf = i + 1));
  state.ranked = elig;
  state.excluded = excl;
}

function visibleRows() {
  const sector = $("#f-sector").value;
  const q = $("#f-search").value.trim().toLowerCase();
  const top = +$("#f-top").value;
  const match = (r) => (!sector || r.sector_es === sector) &&
    (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));

  let rows = state.ranked.filter(match);
  if (top && !q) rows = rows.slice(0, top);
  if ($("#f-excluded").checked) rows = rows.concat(state.excluded.filter(match));

  const { k, dir } = state.sort;
  const m = dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * m;
  });
}

// ------------------------------------------------------------------ render: ranking
function renderTabs(status) {
  const box = $("#universe-tabs");
  box.innerHTML = UNIVERSE_ORDER.filter((k) => status.universes[k]).map((k) => {
    const u = status.universes[k];
    return `<button role="tab" data-u="${k}" class="${k === state.universe ? "active" : ""}">${esc(u.name)}<small>${u.count}</small></button>`;
  }).join("");
}

function renderKpis() {
  const d = state.data;
  const top = +$("#f-top").value || state.ranked.length;
  const head = state.ranked.slice(0, top);
  const n = head.length;
  $("#kpis").innerHTML = [
    ["Empresas en el ranking", `${state.ranked.length}`, `de ${d.total} en el ${esc(d.name)}`],
    [`EY mediano · Top ${n}`, fmtPct(median(head.map((r) => r.ey))), `Índice completo: ${fmtPct(median(state.ranked.map((r) => r.ey)))}`],
    [`ROC${withGoodwill() ? " c/ FdC" : ""} mediano · Top ${n}`, fmtPct(median(head.map((r) => r.rocx)), false, 0), `Índice completo: ${fmtPct(median(state.ranked.map((r) => r.rocx)), false, 0)}`],
    ["Última cotización", fmtTime(d.last_price_update), anyOpen(d.market_open) ? "Mercado abierto · se actualiza cada ~1 min" : "Mercado cerrado · último cierre"],
  ].map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join("");
}

const anyOpen = (mo) => mo && (mo.us || mo.eu);

// La barra se satura en `max` (ROC muy altos no deben aplastar al resto)
function metricCell(v, max, digits) {
  const w = v == null ? 0 : Math.max(0, Math.min(1, v / max)) * 100;
  return `<span class="metric">${fmtPct(v, false, digits)}<span class="bar"><span style="width:${w}%"></span></span></span>`;
}

function renderTable() {
  const rows = visibleRows();
  const body = $("#grid-body");
  const maxEy = Math.max(0.0001, ...state.ranked.slice(0, 50).map((r) => r.ey));
  const maxRoc = Math.max(0.0001, ...state.ranked.slice(0, 50).map((r) => Math.min(r.rocx, 3)));

  if (!rows.length) {
    const loading = !state.data || state.data.rows.length === 0;
    body.innerHTML = loading ? skeletonRows() :
      `<tr><td colspan="11" class="empty">No hay empresas que cumplan los filtros.</td></tr>`;
  } else {
    body.innerHTML = rows.map((r) => {
      const prev = state.lastPrices.get(r.symbol);
      const flash = prev != null && r.price != null && prev !== r.price ? (r.price > prev ? "flash-up" : "flash-down") : "";
      const chg = r.change_pct;
      return `<tr data-s="${esc(r.symbol)}" class="${r.mf ? "" : "excluded"}" ${r.mf ? "" : `title="${esc(r.reason)}"`}>
        <td class="num">${r.mf ? `<span class="rank ${r.mf <= 10 ? "top" : ""}">${r.mf}</span>` : `<span class="pill">—</span>`}</td>
        <td><div class="co"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span></div></td>
        <td class="hide-sm"><span class="pill">${esc(r.sector_es)}</span></td>
        <td class="num ${flash}">${fmtPrice(r.price, r.currency)}</td>
        <td class="num ${chg > 0 ? "pos" : chg < 0 ? "neg" : ""}">${fmtPct(chg, true, 2)}</td>
        <td class="num hide-sm">${fmtBig(r.mcap, r.currency)}</td>
        <td class="num">${r.mf ? metricCell(r.ey, maxEy, 1) : fmtPct(r.ey)}</td>
        <td class="num">${r.mf ? metricCell(r.rocx, maxRoc, 0) : fmtPct(r.rocx, false, 0)}</td>
        <td class="num hide-sm">${r.r_ey ?? "—"}</td>
        <td class="num hide-sm">${r.r_roc ?? "—"}</td>
        <td class="num"><b>${r.score ?? "—"}</b></td>
      </tr>`;
    }).join("");
  }

  for (const r of state.data?.rows ?? []) if (r.price != null) state.lastPrices.set(r.symbol, r.price);

  document.querySelectorAll("#grid th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === state.sort.k);
    th.classList.toggle("desc", th.dataset.k === state.sort.k && state.sort.dir === "desc");
  });

  $("#roc-head").textContent = withGoodwill() ? "ROC c/ FdC" : "ROC";
  $("#excluded-count").textContent = state.excluded.length ? `(${state.excluded.length})` : "";

  const d = state.data;
  const pending = d ? d.total - d.rows.length : 0;
  $("#table-foot").innerHTML = d
    ? `${rows.length} filas · ${state.excluded.length} excluidas (financieras, utilities, inmobiliarias, EBIT ≤ 0 o bajo el mínimo)` +
      (pending > 0 ? ` · ${pending} empresas pendientes de descargar` : "") +
      ` · Haz clic en una fila para ver el detalle`
    : "";
}

function skeletonRows() {
  return Array.from({ length: 8 }, () =>
    `<tr class="skeleton">${Array.from({ length: 11 }, (_, i) => `<td class="${i > 2 ? "num" : ""}"><span style="width:${40 + ((i * 37) % 50)}%"></span></td>`).join("")}</tr>`
  ).join("");
}

function renderSectors() {
  const sel = $("#f-sector");
  const cur = sel.value;
  const sectors = [...new Set(state.ranked.map((r) => r.sector_es))].sort((a, b) => a.localeCompare(b, "es"));
  sel.innerHTML = `<option value="">Todos</option>` + sectors.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
}

// ------------------------------------------------------------------ render: cartera
function portfolio() {
  const n = +$("#p-n").value;
  const amount = Math.max(0, +$("#p-amount").value || 0);
  const frac = $("#p-fractional").checked;
  const picks = state.ranked.slice(0, n).filter((r) => r.price);
  const target = picks.length ? amount / picks.length : 0;
  return picks.map((r) => {
    const shares = frac ? target / r.price : Math.floor(target / r.price);
    return { ...r, target, shares, invested: shares * r.price };
  });
}

function renderPortfolio() {
  if (!state.data) return;
  const rows = portfolio();
  const amount = +$("#p-amount").value || 0;
  const cur = state.data.currency;
  const invested = rows.reduce((s, r) => s + r.invested, 0);
  const frac = $("#p-fractional").checked;

  $("#p-kpis").innerHTML = [
    ["Posiciones", rows.length, `Universo: ${esc(state.data.name)}`],
    ["Invertido", fmtBig(invested, cur), amount - invested > amount * 0.1 && !frac
      ? `Quedan ${fmtBig(amount - invested, cur)} sin invertir: sube el importe o activa fracciones`
      : `Liquidez restante: ${fmtBig(amount - invested, cur)}`],
    ["EY medio cartera", fmtPct(median(rows.map((r) => r.ey))), "Mediana de las posiciones"],
    ["ROC medio cartera", fmtPct(median(rows.map((r) => r.rocx)), false, 0), withGoodwill() ? "Incluyendo fondo de comercio" : "Mediana de las posiciones"],
  ].map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join("");

  $("#p-body").innerHTML = rows.length ? rows.map((r) => `
    <tr data-s="${esc(r.symbol)}">
      <td class="num"><span class="rank ${r.mf <= 10 ? "top" : ""}">${r.mf}</span></td>
      <td><div class="co"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span></div></td>
      <td class="num">${fmtPrice(r.price, r.currency)}</td>
      <td class="num">${fmtPct(amount ? r.invested / amount : 0)}</td>
      <td class="num">${frac ? nf(0, 3).format(r.shares) : NF0.format(r.shares)}</td>
      <td class="num">${fmtPrice(r.invested, r.currency)}</td>
      <td class="num hide-sm">${fmtPct(r.ey)}</td>
      <td class="num hide-sm">${fmtPct(r.rocx, false, 0)}</td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">Aún no hay datos suficientes para este universo.</td></tr>`;

  const bySector = {};
  rows.forEach((r) => (bySector[r.sector_es] = (bySector[r.sector_es] || 0) + 1));
  const list = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  $("#p-sectors").innerHTML = list.map(([s, c]) => `
    <div class="row"><span>${esc(s)}</span><b>${c} · ${fmtPct(c / rows.length, false, 0)}</b>
    <div class="track"><span style="width:${(c / rows.length) * 100}%"></span></div></div>`).join("") ||
    `<p class="note">Sin posiciones.</p>`;
}

// ------------------------------------------------------------------ CSV
function downloadCsv(name, header, lines) {
  const csv = [header, ...lines].map((l) => l.map((v) => {
    const s = v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

function exportRanking() {
  const rows = visibleRows();
  downloadCsv(`magic-formula_${state.universe}_${today()}.csv`,
    ["Rank MF", "Ticker", "Empresa", "Sector", "Divisa", "Precio", "Var. dia", "Cap. bursatil", "EV", "EBIT", "Earnings Yield", "ROC Greenblatt", "ROC incl. fondo de comercio", "Rank EY", "Rank ROC", "Puntos", "Motivo exclusion"],
    rows.map((r) => [r.mf, r.symbol, r.name, r.sector_es, r.currency, r.price, r.change_pct, r.mcap, r.ev, r.ebit, r.ey, r.roc, r.roc_gw, r.r_ey, r.r_roc, r.score, r.mf ? "" : r.reason]));
}
function exportPortfolio() {
  downloadCsv(`cartera-magic-formula_${state.universe}_${today()}.csv`,
    ["Rank MF", "Ticker", "Empresa", "Sector", "Divisa", "Precio", "Acciones", "Importe", "Earnings Yield", "ROC Greenblatt", "ROC incl. fondo de comercio"],
    portfolio().map((r) => [r.mf, r.symbol, r.name, r.sector_es, r.currency, r.price, r.shares, r.invested, r.ey, r.roc, r.roc_gw]));
}

// ------------------------------------------------------------------ detalle
async function openDrawer(symbol) {
  state.drawerSym = symbol;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
  const fromRank = findRow(symbol);
  if (fromRank) fillDrawer(fromRank);
  loadHistory();
  try {
    const r = await fetch(`/api/stock/${encodeURIComponent(symbol)}`).then((x) => x.json());
    if (state.drawerSym === symbol) fillDrawer({ ...r, ...(findRow(symbol) || {}) , summary: r.summary, website: r.website, exchange: r.exchange, long_name: r.long_name });
  } catch { /* se mantiene lo que hay */ }
}

function closeDrawer() {
  state.drawerSym = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
}

const findRow = (s) => state.ranked.find((r) => r.symbol === s) || state.excluded.find((r) => r.symbol === s);

function fillDrawer(r) {
  const fc = r.fin_currency, cur = r.currency;
  $("#d-ticker").textContent = r.symbol;
  $("#d-name").textContent = r.long_name || r.name;
  $("#d-meta").textContent = [r.sector_es, r.industry, r.country, r.exchange].filter(Boolean).join(" · ");
  $("#d-price").textContent = fmtPrice(r.price, cur);
  const chg = r.change_pct;
  $("#d-change").className = chg > 0 ? "pos" : chg < 0 ? "neg" : "";
  $("#d-change").textContent = chg == null ? "" : `${fmtPct(chg, true, 2)} hoy`;

  $("#d-ranks").innerHTML = r.mf
    ? `<div><small>Puesto Magic Formula</small><b>${r.mf}</b></div><div><small>Rank EY</small><b>${r.r_ey}</b></div><div><small>Rank ROC</small><b>${r.r_roc}</b></div>`
    : `<div style="grid-column:1/-1"><small>Fuera del ranking</small><b style="font-size:14px">${esc(r.reason)}</b></div>`;

  const row = (op, label, v) => `<tr><td class="op">${op}</td><td>${label}</td><td>${v}</td></tr>`;
  const mcapFin = r.ev != null ? r.ev - r.total_debt - r.minority - r.preferred + r.cash : null;
  $("#d-ey").innerHTML =
    row("", `Capitalización${fc !== cur ? ` (en ${fc})` : ""}`, fmtBig(mcapFin, fc)) +
    row("+", "Deuda total", fmtBig(r.total_debt, fc)) +
    (r.minority ? row("+", "Minoritarios", fmtBig(r.minority, fc)) : "") +
    (r.preferred ? row("+", "Preferentes", fmtBig(r.preferred, fc)) : "") +
    row("−", "Caja e inversiones c/p", fmtBig(r.cash, fc)) +
    `<tr class="total"><td class="op">=</td><td>Enterprise Value</td><td>${fmtBig(r.ev, fc)}</td></tr>` +
    row("", "EBIT", fmtBig(r.ebit, fc)) +
    `<tr class="total"><td class="op"></td><td>Earnings Yield</td><td>${fmtPct(r.ey, false, 2)}</td></tr>`;

  $("#d-roc").innerHTML =
    row("", "Activo corriente − caja", fmtBig(r.current_assets != null ? r.current_assets - r.cash : null, fc)) +
    row("−", "Pasivo corriente − deuda c/p", fmtBig(r.current_liabilities != null ? r.current_liabilities - r.current_debt : null, fc)) +
    `<tr class="total"><td class="op">=</td><td>Capital circulante neto${r.nwc < 0 ? " (se toma 0)" : ""}</td><td>${fmtBig(r.nwc, fc)}</td></tr>` +
    row("+", "Inmovilizado material neto", fmtBig(r.net_ppe, fc)) +
    `<tr class="total"><td class="op">=</td><td>Capital invertido</td><td>${fmtBig(r.capital, fc)}</td></tr>` +
    row("", "EBIT", fmtBig(r.ebit, fc)) +
    `<tr class="total"><td class="op"></td><td>Return on Capital (Greenblatt)</td><td>${fmtPct(r.roc, false, 1)}</td></tr>` +
    `<tr><td class="op"></td><td colspan="2" class="sub-head">Variante con fondo de comercio</td></tr>` +
    row("", "Capital invertido", fmtBig(r.capital, fc)) +
    row("+", "Fondo de comercio e intangibles", fmtBig(r.goodwill, fc)) +
    `<tr class="total"><td class="op">=</td><td>Capital incl. fondo de comercio</td><td>${fmtBig(r.capital_gw, fc)}</td></tr>` +
    `<tr class="total"><td class="op"></td><td>ROC incl. fondo de comercio</td><td>${fmtPct(r.roc_gw, false, 1)}</td></tr>`;

  $("#d-source").textContent = `EBIT: ${r.ebit_source || "—"}${r.period ? ` · último periodo ${r.period}` : ""}` +
    (fc !== cur ? ` · cotiza en ${cur}, reporta en ${fc} (convertido al tipo actual)` : "") +
    (r.debt_source && r.debt_source !== "balance" ? ` · deuda: ${r.debt_source}` : "") +
    (r.price_ts ? ` · Precio actualizado ${fmtTime(r.price_ts)}` : " · Precio de referencia, pendiente de actualizar");
  if (r.summary !== undefined) $("#d-summary").textContent = r.summary || "Sin descripción disponible.";
  $("#d-yahoo").href = `https://finance.yahoo.com/quote/${encodeURIComponent(r.symbol)}`;
}

async function loadHistory() {
  const symbol = state.drawerSym, range = state.range;
  const box = $("#d-chart");
  box.innerHTML = `<div class="msg">Cargando gráfico…</div>`;
  try {
    const pts = await fetch(`/api/history/${encodeURIComponent(symbol)}?range=${range}`).then((x) => x.json());
    if (state.drawerSym !== symbol || state.range !== range) return;
    state.history = pts;
    drawChart();
  } catch {
    box.innerHTML = `<div class="msg">No se pudo cargar el histórico.</div>`;
  }
}

function drawChart() {
  const box = $("#d-chart");
  const pts = state.history;
  if (!pts || pts.length < 2) { box.innerHTML = `<div class="msg">Sin datos para este periodo.</div>`; return; }
  const row = findRow(state.drawerSym);
  const cur = row?.currency;
  const W = box.clientWidth, H = box.clientHeight, padL = 4, padR = 58, padT = 8, padB = 22;
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.c);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad; hi += pad;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? "var(--up)" : "var(--down)";

  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    grid += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="axis-label" x="${W - padR + 8}" y="${y(v) + 3.5}">${NF2.format(v)}</text>`;
  }
  const intraday = state.range === "1d" || state.range === "5d";
  const dfmt = (t) => new Date(t * 1000).toLocaleDateString("es-ES",
    state.range === "1d" ? { hour: "2-digit", minute: "2-digit" } :
    state.range === "5d" ? { weekday: "short", day: "numeric" } :
    state.range === "5y" ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" });
  let xl = "";
  for (let i = 0; i < 4; i++) {
    const idx = Math.round((i / 3) * (pts.length - 1));
    const anchor = i === 0 ? "start" : i === 3 ? "end" : "middle";
    xl += `<text class="axis-label" text-anchor="${anchor}" x="${i === 3 ? W - padR : x(idx)}" y="${H - 5}">${dfmt(xs[idx])}</text>`;
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join("");
  const area = `${d}L${x(pts.length - 1)},${H - padB}L${x(0)},${H - padB}Z`;

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del precio">
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${xl}
    <path d="${area}" fill="url(#g)"/>
    <path class="line" d="${d}" stroke="${color}"/>
    <g id="hover" style="display:none">
      <line class="cross" id="hx" y1="${padT}" y2="${H - padB}"/>
      <circle class="dot" id="hd" r="4.5" fill="${color}"/>
    </g>
    <rect x="0" y="0" width="${W - padR}" height="${H}" fill="transparent" id="hit"/>
  </svg>`;

  const tip = $("#tooltip"), hov = box.querySelector("#hover");
  const move = (ev) => {
    const e = ev.touches ? ev.touches[0] : ev;
    const rect = box.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - padL) / (W - padL - padR)) * (pts.length - 1))));
    const cx = x(i), cy = y(pts[i].c);
    hov.style.display = "";
    box.querySelector("#hx").setAttribute("x1", cx);
    box.querySelector("#hx").setAttribute("x2", cx);
    box.querySelector("#hd").setAttribute("cx", cx);
    box.querySelector("#hd").setAttribute("cy", cy);
    const when = new Date(pts[i].t * 1000).toLocaleString("es-ES", intraday
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric" });
    const chg = pts[i].c / pts[0].c - 1;
    tip.innerHTML = `${when} · <b>${fmtPrice(pts[i].c, cur)}</b> · ${fmtPct(chg, true, 1)}`;
    tip.hidden = false;
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + cx - tip.offsetWidth / 2);
    tip.style.left = `${Math.max(8, tx)}px`;
    tip.style.top = `${rect.top + cy - 40}px`;
  };
  const leave = () => { hov.style.display = "none"; tip.hidden = true; };
  const hit = box.querySelector("#hit");
  hit.addEventListener("mousemove", move);
  hit.addEventListener("touchmove", move, { passive: true });
  hit.addEventListener("mouseleave", leave);
  hit.addEventListener("touchend", leave);
}

// ------------------------------------------------------------------ datos
async function poll() {
  try {
    const [status, data] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch(`/api/ranking/${state.universe}`).then((r) => r.json()),
    ]);
    renderStatus(status);
    if (data.universe === state.universe) {
      state.data = data;
      refresh();
    }
  } catch {
    $("#live").className = "live err";
    $("#live-text").textContent = "Sin conexión con el servidor";
  }
}

function renderStatus(s) {
  renderTabs(s);
  $("#mkt-us").classList.toggle("open", !!s.market_open.us);
  $("#mkt-eu").classList.toggle("open", !!s.market_open.eu);
  $("#mkt-us").title = s.market_open.us ? "NYSE / Nasdaq abiertos" : "NYSE / Nasdaq cerrados";
  $("#mkt-eu").title = s.market_open.eu ? "Bolsas europeas abiertas" : "Bolsas europeas cerradas";
  const age = s.last_price_update ? s.server_time - s.last_price_update : null;
  const live = $("#live");
  if (age == null) { live.className = "live stale"; $("#live-text").textContent = "Cargando precios…"; }
  else {
    live.className = age > 400 ? "live stale" : "live";
    $("#live-text").textContent = anyOpen(s.market_open) ? `En vivo · ${fmtTime(s.last_price_update)}` : `Cierre · ${fmtTime(s.last_price_update)}`;
  }
  const f = s.fundamentals;
  const showProg = f.running && f.total;
  $("#progress").hidden = !showProg;
  if (showProg) {
    $("#progress-fill").style.width = `${(f.done / f.total) * 100}%`;
    $("#progress-text").textContent = `Descargando estados financieros · ${f.done}/${f.total}`;
  }
}

function refresh() {
  if (!state.data) return;
  rank(state.data.rows);
  renderSectors();
  renderKpis();
  renderTable();
  renderPortfolio();
  if (state.drawerSym) {
    const r = findRow(state.drawerSym);
    if (r) {
      $("#d-price").textContent = fmtPrice(r.price, r.currency);
      const c = r.change_pct;
      $("#d-change").className = c > 0 ? "pos" : c < 0 ? "neg" : "";
      $("#d-change").textContent = c == null ? "" : `${fmtPct(c, true, 2)} hoy`;
    }
  }
}

// ------------------------------------------------------------------ navegación y eventos
function showView() {
  const v = (location.hash || "#ranking").slice(1);
  const view = ["ranking", "cartera", "metodologia"].includes(v) ? v : "ranking";
  document.querySelectorAll(".view").forEach((el) => (el.hidden = el.id !== `view-${view}`));
  document.querySelectorAll(".mainnav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  $(".universe-bar").hidden = view === "metodologia";
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("mf-theme", t);
  if (state.drawerSym && state.history.length) drawChart();
}

function init() {
  const saved = store.get("mf-theme", null);
  setTheme(saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  state.universe = store.get("mf-universe", "sp500");
  for (const id of ["f-mcap", "f-top", "f-roc"]) {
    const v = store.get(`mf-${id}`, null);
    if (v != null && [...$(`#${id}`).options].some((o) => o.value === v)) $(`#${id}`).value = v;
  }
  $("#grid-body").innerHTML = skeletonRows();

  $("#theme-btn").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("#universe-tabs").onclick = (e) => {
    const b = e.target.closest("button[data-u]");
    if (!b || b.dataset.u === state.universe) return;
    state.universe = b.dataset.u;
    store.set("mf-universe", state.universe);
    state.data = null;
    state.ranked = state.excluded = [];
    $("#f-sector").value = "";
    $("#grid-body").innerHTML = skeletonRows();
    document.querySelectorAll("#universe-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    poll();
  };
  for (const id of ["f-mcap", "f-top", "f-roc"]) {
    $(`#${id}`).onchange = () => { store.set(`mf-${id}`, $(`#${id}`).value); refresh(); };
  }
  $("#f-sector").onchange = renderTable;
  $("#f-excluded").onchange = renderTable;
  $("#f-search").oninput = renderTable;
  $("#grid thead").onclick = (e) => {
    const th = e.target.closest("th");
    if (!th) return;
    const k = th.dataset.k;
    const ascDefault = ["mf", "symbol", "sector_es", "r_ey", "r_roc", "score"].includes(k);
    state.sort = state.sort.k === k
      ? { k, dir: state.sort.dir === "asc" ? "desc" : "asc" }
      : { k, dir: ascDefault ? "asc" : "desc" };
    renderTable();
  };
  const rowClick = (e) => { const tr = e.target.closest("tr[data-s]"); if (tr) openDrawer(tr.dataset.s); };
  $("#grid-body").onclick = rowClick;
  $("#p-body").onclick = rowClick;
  $("#export-btn").onclick = exportRanking;
  $("#p-export").onclick = exportPortfolio;
  for (const id of ["p-amount", "p-n", "p-fractional"]) $(`#${id}`).addEventListener("input", renderPortfolio);
  $("#d-close").onclick = closeDrawer;
  $("#scrim").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#d-ranges").onclick = (e) => {
    const b = e.target.closest("button[data-r]");
    if (!b) return;
    state.range = b.dataset.r;
    document.querySelectorAll("#d-ranges button").forEach((x) => x.classList.toggle("active", x === b));
    loadHistory();
  };
  window.addEventListener("resize", () => { if (state.drawerSym && state.history.length) drawChart(); });
  window.addEventListener("hashchange", showView);
  showView();
  poll();
  setInterval(poll, POLL_MS);
}

init();
