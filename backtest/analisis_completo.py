"""Análisis completo de la Magic Formula en EE. UU. (WRDS + Bloomberg) y Europa (Bloomberg).

Entradas (no se suben a GitHub):
  resultados_forward/panel_eeuu.csv, rentabilidad_mensual.csv, tiempo_reconocimiento.csv  (WRDS)
  europa/resultados/panel_europa.csv, rentabilidad_anual_europa.csv                         (Bloomberg)
Salida: resultados_analisis/analisis.json con todo lo que dibuja el informe.
"""
import json
import os

import numpy as np
import pandas as pd

B = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(B, "resultados_analisis")
os.makedirs(OUT, exist_ok=True)
GICS = {10: "Energía", 15: "Materiales", 20: "Industria", 25: "Consumo discrecional", 30: "Consumo básico",
        35: "Salud", 40: "Financiero", 45: "Tecnología", 50: "Comunicación", 55: "Utilities", 60: "Inmobiliario"}
SECT_EU = {"Energy": "Energía", "Materials": "Materiales", "Industrials": "Industria",
           "Consumer Discretionary": "Consumo discrecional", "Consumer Staples": "Consumo básico",
           "Health Care": "Salud", "Information Technology": "Tecnología", "Communication Services": "Comunicación",
           "Financials": "Financiero", "Utilities": "Utilities", "Real Estate": "Inmobiliario"}

# ------------------------------------------------------------------ datos
us = pd.read_csv(os.path.join(B, "resultados_forward", "panel_eeuu.csv"))
us = us.rename(columns={"conm": "nombre", "gvkey": "id"})
us["sector"] = us.gsector.map(GICS).fillna("Otros")
us["pais"] = "US"
eu = pd.read_csv(os.path.join(B, "europa", "resultados", "panel_europa.csv")).rename(columns={"ticker": "id"})
eu["sector"] = eu.sector.map(SECT_EU).fillna("Sin dato")
eu_full = eu.copy()                                          # incluye años con EBIT <= 0 (para seguir carteras varios años)
eu = eu[eu.ebit > 0].copy()                                  # mismo criterio que EE. UU.
mens_us = pd.read_csv(os.path.join(B, "resultados_forward", "rentabilidad_mensual.csv"))
anual_eu = pd.read_csv(os.path.join(B, "europa", "resultados", "rentabilidad_anual_europa.csv"), index_col=0)
anual_us = pd.read_csv(os.path.join(B, "resultados_forward", "rentabilidad_anual.csv"), index_col=0)
evento_us = pd.read_csv(os.path.join(B, "resultados_forward", "tiempo_reconocimiento.csv"))
# rolling por tercios y tenencia de Europa siguiendo a las empresas aunque salgan del índice (europa/rolling_y_panel_completo.py)
roll_eu = pd.read_csv(os.path.join(B, "europa", "resultados", "rolling_europa.csv"), index_col=0)
ten_eu = pd.read_csv(os.path.join(B, "europa", "resultados", "tenencia_europa.csv"))
# EE. UU.: rolling con tramos de 10 y de 30 (notebook magic_formula_rolling30_eeuu.ipynb), si ya está ejecutado
F30 = os.path.join(B, "resultados_rolling30", "rolling_mensual.csv")
roll_us = None
if os.path.exists(F30):
    m30 = pd.read_csv(F30)
    m30["anio"] = m30.mes.str[:4].astype(int)
    roll_us = m30.groupby("anio")[["rolling10", "rolling30"]].apply(lambda x: (1 + x).prod() - 1)

eu_full["ret"] = eu_full.ret_anio.clip(-1, 5)
for p in (us, eu):
    p["g"] = (p.ebit_fwd / p.ebit - 1).where(p.ebit_fwd.notna())
    p["err"] = (p.ebit_real_sig / p.ebit_fwd - 1).replace([np.inf, -np.inf], np.nan)
    p["ret"] = p.ret_anio.clip(-1, 5)

