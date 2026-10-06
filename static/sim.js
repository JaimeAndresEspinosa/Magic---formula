"use strict";
// Cartera simulada: se guarda en el navegador (y en un enlace compartible) y se
// valora con el histórico de cierres + el precio en vivo, frente al índice.

const SIM_KEY = "mf-sims";
const sim = { list: [], activeId: null, hist: new Map(), live: new Map(), loading: false };

const loadSims = () => { try { return JSON.parse(store.get(SIM_KEY, "[]")) || []; } catch { return []; } };
const saveSims = () => store.set(SIM_KEY, JSON.stringify(sim.list));
const activeSim = () => sim.list.find((s) => s.id === sim.activeId) || sim.list[sim.list.length - 1] || null;
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => new Date(d).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

function encodeSim(s) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(s)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeSim(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(s + "===".slice((s.length + 3) % 4)))));
}

// ------------------------------------------------------------------ crear
function createSim() {
  const d = state.data;
  const n = +$("#s-n").value;
  const amount = Math.max(100, +$("#s-amount").value || 10000);
  const picks = state.ranked.slice(0, n).filter((r) => r.price);
  if (!d || picks.length < Math.min(n, 5) || !d.benchmark?.price) {
    alert("Todavía no hay datos suficientes de este universo. Espera a que cargue el ranking y vuelve a intentarlo.");
    return;
  }
  const per = amount / picks.length;
  const s = {
    id: Date.now().toString(36),
    name: $("#s-name").value.trim() || `${d.name} · ${fmtDate(Date.now())}`,
    created: Math.floor(Date.now() / 1000),
    start: todayISO(),
    universe: d.universe, uname: d.name, cur: d.currency,
    roc: $("#f-roc").value, amount,
    bench: { s: d.benchmark.symbol, px: d.benchmark.price },
    pos: picks.map((r) => ({ s: r.symbol, n: r.name, px: r.price, sh: per / r.price })),
  };
  sim.list.push(s);
  sim.activeId = s.id;
  saveSims();
  $("#s-name").value = "";
  renderSim();
}

function deleteSim() {
  const s = activeSim();
  if (!s || !confirm(`¿Eliminar la simulación «${s.name}»? No se puede deshacer.`)) return;
  sim.list = sim.list.filter((x) => x.id !== s.id);
  sim.activeId = null;
  saveSims();
  renderSim();
}

async function copySimLink() {
  const s = activeSim();
  if (!s) return;
  const url = `${location.origin}/#sim=${encodeSim(s)}`;
  try {
    await navigator.clipboard.writeText(url);
    const b = $("#s-copy");
    const old = b.innerHTML;
    b.textContent = "¡Enlace copiado!";
    setTimeout(() => (b.innerHTML = old), 2000);
  } catch {
    prompt("Copia este enlace para abrir la simulación en otro dispositivo:", url);
  }
}

function importSimFromHash() {
  const m = location.hash.match(/^#sim=([\w-]+)/);
  if (!m) return false;
  try {
    const s = decodeSim(m[1]);
    if (s?.id && Array.isArray(s.pos)) {
      if (!sim.list.some((x) => x.id === s.id)) sim.list.push(s);
      sim.activeId = s.id;
      saveSims();
    }
  } catch { /* enlace dañado: se ignora */ }
  history.replaceState(null, "", "#simulacion");
  return true;
}

// ------------------------------------------------------------------ datos
async function ensureSimData(s) {
  // Precios en vivo del universo de la simulación
  if (state.data?.universe === s.universe) sim.live.set(s.universe, state.data);
  else if (!sim.live.has(s.universe) || Date.now() - sim.live.get(s.universe)._t > 30000) {
    const d = await fetch(`/api/ranking/${s.universe}`).then((r) => r.json());
    d._t = Date.now();
    sim.live.set(s.universe, d);
  }
  // Histórico de cierres desde el inicio
  const h = sim.hist.get(s.id);
  if (!h || Date.now() - h._t > 15 * 60000) {
    const syms = [...s.pos.map((p) => p.s), s.bench.s].join(",");
    const data = await fetch(`/api/sim-history?symbols=${encodeURIComponent(syms)}&start=${s.start}`).then((r) => r.json());
    data._t = Date.now();
    sim.hist.set(s.id, data);
  }
}

function valueSim(s) {
  const live = sim.live.get(s.universe);
  const px = new Map((live?.rows || []).map((r) => [r.symbol, r.price]));
  const benchLive = live?.benchmark?.price;
  const h = sim.hist.get(s.id) || { dates: [], closes: {} };
  const today = todayISO();

  const pts = [{ t: s.created * 1000, v: s.amount, b: 0 }];
  h.dates.forEach((d, i) => {
    if (d <= s.start || d >= today) return;
    let v = 0;
    for (const p of s.pos) v += p.sh * (h.closes[p.s]?.[i] ?? p.px);
    const bc = h.closes[s.bench.s]?.[i];
    pts.push({ t: Date.parse(d + "T21:00:00Z"), v, b: bc ? bc / s.bench.px - 1 : null });
  });

  const positions = s.pos.map((p) => {
    const now = px.get(p.s) ?? lastClose(h, p.s) ?? p.px;
    return { ...p, now, ret: now / p.px - 1, value: p.sh * now };
  });
  const value = positions.reduce((a, p) => a + p.value, 0);
  const bNow = benchLive ?? lastClose(h, s.bench.s) ?? s.bench.px;
  if (Date.now() / 1000 - s.created > 60) pts.push({ t: Date.now(), v: value, b: bNow / s.bench.px - 1 });
  pts.forEach((p) => (p.r = p.v / s.amount - 1));
  return { positions, value, ret: value / s.amount - 1, bret: bNow / s.bench.px - 1, pts };
}

function lastClose(h, sym) {
  const c = h.closes?.[sym];
  if (!c) return null;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] != null) return c[i];
  return null;
}

