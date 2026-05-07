// Supabase connection constants for the dashboard.
//
// The anon key is public by design — access is controlled by Row-Level
// Security in the database. Safe to ship to the browser and commit to
// the repo.
//
// Do NOT put the service_role key here. That key bypasses RLS and must
// never leave your Supabase dashboard.

window.SUPABASE_CONFIG = {
  url:     "https://svikzdeqovrtrxsqmnbv.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2aWt6ZGVxb3ZydHJ4c3FtbmJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4ODU3MzMsImV4cCI6MjA5MjQ2MTczM30.6Diul_oHOUT3ENkCDjYO4U9EP785Gsdn1iNbpICHF_Y",
  // Stripe publishable key — safe to ship to the browser. Live key
  // begins with pk_live_, test key with pk_test_. Set this when
  // Stripe is configured (see BILLING_SETUP.md).
  stripePublishableKey: "pk_live_GnliOtGC76yQtYsV59tPjQga",
  // Chrome Web Store URL for the Uptown Tracker extension. Empty
  // string hides the "Get the Chrome extension" link in the
  // dashboard header. The dashboard's reveal-on-load JS reads this
  // and unhides #chrome-ext-link when it's non-empty.
  chromeExtensionUrl: "https://chromewebstore.google.com/detail/uptown-%E2%80%94-linkedin-outreac/oiojmfjjdgpjpanoienjmnoigjpjlhlc",
};
