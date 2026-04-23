// Thin Supabase REST client built on fetch. Mirrors the extension's
// supabase.js surface so the sign-in / session / sbFetch pattern is
// the same between the Chrome extension and this dashboard.
//
// Session is persisted in localStorage under "sb_session".
//
// Depends on window.SUPABASE_CONFIG (set in config.js). Exposes
// window.sb with: signIn, signOut, getSession, refreshSession,
// ensureFreshSession, sbFetch.

(function () {
  const { url: URL_BASE, anonKey: ANON_KEY } = window.SUPABASE_CONFIG;
  const STORAGE_KEY = "sb_session";

  // --- session storage ----------------------------------------------

  function getSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function setSession(session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // --- auth ---------------------------------------------------------

  async function signIn(email, password) {
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey:         ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data.error_description || data.msg || data.error || "Sign-in failed"
      );
    }
    const session = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      user:          data.user,
      expires_at:    Date.now() + (data.expires_in * 1000),
    };
    setSession(session);
    return session;
  }

  async function refreshSession() {
    const current = getSession();
    if (!current?.refresh_token) throw new Error("No refresh token");
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey:         ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: current.refresh_token }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Refresh token stale or revoked — wipe so UI falls back to sign-in.
      clearSession();
      throw new Error(data.error_description || "Session expired");
    }
    const session = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      user:          data.user,
      expires_at:    Date.now() + (data.expires_in * 1000),
    };
    setSession(session);
    return session;
  }

  // Returns a fresh session or null. Refreshes if access token expires
  // within 60 seconds.
  async function ensureFreshSession() {
    let s = getSession();
    if (!s) return null;
    if (Date.now() > (s.expires_at - 60_000)) {
      try { s = await refreshSession(); }
      catch (_) { return null; }
    }
    return s;
  }

  async function signOut() {
    const s = getSession();
    if (s?.access_token) {
      // Best-effort: tell Supabase to invalidate the refresh token.
      // Ignore network errors — we're signing out either way.
      try {
        await fetch(`${URL_BASE}/auth/v1/logout`, {
          method: "POST",
          headers: {
            apikey:        ANON_KEY,
            Authorization: `Bearer ${s.access_token}`,
          },
        });
      } catch (_) {}
    }
    clearSession();
  }

  // --- REST helper --------------------------------------------------
  //
  // Examples:
  //   await sb.sbFetch("/rest/v1/clients?select=id,name&order=name.asc")
  //   await sb.sbFetch("/rest/v1/outreach", {
  //     method: "POST",
  //     body:   JSON.stringify([row]),
  //     headers:{ Prefer: "return=minimal" }
  //   })

  async function sbFetch(path, options = {}) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");
    const res = await fetch(`${URL_BASE}${path}`, {
      ...options,
      headers: {
        apikey:         ANON_KEY,
        Authorization:  `Bearer ${s.access_token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      let payload;
      try { payload = JSON.parse(text); } catch (_) { payload = { message: text }; }
      throw new Error(payload.message || payload.error || `HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return null;
  }

  // Paginated GET. PostgREST caps a single response at `max-rows` (default
  // 1000 on Supabase), so any query returning more than that silently gets
  // truncated unless we page via Range headers. sbFetchAll loops Range
  // requests until it's pulled every row, concatenating into one array.
  //
  // Only use for SELECT reads — it's not safe to send Range with writes.
  // Path should NOT include an offset/limit that conflicts; if the caller
  // included `&limit=100000` etc. it's ignored in favour of PAGE-sized
  // Range requests.
  //
  // Response carries `Content-Range: 0-999/3085` — the `/N` suffix is the
  // true total (requires Prefer: count=exact). We stop when either:
  //   (a) we've accumulated >= total rows, or
  //   (b) a page came back short (< PAGE rows) — covers servers that don't
  //       return a count and natural end-of-data.
  async function sbFetchAll(path, options = {}) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");

    const PAGE = 1000;
    let offset = 0;
    const all = [];

    while (true) {
      const res = await fetch(`${URL_BASE}${path}`, {
        ...options,
        headers: {
          apikey:         ANON_KEY,
          Authorization:  `Bearer ${s.access_token}`,
          "Content-Type": "application/json",
          "Range-Unit":   "items",
          "Range":        `${offset}-${offset + PAGE - 1}`,
          "Prefer":       "count=exact",
          ...(options.headers || {}),
        },
      });
      // 206 Partial Content is the expected success code for ranged reads.
      if (!res.ok && res.status !== 206) {
        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); } catch (_) { payload = { message: text }; }
        throw new Error(payload.message || payload.error || `HTTP ${res.status}`);
      }
      const batch = await res.json();
      if (!Array.isArray(batch)) {
        // Server returned a single object or error-shaped body. Bail cleanly.
        return batch;
      }
      for (const row of batch) all.push(row);

      const cr = res.headers.get("Content-Range"); // e.g. "0-999/3085" or "*/0"
      let total = null;
      if (cr) {
        const slash = cr.indexOf("/");
        if (slash >= 0) {
          const n = parseInt(cr.slice(slash + 1), 10);
          if (Number.isFinite(n)) total = n;
        }
      }

      if (batch.length < PAGE) break;                  // end-of-data
      if (total != null && all.length >= total) break; // hit the known total
      offset += PAGE;
    }

    return all;
  }

  window.sb = {
    signIn,
    signOut,
    getSession,
    refreshSession,
    ensureFreshSession,
    sbFetch,
    sbFetchAll,
  };
})();