// ------------------------------------------------------------------ render
async function renderSim() {
  sim.list = loadSims();
  const d = state.data;
  $("#s-universe").textContent = d ? d.name : "—";
  $("#s-roc-note").textContent = $("#f-roc").value === "gw" ? "ROC incluyendo fondo de comercio" : "ROC de Greenblatt";
  $("#s-cur").textContent = d ? sym(d.currency) : "";

  const s = activeSim();
  $("#s-list").innerHTML = sim.list.map((x) =>
    `<button data-id="${esc(x.id)}" class="${x === s ? "active" : ""}">${esc(x.name)}</button>`).join("");
  $("#s-list-wrap").hidden = sim.list.length < 2;
  $("#s-detail").hidden = !s;
  $("#s-empty").hidden = !!s;
  if (!s) return;

  $("#s-title").textContent = s.name;
  const review = new Date(s.created * 1000);
  review.setFullYear(review.getFullYear() + 1);
  $("#s-meta").textContent = `${s.uname} · ${s.pos.length} empresas · creada el ${fmtDate(s.created * 1000)} · ` +
    `${s.roc === "gw" ? "ROC con fondo de comercio" : "ROC de Greenblatt"} · revisión según Greenblatt: ${fmtDate(review)}`;

  if (sim.loading) return;
  if (!sim.hist.has(s.id)) {
    $("#s-kpis").innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="label">Cargando precios desde el inicio de la simulación…</div></div>';
    $("#s-chart").innerHTML = '<div class="msg">Cargando gráfico…</div>';
  }
  sim.loading = true;
  try {
    await Promise.race([ensureSimData(s), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000))]);
  } catch { /* se pinta con lo que haya */ } finally {
    sim.loading = false;
  }
  if (activeSim() !== s) return;
  paintSim(s);
}

