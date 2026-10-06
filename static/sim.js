"use strict";
// Simulaciones sin dinero real, de dos tipos:
//  - "manual": compra única de las primeras del ranking, a precio de ese momento.
//  - "auto":   estrategia de Greenblatt por tramos; usa el ranking guardado cada
//              día por el servidor, compra un tramo cada N meses y lo vende al año.
// Se guardan en la cuenta del usuario (Supabase) si ha iniciado sesión, y si no en
// el navegador. Cualquier simulación se puede compartir con un enlace.

const SIM_KEY = "mf-sims";
const sim = { list: [], activeId: null, cache: new Map(), live: new Map(), loading: false };

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => new Date(d).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
const fmtDay = (iso) => fmtDate(iso + "T12:00:00");
const activeSim = () => sim.list.find((s) => s.id === sim.activeId) || sim.list[sim.list.length - 1] || null;
const isAuto = (s) => s.kind === "auto";
const addMonths = (iso, m) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------------ almacenamiento
const localSims = {
  load() { try { return JSON.parse(store.get(SIM_KEY, "[]")) || []; } catch { return []; } },
  save(list) { store.set(SIM_KEY, JSON.stringify(list)); },
};

const usingCloud = () => typeof cloud !== "undefined" && cloud.user;

async function reloadSims() {
  sim.list = usingCloud() ? await cloud.list() : localSims.load();
}

async function addSim(s) {
  sim.list.push(s);
  sim.activeId = s.id;
  if (usingCloud()) await cloud.save(s);
  else localSims.save(sim.list);
}

async function removeSim(id) {
  sim.list = sim.list.filter((x) => x.id !== id);
  if (usingCloud()) await cloud.remove(id);
  else localSims.save(sim.list);
}

// Al iniciar sesión: sube a la cuenta las simulaciones que había en este navegador
async function syncLocalToCloud() {
  const local = localSims.load();
  if (!local.length) return 0;
  const remote = new Set((await cloud.list()).map((s) => s.id));
  const missing = local.filter((s) => !remote.has(s.id));
  for (const s of missing) await cloud.save(s);
  localSims.save([]);
  return missing.length;
}

// ------------------------------------------------------------------ enlaces
function encodeSim(s) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(s)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeSim(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(s + "===".slice((s.length + 3) % 4)))));
}

