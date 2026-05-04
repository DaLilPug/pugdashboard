// Page-level auth helpers.
//
// At the top of any protected page:
//   <script src="config.js"></script>
//   <script src="supabase-client.js"></script>
//   <script src="auth.js"></script>
//   <script>
//     Auth.requireAuth().then(session => { /* page init */ });
//   </script>
//
// requireAuth() resolves with a session or redirects to /login/
// (returning a never-resolving promise so downstream code doesn't run
// on a page that's already leaving).

(function () {
  const LOGIN_PAGE = "/login/";

  async function requireAuth() {
    const session = await sb.ensureFreshSession();
    if (!session) {
      window.location.replace(LOGIN_PAGE);
      return new Promise(() => {}); // never resolves; page is unloading
    }
    return session;
  }

  async function signOutAndRedirect() {
    try { await sb.signOut(); }
    finally { window.location.replace(LOGIN_PAGE); }
  }

  // Wire a sign-out button by selector. No-op if not present.
  function wireSignOut(selector = "#signout-btn") {
    const btn = document.querySelector(selector);
    if (!btn) return;
    btn.addEventListener("click", e => {
      e.preventDefault();
      signOutAndRedirect();
    });
  }

  // Populate a user-email label by selector.
  function wireUserEmail(session, selector = "#user-email") {
    const el = document.querySelector(selector);
    if (el && session?.user?.email) el.textContent = session.user.email;
  }

  // Is the signed-in operator a platform admin? Pages call this to
  // decide whether to render the "Platform admin" nav link and gate
  // drill-in mode. Cached for the tab's lifetime — platform admin
  // status doesn't change mid-session in normal use, and a stale
  // `true` is caught by server-side RLS on every write anyway.
  //
  // Implemented as a tiny RPC (see add_platform_admin_rpcs.sql) so
  // the client doesn't need to parse an empty-rows-from-platform_admins
  // response as "not an admin".
  let _platformAdminCache;          // undefined = not resolved
  async function isPlatformAdmin() {
    if (_platformAdminCache !== undefined) return _platformAdminCache;
    try {
      const res = await sb.sbFetch("/rest/v1/rpc/am_i_platform_admin", {
        method: "POST",
        body:   JSON.stringify({}),
      });
      // PostgREST returns the scalar directly (true/false).
      _platformAdminCache = res === true;
    } catch (err) {
      // Don't block the page on a probe failure — just treat as
      // not-an-admin. The nav link stays hidden; if someone tried
      // to hit /platform-admin/ directly, its own guard fires.
      console.warn("isPlatformAdmin probe failed:", err);
      _platformAdminCache = false;
    }
    return _platformAdminCache;
  }

  window.Auth = {
    requireAuth,
    signOutAndRedirect,
    wireSignOut,
    wireUserEmail,
    isPlatformAdmin,
  };
})();
