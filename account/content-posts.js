// Posts tab: write, review, approve, schedule and publish LinkedIn posts.
//
// One page for two readers. The client (a share-link visitor) sees each post
// from "waiting for approval" on, can approve it, edit it, and highlight any
// words to comment on them. The team also sees drafts, writes posts in a
// composer that looks like LinkedIn's, schedules and publishes them, and can
// add the link of a post that went live some other way.
//
// Data: content_posts (+ content_posts_latest for numbers) and
// content_post_comments, both gated by has_client_access; drafts are hidden
// from share-link visitors by the table's own rules. Images sit in the private
// client-attachments bucket under <client_id>/content/. Publishing goes
// through the linkedin-content function. See add_content_posts_workflow.sql.
(function () {
  "use strict";

  const BUCKET = "client-attachments";
  const MAX_CHARS = 3000;       // LinkedIn's limit for a post
  const MAX_IMAGES = 20;
  const POSTED_PAGE = 10;

  let S = null;

  // ---- small helpers ----------------------------------------------------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T12:00:00") : new Date(v));
  const fmtDate = (v) => {
    if (!v) return "";
    const x = toDate(v);
    return `${x.getMonth() + 1}/${x.getDate()}/${String(x.getFullYear()).slice(2)}`;
  };
  const fmtTime = (v) => new Date(v).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtDay = (v) => toDate(v).toLocaleDateString([], { weekday: "short" });
  const num = (n) => Number(n || 0).toLocaleString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const cid = () => encodeURIComponent(S.clientId);
  const postById = (id) => S.posts.find((p) => p.id === id);

  function toast(msg, bad) {
    const t = document.createElement("div");
    t.className = "cp-toast" + (bad ? " cp-toast-bad" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("cp-toast-on"), 10);
    setTimeout(() => { t.classList.remove("cp-toast-on"); setTimeout(() => t.remove(), 300); }, bad ? 6000 : 2600);
  }

  // ---- who the posts go out as -------------------------------------------
  function profile() {
    const m = (S.integ && S.integ.scope_metadata) || {};
    return { name: m.member_name || S.clientName || "", picture: m.member_picture || "", headline: m.member_headline || "" };
  }
  function canPublish() {
    const m = (S.integ && S.integ.scope_metadata) || {};
    return String(m.granted_scope || "").includes("w_member_social");
  }
  function avatarHtml(cls) {
    const p = profile();
    if (p.picture) return `<img class="cp-avatar ${cls || ""}" src="${esc(p.picture)}" alt="" />`;
    const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "in";
    return `<div class="cp-avatar cp-avatar-initials ${cls || ""}">${esc(initials)}</div>`;
  }

  // ---- loading -------------------------------------------------------------
  async function load() {
    const [posts, comments, integ] = await Promise.all([
      sb.sbFetch(`/rest/v1/content_posts_latest?select=*&client_id=eq.${cid()}&order=created_at.asc`),
      sb.sbFetch(`/rest/v1/content_post_comments?select=*&client_id=eq.${cid()}&order=created_at.asc`),
      sb.sbFetch(`/rest/v1/integrations?select=id,scope_metadata&client_id=eq.${cid()}&purpose=eq.content_analytics&limit=1`).catch(() => []),
    ]);
    S.posts = posts || [];
    S.comments = comments || [];
    S.integ = (integ && integ[0]) || null;
  }

  async function patchPost(id, fields) {
    const rows = await sb.sbFetch(`/rest/v1/content_posts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields),
    });
    if (!rows || !rows.length) throw new Error("That change was not saved. Refresh the page and try again.");
    Object.assign(postById(id) || {}, rows[0]);
    return rows[0];
  }

  // ---- images ----------------------------------------------------------------
  function signedUrl(path) {
    if (!S.urls[path]) {
      S.urls[path] = sb.storageSignedUrl(BUCKET, path, 6 * 3600).catch(() => "");
    }
    return S.urls[path];
  }
  function hydrateImages(scope) {
    scope.querySelectorAll("img[data-path]").forEach(async (img) => {
      const url = await signedUrl(img.dataset.path);
      if (url) img.src = url;
    });
  }
  function imagesHtml(images) {
    if (!images || !images.length) return "";
    const n = images.length, shown = images.slice(0, 5);
    const cells = shown.map((im, i) => {
      const more = i === 4 && n > 5 ? `<span class="cp-img-more">+${n - 5}</span>` : "";
      return `<div class="cp-img">${more}<img data-path="${esc(im.path)}" alt="${esc(im.alt || "")}" /></div>`;
    }).join("");
    return `<div class="cp-imgs cp-imgs-${Math.min(n, 5)}">${cells}</div>`;
  }

  // ---- post text, with the commented passages highlighted --------------------
  function rich(s) {
    return esc(s)
      .replace(/(^|\s)(#[A-Za-z]\w*)/g, '$1<span class="cp-blue">$2</span>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<span class="cp-blue">$1</span>');
  }
  function locate(body, quote, start) {
    if (!quote) return -1;
    if (start != null && body.substr(start, quote.length) === quote) return start;
    let best = -1, i = body.indexOf(quote);
    while (i !== -1) {
      if (best === -1 || Math.abs(i - (start || 0)) < Math.abs(best - (start || 0))) best = i;
      i = body.indexOf(quote, i + 1);
    }
    return best;
  }
  function threadsFor(postId) {
    const all = S.comments.filter((c) => c.post_id === postId);
    return all.filter((c) => !c.thread_id).map((root) => ({ root, replies: all.filter((c) => c.thread_id === root.id) }));
  }
  function bodyHtml(post) {
    const body = post.body || "";
    const ranges = [];
    threadsFor(post.id).forEach((t) => {
      if (t.root.resolved_at || !t.root.quote) return;
      const s = locate(body, t.root.quote, t.root.quote_start);
      if (s >= 0) ranges.push({ s, e: s + t.root.quote.length, id: t.root.id });
    });
    const d = S.draft;
    if (d && d.postId === post.id && d.quote) ranges.push({ s: d.start, e: d.start + d.quote.length, id: "draft" });
    ranges.sort((a, b) => a.s - b.s);
    let out = "", cur = 0;
    for (const r of ranges) {
      const s = Math.max(r.s, cur);
      if (r.e <= s) continue;
      out += rich(body.slice(cur, s));
      out += `<mark class="cp-mark${r.id === "draft" ? " cp-mark-draft" : ""}" data-thread="${r.id}">${rich(body.slice(s, r.e))}</mark>`;
      cur = r.e;
    }
    return out + rich(body.slice(cur));
  }

  // ---- where a post stands, in words -----------------------------------------
  function statusLine(p) {
    if (p.status === "draft") return "Draft";
    if (p.status === "ready") return S.isShare ? "Waiting for your approval" : "Waiting for approval";
    if (p.status === "approved") return `Approved${p.approved_at ? " " + fmtDate(p.approved_at) : ""}`;
    if (p.status === "scheduled") return `Scheduled for ${fmtDay(p.scheduled_at)} ${fmtDate(p.scheduled_at)} at ${fmtTime(p.scheduled_at)}`;
    if (p.status === "publishing") return "Publishing";
    return `Posted ${fmtDate(p.posted_on || p.published_at)}`;
  }

  function actionsHtml(p) {
    const b = (act, label, cls) => `<button type="button" class="cp-btn ${cls || ""}" data-act="${act}">${label}</button>`;
    const menu = (items) => {
      const rows = items.filter(Boolean).map(([act, label, danger]) =>
        `<button type="button" class="cp-menu-item${danger ? " cp-danger" : ""}" data-act="${act}">${label}</button>`).join("");
      return rows ? `<div class="cp-menu-wrap"><button type="button" class="cp-btn cp-btn-quiet cp-more" data-act="menu" aria-label="More">&#8943;</button><div class="cp-menu hidden">${rows}</div></div>` : "";
    };
    let main = "", more = "";
    if (S.isShare) {
      if (p.status === "ready") main = b("approve", "Approve", "cp-btn-approve") + b("edit", "Edit", "cp-btn-ghost");
      else if (p.status === "approved") main = b("edit", "Edit", "cp-btn-ghost") + b("unapprove", "Undo approval", "cp-btn-quiet");
      else if (p.status === "scheduled") main = b("edit", "Edit", "cp-btn-ghost");
    } else if (p.status === "draft") {
      main = b("send", "Send for approval", "cp-btn-primary") + b("edit", "Edit", "cp-btn-ghost");
      more = menu([["schedule", "Schedule"], ["publish", "Publish now"], ["link", "Already posted? Add the link"], ["delete", "Delete", true]]);
    } else if (p.status === "ready") {
      main = b("approve", "Mark approved", "cp-btn-primary") + b("edit", "Edit", "cp-btn-ghost");
      more = menu([["schedule", "Schedule"], ["publish", "Publish now"], ["todraft", "Back to draft"], ["link", "Already posted? Add the link"], ["delete", "Delete", true]]);
    } else if (p.status === "approved") {
      main = b("schedule", "Schedule", "cp-btn-primary") + b("publish", "Publish now", "cp-btn-ghost") + b("edit", "Edit", "cp-btn-ghost");
      more = menu([["unapprove", "Back to waiting for approval"], ["link", "Already posted? Add the link"], ["delete", "Delete", true]]);
    } else if (p.status === "scheduled") {
      main = b("schedule", "Change time", "cp-btn-ghost") + b("publish", "Publish now", "cp-btn-ghost") + b("edit", "Edit", "cp-btn-ghost");
      more = menu([["unschedule", "Take off the schedule"], ["link", "Already posted? Add the link"], ["delete", "Delete", true]]);
    } else if (p.status === "publishing") {
      const stuck = Date.now() - new Date(p.updated_at).getTime() > 10 * 60 * 1000;
      more = stuck ? menu([["unstick", "Stop and set back to approved"]]) : "";
    } else {
      more = menu([["delete", "Remove from this list", true]]);
    }
    return main || more ? `<div class="cp-actions">${main}<span class="cp-grow"></span>${more}</div>` : "";
  }

  function statsHtml(p) {
    if (p.status !== "posted") return "";
    const link = p.url ? `<a class="cp-blue" href="${esc(p.url)}" target="_blank" rel="noopener">View on LinkedIn</a>` : "";
    if (!p.metrics_at) return link ? `<div class="cp-stats">${link}</div>` : "";
    const parts = [
      `<b>${num(p.impressions)}</b> impressions`, `<b>${num(p.reactions)}</b> reactions`,
      `<b>${num(p.comments)}</b> comments`, `<b>${num(p.reshares)}</b> reposts`,
    ];
    return `<div class="cp-stats"><span>${parts.join('<i class="cp-dot"></i>')}</span><span class="cp-grow"></span>${link}</div>`;
  }

  // ---- comments beside the post ---------------------------------------------
  function who(side) {
    const mine = (side === "client") === S.isShare;
    if (mine) return "You";
    return side === "client" ? "Client" : "Uptown";
  }
  function msgHtml(c) {
    const mine = (c.side === "client") === S.isShare;
    return `<div class="cp-msg${mine ? " cp-msg-mine" : ""}" data-comment="${c.id}">
      <div class="cp-msg-meta"><b>${who(c.side)}</b><span>${fmtDate(c.created_at)}</span>${mine ? `<button type="button" class="cp-msg-del" data-act="delcomment" title="Delete">Delete</button>` : ""}</div>
      <div class="cp-msg-body">${esc(c.body)}</div></div>`;
  }
  function threadHtml(post, t) {
    const done = !!t.root.resolved_at;
    const gone = t.root.quote && !done && locate(post.body || "", t.root.quote, t.root.quote_start) < 0;
    const quote = t.root.quote
      ? `<div class="cp-quote${gone ? " cp-quote-gone" : ""}" data-act="focusmark">${esc(t.root.quote)}</div>${gone ? `<div class="cp-quote-note">These words have since been changed.</div>` : ""}`
      : "";
    return `<div class="cp-thread${done ? " cp-thread-done" : ""}" data-thread="${t.root.id}">
      ${quote}${msgHtml(t.root)}${t.replies.map(msgHtml).join("")}
      <div class="cp-thread-foot">
        ${done ? "" : `<textarea class="cp-reply" rows="1" placeholder="Reply"></textarea><button type="button" class="cp-btn cp-btn-quiet cp-send hidden" data-act="reply">Send</button>`}
        <button type="button" class="cp-btn cp-btn-quiet" data-act="${done ? "reopen" : "resolve"}">${done ? "Reopen" : "Resolve"}</button>
      </div></div>`;
  }
  function railHtml(post) {
    const threads = threadsFor(post.id);
    // Comments on a passage first, in the order the passages appear; then the general ones.
    const where = (t) => { const i = t.root.quote ? locate(post.body || "", t.root.quote, t.root.quote_start) : -1; return i < 0 ? 1e9 : i; };
    const open = threads.filter((t) => !t.root.resolved_at).sort((x, y) => where(x) - where(y));
    const done = threads.filter((t) => t.root.resolved_at);
    const d = S.draft && S.draft.postId === post.id ? S.draft : null;
    const draft = d ? `<div class="cp-thread cp-thread-draft">
        ${d.quote ? `<div class="cp-quote">${esc(d.quote)}</div>` : ""}
        <textarea class="cp-draft-input" rows="2" placeholder="Add your comment"></textarea>
        <div class="cp-thread-foot"><span class="cp-grow"></span>
          <button type="button" class="cp-btn cp-btn-quiet" data-act="draftcancel">Cancel</button>
          <button type="button" class="cp-btn cp-btn-primary" data-act="draftsave">Comment</button></div></div>` : "";
    const showDone = S.showResolved.has(post.id);
    const doneHtml = done.length ? `<button type="button" class="cp-resolved-toggle" data-act="toggleresolved">${done.length} resolved ${done.length === 1 ? "comment" : "comments"}</button>${showDone ? done.map((t) => threadHtml(post, t)).join("") : ""}` : "";
    const hint = post.status === "posted" ? "" :
      (d ? "" : `<button type="button" class="cp-addcomment" data-act="newcomment">Add a comment</button>
        ${open.length || done.length ? "" : `<p class="cp-hint">Or highlight any words in the post to comment on just those.</p>`}`);
    return draft + open.map((t) => threadHtml(post, t)).join("") + hint + doneHtml;
  }

  // ---- one post: the card and its comments -----------------------------------
  function rowHtml(p) {
    const pr = profile();
    const err = p.publish_error && !S.isShare ? `<div class="cp-error">${esc(p.publish_error)}</div>` : "";
    return `<article class="cp-row" data-post="${p.id}">
      <div class="cp-card">
        ${p.status === "draft" || p.status === "ready" ? "" : `<div class="cp-status cp-status-${p.status}">${esc(statusLine(p))}</div>`}
        <header class="cp-head">${avatarHtml()}
          <div class="cp-head-text"><div class="cp-name">${esc(pr.name)}</div>
          ${pr.headline ? `<div class="cp-headline">${esc(pr.headline)}</div>` : ""}</div></header>
        ${p.body ? `<div class="cp-text">${bodyHtml(p)}</div>` : (p.status === "posted" && p.url ? `<div class="cp-text cp-text-empty">Posted on LinkedIn. The text was not saved here.</div>` : "")}
        ${imagesHtml(p.images)}${statsHtml(p)}${err}${actionsHtml(p)}
      </div>
      <aside class="cp-rail">${railHtml(p)}</aside>
    </article>`;
  }

  const SECTIONS = [
    { key: "draft",     title: "Drafts",                  note: "Only the team sees these.", team: true, has: (p) => p.status === "draft" },
    { key: "ready",     title: () => (S.isShare ? "Waiting for your approval" : "Waiting for approval"), has: (p) => p.status === "ready" },
    { key: "approved",  title: "Approved",                has: (p) => p.status === "approved" || p.status === "scheduled" || p.status === "publishing" },
    { key: "posted",    title: "Posted",                  has: (p) => p.status === "posted" },
  ];

  function render() {
    const root = S.root;
    const team = !S.isShare;
    let html = `<div class="cp-top"><div><h2 class="cp-title">Posts</h2>
        <p class="cp-sub">${team
          ? (canPublish() ? `Approved posts publish to LinkedIn as ${esc(profile().name)}.`
                          : `LinkedIn is not connected for publishing on this account yet. <a href="#content" data-act="gocontent">Connect it on the Content tab</a>.`)
          : "Read each post, approve it, or highlight any words to leave a comment."}</p></div>
        ${team ? `<div class="cp-top-actions"><button type="button" class="cp-btn cp-btn-ghost" data-act="external">Add a post that is already live</button><button type="button" class="cp-btn cp-btn-primary cp-btn-lg" data-act="new">Write a post</button></div>` : ""}
      </div>`;
    let any = false;
    for (const sec of SECTIONS) {
      if (sec.team && !team) continue;
      let list = S.posts.filter(sec.has);
      if (!list.length) continue;
      any = true;
      if (sec.key === "posted") list = list.slice().sort((a, b) => String(b.posted_on || b.published_at || "").localeCompare(String(a.posted_on || a.published_at || "")));
      if (sec.key === "approved") list = list.slice().sort((a, b) => String(a.scheduled_at || "9").localeCompare(String(b.scheduled_at || "9")));
      const total = list.length;
      if (sec.key === "posted") list = list.slice(0, S.postedShown);
      const title = typeof sec.title === "function" ? sec.title() : sec.title;
      html += `<section class="cp-section"><h3 class="cp-section-title">${esc(title)}<span class="cp-count">${total}</span>${sec.note ? `<em>${esc(sec.note)}</em>` : ""}</h3>
        ${list.map(rowHtml).join("")}
        ${total > list.length ? `<button type="button" class="cp-btn cp-btn-ghost cp-showmore" data-act="moreposted">Show ${Math.min(POSTED_PAGE, total - list.length)} more</button>` : ""}</section>`;
    }
    if (!any) {
      html += `<div class="cp-empty">${team
        ? `<p>No posts here yet.</p><button type="button" class="cp-btn cp-btn-primary cp-btn-lg" data-act="new">Write the first post</button>`
        : `<p>Nothing to review right now. New posts show up here when they are ready for you.</p>`}</div>`;
    }
    root.innerHTML = html;
    hydrateImages(root);
    root.querySelectorAll(".cp-draft-input").forEach((el) => el.focus());
  }

  function refreshRow(postId) {
    const el = S.root.querySelector(`.cp-row[data-post="${postId}"]`);
    const p = postById(postId);
    if (!el || !p) return render();
    const tmp = document.createElement("div");
    tmp.innerHTML = rowHtml(p);
    el.replaceWith(tmp.firstElementChild);
    const fresh = S.root.querySelector(`.cp-row[data-post="${postId}"]`);
    hydrateImages(fresh);
    const input = fresh.querySelector(".cp-draft-input");
    if (input) input.focus();
  }

  // ---- highlight to comment --------------------------------------------------
  function selectionIn() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    const text = node && node.closest ? node.closest(".cp-text") : null;
    if (!text || !S.root.contains(text) || text.classList.contains("cp-text-empty")) return null;
    const quote = r.toString();
    if (!quote.trim()) return null;
    const pre = document.createRange();
    pre.selectNodeContents(text);
    pre.setEnd(r.startContainer, r.startOffset);
    const postId = text.closest(".cp-row").dataset.post;
    if (postById(postId).status === "posted") return null;
    return { postId, quote, start: pre.toString().length, rect: r.getBoundingClientRect() };
  }
  function updateSelButton() {
    const btn = S.selBtn;
    const s = selectionIn();
    if (!s) { btn.classList.add("hidden"); S.pending = null; return; }
    S.pending = s;
    btn.classList.remove("hidden");
    const top = window.scrollY + s.rect.top - btn.offsetHeight - 8;
    const left = window.scrollX + s.rect.left + s.rect.width / 2 - btn.offsetWidth / 2;
    btn.style.top = Math.max(window.scrollY + 4, top) + "px";
    btn.style.left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - btn.offsetWidth - 8)) + "px";
  }
  function startDraft(postId, quote, start) {
    const old = S.draft && S.draft.postId;
    S.draft = { postId, quote: quote || null, start: quote ? start : null };
    if (old && old !== postId) refreshRow(old);
    refreshRow(postId);
    const row = S.root.querySelector(`.cp-row[data-post="${postId}"] .cp-thread-draft`);
    if (row && row.getBoundingClientRect().top > window.innerHeight - 120) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---- modals ------------------------------------------------------------------
  function openModal(html, opts) {
    const o = document.createElement("div");
    o.className = "cp-overlay";
    o.innerHTML = `<div class="cp-modal ${(opts && opts.cls) || ""}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(o);
    const close = () => { o.remove(); document.removeEventListener("keydown", onKey); };
    const tryClose = () => { if (!opts || !opts.guard || opts.guard()) close(); };
    const onKey = (e) => { if (e.key === "Escape") tryClose(); };
    document.addEventListener("keydown", onKey);
    o.addEventListener("mousedown", (e) => { if (e.target === o && !(opts && opts.sticky)) tryClose(); });
    o.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", tryClose));
    return { el: o, close };
  }
  function confirmBox(title, text, yes, danger) {
    return new Promise((resolve) => {
      const m = openModal(`<div class="cp-modal-body"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>
        <div class="cp-modal-foot"><button type="button" class="cp-btn cp-btn-ghost" data-no>Cancel</button><button type="button" class="cp-btn ${danger ? "cp-btn-danger" : "cp-btn-primary"}" data-yes>${esc(yes)}</button></div>`, { cls: "cp-modal-sm" });
      m.el.querySelector("[data-no]").onclick = () => { m.close(); resolve(false); };
      m.el.querySelector("[data-yes]").onclick = () => { m.close(); resolve(true); };
    });
  }

  // The composer: laid out like LinkedIn's own "Create a post" box.
  function openComposer(post) {
    const isNew = !post;
    const team = !S.isShare;
    const pr = profile();
    let images = post ? (post.images || []).slice() : [];
    const startText = post ? post.body || "" : "";
    const startImgs = JSON.stringify(images);
    const draftish = isNew || post.status === "draft";
    const buttons = team && draftish
      ? `<button type="button" class="cp-btn cp-btn-ghost" data-save="draft">Save draft</button><button type="button" class="cp-btn cp-btn-li" data-save="ready">Send for approval</button>`
      : `<button type="button" class="cp-btn cp-btn-li" data-save="keep">Save</button>`;
    const m = openModal(`
      <header class="cp-comp-head">${avatarHtml("cp-avatar-lg")}
        <div><div class="cp-comp-name">${esc(pr.name)}</div><div class="cp-comp-sub">Post to Anyone</div></div>
        <button type="button" class="cp-x" data-close aria-label="Close">&times;</button></header>
      <div class="cp-comp-scroll">
        <textarea class="cp-comp-text" placeholder="What do you want to talk about?"></textarea>
        <div class="cp-comp-imgs"></div>
      </div>
      <footer class="cp-comp-foot">
        <label class="cp-icon-btn" title="Add photos"><input type="file" accept="image/png,image/jpeg,image/gif" multiple hidden />
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm1 13a1 1 0 0 1-.29.71L16 14l-2 2-6-6-4 4V7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1zm-2-7a2 2 0 1 1-2-2 2 2 0 0 1 2 2z"/></svg></label>
        <span class="cp-comp-msg"></span><span class="cp-grow"></span><span class="cp-count-chars"></span>${buttons}
      </footer>`, {
      cls: "cp-composer", sticky: true,
      guard: () => (ta.value === startText && JSON.stringify(images) === startImgs) || window.confirm("Close without saving your changes?"),
    });
    const ta = m.el.querySelector(".cp-comp-text");
    const imgBox = m.el.querySelector(".cp-comp-imgs");
    const msg = m.el.querySelector(".cp-comp-msg");
    const counter = m.el.querySelector(".cp-count-chars");
    const saveBtns = [...m.el.querySelectorAll("[data-save]")];
    ta.value = startText;

    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.max(180, ta.scrollHeight) + "px"; };
    const sync = () => {
      const n = ta.value.length;
      counter.textContent = n > MAX_CHARS - 300 ? `${num(n)} / ${num(MAX_CHARS)}` : "";
      counter.classList.toggle("cp-over", n > MAX_CHARS);
      const empty = !ta.value.trim() && !images.length;
      saveBtns.forEach((b) => { b.disabled = empty || n > MAX_CHARS; });
    };
    const drawImages = () => {
      imgBox.innerHTML = images.map((im, i) =>
        `<div class="cp-thumb"><img data-path="${esc(im.path)}" alt="" /><button type="button" class="cp-thumb-x" data-i="${i}" aria-label="Remove photo">&times;</button></div>`).join("");
      hydrateImages(imgBox);
      sync();
    };
    ta.addEventListener("input", () => { grow(); sync(); });
    imgBox.addEventListener("click", (e) => {
      const x = e.target.closest(".cp-thumb-x");
      if (!x) return;
      images.splice(Number(x.dataset.i), 1);
      drawImages();
    });
    m.el.querySelector('input[type="file"]').addEventListener("change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      for (const f of files) {
        if (images.length >= MAX_IMAGES) { msg.textContent = `A post can hold up to ${MAX_IMAGES} photos.`; break; }
        if (!/^image\/(png|jpeg|gif)$/.test(f.type)) { msg.textContent = "Photos need to be JPG, PNG or GIF."; continue; }
        msg.textContent = "Adding photo...";
        const path = `${S.clientId}/content/${uid()}_${f.name.replace(/[^\w.\-]+/g, "_")}`;
        try {
          await sb.storageUpload(BUCKET, path, f);
          images.push({ path, name: f.name });
          msg.textContent = "";
          drawImages();
        } catch (err) { msg.textContent = "That photo did not upload. " + err.message; }
      }
    });
    saveBtns.forEach((btn) => btn.addEventListener("click", async () => {
      const mode = btn.dataset.save;
      saveBtns.forEach((b) => { b.disabled = true; });
      msg.textContent = "Saving...";
      try {
        const fields = { body: ta.value.replace(/\s+$/, ""), images };
        if (mode === "ready") fields.status = "ready";
        if (isNew) {
          const sess = sb.getSession();
          if (mode !== "ready") fields.status = "draft";
          const rows = await sb.sbFetch("/rest/v1/content_posts", {
            method: "POST", headers: { Prefer: "return=representation" },
            body: JSON.stringify({ ...fields, client_id: S.clientId, source: "uptown", created_by: sess && sess.user ? sess.user.id : null }),
          });
          S.posts.push(rows[0]);
        } else {
          await patchPost(post.id, fields);
          const kept = new Set(images.map((im) => im.path));
          const gone = JSON.parse(startImgs).map((im) => im.path).filter((pth) => !kept.has(pth));
          if (gone.length) sb.storageRemove(BUCKET, gone);
        }
        m.close();
        render();
        toast(mode === "ready" ? "Sent for approval" : "Saved");
      } catch (err) {
        msg.textContent = err.message;
        sync();
      }
    }));
    drawImages();
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function openSchedule(post) {
    if (!canPublish()) { toast("Connect LinkedIn for publishing on the Content tab first.", true); return; }
    const base = post.scheduled_at ? new Date(post.scheduled_at) : (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(9, 0, 0, 0); return x; })();
    const pad = (n) => String(n).padStart(2, "0");
    const dval = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
    const tval = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
    const m = openModal(`<div class="cp-modal-body"><h3>Schedule this post</h3>
        <p>It publishes to LinkedIn as ${esc(profile().name)} at the time you pick. Times are in your own time zone.</p>
        <div class="cp-fields"><label>Date<input type="date" class="cp-input" data-d value="${dval}" /></label>
        <label>Time<input type="time" class="cp-input" data-t value="${tval}" step="300" /></label></div>
        <p class="cp-modal-msg"></p></div>
      <div class="cp-modal-foot"><button type="button" class="cp-btn cp-btn-ghost" data-close>Cancel</button><button type="button" class="cp-btn cp-btn-primary" data-ok>Schedule</button></div>`, { cls: "cp-modal-sm" });
    m.el.querySelector("[data-ok]").onclick = async () => {
      const when = new Date(`${m.el.querySelector("[data-d]").value}T${m.el.querySelector("[data-t]").value}`);
      const out = m.el.querySelector(".cp-modal-msg");
      if (isNaN(when)) { out.textContent = "Pick a date and a time."; return; }
      if (when.getTime() < Date.now() + 60 * 1000) { out.textContent = "Pick a time that is still ahead."; return; }
      try {
        const fields = { status: "scheduled", scheduled_at: when.toISOString(), publish_error: null };
        if (!post.approved_at) fields.approved_at = new Date().toISOString();
        await patchPost(post.id, fields);
        m.close(); render(); toast("Scheduled");
      } catch (err) { out.textContent = err.message; }
    };
  }

  const ACTIVITY_RE = /(?:activity|ugcPost|share)[-:](\d{15,25})/;
  // Add the link of a post that is already on LinkedIn. With a post: that
  // post becomes "posted". Without: a new row, for a post we never held here.
  function openLink(post) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dval = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const m = openModal(`<div class="cp-modal-body"><h3>${post ? "Add the link to this post" : "Add a post that is already live"}</h3>
        <p>On LinkedIn, open the post's menu and choose Copy link to post. With the link in place the post counts as posted and its numbers come in overnight.</p>
        <div class="cp-fields cp-fields-wide"><label>Link to the post<input type="url" class="cp-input" data-u placeholder="https://www.linkedin.com/posts/..." /></label>
        <label>Date it went live<input type="date" class="cp-input" data-d value="${dval}" /></label></div>
        ${post ? "" : `<label class="cp-field-block">The post's text (optional)<textarea class="cp-input" data-b rows="5"></textarea></label>`}
        <p class="cp-modal-msg"></p></div>
      <div class="cp-modal-foot"><button type="button" class="cp-btn cp-btn-ghost" data-close>Cancel</button><button type="button" class="cp-btn cp-btn-primary" data-ok>Save</button></div>`, { cls: "cp-modal-md" });
    m.el.querySelector("[data-u]").focus();
    m.el.querySelector("[data-ok]").onclick = async () => {
      const url = m.el.querySelector("[data-u]").value.trim();
      const day = m.el.querySelector("[data-d]").value;
      const out = m.el.querySelector(".cp-modal-msg");
      const hit = url.match(ACTIVITY_RE);
      if (!hit) { out.textContent = "That does not look like a link to a LinkedIn post."; return; }
      if (!day) { out.textContent = "Add the date it went live."; return; }
      const fields = { url, activity_id: hit[1], posted_on: day, status: "posted", source: "external",
        published_at: new Date(day + "T12:00:00").toISOString(), scheduled_at: null, publish_error: null };
      try {
        if (post) await patchPost(post.id, fields);
        else {
          const sess = sb.getSession();
          const body = (m.el.querySelector("[data-b]").value || "").trim() || null;
          const rows = await sb.sbFetch("/rest/v1/content_posts", {
            method: "POST", headers: { Prefer: "return=representation" },
            body: JSON.stringify({ ...fields, body, client_id: S.clientId, created_by: sess && sess.user ? sess.user.id : null }),
          });
          S.posts.push(rows[0]);
        }
        m.close(); render(); toast("Saved as posted");
      } catch (err) {
        out.textContent = /duplicate|unique/i.test(err.message) ? "That post is already in the list." : err.message;
      }
    };
  }

  async function publishNow(post) {
    if (!canPublish()) { toast("Connect LinkedIn for publishing on the Content tab first.", true); return; }
    const ok = await confirmBox("Publish to LinkedIn now?", `This goes live right away on ${profile().name}'s profile.`, "Publish now");
    if (!ok) return;
    post.status = "publishing";
    refreshRow(post.id);
    try {
      const r = await sb.invokeFunction("linkedin-content", { action: "publish", client_id: S.clientId, post_id: post.id });
      await load(); render();
      toast(r.ok ? "Published to LinkedIn" : (r.error || "It did not publish."), !r.ok);
    } catch (err) {
      await load(); render();
      toast(err.message, true);
    }
  }

  // ---- comments: saving ------------------------------------------------------
  async function addComment(fields) {
    const rows = await sb.sbFetch("/rest/v1/content_post_comments", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ ...fields, client_id: S.clientId }),
    });
    S.comments.push(rows[0]);
  }
  async function patchComment(id, fields) {
    const rows = await sb.sbFetch(`/rest/v1/content_post_comments?id=eq.${id}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields),
    });
    Object.assign(S.comments.find((c) => c.id === id) || {}, (rows && rows[0]) || {});
  }

  // ---- every click on the tab ---------------------------------------------------
  async function onClick(e) {
    const actEl = e.target.closest("[data-act]");
    if (!e.target.closest(".cp-menu-wrap")) S.root.querySelectorAll(".cp-menu").forEach((mn) => mn.classList.add("hidden"));
    if (!actEl) {
      const mark = e.target.closest(".cp-mark");
      if (mark && mark.dataset.thread !== "draft") {
        const th = S.root.querySelector(`.cp-thread[data-thread="${mark.dataset.thread}"]`);
        if (th) { th.scrollIntoView({ block: "nearest", behavior: "smooth" }); th.classList.add("cp-flash"); setTimeout(() => th.classList.remove("cp-flash"), 1200); }
      }
      return;
    }
    const act = actEl.dataset.act;
    const row = actEl.closest(".cp-row");
    const post = row ? postById(row.dataset.post) : null;
    const thread = actEl.closest(".cp-thread");
    const threadId = thread ? thread.dataset.thread : null;
    try {
      if (act === "menu") {
        const mn = actEl.parentElement.querySelector(".cp-menu");
        const was = mn.classList.contains("hidden");
        S.root.querySelectorAll(".cp-menu").forEach((x) => x.classList.add("hidden"));
        mn.classList.toggle("hidden", !was);
      }
      else if (act === "new") openComposer(null);
      else if (act === "external") openLink(null);
      else if (act === "gocontent") { e.preventDefault(); if (S.selectTab) S.selectTab("content"); }
      else if (act === "moreposted") { S.postedShown += POSTED_PAGE; render(); }
      else if (act === "edit") openComposer(post);
      else if (act === "approve") { await patchPost(post.id, { status: "approved", approved_at: new Date().toISOString() }); render(); toast("Approved"); }
      else if (act === "unapprove") { await patchPost(post.id, { status: "ready", approved_at: null }); render(); }
      else if (act === "send") { await patchPost(post.id, { status: "ready" }); render(); toast("Sent for approval"); }
      else if (act === "todraft") { await patchPost(post.id, { status: "draft", approved_at: null }); render(); }
      else if (act === "schedule") openSchedule(post);
      else if (act === "unschedule") { await patchPost(post.id, { status: "approved", scheduled_at: null }); render(); }
      else if (act === "unstick") { await patchPost(post.id, { status: "approved", publish_error: "Publishing was stopped part way. Check LinkedIn before publishing again." }); render(); }
      else if (act === "publish") await publishNow(post);
      else if (act === "link") openLink(post);
      else if (act === "delete") {
        const posted = post.status === "posted";
        const ok = await confirmBox(posted ? "Remove this post from the list?" : "Delete this post?",
          posted ? "It stays on LinkedIn. Only this record and its numbers are removed." : "The post and its comments are deleted for good.", posted ? "Remove" : "Delete", true);
        if (!ok) return;
        await sb.sbFetch(`/rest/v1/content_posts?id=eq.${post.id}`, { method: "DELETE" });
        const paths = (post.images || []).map((im) => im.path);
        if (paths.length) sb.storageRemove(BUCKET, paths);
        S.posts = S.posts.filter((p) => p.id !== post.id);
        S.comments = S.comments.filter((c) => c.post_id !== post.id);
        render();
      }
      else if (act === "newcomment") startDraft(post.id, null, null);
      else if (act === "draftcancel") { S.draft = null; refreshRow(post.id); }
      else if (act === "draftsave") {
        const text = thread.querySelector(".cp-draft-input").value.trim();
        if (!text) return;
        const d = S.draft;
        await addComment({ post_id: post.id, body: text, quote: d.quote, quote_start: d.start });
        S.draft = null; refreshRow(post.id);
      }
      else if (act === "reply") {
        const ta = thread.querySelector(".cp-reply");
        const text = ta.value.trim();
        if (!text) return;
        await addComment({ post_id: post.id, thread_id: threadId, body: text });
        refreshRow(post.id);
      }
      else if (act === "resolve") { await patchComment(threadId, { resolved_at: new Date().toISOString() }); refreshRow(post.id); }
      else if (act === "reopen") { await patchComment(threadId, { resolved_at: null }); refreshRow(post.id); }
      else if (act === "toggleresolved") { S.showResolved.has(post.id) ? S.showResolved.delete(post.id) : S.showResolved.add(post.id); refreshRow(post.id); }
      else if (act === "delcomment") {
        const id = actEl.closest(".cp-msg").dataset.comment;
        await sb.sbFetch(`/rest/v1/content_post_comments?id=eq.${id}`, { method: "DELETE" });
        S.comments = S.comments.filter((c) => c.id !== id && c.thread_id !== id);
        refreshRow(post.id);
      }
      else if (act === "focusmark") {
        const mark = row.querySelector(`.cp-mark[data-thread="${threadId}"]`);
        if (mark) { mark.scrollIntoView({ block: "center", behavior: "smooth" }); mark.classList.add("cp-mark-on"); setTimeout(() => mark.classList.remove("cp-mark-on"), 1400); }
      }
    } catch (err) {
      toast(err.message || "Something went wrong.", true);
    }
  }

  function onInput(e) {
    const ta = e.target;
    if (!ta.classList || !(ta.classList.contains("cp-reply") || ta.classList.contains("cp-draft-input"))) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    if (ta.classList.contains("cp-reply")) ta.parentElement.querySelector(".cp-send").classList.toggle("hidden", !ta.value.trim());
  }
  function onKey(e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    const ta = e.target;
    if (!ta.classList) return;
    if (ta.classList.contains("cp-reply")) { e.preventDefault(); ta.parentElement.querySelector('[data-act="reply"]').click(); }
    else if (ta.classList.contains("cp-draft-input") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.closest(".cp-thread").querySelector('[data-act="draftsave"]').click(); }
  }
  function onHover(e) {
    const th = e.target.closest && e.target.closest(".cp-thread[data-thread]");
    S.root.querySelectorAll(".cp-mark-on").forEach((mk) => mk.classList.remove("cp-mark-on"));
    if (!th) return;
    const mark = th.closest(".cp-row").querySelector(`.cp-mark[data-thread="${th.dataset.thread}"]`);
    if (mark) mark.classList.add("cp-mark-on");
  }

  // ---- start ---------------------------------------------------------------------
  async function init(opts) {
    S = {
      clientId: opts.clientId, clientName: opts.clientName || "", isShare: !!opts.isShare,
      root: opts.root, selectTab: opts.selectTab || null,
      posts: [], comments: [], integ: null, urls: {}, draft: null, pending: null,
      showResolved: new Set(), postedShown: POSTED_PAGE,
    };
    S.root.classList.add("cp");
    S.root.innerHTML = `<div class="cp-loading">Loading posts...</div>`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp-selbtn hidden";
    btn.textContent = "Comment";
    document.body.appendChild(btn);
    S.selBtn = btn;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const p = S.pending;
      if (!p) return;
      window.getSelection().removeAllRanges();
      btn.classList.add("hidden");
      startDraft(p.postId, p.quote, p.start);
    });
    document.addEventListener("selectionchange", () => { clearTimeout(S.selTimer); S.selTimer = setTimeout(updateSelButton, 120); });

    S.root.addEventListener("click", onClick);
    S.root.addEventListener("input", onInput);
    S.root.addEventListener("keydown", onKey);
    S.root.addEventListener("mouseover", onHover);
    document.addEventListener("click", (e) => { if (!S.root.contains(e.target)) S.root.querySelectorAll(".cp-menu").forEach((mn) => mn.classList.add("hidden")); });

    try {
      await load();
      render();
    } catch (err) {
      S.root.innerHTML = `<div class="cp-empty"><p>The posts did not load. ${esc(err.message)}</p></div>`;
    }
  }

  window.ContentPosts = { init };
})();