async function importSimFromHash() {
  const m = location.hash.match(/^#sim=([\w-]+)/);
  if (!m) return false;
  try {
    const s = decodeSim(m[1]);
    if (s?.id && (Array.isArray(s.pos) || isAuto(s))) {
      if (!sim.list.some((x) => x.id === s.id)) await addSim(s);
      sim.activeId = s.id;
    }
  } catch { /* enlace dañado: se ignora */ }
  history.replaceState(null, "", "#simulacion");
  return true;
}

// ------------------------------------------------------------------ crear / borrar
function syncCreateForm() {
  const auto = $("#s-kind").value === "auto";
  $("#s-n-wrap").hidden = auto;
  $("#s-per-wrap").hidden = !auto;
  $("#s-every-wrap").hidden = !auto;
  const every = +$("#s-every").value, per = +$("#s-per").value;
  $("#s-kind-note").textContent = auto
    ? `Compra ${per} empresas ahora y otras ${per} cada ${every} meses; cada tramo se vende al cumplir un año y se reinvierte en las primeras del ranking de ese día. Cartera completa: ${per * (12 / every)} empresas.`
    : "Compra todas las empresas ahora, a partes iguales, y las mantiene sin cambios.";
}

async function createSim() {
  const d = state.data;
  const amount = Math.max(100, +$("#s-amount").value || 10000);
  const auto = $("#s-kind").value === "auto";
  if (!d) return alert("Espera a que cargue el ranking y vuelve a intentarlo.");
  const base = {
    id: Date.now().toString(36),
    created: Math.floor(Date.now() / 1000),
    start: todayISO(),
    universe: d.universe, uname: d.name, cur: d.currency,
    roc: $("#f-roc").value, amount,
  };
  let s;
  if (auto) {
    const per = +$("#s-per").value, every = +$("#s-every").value;
    s = { ...base, kind: "auto", per, every, sleeves: 12 / every,
      name: $("#s-name").value.trim() || `Greenblatt automática · ${d.name} · ${fmtDate(Date.now())}` };
  } else {
    const n = +$("#s-n").value;
    const picks = state.ranked.slice(0, n).filter((r) => r.price);
    if (picks.length < Math.min(n, 5) || !d.benchmark?.price) {
      return alert("Todavía no hay precios suficientes de este universo. Espera un minuto y vuelve a intentarlo.");
    }
    const per = amount / picks.length;
    s = { ...base, kind: "manual",
      name: $("#s-name").value.trim() || `${d.name} · ${fmtDate(Date.now())}`,
      bench: { s: d.benchmark.symbol, px: d.benchmark.price },
      pos: picks.map((r) => ({ s: r.symbol, n: r.name, px: r.price, sh: per / r.price })) };
  }
  try { await addSim(s); } catch (e) { return alert(`No se pudo guardar la simulación: ${e.message || e}`); }
  $("#s-name").value = "";
  renderSim();
}

async function deleteSim() {
  const s = activeSim();
  if (!s || !confirm(`¿Eliminar la simulación «${s.name}»? No se puede deshacer.`)) return;
  try { await removeSim(s.id); } catch (e) { return alert(`No se pudo eliminar: ${e.message || e}`); }
  sim.activeId = null;
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

// ------------------------------------------------------------------ datos
async function liveFor(universe) {
  if (state.data?.universe === universe) return state.data;
  const c = sim.live.get(universe);
  if (c && Date.now() - c._t < 30000) return c;
  const d = await fetch(`/api/ranking/${universe}`).then((r) => r.json());
  d._t = Date.now();
  sim.live.set(universe, d);
  return d;
}

async function history(symbols, start) {
  const r = await fetch(`/api/sim-history?symbols=${encodeURIComponent(symbols.join(","))}&start=${start}`);
  if (!r.ok) throw new Error("histórico no disponible");
  return r.json();
}

// Cierre de `sym` en la fecha `iso` o el último anterior disponible
function closeOn(h, sym, iso) {
  const c = h.closes?.[sym];
  if (!c) return null;
  let i = h.dates.length - 1;
  while (i >= 0 && h.dates[i] > iso) i--;
  for (; i >= 0; i--) if (c[i] != null) return c[i];
  return null;
}

async function loadSimData(s) {
  const c = sim.cache.get(s.id);
  if (c && Date.now() - c._t < 15 * 60000) return c;
  const out = { _t: Date.now() };
  if (isAuto(s)) {
    out.snaps = await fetch(`/api/snapshots?universe=${s.universe}&method=${s.roc}&since=${s.start}`).then((r) => r.json());
    out.plan = planAuto(s, out.snaps);
    const syms = [...new Set(out.plan.events.flatMap((e) => e.buys.map((b) => b.s)))];
    const bench = out.snaps[0]?.bench?.s;
    out.hist = syms.length ? await history([...syms, bench].filter(Boolean), out.plan.events[0].date) : { dates: [], closes: {} };
  } else {
    out.hist = await history([...s.pos.map((p) => p.s), s.bench.s], s.start);
  }
  sim.cache.set(s.id, out);
  return out;
}

// ------------------------------------------------------------------ estrategia automática
// Decide qué se compra en cada tramo. Solo depende de los rankings guardados.
function planAuto(s, snaps) {
  const sleeves = Array.from({ length: s.sleeves }, () => []);
  const events = [];
  const today = todayISO();
  let next = null;
  for (let k = 0; ; k++) {
    const due = addMonths(s.start, k * s.every);
    if (due > today) { next = due; break; }
    const snap = snaps.find((x) => x.date >= due);
    if (!snap) { next = due; break; }  // aún no hay ranking guardado para esta fecha
    const j = k % s.sleeves;
    const heldElsewhere = new Set(sleeves.flatMap((pos, i) => (i === j ? [] : pos.map((p) => p.s))));
    const buys = [...snap.rows].sort((a, b) => a.mf - b.mf)
      .filter((r) => !heldElsewhere.has(r.s)).slice(0, s.per)
      .map((r) => ({ s: r.s, n: r.n, px: r.px, mf: r.mf }));
    events.push({ k, sleeve: j, due, date: snap.date, sells: sleeves[j].map((p) => p.s), buys, bench: snap.bench });
    sleeves[j] = buys;
  }
  return { events, next };
}

// Valora la estrategia día a día con los cierres históricos y el precio en vivo
function runAuto(s, data, live) {
  const { plan, hist } = data;
  const pxLive = new Map((live?.rows || []).map((r) => [r.symbol, r.price]));
  const sleeves = Array.from({ length: s.sleeves }, () => ({ cash: s.amount / s.sleeves, pos: [] }));
  const log = [];
  const ev = [...plan.events];
  const priceAt = (sym, iso, fallback) => closeOn(hist, sym, iso) ?? fallback;

  const apply = (e) => {
    const sl = sleeves[e.sleeve];
    for (const p of sl.pos) {
      const px = priceAt(p.s, e.date, p.px);
      sl.cash += p.sh * px;
      log.push({ date: e.date, type: "Venta", s: p.s, n: p.n, px, ret: px / p.px - 1, sleeve: e.sleeve });
    }
    sl.pos = [];
    const per = sl.cash / Math.max(1, e.buys.length);
    for (const b of e.buys) {
      const px = priceAt(b.s, e.date, b.px);
      if (!px) continue;
      sl.pos.push({ s: b.s, n: b.n, px, sh: per / px, date: e.date, sleeve: e.sleeve, mf: b.mf });
      sl.cash -= per;
      log.push({ date: e.date, type: "Compra", s: b.s, n: b.n, px, sleeve: e.sleeve, mf: b.mf });
    }
  };
  const value = (iso, live = false) => sleeves.reduce((a, sl) => a + sl.cash +
    sl.pos.reduce((b, p) => b + p.sh * ((live && pxLive.get(p.s)) || priceAt(p.s, iso, p.px)), 0), 0);

  const start = ev[0]?.date;
  const bsym = ev[0]?.bench?.s;
  const b0 = start ? (closeOn(hist, bsym, start) ?? ev[0].bench?.px) : null;
  const pts = [];
  if (start) {
    for (const d of hist.dates.filter((x) => x >= start && x < todayISO())) {
      while (ev.length && ev[0].date <= d) apply(ev.shift());
      const bc = closeOn(hist, bsym, d);
      pts.push({ t: Date.parse(d + "T21:00:00Z"), v: value(d), b: bc && b0 ? bc / b0 - 1 : null });
    }
    while (ev.length) apply(ev.shift());
  }
  const nowV = start ? value(todayISO(), true) : s.amount;
  const bNow = live?.benchmark?.price ?? closeOn(hist, bsym, todayISO());
  if (start) pts.push({ t: Date.now(), v: nowV, b: bNow && b0 ? bNow / b0 - 1 : null });
  if (pts.length) pts.unshift({ t: Date.parse(start + "T14:00:00Z"), v: s.amount, b: 0 });
  pts.forEach((p) => (p.r = p.v / s.amount - 1));

  const positions = sleeves.flatMap((sl) => sl.pos.map((p) => {
    const now = pxLive.get(p.s) ?? priceAt(p.s, todayISO(), p.px);
    return { ...p, now, ret: now / p.px - 1, value: p.sh * now, sellBy: addMonths(p.date, 12) };
  }));
  const cash = sleeves.reduce((a, sl) => a + sl.cash, 0);
  return { positions, cash, value: nowV, ret: nowV / s.amount - 1,
    bret: bNow && b0 ? bNow / b0 - 1 : 0, pts, log: log.reverse(), next: plan.next, started: !!start };
}

// ------------------------------------------------------------------ compra única
function runManual(s, data, live) {
  const h = data.hist;
  const px = new Map((live?.rows || []).map((r) => [r.symbol, r.price]));
  const today = todayISO();
  const pts = [{ t: s.created * 1000, v: s.amount, b: 0 }];
  h.dates.forEach((d) => {
    if (d <= s.start || d >= today) return;
    let v = 0;
    for (const p of s.pos) v += p.sh * (closeOn(h, p.s, d) ?? p.px);
    const bc = closeOn(h, s.bench.s, d);
    pts.push({ t: Date.parse(d + "T21:00:00Z"), v, b: bc ? bc / s.bench.px - 1 : null });
  });
  const positions = s.pos.map((p) => {
    const now = px.get(p.s) ?? closeOn(h, p.s, today) ?? p.px;
    return { ...p, now, ret: now / p.px - 1, value: p.sh * now };
  });
  const value = positions.reduce((a, p) => a + p.value, 0);
  const bNow = live?.benchmark?.price ?? closeOn(h, s.bench.s, today) ?? s.bench.px;
  if (Date.now() / 1000 - s.created > 60) pts.push({ t: Date.now(), v: value, b: bNow / s.bench.px - 1 });
  pts.forEach((p) => (p.r = p.v / s.amount - 1));
  return { positions, cash: 0, value, ret: value / s.amount - 1, bret: bNow / s.bench.px - 1, pts };
}

// ------------------------------------------------------------------ render
async function renderSim() {
  const d = state.data;
  $("#s-universe").textContent = d ? d.name : "—";
  $("#s-roc-note").textContent = $("#f-roc").value === "gw" ? "ROC incluyendo fondo de comercio" : "ROC de Greenblatt";
  $("#s-cur").textContent = d ? sym(d.currency) : "";
  syncCreateForm();

  const s = activeSim();
  $("#s-list").innerHTML = sim.list.map((x) =>
    `<button data-id="${esc(x.id)}" class="${x === s ? "active" : ""}">${isAuto(x) ? "⟳ " : ""}${esc(x.name)}</button>`).join("");
  $("#s-list-wrap").hidden = sim.list.length < 2;
  $("#s-detail").hidden = !s;
  $("#s-empty").hidden = !!s;
  $("#s-empty").textContent = usingCloud()
    ? "Todavía no tienes ninguna simulación en tu cuenta. Crea la primera arriba."
    : "Todavía no tienes ninguna simulación. Crea la primera arriba: se guardará en este navegador (o en tu cuenta si inicias sesión).";
  if (!s) return;

  $("#s-title").textContent = s.name;
  const method = s.roc === "gw" ? "ROC con fondo de comercio" : "ROC de Greenblatt";
  if (isAuto(s)) {
    $("#s-meta").textContent = `${s.uname} · estrategia automática: ${s.per} empresas cada ${s.every} meses, cada tramo se mantiene 1 año · ${method} · desde el ${fmtDay(s.start)}`;
  } else {
    const review = new Date(s.created * 1000);
    review.setFullYear(review.getFullYear() + 1);
    $("#s-meta").textContent = `${s.uname} · compra única de ${s.pos.length} empresas · creada el ${fmtDate(s.created * 1000)} · ${method} · revisión según Greenblatt: ${fmtDate(review)}`;
  }

  if (sim.loading) return;
  if (!sim.cache.has(s.id)) {
    $("#s-kpis").innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="label">Cargando precios desde el inicio de la simulación…</div></div>';
    $("#s-chart").innerHTML = '<div class="msg">Cargando gráfico…</div>';
  }
  sim.loading = true;
  try {
    await Promise.race([Promise.all([loadSimData(s), liveFor(s.universe)]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 45000))]);
  } catch { /* se pinta con lo que haya */ } finally {
    sim.loading = false;
  }
  if (activeSim() === s) paintSim(s);
}

function paintSim(s) {
  const data = sim.cache.get(s.id);
  if (!data) {
    $("#s-kpis").innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="label">No se pudieron cargar los precios. Vuelve a intentarlo en unos minutos.</div></div>';
    return;
  }
  const live = sim.live.get(s.universe) || (state.data?.universe === s.universe ? state.data : null);
  const v = isAuto(s) ? runAuto(s, data, live) : runManual(s, data, live);
  const diff = v.ret - v.bret;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(s.start + "T00:00:00")) / 86400000));
  const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  const kpi = (l, val, sub) => `<div class="kpi"><div class="label">${l}</div><div class="value">${val}</div><div class="sub">${sub}</div></div>`;
  $("#s-kpis").innerHTML =
    kpi("Valor actual", fmtPrice(v.value, s.cur), isAuto(s) && v.cash > 1 ? `Liquidez pendiente de invertir: ${fmtPrice(v.cash, s.cur)}` : `Inicial: ${fmtPrice(s.amount, s.cur)}`) +
    kpi("Tu cartera", `<span class="${cls(v.ret)}">${fmtPct(v.ret, true, 2)}</span>`, `${days} ${days === 1 ? "día" : "días"} desde el inicio`) +
    kpi(`Índice (${esc(s.uname)})`, `<span class="${cls(v.bret)}">${fmtPct(v.bret, true, 2)}</span>`, "Mismo periodo, sin dividendos") +
    kpi("Diferencia", `<span class="${cls(diff)}">${fmtPct(diff, true, 2)}</span>`, diff >= 0 ? "Por encima del índice" : "Por debajo del índice");

  const auto = isAuto(s);
  $("#s-head-row").innerHTML = `<th>Empresa</th>${auto ? '<th class="num hide-sm">Tramo</th><th class="num hide-sm">Comprada</th>' : ""}
    <th class="num">Precio inicial</th><th class="num">Precio actual</th><th class="num">Rentabilidad</th>
    ${auto ? '<th class="num hide-sm">Venta prevista</th>' : '<th class="num hide-sm">Valor</th>'}`;
  const rows = [...v.positions].sort((a, b) => b.ret - a.ret);
  $("#s-body").innerHTML = rows.length ? rows.map((p) => `
    <tr data-s="${esc(p.s)}">
      <td><div class="co"><b>${esc(p.s)}</b><span>${esc(p.n)}</span></div></td>
      ${auto ? `<td class="num hide-sm">${p.sleeve + 1}</td><td class="num hide-sm">${fmtDay(p.date)}</td>` : ""}
      <td class="num">${fmtPrice(p.px, s.cur)}</td>
      <td class="num">${fmtPrice(p.now, s.cur)}</td>
      <td class="num ${cls(p.ret)}">${fmtPct(p.ret, true, 2)}</td>
      <td class="num hide-sm">${auto ? fmtDay(p.sellBy) : fmtPrice(p.value, s.cur)}</td>
    </tr>`).join("")
    : `<tr><td colspan="7" class="empty">${auto ? "La estrategia hará su primera compra con el ranking que se guarda hoy tras el cierre de Wall Street (22:00, hora peninsular)." : "Sin posiciones."}</td></tr>`;

  $("#s-auto-info").hidden = !auto;
  if (auto) {
    $("#s-next").textContent = v.next
      ? `Próximo tramo: ${fmtDay(v.next)}${v.next <= todayISO() ? " (en cuanto se guarde el ranking de hoy, tras el cierre de Wall Street)" : ""}`
      : "";
    $("#s-log").innerHTML = v.log.length ? v.log.map((m) => `
      <tr><td class="num">${fmtDay(m.date)}</td><td><span class="pill ${m.type === "Compra" ? "buy" : "sell"}">${m.type}</span></td>
      <td><div class="co"><b>${esc(m.s)}</b><span>${esc(m.n)}</span></div></td>
      <td class="num hide-sm">${m.sleeve + 1}</td><td class="num">${fmtPrice(m.px, s.cur)}</td>
      <td class="num ${m.ret != null ? cls(m.ret) : ""}">${m.ret != null ? fmtPct(m.ret, true, 2) : m.mf ? `#${m.mf}` : ""}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">Aún no hay movimientos.</td></tr>`;
  }
  drawSimChart(v.pts, s, auto && !v.started);
}

