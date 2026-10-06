"""Almacén del ranking diario.

Con SUPABASE_URL y SUPABASE_SERVICE_KEY definidos se guarda en Supabase (tabla
ranking_snapshots); si no, en data/snapshots.json para desarrollo local.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

import requests

log = logging.getLogger("storage")

# Variables de un archivo .env local (no se sube a GitHub); en Render se definen
# en la pestaña Environment y tienen prioridad.
_env = Path(__file__).parent / ".env"
if _env.exists():
    for line in _env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def _key_env(name: str) -> str:
    """Las claves son ASCII; si al copiarlas se colaron los puntos de una clave
    oculta (•••), se ignoran para no romper la web con una clave inválida."""
    v = os.getenv(name, "").strip()
    if v and not v.isascii():
        log.error("%s contiene caracteres no válidos (¿se copió oculta?); se ignora", name)
        return ""
    return v


SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_ANON_KEY = _key_env("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_KEY = _key_env("SUPABASE_SERVICE_KEY")
LOCAL_FILE = Path(__file__).parent / "data" / "snapshots.json"
TABLE = "ranking_snapshots"

_lock = threading.Lock()


def remote_enabled() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)


def _headers(key: str) -> dict:
    h = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):  # claves JWT antiguas también van como Bearer
        h["Authorization"] = f"Bearer {key}"
    return h


def _local_load() -> dict:
    if LOCAL_FILE.exists():
        return json.loads(LOCAL_FILE.read_text(encoding="utf-8"))
    return {}


def _key(date: str, universe: str, method: str) -> str:
    return f"{date}|{universe}|{method}"


def exists(date: str, universe: str, method: str) -> bool:
    if remote_enabled():
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{TABLE}", headers=_headers(SUPABASE_SERVICE_KEY), timeout=20,
                         params={"select": "date", "date": f"eq.{date}",
                                 "universe": f"eq.{universe}", "roc_method": f"eq.{method}"})
        r.raise_for_status()
        return bool(r.json())
    with _lock:
        return _key(date, universe, method) in _local_load()


def save(records: list[dict]) -> None:
    if not records:
        return
    if remote_enabled():
        r = requests.post(f"{SUPABASE_URL}/rest/v1/{TABLE}", json=records, timeout=30,
                          headers={**_headers(SUPABASE_SERVICE_KEY),
                                   "Prefer": "resolution=merge-duplicates,return=minimal"})
        r.raise_for_status()
        return
    with _lock:
        data = _local_load()
        for rec in records:
            data[_key(rec["date"], rec["universe"], rec["roc_method"])] = rec
        LOCAL_FILE.parent.mkdir(exist_ok=True)
        LOCAL_FILE.write_text(json.dumps(data), encoding="utf-8")


def load(universe: str, method: str, since: str) -> list[dict]:
    """Snapshots desde `since` (incluido), ordenados por fecha."""
    if remote_enabled() or (SUPABASE_URL and SUPABASE_ANON_KEY):
        key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{TABLE}", headers=_headers(key), timeout=30,
                         params={"select": "date,universe,roc_method,min_cap,bench,rows",
                                 "universe": f"eq.{universe}", "roc_method": f"eq.{method}",
                                 "date": f"gte.{since}", "order": "date.asc"})
        r.raise_for_status()
        return r.json()
    with _lock:
        data = _local_load()
    out = [v for v in data.values()
           if v["universe"] == universe and v["roc_method"] == method and v["date"] >= since]
    return sorted(out, key=lambda v: v["date"])