cagr = lambda s: float((1 + s.dropna()).prod() ** (1 / s.dropna().size) - 1) if s.dropna().size else None
R = {}


def top_ret(p, score_col, n=30, asc=True, filtro=None):
    out = {}
    for a, g in p.groupby("anio"):
        if filtro is not None:
            g = filtro(g)
        g = g.dropna(subset=[score_col])
        if len(g) < n:
            continue
        out[a] = g.nsmallest(n, score_col).ret.mean() if asc else g.nlargest(n, score_col).ret.mean()
    return pd.Series(out)


def score_mf(g, ebit_col):
    g = g[(g[ebit_col] > 0)].copy()
    g["_ey"] = g[ebit_col] / g.ev
    g["_roc"] = g[ebit_col] / g.capital
    return g._ey.rank(ascending=False) + g._roc.rank(ascending=False)


def variantes(p, p_ret=None):
    p_ret = p if p_ret is None else p_ret
    v = {}
    v["original"] = top_ret(p, "puesto")
    q = p.copy()
    q["s_fwd"] = q.groupby("anio", group_keys=False).apply(lambda g: score_mf(g, "ebit_fwd"))
    v["forward"] = top_ret(q, "s_fwd")
    q["ebit_cons"] = np.where(q.ebit_fwd.notna(), np.minimum(q.ebit, q.ebit_fwd), np.nan)
    q["s_cons"] = q.groupby("anio", group_keys=False).apply(lambda g: score_mf(g, "ebit_cons"))
    v["prudente"] = top_ret(q, "s_cons")
    q["s_hib"] = q.groupby("anio", group_keys=False).apply(
        lambda g: g.puesto.rank() + g.s_fwd.rank())
    v["hibrida"] = top_ret(q, "s_hib")

    def sin_euforia(g):
        lim = g.g.quantile(0.8)
        return g[~(g.g > lim)] if g.g.notna().any() else g
    v["sin_expectativas_altas"] = top_ret(q[q.anio >= 2006], "puesto", filtro=sin_euforia)

    def tope_sector(g):
        g = g.sort_values("puesto")
        return g[g.groupby("sector").cumcount() < 6]
    v["max_6_por_sector"] = top_ret(p, "puesto", filtro=tope_sector)
    v["top_50"] = top_ret(p, "puesto", n=50)
    v["top_10"] = top_ret(p, "puesto", n=10)
    # rolling por tercios: tramos de 10 mantenidos 3 años
    roll = {}
    for t in sorted(p.anio.unique()):
        rs = []
        for f in (t, t - 1, t - 2):
            coh = set(p[(p.anio == f) & (p.puesto <= 10)].id)
            x = p_ret[(p_ret.anio == t) & p_ret.id.isin(coh)].ret
            if len(x):
                rs.append(x.mean())
        if len(rs) == 3:
            roll[t] = np.mean(rs)
    v["rolling_tercios"] = pd.Series(roll)
    return pd.DataFrame(v)


def quintiles(p, col, asc_better):
    tab = {}
    for a, g in p.groupby("anio"):
        g = g.dropna(subset=[col])
        if len(g) < 50:
            continue
        q = pd.qcut(g[col].rank(method="first", ascending=not asc_better), 5, labels=[1, 2, 3, 4, 5])
        tab[a] = g.groupby(q, observed=True).ret.mean()
    t = pd.DataFrame(tab).T
    return {"cagr": {int(k): cagr(t[k]) for k in t.columns}, "anual": t}


def ic(p):
    s = {}
    for a, g in p.groupby("anio"):
        g = g.dropna(subset=["puesto", "ret"])
        s[a] = -g.puesto.rank().corr(g.ret.rank())       # correlación de Spearman
    return pd.Series(s)


