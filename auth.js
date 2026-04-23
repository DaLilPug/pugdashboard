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
// requireAuth() resolves with a session or redirects to login.html
// (returning a never-resolving promise so downstream code doesn't run
// on a page that's already leaving).

(function () {
  const LOGIN_PAGE = "login.html";

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

  window.Auth = {
    requireAuth,
    signOutAndRedirect,
    wireSignOut,
    wireUserEmail,
  };
})();
