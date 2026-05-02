// =============================================================
// Uptown billing client
// =============================================================
// Thin Stripe.js + Edge Function wrapper. Used by team.html (admin
// billing card), dashboard.html / account.html (when "+ Add Account"
// hits the seat cap), and platform-admin.html (gift seats).
//
// Public surface (window.Billing):
//   getSummary()
//     Fetches my_billing_summary. Returns the row or null.
//
//   openPurchaseModal(opts)
//     Opens the modal that lets an admin buy seats. Branches on
//     whether the org already has a Stripe subscription:
//       - No sub yet  → card form (Stripe Elements) + interval toggle
//                       + "Start 7-day trial". POSTs first_seat.
//       - Has sub     → quantity bump only, charged via saved card.
//                       No Elements required.
//     opts.minSeats   default 1; the modal preselects this many.
//     opts.title      override modal heading.
//     opts.onSuccess  invoked with the updated seats_paid total.
//
//   openPortal()
//     Generates a Stripe Customer Portal session URL and redirects
//     the operator to Stripe. They come back via the return_url.
//
// Stripe.js is loaded lazily on first use (the team.html landing
// path doesn't need it, only the modal flow does).

(function () {
  const SUPABASE_URL = window.SUPABASE_CONFIG?.url;
  const ANON_KEY     = window.SUPABASE_CONFIG?.anonKey;
  const PUB_KEY      = window.SUPABASE_CONFIG?.stripePublishableKey;

  let stripeInstance = null;
  let stripeJsLoadPromise = null;

  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (!stripeJsLoadPromise) {
      stripeJsLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://js.stripe.com/v3/";
        s.onload = () => resolve(window.Stripe);
        s.onerror = () => reject(new Error("Couldn't load Stripe.js"));
        document.head.appendChild(s);
      });
    }
    return stripeJsLoadPromise;
  }

  async function getStripe() {
    if (stripeInstance) return stripeInstance;
    if (!PUB_KEY) throw new Error("Missing STRIPE_PUBLISHABLE_KEY in window.SUPABASE_CONFIG.stripePublishableKey");
    const Stripe = await loadStripeJs();
    stripeInstance = Stripe(PUB_KEY);
    return stripeInstance;
  }

  // sbFetch wrapper that includes the user's session JWT — Edge
  // Functions resolve auth.uid() from it. Returns parsed JSON or
  // throws Error with the server's message.
  async function callFn(name, body) {
    if (!window.sb || !window.sb.sbFetch) {
      throw new Error("supabase-client.js not loaded");
    }
    return await window.sb.sbFetch(`/functions/v1/${name}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body || {}),
    });
  }

  async function getSummary() {
    if (!window.sb || !window.sb.sbFetch) return null;
    try {
      const rows = await window.sb.sbFetch("/rest/v1/rpc/my_billing_summary", {
        method: "POST",
        body:   JSON.stringify({}),
      });
      return Array.isArray(rows) ? (rows[0] || null) : null;
    } catch {
      return null;
    }
  }

  // ── Modal infrastructure ────────────────────────────────────
  function ensureModalRoot() {
    let root = document.getElementById("uptown-billing-modal-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "uptown-billing-modal-root";
      document.body.appendChild(root);
    }
    return root;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, ch => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    })[ch]);
  }

  function closeModal() {
    const root = document.getElementById("uptown-billing-modal-root");
    if (root) root.innerHTML = "";
  }

  // ── Purchase modal ──────────────────────────────────────────
  async function openPurchaseModal(opts = {}) {
    const minSeats = Math.max(1, Number(opts.minSeats) || 1);
    const title    = opts.title || "Add seats";
    const onSuccess = opts.onSuccess || (() => {});

    // Resolve current state up front so the modal can render the
    // right path (card form vs quantity bump).
    const summary = await getSummary();
    if (!summary) {
      alert("Couldn't load billing info. Refresh and try again.");
      return;
    }
    if (!summary.is_admin) {
      alert("Only organization admins can purchase seats. Ask your admin to add more.");
      return;
    }

    const isFirstPurchase = !summary.has_subscription;

    // Render
    const root = ensureModalRoot();
    root.innerHTML = `
      <div class="ub-modal-backdrop">
        <div class="ub-modal" role="dialog" aria-labelledby="ub-title">
          <div class="ub-modal-head">
            <h2 id="ub-title">${escapeHtml(title)}</h2>
            <button type="button" class="ub-modal-close" aria-label="Close">×</button>
          </div>

          <div class="ub-modal-body">
            ${isFirstPurchase ? `
              <p class="ub-modal-intro">Start with a <strong>7-day free trial</strong>. We'll save your card and charge after the trial ends.</p>

              <div class="ub-interval-toggle" role="radiogroup" aria-label="Billing interval">
                <label class="ub-interval-opt">
                  <input type="radio" name="ub-interval" value="month" checked />
                  <span class="ub-interval-name">Monthly</span>
                  <span class="ub-interval-price">$15 per seat / month</span>
                </label>
                <label class="ub-interval-opt">
                  <input type="radio" name="ub-interval" value="year" />
                  <span class="ub-interval-name">Annual</span>
                  <span class="ub-interval-price">$120 per seat / year <em>(save 33%)</em></span>
                </label>
              </div>
            ` : `
              <p class="ub-modal-intro">You'll be charged a prorated amount today on your card ending in
                ${summary.has_payment_method ? "your saved card" : ""}, and your next invoice will reflect the new seat count.</p>
            `}

            <div class="ub-qty-row">
              <label class="ub-qty-label">Seats to add</label>
              <div class="ub-qty-control">
                <button type="button" class="ub-qty-btn" data-step="-1">−</button>
                <input type="number" class="ub-qty-input" min="1" value="${minSeats}" />
                <button type="button" class="ub-qty-btn" data-step="1">+</button>
              </div>
            </div>

            <div class="ub-summary" id="ub-summary"></div>

            ${isFirstPurchase ? `
              <div class="ub-card-row">
                <label class="ub-card-label">Card details</label>
                <div id="ub-card-element" class="ub-card-element"></div>
                <div id="ub-card-error" class="ub-card-error" role="alert"></div>
              </div>
            ` : ""}
          </div>

          <div class="ub-modal-foot">
            <button type="button" class="ub-btn ub-btn-secondary" data-action="cancel">Cancel</button>
            <button type="button" class="ub-btn ub-btn-primary" data-action="confirm">
              ${isFirstPurchase ? "Start free trial" : "Purchase"}
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire UI
    const qtyInput = root.querySelector(".ub-qty-input");
    const summaryEl = root.querySelector("#ub-summary");
    const errorEl   = root.querySelector("#ub-card-error");
    const confirmBtn = root.querySelector("[data-action='confirm']");

    function updateSummary() {
      const qty = Math.max(1, Number(qtyInput.value) || 1);
      qtyInput.value = qty;
      const interval = isFirstPurchase
        ? root.querySelector("input[name='ub-interval']:checked")?.value || "month"
        : (summary.billing_interval || "month");
      const unitPrice = interval === "year" ? 120 : 15;
      const periodLabel = interval === "year" ? "/year" : "/month";
      const total = qty * unitPrice;
      summaryEl.innerHTML = `
        <div class="ub-summary-line">
          ${qty} seat${qty === 1 ? "" : "s"} × $${unitPrice}${periodLabel}
        </div>
        <div class="ub-summary-total">$${total}${periodLabel}</div>
      `;
    }
    updateSummary();

    qtyInput.addEventListener("input", updateSummary);
    root.querySelectorAll(".ub-qty-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const step = Number(btn.dataset.step) || 0;
        qtyInput.value = Math.max(1, (Number(qtyInput.value) || 1) + step);
        updateSummary();
      });
    });
    if (isFirstPurchase) {
      root.querySelectorAll("input[name='ub-interval']").forEach(r => r.addEventListener("change", updateSummary));
    }

    root.querySelector(".ub-modal-close").addEventListener("click", closeModal);
    root.querySelector("[data-action='cancel']").addEventListener("click", closeModal);

    // Mount Stripe Elements for first-purchase flow
    let cardElement = null;
    let elements    = null;
    if (isFirstPurchase) {
      try {
        const stripe = await getStripe();
        elements = stripe.elements({ appearance: { theme: "stripe" } });
        cardElement = elements.create("card", {
          style: {
            base: {
              fontSize:  "16px",
              fontFamily:"Inter, system-ui, sans-serif",
              color:     "#013A52",
              "::placeholder": { color: "#8899a6" },
            },
            invalid: { color: "#c0392b" },
          },
        });
        cardElement.mount("#ub-card-element");
        cardElement.on("change", (e) => {
          errorEl.textContent = e.error?.message || "";
        });
      } catch (err) {
        errorEl.textContent = "Couldn't load payment form: " + (err.message || err);
      }
    }

    // Confirm
    confirmBtn.addEventListener("click", async () => {
      const qty = Math.max(1, Number(qtyInput.value) || 1);
      const interval = isFirstPurchase
        ? root.querySelector("input[name='ub-interval']:checked")?.value || "month"
        : (summary.billing_interval || "month");

      confirmBtn.disabled = true;
      const prevLabel = confirmBtn.textContent;
      confirmBtn.textContent = "Processing…";

      try {
        if (isFirstPurchase) {
          const stripe = await getStripe();
          // 1. Create subscription on the server (returns client_secret
          //    of the pending SetupIntent — Stripe collects card without
          //    charging during the 7-day trial).
          const init = await callFn("stripe-billing-init", {
            action: "first_seat",
            qty,
            interval,
          });
          if (!init?.client_secret) {
            throw new Error(init?.error || "Couldn't initialize subscription");
          }
          // 2. Confirm card with Stripe Elements.
          const result = await stripe.confirmCardSetup(init.client_secret, {
            payment_method: { card: cardElement },
          });
          if (result.error) {
            throw new Error(result.error.message || "Card declined");
          }
        } else {
          await callFn("stripe-billing-init", { action: "add_seat", qty });
        }

        // Brief poll: webhook may take a moment to write the new
        // seats_purchased. Try up to 10× (3s total). After that we
        // hand back the latest summary anyway — caller can re-poll.
        let updated = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 300));
          const s = await getSummary();
          if (s && s.seats_paid >= (summary.seats_paid + qty)) {
            updated = s; break;
          }
          updated = s;
        }
        closeModal();
        onSuccess(updated || (await getSummary()));
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = prevLabel;
        if (errorEl) errorEl.textContent = err.message || String(err);
        else alert(err.message || String(err));
      }
    });
  }

  // ── Stripe Customer Portal redirect ─────────────────────────
  async function openPortal() {
    const summary = await getSummary();
    if (!summary?.is_admin) {
      alert("Only admins can manage billing.");
      return;
    }
    if (!summary.has_payment_method) {
      alert("No active subscription yet — purchase a seat first.");
      return;
    }
    try {
      const r = await callFn("stripe-billing-portal", {
        return_url: window.location.href,
      });
      if (r?.url) window.location.assign(r.url);
    } catch (err) {
      alert("Couldn't open billing portal: " + (err.message || err));
    }
  }

  window.Billing = {
    getSummary,
    openPurchaseModal,
    openPortal,
    callFn,
  };
})();