def analiza(p, nombre, indice_cap, indice_eq, p_ret=None, rolling=None, rolling30=None):
    res = {}
    v = variantes(p, p_ret)
    if rolling is not None:
        v["rolling_tercios"] = rolling
    v["rolling_30"] = rolling30 if rolling30 is not None else pd.Series(np.nan, index=v.index)
    res["variantes"] = {c: {"cagr_total": cagr(v[c]), "cagr_2006_2025": cagr(v[c].loc[2006:2025]),
                            "anual": {int(a): float(x) for a, x in v[c].dropna().items()}} for c in v}
    res["indice"] = {"cap": {int(a): float(x) for a, x in indice_cap.dropna().items()},
                     "eq": {int(a): float(x) for a, x in indice_eq.dropna().items()},
                     "cap_cagr_2006_2025": cagr(indice_cap.loc[2006:2025]), "eq_cagr_2006_2025": cagr(indice_eq.loc[2006:2025]),
                     "cap_cagr_total": cagr(indice_cap.loc[p.anio.min():]), "eq_cagr_total": cagr(indice_eq.loc[p.anio.min():])}
    for col, asc, k in [("ey", False, "q_ey"), ("roc", False, "q_roc"), ("puesto", True, "q_mf"), ("g", False, "q_crec")]:
        sub = p if k != "q_crec" else p[p.anio >= 2006]
        q = quintiles(sub, col, asc_better=not asc if col != "puesto" else True)
        c = q["cagr"]
        if col == "puesto":                     # Q1 = mejores del ranking
            c = {6 - k: v for k, v in c.items()}
        res[k] = {"cagr": dict(sorted(c.items()))}
    i = ic(p)
    res["ic"] = {"anual": {int(a): float(x) for a, x in i.items()}, "media": float(i.mean()), "pct_pos": float((i > 0).mean())}
    e = p[(p.anio >= 2006) & p.err.notna()]
    res["error"] = {"por_anio": {int(a): float(x) for a, x in e.groupby("anio").err.median().items()},
                    "por_sector": {s: float(x) for s, x in e.groupby("sector").err.median().sort_values().items() if s != "Sin dato"},
                    "mediana": float(e.err.median()), "pct_neg": float((e.err < 0).mean()),
                    "top30_fwd_mediana": None}
    # valoración del mercado y spread de valor
    val = p.groupby("anio").ey.median()
    spread = p.groupby("anio").apply(lambda g: g.ey.quantile(0.9) / g.ey.median())
    res["valoracion"] = {"ey_mediano": {int(a): float(x) for a, x in val.items()},
                         "spread": {int(a): float(x) for a, x in spread.items()}}
    res["sector_ey"] = {s: {int(a): float(x) for a, x in g.groupby("anio").ey.median().items()}
                        for s, g in p.groupby("sector") if s not in ("Sin dato", "Otros")}
    res["cagr_2003_2025"] = {"original": cagr(v["original"].loc[2003:2025]), "rolling": cagr(v["rolling_tercios"].loc[2003:2025]),
                             "rolling30": cagr(v["rolling_30"].loc[2003:2025]),
                             "cap": cagr(indice_cap.loc[2003:2025]), "eq": cagr(indice_eq.loc[2003:2025])}
    res["n_empresas"] = int(p.id.nunique())
    res["n_obs"] = int(len(p))
    return res, v


R["us"], v_us = analiza(us, "EE. UU.", anual_us.sp500, anual_us.sp500_igual_peso, rolling=anual_us.rolling_ltm.loc[2003:],
                        rolling30=None if roll_us is None else roll_us.rolling30.loc[2003:2025])
R["eu"], v_eu = analiza(eu, "Europa", anual_eu.indice_cap, anual_eu.indice_eq, p_ret=eu_full,
                        rolling=roll_eu.rolling10.dropna(), rolling30=roll_eu.rolling30.dropna())