function paintSim(s) {
  const v = valueSim(s);
  const diff = v.ret - v.bret;
  const days = Math.floor((Date.now() / 1000 - s.created) / 86400);
  const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  $("#s-kpis").innerHTML = [
    ["Valor actual", fmtPrice(v.value, s.cur), `Inicial: ${fmtPrice(s.amount, s.cur)}`],
    ["Tu cartera", `<span class="${cls(v.ret)}">${fmtPct(v.ret, true, 2)}</span>`, `${days} ${days === 1 ? "día" : "días"} desde el inicio`],
    [`Índice (${esc(s.uname)})`, `<span class="${cls(v.bret)}">${fmtPct(v.bret, true, 2)}</span>`, "Mismo periodo, sin dividendos"],
    ["Diferencia", `<span class="${cls(diff)}">${fmtPct(diff, true, 2)}</span>`, diff >= 0 ? "Por encima del índice" : "Por debajo del índice"],
  ].map(([l, val, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${val}</div><div class="sub">${sub}</div></div>`).join("");

  const rows = [...v.positions].sort((a, b) => b.ret - a.ret);
  $("#s-body").innerHTML = rows.map((p) => `
    <tr data-s="${esc(p.s)}">
      <td><div class="co"><b>${esc(p.s)}</b><span>${esc(p.n)}</span></div></td>
      <td class="num">${fmtPrice(p.px, s.cur)}</td>
      <td class="num">${fmtPrice(p.now, s.cur)}</td>
      <td class="num ${cls(p.ret)}">${fmtPct(p.ret, true, 2)}</td>
      <td class="num hide-sm">${fmtPrice(p.value, s.cur)}</td>
    </tr>`).join("");

  drawSimChart(v.pts, s);
}

function drawSimChart(pts, s) {
  const box = $("#s-chart");
  if (pts.length < 2) {
    box.innerHTML = `<div class="msg">Acabas de crearla. Vuelve dentro de unos días para ver la evolución frente al índice.</div>`;
    return;
  }
  const W = box.clientWidth, H = box.clientHeight, padL = 4, padR = 64, padT = 10, padB = 24;
  const vals = pts.flatMap((p) => [p.r, p.b]).filter((x) => x != null);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.12 || 0.01;
  lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    let v = lo + ((hi - lo) * i) / 4;
    if (Math.abs(v) < 5e-4) v = 0;
    grid += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="axis-label" x="${W - padR + 8}" y="${y(v) + 3.5}">${fmtPct(v, true, 1)}</text>`;
  }
  grid += `<line class="zero-line" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>`;
  const xl = [0, pts.length - 1].map((i) =>
    `<text class="axis-label" text-anchor="${i ? "end" : "start"}" x="${i ? W - padR : padL}" y="${H - 6}">${new Date(pts[i].t).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}</text>`).join("");
  const path = (key) => pts.filter((p) => p[key] != null).map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rentabilidad de la cartera frente al índice">
    ${grid}${xl}
    <path class="line bench" d="${path("b")}"/>
    <path class="line port" d="${path("r")}"/>
    <g id="s-hover" style="display:none">
      <line class="cross" id="s-hx" y1="${padT}" y2="${H - padB}"/>
      <circle class="dot bench-dot" id="s-hb" r="4"/>
      <circle class="dot port-dot" id="s-hp" r="4.5"/>
    </g>
    <rect x="0" y="0" width="${W - padR}" height="${H}" fill="transparent" id="s-hit"/>
  </svg>`;
  $("#s-legend").innerHTML =
    `<span><i class="sw port"></i>Tu cartera <b>${fmtPct(last.r, true, 2)}</b></span>` +
    `<span><i class="sw bench"></i>${esc(s.uname)} <b>${fmtPct(last.b, true, 2)}</b></span>`;

  const tip = $("#tooltip");
  const hov = box.querySelector("#s-hover");
  const move = (ev) => {
    const e = ev.touches ? ev.touches[0] : ev;
    const rect = box.getBoundingClientRect();
    const tx = t0 + ((e.clientX - rect.left - padL) / (W - padL - padR)) * (t1 - t0);
    let i = 0;
    pts.forEach((p, k) => { if (Math.abs(p.t - tx) < Math.abs(pts[i].t - tx)) i = k; });
    const p = pts[i];
    hov.style.display = "";
    for (const id of ["#s-hx"]) { box.querySelector(id).setAttribute("x1", x(p.t)); box.querySelector(id).setAttribute("x2", x(p.t)); }
    box.querySelector("#s-hp").setAttribute("cx", x(p.t)); box.querySelector("#s-hp").setAttribute("cy", y(p.r));
    const hb = box.querySelector("#s-hb");
    hb.style.display = p.b == null ? "none" : "";
    if (p.b != null) { hb.setAttribute("cx", x(p.t)); hb.setAttribute("cy", y(p.b)); }
    tip.innerHTML = `${new Date(p.t).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })} · cartera <b>${fmtPct(p.r, true, 2)}</b> · índice ${fmtPct(p.b, true, 2)}`;
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + x(p.t) - tip.offsetWidth / 2))}px`;
    tip.style.top = `${rect.top + Math.min(y(p.r), p.b == null ? Infinity : y(p.b)) - 42}px`;
  };
  const leave = () => { hov.style.display = "none"; tip.hidden = true; };
  const hit = box.querySelector("#s-hit");
  hit.addEventListener("mousemove", move);
  hit.addEventListener("touchmove", move, { passive: true });
  hit.addEventListener("mouseleave", leave);
  hit.addEventListener("touchend", leave);
}

// Llamado en cada refresco de precios
function simRefresh() {
  if ($("#view-simulacion").hidden) return;
  const s = activeSim();
  if (s && s.universe === state.data?.universe) { sim.live.set(s.universe, state.data); paintSim(s); }
  else renderSim();
}

function initSim() {
  sim.list = loadSims();
  const imported = importSimFromHash();
  $("#s-create").onclick = createSim;
  $("#s-delete").onclick = deleteSim;
  $("#s-copy").onclick = copySimLink;
  $("#s-list").onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) { sim.activeId = b.dataset.id; renderSim(); }
  };
  $("#s-body").onclick = (e) => { const tr = e.target.closest("tr[data-s]"); if (tr) openDrawer(tr.dataset.s); };
  window.addEventListener("resize", () => { const s = activeSim(); if (s && !$("#view-simulacion").hidden) paintSim(s); });
  return imported;
}
