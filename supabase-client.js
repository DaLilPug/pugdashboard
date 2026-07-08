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

  // A share-link tab keeps its (synthetic, single-account) session in
  // sessionStorage so it never clobbers the operator's real session in
  // localStorage - and a real session in another tab stays put. We prefer
  // the per-tab session when present; with no sessionStorage session this
  // is byte-for-byte the old localStorage behavior.
  function sessionStore() {
    return sessionStorage.getItem(STORAGE_KEY) ? sessionStorage : localStorage;
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function setSession(session) {
    sessionStore().setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    sessionStore().removeItem(STORAGE_KEY);
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

  // Create a new Supabase auth account from the login page's signup mode.
  //
  // On success Supabase returns one of two shapes, depending on the
  // project's "Confirm email" setting:
  //
  //   - Confirm email OFF: response includes access_token + refresh_token
  //     and we can drop the user straight onto the dashboard. This is
  //     what we want for Phase C slice 1 (no email infrastructure yet).
  //
  //   - Confirm email ON: response has user but no tokens, and the
  //     session field is null until the user clicks the email link.
  //     We return { session: null } so the caller can show a
  //     "check your inbox" message instead of redirecting.
  //
  // options.name → stored on auth.users.raw_user_meta_data.name, where
  // the handle_new_auth_user trigger picks it up as the operators.name.
  async function signUp(email, password, options = {}) {
    const body = { email, password };
    if (options.name) {
      body.data = { name: options.name };
    }
    const res = await fetch(`${URL_BASE}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey:         ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Dump the full response into the console so the operator can see
      // what actually went wrong even if our fallback chain didn't
      // catch the field name GoTrue used. The message shown to the
      // user is built from whichever known field is populated; if
      // none are, we include the HTTP status + error_code so the
      // signal isn't just "Sign-up failed".
      console.error("signUp failed:", { status: res.status, body: data });
      const msg =
        data.msg ||
        data.message ||
        data.error_description ||
        data.error ||
        data.error_code ||
        `Sign-up failed (HTTP ${res.status})`;
      throw new Error(msg);
    }
    // Newer GoTrue nests tokens under `session`; older versions return
    // them at the top level. Handle both.
    const tokenSource = data.session || data;
    if (tokenSource.access_token && tokenSource.refresh_token) {
      const session = {
        access_token:  tokenSource.access_token,
        refresh_token: tokenSource.refresh_token,
        user:          data.user || tokenSource.user,
        expires_at:    Date.now() + ((tokenSource.expires_in || 3600) * 1000),
      };
      setSession(session);
      return { session, needsConfirmation: false };
    }
    // Confirm-email mode — no session yet.
    return { session: null, needsConfirmation: true, user: data.user };
  }

  // After a dashboard-side refresh, hand the rotated session to the Chrome
  // extension. Sends the SAME "session_handshake" message the login page's
  // SSO flow sends, so fielded extension builds accept it unchanged (their
  // background.js validates the app.uptown.com origin and message shape).
  //
  // Why: the login handshake copies this browser's session into the
  // extension, so both hold ONE refresh token. Supabase rotates refresh
  // tokens on use - when the dashboard refreshes first, the extension's
  // stored copy is revoked and its next refresh gets a 400, dropping it to
  // the signed-out bar even though this browser is still signed in. Pushing
  // each rotation keeps the extension's copy current.
  //
  // Best-effort and fire-and-forget: non-Chrome browsers, no extension
  // installed, or a share-link tab (synthetic single-account session in
  // sessionStorage - must never overwrite the operator's real extension
  // session) all no-op silently.
  //
  // Dev escape hatch: an unpacked dev build has a random id. Setting
  // localStorage.uptown_dev_ext_id (validated against the extension id
  // charset) adds it as a push target. localStorage requires same-origin
  // script access to set, so this doesn't reopen the phishing-link vector
  // the login page's URL-param validation guards against.
  const PUSH_EXTENSION_IDS = (() => {
    const ids = [];
    try {
      const dev = localStorage.getItem("uptown_dev_ext_id");
      if (dev && /^[a-p]{32}$/.test(dev)) ids.push(dev);
    } catch (_) {}
    ids.push("oiojmfjjdgpjpanoienjmnoigjpjlhlc"); // published store build
    return ids;
  })();

  function pushSessionToExtension(session) {
    try {
      if (sessionStorage.getItem(STORAGE_KEY)) return; // share-link tab
      if (typeof chrome === "undefined"
          || !chrome.runtime
          || !chrome.runtime.sendMessage) return;
      const payload = {
        type: "session_handshake",
        session: {
          access_token:  session.access_token,
          refresh_token: session.refresh_token,
          user:          session.user || null,
          expires_at:    session.expires_at,
        },
      };
      for (const id of PUSH_EXTENSION_IDS) {
        try {
          chrome.runtime.sendMessage(id, payload, () => {
            // Touch lastError so Chrome doesn't log "Unchecked
            // runtime.lastError" when the extension isn't installed.
            void chrome.runtime.lastError;
          });
        } catch (_) { /* id unreachable - fine, best effort */ }
      }
    } catch (_) { /* never let a push failure break the refresh */ }
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
    // Keep the extension's copy of this session family current - see
    // pushSessionToExtension above.
    pushSessionToExtension(session);
    return session;
  }

  // Returns a fresh session or null. Refreshes if access token expires
  // within 60 seconds. Also backfills session.user if missing - this
  // can happen for OAuth signups where the callback hash doesn't
  // carry user data; downstream code that reads session.user.id
  // (e.g. team page's admin-org probe) would otherwise see undefined.
  async function ensureFreshSession() {
    let s = getSession();
    if (!s) return null;
    if (Date.now() > (s.expires_at - 60_000)) {
      try { s = await refreshSession(); }
      catch (_) { return null; }
    }
    // Self-heal: backfill session.user if it's null (e.g. an older
    // OAuth signup stored before the login page started fetching it
    // up-front). One-shot lookup against /auth/v1/user; on success
    // we persist so this fast-paths next call.
    if (!s.user && s.access_token) {
      try {
        const res = await fetch(`${URL_BASE}/auth/v1/user`, {
          headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}` },
        });
        if (res.ok) {
          s = { ...s, user: await res.json() };
          setSession(s);
        }
      } catch (_) { /* leave session.user null; next call retries */ }
    }
    return s;
  }

  // Trigger Supabase's password-recovery flow. Sends an email containing
  // a one-time link that, when clicked, redirects the user to the
  // `redirectTo` URL with a recovery session embedded in the URL hash.
  // The /reset/ page parses that hash, calls setSessionFromTokens, and
  // shows a "set new password" form that calls updatePassword().
  //
  // Note: Supabase silently no-ops if the email isn't a real user (so an
  // attacker can't enumerate accounts). The UI says "if your email is on
  // file, a link is on its way" regardless of outcome.
  async function resetPasswordForEmail(email, redirectTo) {
    const res = await fetch(`${URL_BASE}/auth/v1/recover`, {
      method: "POST",
      headers: {
        apikey:         ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, redirect_to: redirectTo }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        data.error_description || data.msg || data.error || "Couldn't send reset email"
      );
    }
  }

  // Update the signed-in user's password. Used by the /reset/ page after
  // the user lands from a recovery link with a session in URL hash.
  async function updatePassword(newPassword) {
    const s = await ensureFreshSession();
    if (!s?.access_token) throw new Error("Not signed in");
    const res = await fetch(`${URL_BASE}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey:         ANON_KEY,
        Authorization:  `Bearer ${s.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        data.error_description || data.msg || data.error || "Couldn't update password"
      );
    }
    return data;
  }

  // Stash a session that came from outside the normal sign-in flow (the
  // recovery URL Supabase redirects to has the access + refresh tokens
  // in the URL hash; the /reset/ page reads them and calls this).
  // Also used by the OAuth callback on /login/.
  function setSessionFromTokens({ access_token, refresh_token, expires_in, user }, opts = {}) {
    const session = {
      access_token,
      refresh_token,
      user: user || null,
      expires_at: Date.now() + ((expires_in || 3600) * 1000),
    };
    // ephemeral -> store only in this tab's sessionStorage (share-link
    // sessions), leaving the operator's real localStorage session intact.
    if (opts.ephemeral) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else setSession(session);
    return session;
  }

  // Kick off an OAuth sign-in. Navigates the browser to Supabase's
  // authorize endpoint; Supabase handles the round-trip with the
  // provider (Google, etc.) and bounces back to `redirectTo` with
  // tokens in the URL hash. The landing page (typically /login/)
  // parses the hash and calls setSessionFromTokens.
  function signInWithProvider(provider, redirectTo) {
    const params = new URLSearchParams({
      provider,
      redirect_to: redirectTo || `${location.origin}/login/`,
    });
    window.location.href = `${URL_BASE}/auth/v1/authorize?${params.toString()}`;
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

  // --- Storage helpers ----------------------------------------------
  //
  // Used by the Assets tab's Attachments card. The client-attachments
  // bucket is PRIVATE; access is gated by the same has_client_access()
  // RLS operators (and scoped share-link users) already pass. Object
  // paths are '<client_id>/<uuid>_<filename>'.

  async function storageUpload(bucket, path, file) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");
    const res = await fetch(
      `${URL_BASE}/storage/v1/object/${bucket}/${encodeURI(path)}`,
      {
        method: "POST",
        headers: {
          apikey:         ANON_KEY,
          Authorization:  `Bearer ${s.access_token}`,
          "Content-Type": file.type || "application/octet-stream",
          "x-upsert":     "true",
        },
        body: file,
      }
    );
    if (!res.ok) {
      const text = await res.text();
      let payload; try { payload = JSON.parse(text); } catch (_) { payload = { message: text }; }
      throw new Error(payload.message || payload.error || `Upload failed (HTTP ${res.status})`);
    }
    return res.json().catch(() => ({}));
  }

  // Short-lived signed URL for downloading a private object.
  async function storageSignedUrl(bucket, path, expiresIn = 3600) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");
    const res = await fetch(
      `${URL_BASE}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`,
      {
        method: "POST",
        headers: {
          apikey:         ANON_KEY,
          Authorization:  `Bearer ${s.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "Couldn't sign download URL");
    // data.signedURL is like "/object/sign/<bucket>/<path>?token=…"
    return `${URL_BASE}/storage/v1${data.signedURL}`;
  }

  // Delete objects. Best-effort - a failed cleanup shouldn't block a save.
  async function storageRemove(bucket, paths) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");
    try {
      const res = await fetch(`${URL_BASE}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: {
          apikey:         ANON_KEY,
          Authorization:  `Bearer ${s.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: paths }),
      });
      return res.ok;
    } catch (_) { return false; }
  }

  // --- Edge Functions ----------------------------------------------
  //
  // Invoke a Supabase Edge Function as the signed-in operator. Used by
  // the account page's Share button (share-admin). share-login is NOT
  // called through here - visitors have no session yet, so the /share/
  // page calls it directly with just the anon key.
  async function invokeFunction(name, body) {
    const s = await ensureFreshSession();
    if (!s) throw new Error("Not signed in");
    const res = await fetch(`${URL_BASE}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        apikey:         ANON_KEY,
        Authorization:  `Bearer ${s.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }

  window.sb = {
    signIn,
    signUp,
    invokeFunction,
    signOut,
    signInWithProvider,
    resetPasswordForEmail,
    updatePassword,
    setSessionFromTokens,
    getSession,
    refreshSession,
    ensureFreshSession,
    sbFetch,
    sbFetchAll,
    storageUpload,
    storageSignedUrl,
    storageRemove,
  };

  // --- Share-link scope guard ---------------------------------------
  // A share-link session is a synthetic single-account user. It should
  // only ever see /share (the entry page) and /account (its one account).
  // If such a session lands anywhere else - /dashboard, /team,
  // /platform-admin, a stale bookmark - bounce it to its account. Normal
  // sessions are untouched (the is_share_user check returns early).
  (function shareScopeGuard() {
    const path = location.pathname;
    if (/^\/(share|account)(\/|$)/.test(path)) return; // allowed surfaces
    (async () => {
      let s;
      try { s = await ensureFreshSession(); } catch (_) { return; }
      if (!s) return;
      const meta = s.user && s.user.user_metadata;
      if (!meta || !meta.is_share_user) return; // only acts on share sessions
      try {
        const rows = await sbFetch("/rest/v1/clients?select=id&limit=1");
        const id = Array.isArray(rows) && rows[0] && rows[0].id;
        if (id) { location.replace("/account/?id=" + encodeURIComponent(id)); return; }
      } catch (_) { /* fall through to sign-out */ }
      // Share session with no reachable account (e.g. link revoked): sign out.
      clearSession();
      location.replace("/login/");
    })();
  })();
})();
