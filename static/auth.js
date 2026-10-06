"use strict";
// Inicio de sesión con enlace por email (Supabase Auth) y guardado de las
// simulaciones en la cuenta. Solo se activa si el servidor tiene configurado
// Supabase (/api/config); si no, la web funciona igual que antes, sin cuentas.

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";

const cloud = {
  client: null,
  user: null,

  async list() {
    const { data, error } = await this.client.from("simulations").select("payload").order("created_at");
    if (error) throw error;
    return data.map((r) => r.payload);
  },
  async save(s) {
    const { error } = await this.client.from("simulations")
      .upsert({ user_id: this.user.id, sim_id: s.id, payload: s }, { onConflict: "user_id,sim_id" });
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await this.client.from("simulations").delete().eq("sim_id", id);
    if (error) throw error;
  },
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

function authModal(view) {
  const m = $("#auth-modal");
  if (!view) { m.hidden = true; return; }
  for (const v of ["form", "sent", "user"]) $(`#auth-${v}-view`).hidden = v !== view;
  $("#auth-error").hidden = true;
  m.hidden = false;
  if (view === "form") setTimeout(() => $("#auth-email").focus(), 50);
}

function paintAuthButton() {
  const b = $("#auth-btn");
  b.hidden = false;
  b.textContent = cloud.user ? "Mi cuenta" : "Entrar";
  b.title = cloud.user ? cloud.user.email : "Entra para guardar tus simulaciones en tu cuenta";
}

async function initAuth() {
  // El enlace del correo vuelve con los datos de sesión (o un error) en el #hash
  const cameFromEmail = /access_token=|error_code=/.test(location.hash);
  const hashError = new URLSearchParams(location.hash.slice(1)).get("error_code");

  let cfg;
  try { cfg = await fetch("/api/config").then((r) => r.json()); } catch { return; }
  if (!cfg.auth) return;
  try { await loadScript(SUPABASE_JS); } catch { return; }

  cloud.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });

  cloud.client.auth.onAuthStateChange((event, session) => {
    const before = cloud.user?.id;
    cloud.user = session?.user || null;
    paintAuthButton();
    if (before !== cloud.user?.id) {
      onAuthChanged(!!cloud.user);
      if (event === "SIGNED_IN" && cameFromEmail) location.hash = "#simulacion";
    }
  });
  const { data } = await cloud.client.auth.getSession();
  cloud.user = data.session?.user || null;
  paintAuthButton();
  if (cloud.user) onAuthChanged(true);

  if (hashError) {
    history.replaceState(null, "", "#simulacion");
    authModal("form");
    $("#auth-error").textContent = hashError === "otp_expired"
      ? "El enlace ha caducado o ya se usó. Pide uno nuevo."
      : "No se pudo iniciar sesión con ese enlace. Pide uno nuevo.";
    $("#auth-error").hidden = false;
  }

  $("#auth-btn").onclick = () => {
    if (cloud.user) $("#auth-user-email").textContent = cloud.user.email;
    authModal(cloud.user ? "user" : "form");
  };
  $("#auth-close").onclick = () => authModal(null);
  $("#auth-modal").onclick = (e) => { if (e.target.id === "auth-modal") authModal(null); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") authModal(null); });

  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const btn = $("#auth-submit");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    const { error } = await cloud.client.auth.signInWithOtp({
      email, options: { emailRedirectTo: `${location.origin}/` },
    });
    btn.disabled = false;
    btn.textContent = "Enviarme el enlace";
    if (error) {
      $("#auth-error").textContent = /rate|limit/i.test(error.message)
        ? "Se han enviado demasiados correos en poco tiempo. Espera unos minutos y vuelve a intentarlo."
        : `No se pudo enviar el correo: ${error.message}`;
      $("#auth-error").hidden = false;
      return;
    }
    $("#auth-sent-email").textContent = email;
    authModal("sent");
  };

  $("#auth-logout").onclick = async () => {
    await cloud.client.auth.signOut();
    authModal(null);
  };
}

initAuth();
