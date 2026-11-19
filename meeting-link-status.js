// How an account's meeting bookings reach the Tracker.
//
// One definition, used by the Meeting Links tab on the account page and
// by the Integration column on the dashboard, so the two can never
// disagree. Nothing here is typed in by hand: it is read off the
// account's meeting links.
//
// A meeting link gets its bookings ONE of three ways (never two: a
// HubSpot or Calendly connection on the link wins over Zapier):
//   - a HubSpot connection listening on one HubSpot meeting link
//   - a Calendly connection listening on one event type
//   - Zapier: the account's own Zap posts each booking with its API key
//
// "live" means bookings are really arriving that way: HubSpot and
// Calendly once the connection knows what to listen on, Zapier once a
// first booking has come in.
(function () {
  "use strict";

  // The way ONE meeting link is tracked: an array with one entry, or
  // none. `integ` is the integrations row the link is bound to, or null.
  function linkMethods(link, integ) {
    if (integ) {
      const sr = integ.selected_resource || {};
      if (integ.provider === "calendly") {
        return [{ method: "Calendly", live: !!sr.event_type_uri, waiting: "not set up" }];
      }
      if (integ.provider === "hubspot") {
        return [{ method: "HubSpot", live: !!sr.link_id, waiting: "not set up" }];
      }
    }
    if (link && link.method === "zapier") {
      return [{ method: "Zapier", live: !!link.zapier_last_booking_at, waiting: "waiting for first booking" }];
    }
    return [];
  }

  // The account-level summary: every method that is live ("HubSpot,
  // Zapier"), else the first one still being set up, else Not Integrated.
  function accountStatus(links, integrationsById) {
    const live = [], pending = [];
    for (const link of (links || [])) {
      const integ = link.integration_id ? (integrationsById || {})[link.integration_id] : null;
      for (const m of linkMethods(link, integ || null)) (m.live ? live : pending).push(m);
    }
    const names = ["HubSpot", "Calendly", "Zapier"].filter(n => live.some(m => m.method === n));
    if (names.length) return { text: names.join(", "), live: true };
    if (pending.length) return { text: pending[0].method + " - " + pending[0].waiting, live: false };
    return { text: "Not Integrated", live: false };
  }

  window.meetingLinkStatus = { linkMethods, accountStatus };
})();