R["eu"]["cagr_2008_2025"] = {k: cagr(s.loc[2008:2025]) for k, s in
                             [("original", roll_eu.mf_ltm), ("rolling10", roll_eu.rolling10), ("rolling30", roll_eu.rolling30),
                              ("cap", roll_eu.indice_cap), ("eq", roll_eu.indice_eq)]}

# error de la cartera forward
for k, p in [("us", us), ("eu", eu)]:
    q = p[p.anio >= 2006].copy()
    q["s_fwd"] = q.groupby("anio", group_keys=False).apply(lambda g: score_mf(g, "ebit_fwd"))
    top = q.groupby("anio", group_keys=False).apply(lambda g: g.nsmallest(30, "s_fwd"))
    R[k]["error"]["top30_fwd_mediana"] = float(top.err.median())
    R[k]["error"]["top30_fwd_pct_neg"] = float((top.err.dropna() < 0).mean())

# sesgo de supervivencia (ambos) y de anticipación (Europa)
for k, p in [("us", us), ("eu", eu)]:
    ultimo = p.anio.max()
    sup = set(p[p.anio == ultimo].id) if k == "us" else set(p[p.superviviente].id)
    honesto = top_ret(p, "puesto")
    sesgado = top_ret(p[p.id.isin(sup)], "puesto")
    R[k]["supervivencia"] = {"honesto": cagr(honesto), "sesgado": cagr(sesgado)}
eu2 = eu.copy()
eu2["s_la"] = eu2.groupby("anio", group_keys=False).apply(lambda g: score_mf(g, "ebit_sin_desfase"))
R["eu"]["anticipacion"] = {"honesto": cagr(top_ret(eu, "puesto")), "sesgado": cagr(top_ret(eu2, "s_la"))}

# tiempo de reconocimiento: EE. UU. de WRDS; Europa con el panel
R["us"]["tenencia"] = evento_us.groupby("anio_tenencia")[["ret", "exceso_sp500", "exceso_igual_peso"]].mean().to_dict()
g_ten = ten_eu.groupby("anio_tenencia")
R["eu"]["tenencia"] = {"ret": g_ten.ret.mean().to_dict(), "exceso_sp500": g_ten.exceso_cap.mean().to_dict(),
                       "exceso_igual_peso": g_ten.exceso_eq.mean().to_dict()}

# serie mensual EE. UU. para el gráfico (2001-2026)
m = mens_us.copy()
R["us"]["mensual"] = {"mes": m.mes.tolist(), **{c: [None if pd.isna(x) else round(float(x), 6) for x in m[c]]
                                                  for c in ["mf_ltm", "mf_fwd", "rolling_ltm", "sp500", "sp500_igual_peso"]}}
if roll_us is not None:
    r30 = m30.set_index("mes").rolling30.reindex(m.mes)
    R["us"]["mensual"]["rolling30"] = [None if pd.isna(x) else round(float(x), 6) for x in r30]

# países (Europa)
R["eu"]["pais_ey"] = {c: {int(a): float(x) for a, x in g.groupby("anio").ey.median().items()}
                      for c, g in eu.groupby("pais") if c in ("GB", "FR", "DE", "CH", "SE", "NL", "ES", "IT", "DK", "NO", "FI", "BE")}
esp = eu[eu.pais == "ES"]
R["eu"]["espana"] = {"n_empresas": int(esp.id.nunique()),
                     "top": esp[esp.puesto <= 30].groupby("nombre").size().sort_values(ascending=False).head(12).to_dict(),
                     "mejor_puesto_medio": esp.groupby("nombre").puesto.median().sort_values().head(10).to_dict()}

# explorador: TODAS las empresas descargadas (también las excluidas por la fórmula, con el motivo)
F_US = os.path.join(B, "resultados_rolling30", "panel_completo_eeuu.csv")
if os.path.exists(F_US):
    us_x = pd.read_csv(F_US).rename(columns={"conm": "nombre", "gvkey": "id"})
    us_x["sector"] = us_x.gsector.map(GICS).fillna("Sin dato")
