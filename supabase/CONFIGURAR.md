# Conectar Supabase (cuentas de usuario y ranking diario)

Todo con planes gratuitos, sin tarjeta.

## 1. Crear las tablas

1. Supabase → tu proyecto → **SQL Editor** → **New query**.
2. Pega el contenido entero de [`schema.sql`](schema.sql) y pulsa **Run**.
3. Debe decir *Success. No rows returned*.

## 2. Inicio de sesión por email

Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** `https://magic-formula-wc0j.onrender.com`
- **Redirect URLs** → *Add URL*:
  - `https://magic-formula-wc0j.onrender.com/**`
  - `http://localhost:8000/**`

(El proveedor *Email* viene activado por defecto en **Authentication → Sign In / Providers**.)

## 3. Claves en Render

Render → servicio **magic-formula** → **Environment** → *Add Environment Variable*:

| Variable | Valor | ¿Secreta? |
|---|---|---|
| `SUPABASE_URL` | `https://ljdnzaouxsklayeokqks.supabase.co` | No |
| `SUPABASE_ANON_KEY` | la *Publishable key* (`sb_publishable_…`) o *anon* | No |
| `SUPABASE_SERVICE_KEY` | la *Secret key* (`sb_secret_…`) o *service_role* | **Sí: no la compartas con nadie** |

Guarda los cambios: Render vuelve a desplegar la web solo.

## 4. Tarea diaria

El archivo `.github/workflows/daily-snapshot.yml` despierta la web cada día laborable
a las 21:40 UTC (después del cierre de Wall Street) para que guarde el ranking aunque
nadie la visite. Se puede lanzar a mano desde GitHub → **Actions** → *Ranking diario*
→ *Run workflow*.

GitHub desactiva las tareas programadas de un repositorio tras 60 días sin cambios;
si pasa, basta con volver a activarla en la pestaña **Actions**.

## Para probar en local

Crea un archivo `.env` (no se sube a GitHub) o define las variables antes de
arrancar. Sin ellas la web funciona igual, pero sin cuentas, y guarda el ranking
diario en `data/snapshots.json`.