function drawSimChart(pts, s, waiting) {
  const box = $("#s-chart");
  if (pts.length < 2) {
    box.innerHTML = `<div class="msg">${waiting
      ? "La estrategia empieza con el primer ranking guardado. Vuelve mañana para ver la primera compra."
      : "Acabas de crearla. Vuelve dentro de unos días para ver la evolución frente al índice."}</div>`;
    $("#s-legend").innerHTML = "";
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
    `<text class="axis-label" text-anchor="${i ? "end" : "start"}" x="${i ? W - padR : padL}" y="${H - 6}">${new Date(pts[i].t).toLocaleDateString("es-ES", t1 - t0 > 300 * 864e5 ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" })}</text>`).join("");
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
    box.querySelector("#s-hx").setAttribute("x1", x(p.t));
    box.querySelector("#s-hx").setAttribute("x2", x(p.t));
    box.querySelector("#s-hp").setAttribute("cx", x(p.t));
    box.querySelector("#s-hp").setAttribute("cy", y(p.r));
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
  if (!s) return renderSim();
  if (s.universe === state.data?.universe) sim.live.set(s.universe, state.data);
  if (sim.cache.has(s.id)) paintSim(s);
  else renderSim();
}

// Lo llama auth.js al iniciar o cerrar sesión
async function onAuthChanged(signedIn) {
  if (signedIn) {
    const n = await syncLocalToCloud().catch(() => 0);
    if (n) setTimeout(() => alert(`Se han guardado en tu cuenta ${n} simulación(es) que tenías en este navegador.`), 300);
  }
  await reloadSims().catch(() => (sim.list = []));
  sim.cache.clear();
  if (!$("#view-simulacion").hidden) renderSim();
}

async function initSim() {
  sim.list = localSims.load();
  const imported = await importSimFromHash();
  $("#s-create").onclick = createSim;
  $("#s-delete").onclick = deleteSim;
  $("#s-copy").onclick = copySimLink;
  for (const id of ["s-kind", "s-per", "s-every"]) $(`#${id}`).addEventListener("change", syncCreateForm);
  $("#s-list").onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) { sim.activeId = b.dataset.id; renderSim(); }
  };
  $("#s-body").onclick = (e) => { const tr = e.target.closest("tr[data-s]"); if (tr) openDrawer(tr.dataset.s); };
  window.addEventListener("resize", () => {
    const s = activeSim();
    if (s && sim.cache.has(s.id) && !$("#view-simulacion").hidden) paintSim(s);
  });
  return imported;
}
