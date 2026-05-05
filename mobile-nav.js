// /mobile-nav.js
//
// Mobile-only UX helpers shared across operator-console pages:
//
//   1. Hamburger drawer — the header's right-cluster (Guides, Team,
//      Platform admin, Chrome ext, email, Sign out) collapses into a
//      slide-in drawer below the 800px breakpoint. Triggered by a
//      hamburger button the script appends to .header-right.
//
//   2. Pill → select — any .timeframe-pills container becomes a
//      <select> dropdown on mobile (kept in sync via MutationObserver
//      so existing click handlers on pills are the source of truth).
//      Same treatment for .sub-tabs containers.
//
// Include with <script src="/mobile-nav.js" defer></script> on every
// operator-console page that uses .header / .header-right (dashboard,
// account, team, platform-admin).
//
// CSS for the drawer + mobile-only select visibility lives in app.css.

(function () {
  // ============================================================
  // 1. Header hamburger drawer
  // ============================================================
  function setupHeaderDrawer() {
    const header = document.querySelector('header.header');
    if (!header) return;
    const right  = header.querySelector('.header-right');
    if (!right || !right.children.length) return;

    // Hamburger button — sits inside .header-right so it occupies the
    // far-right slot the original cluster used. CSS rules in app.css
    // hide the original cluster + show the hamburger only below 800px.
    const hamburger = document.createElement('button');
    hamburger.type = 'button';
    hamburger.className = 'header-hamburger';
    hamburger.setAttribute('aria-label', 'Open menu');
    hamburger.setAttribute('aria-controls', 'header-drawer');
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
        '<line x1="3" y1="6"  x2="21" y2="6"/>' +
        '<line x1="3" y1="12" x2="21" y2="12"/>' +
        '<line x1="3" y1="18" x2="21" y2="18"/>' +
      '</svg>';
    right.appendChild(hamburger);

    const backdrop = document.createElement('div');
    backdrop.className = 'header-drawer-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);

    const drawer = document.createElement('aside');
    drawer.id = 'header-drawer';
    drawer.className = 'header-drawer';
    drawer.setAttribute('aria-label', 'Menu');
    drawer.innerHTML =
      '<button class="header-drawer-close" type="button" aria-label="Close menu">&times;</button>' +
      '<div class="header-drawer-items"></div>';
    document.body.appendChild(drawer);

    const items = drawer.querySelector('.header-drawer-items');

    // Mirror the contents of .header-right into the drawer. Re-runs
    // when right-cluster classes change (e.g. team-link reveal post
    // role-probe, chrome-ext-link reveal once the URL is set).
    function mirrorItems() {
      items.innerHTML = '';
      Array.from(right.children).forEach(orig => {
        if (orig === hamburger) return;
        if (orig.classList.contains('hidden')) return;

        const clone = orig.cloneNode(true);
        clone.removeAttribute('id');

        // Sign-out button: clicking the drawer's clone delegates to
        // the original button's click handler (Auth.wireSignOut
        // attached it via id="signout-btn", which we just stripped
        // from the clone). The original is display:none on mobile
        // but programmatic .click() still fires its listeners.
        if (orig.id === 'signout-btn') {
          clone.addEventListener('click', e => {
            e.preventDefault();
            orig.click();
          });
        }
        if (orig.id === 'user-email') {
          clone.classList.add('header-drawer-email');
        }
        items.appendChild(clone);
      });
    }
    mirrorItems();

    new MutationObserver(mirrorItems).observe(right, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class'],
    });

    function openDrawer() {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      document.body.classList.add('header-drawer-open');
      hamburger.setAttribute('aria-expanded', 'true');
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      document.body.classList.remove('header-drawer-open');
      hamburger.setAttribute('aria-expanded', 'false');
    }

    hamburger.addEventListener('click', openDrawer);
    backdrop .addEventListener('click', closeDrawer);
    drawer.querySelector('.header-drawer-close').addEventListener('click', closeDrawer);

    drawer.addEventListener('click', e => {
      if (e.target.closest('a')) setTimeout(closeDrawer, 50);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 800 && drawer.classList.contains('open')) closeDrawer();
    });
  }

  // ============================================================
  // 2. Pill → mobile <select>
  // ============================================================
  // Build a hidden-on-desktop <select> that mirrors any pill-style
  // toggle group. CSS shows the select / hides the pills below 800px.
  // We keep the two in sync: select.change() fires the pill's click
  // (so existing handlers remain the source of truth), and a
  // MutationObserver on the pills' .active class updates the select
  // when a pill's active state changes via other code paths.
  function mirrorPillsToSelect(container, opts) {
    const pillSel  = opts.pillSel;
    const dataAttr = opts.dataAttr;

    const pills = Array.from(container.querySelectorAll(pillSel));
    if (!pills.length) return;

    const select = document.createElement('select');
    select.className = 'mobile-pill-select';
    select.setAttribute('aria-label', container.getAttribute('aria-label') || opts.label || 'Select');

    pills.forEach(pill => {
      const opt = document.createElement('option');
      opt.value = pill.dataset[dataAttr];
      opt.textContent = pill.textContent.trim();
      if (pill.classList.contains('active')) opt.selected = true;
      select.appendChild(opt);
    });

    container.parentNode.insertBefore(select, container.nextSibling);

    select.addEventListener('change', () => {
      const pill = pills.find(p => p.dataset[dataAttr] === select.value);
      if (pill) pill.click();
    });

    new MutationObserver(() => {
      const active = container.querySelector(pillSel + '.active');
      if (active && select.value !== active.dataset[dataAttr]) {
        select.value = active.dataset[dataAttr];
      }
    }).observe(container, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  function setupMobileSelects() {
    document.querySelectorAll('.timeframe-pills').forEach(c =>
      mirrorPillsToSelect(c, { pillSel: '.timeframe-pill', dataAttr: 'tf',  label: 'Timeframe' })
    );
    document.querySelectorAll('.sub-tabs').forEach(c =>
      mirrorPillsToSelect(c, { pillSel: '.sub-tab',        dataAttr: 'tab', label: 'Section'   })
    );
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    setupHeaderDrawer();
    setupMobileSelects();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