else:                                                        # hasta ejecutar el notebook: solo las elegibles
    us_x = us.assign(motivo="Elegible")
us_x["pais"] = "US"
eu_x = pd.read_csv(os.path.join(B, "europa", "resultados", "panel_completo_europa.csv")).rename(columns={"ticker": "id"})
eu_x["sector"] = eu_x.sector.map(SECT_EU).fillna("Sin dato")
n_desc = {"us": None, "eu": int(pd.read_pickle(os.path.join(B, "europa", "datos", "miembros.pkl")).ticker.nunique())}


def nul(x, d):
    return None if pd.isna(x) or not np.isfinite(x) else round(float(x), d)


def exp(p, mercado):
    p = p.copy()
    p["g"] = (p.ebit_fwd / p.ebit - 1).where(p.ebit_fwd.notna() & (p.ebit > 0))
    rows = []
    for r in p.sort_values(["id", "anio"]).itertuples():
        rows.append([mercado, str(r.id), r.nombre, r.sector, int(r.anio), None if pd.isna(r.puesto) else int(r.puesto),
                     nul(r.ey, 4), nul(r.roc, 3), nul(r.g, 3), nul(r.ret_anio, 4), nul(r.mcap, 0), r.motivo, r.pais])
    return rows


R["explorador"] = exp(us_x, "EE. UU.") + exp(eu_x, "Europa")
R["cobertura"] = {"us_empresas": int(us_x.id.nunique()), "eu_empresas": int(eu_x.id.nunique()), "eu_descargadas": n_desc["eu"],
                  "us_completo": os.path.exists(F_US),
                  "motivos": {m: {k: int(v) for k, v in g.motivo.value_counts().items()} for m, g in [("us", us_x), ("eu", eu_x)]}}

json.dump(R, open(os.path.join(OUT, "analisis.json"), "w", encoding="utf-8"), ensure_ascii=False, default=float)
print("ok", os.path.getsize(os.path.join(OUT, "analisis.json")) // 1024, "KB")
for k in ("us", "eu"):
    r = R[k]
    print(f"\n===== {k}  empresas {r['n_empresas']} obs {r['n_obs']}")
    print("variantes 2006-2025:", {c: round(x['cagr_2006_2025'] * 100, 1) if x['cagr_2006_2025'] else None for c, x in r['variantes'].items()})
    print("variantes total:", {c: round(x['cagr_total'] * 100, 1) if x['cagr_total'] else None for c, x in r['variantes'].items()})
    print("indice 2006-2025 cap/eq:", round(r['indice']['cap_cagr_2006_2025'] * 100, 1), round(r['indice']['eq_cagr_2006_2025'] * 100, 1),
          "| total:", round(r['indice']['cap_cagr_total'] * 100, 1), round(r['indice']['eq_cagr_total'] * 100, 1))
    for q in ("q_ey", "q_roc", "q_mf", "q_crec"):
        print(q, {a: round(b * 100, 1) for a, b in r[q]['cagr'].items()})
    print("IC medio", round(r['ic']['media'], 3), "pct pos", round(r['ic']['pct_pos'], 2))
    print("error", round(r['error']['mediana'] * 100, 1), round(r['error']['pct_neg'] * 100), "top30", round(r['error']['top30_fwd_mediana'] * 100, 1), round(r['error']['top30_fwd_pct_neg'] * 100))
    print("error sector", {s: round(x * 100, 1) for s, x in r['error']['por_sector'].items()})
    print("error año", {a: round(x * 100, 1) for a, x in r['error']['por_anio'].items()})
    print("supervivencia", {a: round(b * 100, 1) for a, b in r['supervivencia'].items()})
    print("tenencia", r['tenencia'])
print("anticipacion eu", R["eu"]["anticipacion"])
print("españa", R["eu"]["espana"])
