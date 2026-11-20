// Posts tab: write, review, approve, schedule and publish LinkedIn posts.
//
// One page for two readers. The client (a share-link visitor) sees each post
// from "waiting for approval" on, can approve it, edit it, and highlight any
// words to comment on them. The team also sees drafts, writes posts in a
// composer that looks like LinkedIn's, schedules and publishes them, and can
// add the link of a post that went live some other way. Under the title sits
// one quiet line for the LinkedIn connection. The Posted section carries how
// the posts are doing: a totals panel on its right, with a timeframe that
// also decides which posted posts are listed, and a sort by any number. This
// tab replaced the old internal Content tab on 11/17/26.
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
    const [posts, comments, integ, followers] = await Promise.all([
      sb.sbFetch(`/rest/v1/content_posts_latest?select=*&client_id=eq.${cid()}&order=created_at.asc`),
      sb.sbFetch(`/rest/v1/content_post_comments?select=*&client_id=eq.${cid()}&order=created_at.asc`),
      sb.sbFetch(`/rest/v1/integrations?select=id,scope_metadata,last_sync_ok_at,last_sync_error&client_id=eq.${cid()}&purpose=eq.content_analytics&limit=1`).catch(() => []),
      sb.sbFetch(`/rest/v1/content_follower_snapshots?select=captured_on,followers&client_id=eq.${cid()}&order=captured_on.asc`).catch(() => []),
    ]);
    S.posts = posts || [];
    S.comments = comments || [];
    S.integ = (integ && integ[0]) || null;
    S.followers = followers || [];
  }

  async function patchPost(id, fields) {
    const cur = postById(id);
    const guard = cur && cur.updated_at ? `&updated_at=eq.${encodeURIComponent(cur.updated_at)}` : "";
    const rows = await sb.sbFetch(`/rest/v1/content_posts?id=eq.${encodeURIComponent(id)}${guard}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields),
    });
    if (!rows || !rows.length) {
      await load(); render();
      throw new Error("This post changed since the page loaded. It is up to date now, so look it over and try again.");
    }
    Object.assign(postById(id) || {}, rows[0]);
    return rows[0];
  }

  // Only ever link out to LinkedIn itself.
  const liUrl = (u) => (/^https:\/\/([\w-]+\.)?linkedin\.com\//i.test(u || "") ? u : "");

  // ---- images ----------------------------------------------------------------
  function signedUrl(path) {
    const hit = S.urls[path];
    if (!hit || Date.now() - hit.at > 5 * 3600 * 1000) {
      S.urls[path] = { at: Date.now(), url: sb.storageSignedUrl(BUCKET, path, 6 * 3600).catch(() => "") };
    }
    return S.urls[path].url;
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
      if (post.status === "posted" || t.root.resolved_at || !t.root.quote) return;
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
    // The team's menu: every stage except the one the post is in, in pipeline order, then Delete.
    const stages = (here) => menu([
      here !== "draft" && ["to-draft", "Move to draft"],
      here !== "ready" && ["to-ready", "Move to waiting for approval"],
      here !== "approved" && ["to-approved", "Move to approved"],
      here !== "scheduled" && ["schedule", "Schedule"],
      ["publish", "Publish now"],
      ["delete", "Delete", true],
    ]);
    let main = "", more = "", linkBox = false;
    if (S.isShare) {
      if (p.status === "ready") main = b("approve", "Approve", "cp-btn-approve") + b("edit", "Edit", "cp-btn-ghost");
      else if (p.status === "approved") main = b("edit", "Edit", "cp-btn-ghost") + b("unapprove", "Undo approval", "cp-btn-quiet");
      else if (p.status === "scheduled") main = b("edit", "Edit", "cp-btn-ghost");
    } else if (p.status === "draft") {
      main = b("send", "Send for approval", "cp-btn-primary") + b("edit", "Edit", "cp-btn-ghost");
      more = stages(p.status);
    } else if (p.status === "ready") {
      main = b("approve", "Mark approved", "cp-btn-primary") + b("edit", "Edit", "cp-btn-ghost");
      more = stages(p.status);
    } else if (p.status === "approved") {
      main = b("schedule", "Schedule", "cp-btn-primary") + b("publish", "Publish now", "cp-btn-ghost") + b("edit", "Edit", "cp-btn-ghost") + `<button type="button" class="cp-btn cp-btn-ghost cp-copybtn" data-act="copytext" title="Copy the post's text" aria-label="Copy the post's text"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>`;
      more = stages(p.status);
      linkBox = true;
    } else if (p.status === "scheduled") {
      main = b("schedule", "Change time", "cp-btn-ghost") + b("publish", "Publish now", "cp-btn-ghost") + b("edit", "Edit", "cp-btn-ghost") + `<button type="button" class="cp-btn cp-btn-ghost cp-copybtn" data-act="copytext" title="Copy the post's text" aria-label="Copy the post's text"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>`;
      more = stages(p.status);
      linkBox = true;
    } else if (p.status === "publishing") {
      const stuck = Date.now() - new Date(p.updated_at).getTime() > 10 * 60 * 1000;
      more = stuck ? menu([["unstick", "Stop and set back to approved"]]) : "";
    }   // a posted post has no action row: its one option sits in the "Posted" line (postedMenuHtml)
    // For a post that went out on LinkedIn directly: paste its link and it counts as posted.
    const box = linkBox ? `<input type="url" class="cp-linkbox" placeholder="Already posted? Paste URL" aria-label="Already posted? Paste the link to the post" autocomplete="off" />` : `<span class="cp-grow"></span>`;
    return main || more ? `<div class="cp-actions">${main}${box}${more}</div>` : "";
  }

  function postedMenuHtml(p) {
    const link = liUrl(p.url) ? `<a class="cp-blue cp-viewlink" href="${esc(p.url)}" target="_blank" rel="noopener">View on LinkedIn</a>` : "";
    if (S.isShare) return `<span class="cp-grow"></span>${link}`;
    return `<span class="cp-grow"></span>${link}<div class="cp-menu-wrap"><button type="button" class="cp-btn cp-btn-quiet cp-more cp-more-sm" data-act="menu" aria-label="More">&#8943;</button>
      <div class="cp-menu cp-menu-down cp-menu-end hidden"><button type="button" class="cp-menu-item cp-danger" data-act="delete">Remove from this list</button></div></div>`;
  }

  function statsHtml(p) {
    if (p.status !== "posted") return "";
    if (!p.metrics_at) return "";
    const parts = [
      `<b>${num(p.impressions)}</b> impressions`, `<b>${num(p.reactions)}</b> reactions`,
      `<b>${num(p.comments)}</b> comments`, `<b>${num(p.reshares)}</b> reposts`,
    ];
    // Clicks: the profile's button on the post ("Visit my website"), and links inside the post.
    const has = (v) => v !== null && v !== undefined;
    if (has(p.cta_clicks)) parts.push(`<span title="Clicks on the profile button shown on the post, such as Visit my website"><b>${num(p.cta_clicks)}</b> button clicks</span>`);
    if (has(p.link_clicks)) parts.push(`<span title="Clicks on links inside the post"><b>${num(p.link_clicks)}</b> link clicks</span>`);
    return `<div class="cp-stats">${refreshIcon(p)}${parts.join('<i class="cp-dot"></i>')}</div>`;
  }

  // One post's refresh, for the team on a connected account (Austin 11/19/26: refreshing many posts at once is the
  // daily run's job only). LinkedIn gives numbers only for posts from the last 400 days, so older posts get no icon.
  const REFRESH_HINT = "Refresh this post's numbers. Posts from the last 7 days also refresh on their own every evening, and older posts less often.";
  function refreshIcon(p) {
    if (S.isShare || !S.integ || !p.posted_on || Date.now() - new Date(p.posted_on).getTime() > 399 * 864e5) return "";
    return `<button type="button" class="cp-refresh" data-act="refreshpost" title="${REFRESH_HINT}" aria-label="Refresh this post's numbers">`
      + `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`
      + `<path d="M12.5 1.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
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
      <div class="cp-msg-meta">${mine ? "" : `<b>${who(c.side)}</b>`}<span>${fmtDate(c.created_at)}</span>${mine ? `<button type="button" class="cp-msg-del" data-act="delcomment" title="Delete">Delete</button>` : ""}</div>
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
    // A live post takes no new comments; the ones from before stay behind a link.
    if (post.status === "posted") {
      if (!threads.length) return "";
      const n = threads.reduce((s, t) => s + 1 + t.replies.length, 0);
      return `<button type="button" class="cp-resolved-toggle" data-act="toggleresolved">${n} ${n === 1 ? "comment" : "comments"} from before it was posted</button>`
        + (S.showResolved.has(post.id) ? threads.map((t) => threadHtml(post, t)).join("") : "");
    }
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
    const posted = p.status === "posted";
    // Shown through LinkedIn's own display, the post already carries its header.
    const viaEmbed = posted && (!p.body || p.source === "external") && embedSrc(p);
    const err = p.publish_error && !S.isShare ? `<div class="cp-error">${esc(p.publish_error)}</div>` : "";
    const strip = p.status === "draft" || p.status === "ready" ? ""
      : `<div class="cp-status cp-status-${p.status}"><span>${esc(statusLine(p))}</span>${posted ? postedMenuHtml(p) : ""}</div>`;
    const head = viaEmbed ? "" : `<header class="cp-head">${avatarHtml()}
          <div class="cp-head-text"><div class="cp-name">${esc(pr.name)}</div>
          ${pr.headline ? `<div class="cp-headline">${esc(pr.headline)}</div>` : ""}</div></header>`;
    const rail = railHtml(p);
    return `<article class="cp-row${posted ? " cp-row-posted" : ""}" data-post="${p.id}">
      <div class="cp-card">
        ${strip}${head}
        ${viaEmbed ? `<iframe class="cp-embed-inline" src="${esc(viaEmbed)}" title="LinkedIn post" loading="lazy"></iframe>` : (p.body ? `<div class="cp-text">${bodyHtml(p)}</div>` : "")}
        ${viaEmbed ? "" : imagesHtml(p.images)}${statsHtml(p)}${err}${actionsHtml(p)}
      </div>
      ${posted && !rail ? "" : `<aside class="cp-rail">${rail}</aside>`}
    </article>`;
  }

  const SECTIONS = [
    { key: "draft",     title: "Drafts",                  note: "Only the team sees these.", team: true, has: (p) => p.status === "draft" },
    { key: "ready",     title: () => (S.isShare ? "Waiting for your approval" : "Waiting for approval"), has: (p) => p.status === "ready" },
    { key: "approved",  title: "Approved",                has: (p) => p.status === "approved" },
    { key: "scheduled", title: "Scheduled",               has: (p) => p.status === "scheduled" || p.status === "publishing" },
    { key: "posted",    title: "Posted",                  has: (p) => p.status === "posted" },
  ];

  // ---- how the posts are doing ------------------------------------------------
  const TIMEFRAMES = [["all", "All time"], ["yr", "This year"], ["3m", "Last 3 months"], ["1m", "Last month"]];
  function cutoffDay() {
    const now = new Date();
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (S.tf === "1m") { now.setMonth(now.getMonth() - 1); return ymd(now); }
    if (S.tf === "3m") { now.setMonth(now.getMonth() - 3); return ymd(now); }
    if (S.tf === "yr") return `${now.getFullYear()}-01-01`;
    return null;
  }
  // Totals for the posted posts in the chosen timeframe, stacked, beside the list.
  function totalsHtml(inWin) {
    const fol = S.followers;
    const latest = fol.length ? fol[fol.length - 1] : null;
    if (!S.posts.some((p) => p.status === "posted") && !latest) return "";
    const cut = cutoffDay();
    const has = (v) => v !== null && v !== undefined;
    const measured = inWin.filter((p) => has(p.impressions));
    const imp = measured.reduce((s, p) => s + (p.impressions || 0), 0);
    const eng = measured.reduce((s, p) => s + (p.reactions || 0) + (p.comments || 0) + (p.reshares || 0), 0);
    const sumOf = (col) => {
      const rows = inWin.filter((p) => has(p[col]));
      return rows.length ? num(rows.reduce((s, p) => s + (p[col] || 0), 0)) : "-";
    };
    let delta = null;
    if (latest) {
      const first = cut ? fol.find((f) => f.captured_on >= cut) : fol[0];
      if (first && first.captured_on !== latest.captured_on) delta = latest.followers - first.followers;
    }
    const row = (label, value, sub, act, hint) =>
      `<${act ? `button type="button" data-act="${act}"` : "div"} class="cp-total${act ? " cp-total-btn" : ""}"${hint ? ` title="${hint}"` : ""}>
        <span class="cp-total-label">${label}</span><span class="cp-total-value">${sub ? `<em>${sub}</em>` : ""}${value}</span></${act ? "button" : "div"}>`;
    const rows = [
      row("Posts", num(inWin.length)),
      row("Impressions", measured.length ? num(imp) : "-"),
      row("Engagement rate", imp ? (100 * eng / imp).toFixed(1) + "%" : "-"),
      row("Button clicks", sumOf("cta_clicks"), "", "", "Clicks on the profile button shown on posts, such as Visit my website"),
      row("Link clicks", sumOf("link_clicks"), "", "", "Clicks on links inside posts"),
      latest ? row("Followers", num(latest.followers),
        delta === null ? "" : `${delta >= 0 ? "+" : ""}${num(delta)}`, fol.length > 1 ? "chart" : "") : "",
    ].join("");
    const chart = S.showChart && fol.length > 1
      ? `<div class="cp-chart"><div class="cp-chart-note">Followers each day since ${fmtDate(fol[0].captured_on)}</div><div class="cp-chart-box"><canvas></canvas></div></div>` : "";
    return `<aside class="cp-totals"><div class="cp-total-list">${rows}</div>${chart}</aside>`;
  }

  // The order of the posted list: newest, or highest on any one number.
  // Posts LinkedIn has given no number for go to the bottom.
  const SORTS = [
    ["newest", "Newest first"], ["impressions", "Most impressions"], ["reactions", "Most reactions"],
    ["comments", "Most comments"], ["reshares", "Most reposts"], ["cta_clicks", "Most button clicks"],
    ["link_clicks", "Most link clicks"], ["rate", "Highest engagement"],
  ];
  function sortPosted(list) {
    // By day, then by the moment it went live, so two posts on the same day keep their order.
    const newest = (a, b) => String(b.posted_on || b.published_at || "").localeCompare(String(a.posted_on || a.published_at || ""))
      || String(b.published_at || "").localeCompare(String(a.published_at || ""));
    const key = S.postedSort;
    if (key === "newest") return list.slice().sort(newest);
    const val = (p) => {
      const v = key === "rate"
        ? (p.impressions ? ((p.reactions || 0) + (p.comments || 0) + (p.reshares || 0)) / p.impressions : null)
        : p[key];
      return v === null || v === undefined ? null : Number(v);
    };
    return list.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      return (x === null ? 0 : y - x) || newest(a, b);
    });
  }

  function drawChart() {
    const canvas = S.root.querySelector(".cp-chart canvas");
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    if (!canvas || typeof Chart === "undefined") return;
    const fol = S.followers;
    S.chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: fol.map((f) => fmtDate(f.captured_on)), datasets: [{
        data: fol.map((f) => f.followers), borderColor: "#1EB683", backgroundColor: "rgba(30,182,131,.12)",
        fill: true, tension: .25, pointRadius: fol.length > 60 ? 0 : 2, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${num(c.parsed.y)} followers` } } },
        scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 11 } }, grid: { display: false } },
                  y: { ticks: { precision: 0, font: { size: 11 } }, grid: { color: "rgba(0,0,0,.05)" } } },
      },
    });
  }

  // ---- the LinkedIn connection, in one quiet line -------------------------------
  function connHtml() {
    const link = (label) => `<button type="button" class="cp-conn cp-conn-link" data-act="connect">${label}</button>`;
    if (!S.integ) return link("Connect LinkedIn");
    const err = String(S.integ.last_sync_error || "");
    if (err.startsWith("reconnect_required") || !canPublish()) {
      return `<span class="cp-conn-warn">LinkedIn needs to be connected again.</span> ${link("Reconnect")}`;
    }
    if (S.isShare) return "";
    const last = S.integ.last_sync_ok_at ? `Last refreshed ${fmtDate(S.integ.last_sync_ok_at)} at ${fmtTime(S.integ.last_sync_ok_at)}.` : "";
    return `<span class="cp-menu-wrap"><button type="button" class="cp-conn" data-act="menu">Connected as ${esc(profile().name)} <span class="cp-caret">&#9662;</span></button>
      <div class="cp-menu cp-menu-down hidden">
        <button type="button" class="cp-menu-item cp-danger" data-act="disconnect">Disconnect LinkedIn</button>
        <div class="cp-menu-note">Numbers refresh on their own every evening. ${last}</div></div></span>`;
  }

  function render() {
    const root = S.root;
    const team = !S.isShare;
    const conn = connHtml();
    let html = `<div class="cp-top"><div>
        ${team ? "" : `<p class="cp-sub">Read each post, approve it, or highlight any words to leave a comment.</p>`}
        ${conn ? `<div class="cp-sub cp-conn-line">${conn}</div>` : ""}</div>
        <div class="cp-top-actions">${S.posts.some((p) => p.status === "posted") ? `<button type="button" class="cp-btn cp-btn-ghost cp-btn-lg" data-act="toposted">Posted <span class="cp-down">&#8595;</span></button>` : ""}
          ${team ? `<button type="button" class="cp-btn cp-btn-primary cp-btn-lg" data-act="new">Write a post</button>` : ""}</div>
      </div>`;
    let any = false;
    for (const sec of SECTIONS) {
      if (sec.team && !team) continue;
      const all = S.posts.filter(sec.has);
      const title = typeof sec.title === "function" ? sec.title() : sec.title;
      if (sec.key === "posted") {
        if (!all.length && !(team && S.posts.length)) continue;
        any = true;
        // The timeframe decides both the totals and which posts are listed.
        const cutDay = cutoffDay();
        const inWin = cutDay ? all.filter((p) => String(p.posted_on || "") >= cutDay) : all;
        const older = all.length - inWin.length;
        const list = sortPosted(inWin).slice(0, S.postedShown);
        const olderLine = older ? `<p class="cp-older">${older} older ${older === 1 ? "post is" : "posts are"} outside this timeframe. <button type="button" class="cp-conn cp-conn-link" data-act="tf" data-tf="all">Show all time</button></p>` : "";
        html += `<section class="cp-section">
          <div class="cp-posted-grid"><h3 class="cp-section-title cp-posted-head">${esc(title)}<span class="cp-count">${inWin.length}</span></h3>
            <div class="cp-posted-side"><div class="cp-posted-tools">${postedToolsHtml(inWin.length)}</div>${totalsHtml(inWin)}</div>
            <div class="cp-posted-list">
            ${list.map(rowHtml).join("")}
            ${!all.length ? `<p class="cp-older">Nothing posted yet.</p>` : ""}
            ${inWin.length > list.length ? `<button type="button" class="cp-btn cp-btn-ghost cp-showmore" data-act="moreposted">Show ${Math.min(POSTED_PAGE, inWin.length - list.length)} more</button>` : ""}
            ${olderLine}</div></div></section>`;
        continue;
      }
      if (!all.length) continue;
      any = true;
      const list = sec.key === "scheduled"
        ? all.slice().sort((a, b) => String(a.scheduled_at || "9").localeCompare(String(b.scheduled_at || "9"))) : all;
      html += `<section class="cp-section"><h3 class="cp-section-title">${esc(title)}<span class="cp-count">${list.length}</span>${sec.note ? `<em>${esc(sec.note)}</em>` : ""}</h3>
        ${list.map(rowHtml).join("")}</section>`;
    }
    if (!any) {
      html += `<div class="cp-empty">${team
        ? `<p>No posts here yet.</p><button type="button" class="cp-btn cp-btn-primary cp-btn-lg" data-act="new">Write the first post</button>
           <div><button type="button" class="cp-btn cp-btn-quiet cp-empty-alt" data-act="external">or add a post that is already on LinkedIn</button></div>`
        : `<p>Nothing to review right now. New posts show up here when they are ready for you.</p>`}</div>`;
    }
    root.innerHTML = html;
    hydrateImages(root);
    root.querySelectorAll(".cp-draft-input").forEach((el) => el.focus());
    if (S.showChart) drawChart();
  }

  // Beside the Posted heading: how to order them and, for the team, the way to
  // add a post that went out some other way.
  function postedToolsHtml(total) {
    const sort = true ? `<select class="cp-sort" aria-label="Order of posted posts">${SORTS.map(([k, label]) =>
      `<option value="${k}"${S.postedSort === k ? " selected" : ""}>${label}</option>`).join("")}</select>` : "";
    const when = `<select class="cp-sort cp-when" aria-label="Timeframe">${TIMEFRAMES.map(([k, label]) =>
      `<option value="${k}"${S.tf === k ? " selected" : ""}>${label}</option>`).join("")}</select>`;
    const add = S.isShare ? "" : `<button type="button" class="cp-btn cp-btn-quiet cp-addpost" data-act="external">+ Add a post</button>`;
    return `${sort}${when}<span class="cp-grow"></span>${add}`;
  }

  // After a post moves to another section (sent, approved, scheduled...), bring
  // it into view and mark it for a moment, so it never seems to have vanished.
  function renderAndShow(postId) {
    render();
    const row = S.root.querySelector(`.cp-row[data-post="${postId}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    if (r.top < 100 || r.top > window.innerHeight - 160) row.scrollIntoView({ block: "center", behavior: "smooth" });
    const card = row.querySelector(".cp-card");
    card.classList.add("cp-moved");
    setTimeout(() => card.classList.remove("cp-moved"), 1800);
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
    const r = sel.getRangeAt(0).cloneRange();
    const inText = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && el.closest ? el.closest(".cp-text") : null; };
    const text = inText(r.startContainer) || inText(r.endContainer);
    if (!text || !S.root.contains(text) || text.classList.contains("cp-text-empty")) return null;
    if (!text.contains(r.startContainer)) r.setStart(text, 0);
    if (!text.contains(r.endContainer)) r.setEnd(text, text.childNodes.length);
    const raw = r.toString();
    const quote = raw.trim();
    if (!quote) return null;
    const pre = document.createRange();
    pre.selectNodeContents(text);
    pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length + (raw.length - raw.trimStart().length);
    const postId = text.closest(".cp-row").dataset.post;
    if (postById(postId).status === "posted") return null;
    // Where to put the button: over the first line of what is highlighted.
    const rects = r.getClientRects();
    const rect = rects.length ? rects[0] : r.getBoundingClientRect();
    return { postId, quote, start, rect };
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
      let savedId = post ? post.id : null;
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
          savedId = rows[0].id;
        } else {
          await patchPost(post.id, fields);
          const kept = new Set(images.map((im) => im.path));
          const gone = JSON.parse(startImgs).map((im) => im.path).filter((pth) => !kept.has(pth));
          if (gone.length) sb.storageRemove(BUCKET, gone);
        }
        m.close();
        renderAndShow(savedId);
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
    if (!canPublish()) { toast("Connect LinkedIn first, with the link under the Posts title.", true); return; }
    const base = post.scheduled_at ? new Date(post.scheduled_at) : (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(9, 0, 0, 0); return x; })();
    const pad = (n) => String(n).padStart(2, "0");
    const dval = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
    const tval = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
    const already = post.status === "scheduled";
    const m = openModal(`<div class="cp-modal-body"><h3>${already ? "Change the time" : "Schedule this post"}</h3>
        <p>It publishes to LinkedIn as ${esc(profile().name)} at the time you pick. Times are in your own time zone.</p>
        <div class="cp-fields"><label>Date<input type="date" class="cp-input" data-d value="${dval}" /></label>
        <label>Time<input type="time" class="cp-input" data-t value="${tval}" step="300" /></label></div>
        <p class="cp-modal-msg"></p></div>
      <div class="cp-modal-foot">${already ? `<button type="button" class="cp-btn cp-btn-quiet cp-danger" data-unschedule>Cancel schedule</button><span class="cp-grow"></span>` : ""}
        <button type="button" class="cp-btn cp-btn-ghost" data-close>${already ? "Close" : "Cancel"}</button><button type="button" class="cp-btn cp-btn-primary" data-ok>${already ? "Save time" : "Schedule"}</button></div>`, { cls: "cp-modal-sm" });
    const off = m.el.querySelector("[data-unschedule]");
    if (off) off.onclick = async () => {
      try {
        await patchPost(post.id, { status: "approved", scheduled_at: null });
        m.close(); renderAndShow(post.id); toast("Taken off the schedule");
      } catch (err) { m.close(); toast(err.message, true); }
    };
    m.el.querySelector("[data-ok]").onclick = async () => {
      const when = new Date(`${m.el.querySelector("[data-d]").value}T${m.el.querySelector("[data-t]").value}`);
      const out = m.el.querySelector(".cp-modal-msg");
      if (isNaN(when)) { out.textContent = "Pick a date and a time."; return; }
      if (when.getTime() < Date.now() + 60 * 1000) { out.textContent = "Pick a time that is still ahead."; return; }
      try {
        const fields = { status: "scheduled", scheduled_at: when.toISOString(), publish_error: null };
        if (!post.approved_at) fields.approved_at = new Date().toISOString();
        await patchPost(post.id, fields);
        m.close(); renderAndShow(post.id); toast("Scheduled");
      } catch (err) { out.textContent = err.message; }
    };
  }

  const ACTIVITY_RE = /(activity|ugcPost|share)[-:](\d{15,25})/;

  // When a post went live, so nobody has to type a date. LinkedIn states it on
  // the post's public page and resolve_link passes it on. Without it, the
  // post's own number gives the moment the post was created (its first 41
  // bits are the time in milliseconds): the day it went live unless it was
  // scheduled ahead.
  function whenFromMs(ms) {
    if (!Number.isFinite(ms) || ms < Date.UTC(2010, 0, 1) || ms > Date.now() + 86400000) return null;
    const d = new Date(ms);
    return { iso: d.toISOString(), day: d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }) };
  }
  function whenFromId(id) {
    try { return whenFromMs(Number(BigInt(id) >> 22n)); } catch (_) { return null; }
  }

  // Everything a pasted link tells us: the post's address, id, date and first line.
  async function readLink(clientId, raw) {
    let url = String(raw || "").trim(), title = null, text = null, live = null;
    if (/^https:\/\/([\w-]+\.)?(lnkd\.in|linkedin\.com)\//i.test(url)) {
      try {
        const r = await sb.invokeFunction("linkedin-content", { action: "resolve_link", client_id: clientId, url });
        if (r && r.url) url = r.url;
        if (r && r.title) title = r.title;
        if (r && r.text) text = r.text;
        if (r && r.published_at) live = whenFromMs(Date.parse(r.published_at));
      } catch (_) {}
    }
    let hit = null;
    try { hit = decodeURIComponent(url).match(ACTIVITY_RE); } catch (_) { hit = url.match(ACTIVITY_RE); }
    if (!hit || !liUrl(url)) return null;
    const when = live || whenFromId(hit[2]);
    return { url, activity_id: hit[2], title, text, posted_on: when ? when.day : null, published_at: when ? when.iso : null };
  }

  // The post as LinkedIn shows it, through LinkedIn's own embed (public posts).
  function embedSrc(p) {
    let urn = p.post_urn;
    if (!urn && p.url) {
      let hit = null;
      try { hit = decodeURIComponent(p.url).match(ACTIVITY_RE); } catch (_) {}
      if (hit) urn = `urn:li:${hit[1]}:${hit[2]}`;
    }
    return urn ? `https://www.linkedin.com/embed/feed/update/${urn}` : null;
  }
  function showPost(p) {
    const src = embedSrc(p);
    if (!src) { if (liUrl(p.url)) window.open(p.url, "_blank", "noopener"); return; }
    openModal(`<div class="cp-embed-head">${liUrl(p.url) ? `<a class="cp-blue" href="${esc(p.url)}" target="_blank" rel="noopener">Open on LinkedIn</a>` : ""}
        <button type="button" class="cp-x" data-close aria-label="Close">&times;</button></div>
      <iframe class="cp-embed-frame" src="${esc(src)}" title="LinkedIn post" allowfullscreen></iframe>`, { cls: "cp-embed" });
  }

  // Paste a post's link. With a post: one written here that went live some other
  // way, which now counts as posted. Without: a post we never held here.
  function openLink(post) {
    const m = openModal(`<div class="cp-modal-body"><h3>${post ? "Add the link to this post" : "Add a post that is already on LinkedIn"}</h3>
        <p>On LinkedIn, click the three dots on the post and choose Copy link to post. Then paste it here.${post ? " This marks the post as posted." : ""}</p>
        <label class="cp-field-block">Link to the post<input type="url" class="cp-input" data-u placeholder="https://www.linkedin.com/posts/..." /></label>
        ${post || S.isShare ? "" : `<div class="cp-export">
          <p><b>Adding many at once?</b> On LinkedIn: their profile, Analytics, Post performance. Click Show more at the bottom until every post is loaded, then Export. Drop the file here.</p>
          <div class="cp-drop" data-drop>Drop the file here or click to choose it</div>
          <input type="file" accept=".xlsx,.xls,.csv" hidden data-file />
        </div>`}
        <p class="cp-modal-msg"></p></div>
      <div class="cp-modal-foot"><button type="button" class="cp-btn cp-btn-ghost" data-close>Cancel</button><button type="button" class="cp-btn cp-btn-primary" data-ok>Save</button></div>`, { cls: "cp-modal-md" });
    m.el.querySelector("[data-u]").focus();
    const drop = m.el.querySelector("[data-drop]"), fileIn = m.el.querySelector("[data-file]");
    if (drop) {
      const out = m.el.querySelector(".cp-modal-msg");
      const take = async (f) => {
        if (!f) return;
        if (f.size > 15 * 1024 * 1024) { out.textContent = "That file is over 15 MB."; return; }
        drop.classList.add("busy"); out.textContent = `Reading ${f.name}...`;
        try {
          const { rows, asOf } = await readExportFile(f);
          out.textContent = `Adding ${rows.length} post${rows.length === 1 ? "" : "s"}... this can take a minute.`;
          const base64 = await fileBase64(f);
          const r = await sb.invokeFunction("linkedin-content", { action: "import_export", client_id: S.clientId, filename: f.name, base64, rows, asOf });
          if (!r || r.error) throw new Error((r && r.error) || "The file could not be added.");
          // The file's numbers go on its posts too; a post whose numbers are already as new is left as it is.
          let said = [r.added ? `${r.added} post${r.added === 1 ? "" : "s"} added` : "",
            r.numbers ? `numbers saved for ${r.numbers}` : ""].filter(Boolean).join(", ");
          said = said ? said[0].toUpperCase() + said.slice(1) : "Nothing new in this file";
          const left = [r.up_to_date ? `${r.up_to_date} already up to date` : "",
            r.before_start ? `${r.before_start} from before ${S.clientName ? S.clientName + "'s" : "their"} start left out` : "",
            r.reposts ? `${r.reposts} repost${r.reposts === 1 ? "" : "s"} left out` : "",
            r.too_old ? `${r.too_old} older than LinkedIn keeps numbers for` : ""].filter(Boolean).join(", ");
          m.close();
          toast(`${said}${left ? ` (${left})` : ""}`, !!(r.brain && r.brain.error));
          if (r.brain && r.brain.error) setTimeout(() => toast("The numbers didn't reach Brain: " + r.brain.error, true), 2500);
          await load(); render();
        } catch (err) {
          out.textContent = err.message;
        } finally { drop.classList.remove("busy"); }
      };
      drop.onclick = () => fileIn.click();
      fileIn.onchange = () => { take(fileIn.files[0]); fileIn.value = ""; };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
    }
    m.el.querySelector("[data-ok]").onclick = async () => {
      const out = m.el.querySelector(".cp-modal-msg");
      out.textContent = "Checking the link...";
      const info = await readLink(S.clientId, m.el.querySelector("[data-u]").value);
      if (!info) { out.textContent = "That does not look like a link to a LinkedIn post."; return; }
      if (post && !(await linkDateOk(post, info))) return;
      const fields = {
        url: info.url, activity_id: info.activity_id, status: "posted", source: "external",
        posted_on: info.posted_on || new Date().toLocaleDateString("en-CA"),
        published_at: info.published_at || new Date().toISOString(), scheduled_at: null, publish_error: null,
      };
      try {
        if (post) await patchPost(post.id, { ...fields, ...liveText(info) });
        else {
          const sess = sb.getSession();
          await sb.sbFetch("/rest/v1/content_posts", {
            method: "POST", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ ...fields, title: info.title, body: info.text || null, client_id: S.clientId, created_by: sess && sess.user ? sess.user.id : null }),
          });
        }
        m.close();
        toast(post ? "Saved as posted" : "Post added");
        await load(); render();
        // Its first numbers now, for this post only.
        const added = post || S.posts.find((x) => x.activity_id === info.activity_id);
        if (S.integ && added) refreshPost(added.id, { quiet: true });
      } catch (err) {
        out.textContent = /duplicate|unique/i.test(err.message) ? "That post is already in the list." : err.message;
      }
    };
  }

  // LinkedIn's Post performance export (.xlsx): one row per post, with its link and publish date. Read here in the
  // browser with SheetJS (loaded only when someone drops a file); the server adds the posts and passes the file on.
  const EXPORT_COLS = {
    "post url": "url", "post publish date": "date", "post type": "type", "impressions": "impressions",
    "impressions (in-network)": "in_network", "impressions (out-of-network)": "out_network", "members reached": "reached",
    "followers gained": "followers", "profile viewers": "profile_views", "reactions": "reactions", "comments": "comments",
    "reposts": "reposts", "saves": "saves", "sends": "sends", "custom button engagements": "button",
    "visits to links": "link_visits", "link visits": "link_visits", "views": "views",
  };
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((ok, bad) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.integrity = "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw"; s.crossOrigin = "anonymous";
      s.onload = () => ok(window.XLSX); s.onerror = () => bad(new Error("The file reader could not load. Try again."));
      document.head.append(s);
    });
  }
  async function readExportFile(f) {
    const X = await loadXLSX();
    const wb = X.read(await f.arrayBuffer(), { type: "array" });
    const rows = [];
    for (const name of wb.SheetNames) {
      const grid = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
      const h = grid.findIndex((r) => r.some((c) => String(c).trim().toLowerCase() === "post url"));
      if (h < 0) continue;
      const cols = grid[h].map((c) => EXPORT_COLS[String(c).trim().toLowerCase()] || null);
      for (const r of grid.slice(h + 1)) {
        const o = {};
        cols.forEach((k, i) => { if (k && o[k] === undefined) o[k] = String(r[i] ?? "").trim(); });
        if (o.url) rows.push(o);
      }
    }
    if (!rows.length) throw new Error("This doesn't look like LinkedIn's Post performance export (no Post URL column).");
    return { rows, asOf: (/_(\d{4}-\d{2}-\d{2})\.\w+$/.exec(f.name) || [])[1] || "" };
  }
  async function fileBase64(f) {
    const b = new Uint8Array(await f.arrayBuffer()); let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Once a post is live, the saved text becomes what LinkedIn shows, so the
  // draft never sits behind it. If LinkedIn will not show the text (a post
  // that is not public), the draft stays.
  const liveText = (info) => (info && info.text ? { body: info.text, title: info.title || null } : {});

  // Copy gets reused (the same post run again weeks later), so a link can open just like the draft and still be the
  // old post. A draft can't have gone live before it was written: if the link's post is older, ask.
  async function linkDateOk(post, info) {
    if (!post || !post.created_at || !info || !info.posted_on) return true;
    const written = new Date(post.created_at).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (info.posted_on >= written) return true;
    const [y, m, d] = info.posted_on.split("-");
    return confirmBox("Is this the right post?", `That link is to a post from ${+m}/${+d}/${y.slice(2)}, before this draft was written.`, "Yes, save it");
  }

  // The start of a post, letters and digits only, for telling two posts apart.
  const opening = (s) => String(s || "").split("\n").find((l) => l.trim()) || "";
  const fingerprint = (s) => opening(s).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);

  // A link pasted into the box on an approved or scheduled post.
  async function saveLink(input) {
    const row = input.closest(".cp-row");
    const post = row ? postById(row.dataset.post) : null;
    const raw = input.value.trim();
    if (!post || !raw || input.disabled) return;
    input.disabled = true;
    try {
      const info = await readLink(S.clientId, raw);
      if (!info) { toast("That does not look like a link to a LinkedIn post.", true); return; }
      if (!(await linkDateOk(post, info))) return;
      // The easy mistake is the link to a different post. Speak up only when the openings differ.
      const linked = info.text || info.title;
      const theirs = fingerprint(linked), ours = fingerprint(post.body);
      const n = Math.min(theirs.length, ours.length);
      if (n > 0 && theirs.slice(0, n) !== ours.slice(0, n)) {
        const ok = await confirmBox("Is this the right post?",
          `The link's post starts with "${opening(linked).slice(0, 80)}". This one starts with "${opening(post.body).slice(0, 80)}".`, "Yes, save it");
        if (!ok) return;
      }
      await patchPost(post.id, {
        url: info.url, activity_id: info.activity_id, status: "posted", source: "external",
        posted_on: info.posted_on || new Date().toLocaleDateString("en-CA"),
        published_at: info.published_at || new Date().toISOString(), scheduled_at: null, publish_error: null,
        ...liveText(info),
      });
      renderAndShow(post.id);
      toast("Marked as posted");
      if (S.integ) refreshPost(post.id, { quiet: true });
    } catch (err) {
      toast(/duplicate|unique/i.test(err.message) ? "That post is already in the list." : err.message, true);
    } finally {
      if (input.isConnected) { input.disabled = false; input.value = ""; }
    }
  }

  async function connectLinkedIn() {
    try {
      const r = await sb.invokeFunction("linkedin-oauth-init", { client_id: S.clientId });
      if (!r || !r.authorize_url) throw new Error("LinkedIn did not answer.");
      window.location.href = r.authorize_url;      // LinkedIn's own approval screen, then back here
    } catch (err) {
      toast("The LinkedIn connection could not start. " + err.message, true);
    }
  }
  // One post's numbers: a click on its refresh icon, or (quiet) a post just added by link or marked posted.
  async function refreshPost(postId, { quiet = false, btn = null } = {}) {
    // One at a time: each refresh spends part of LinkedIn's small daily allowance.
    if (S.refreshing) return;
    S.refreshing = true;
    if (btn) btn.classList.add("is-busy");
    try {
      const res = await sb.invokeFunction("linkedin-content", { action: "sync", client_id: S.clientId, post_id: postId });
      const r = (res && res.result) || {};
      await load(); render();
      if (r.error && /reconnect_required/.test(r.error)) toast("LinkedIn needs to be connected again.", true);
      else if (quiet) { /* nothing to say */ }
      else if (r.error === "daily_limit") toast("Today's refreshes are used up.");
      else if (r.posts_synced) toast("Numbers refreshed");
      else toast("The numbers did not refresh.", true);
    } catch (err) {
      await load(); render();
      if (!quiet) toast("The numbers did not refresh. " + err.message, true);
    } finally { S.refreshing = false; }
  }
  async function disconnectLinkedIn() {
    const ok = await confirmBox("Disconnect LinkedIn?", "Posts and their numbers stay. Publishing and the daily numbers stop until it is connected again.", "Disconnect", true);
    if (!ok) return;
    await sb.invokeFunction("linkedin-content", { action: "disconnect", client_id: S.clientId });
    await load(); render();
    toast("LinkedIn disconnected");
  }

  async function publishNow(post) {
    if (!canPublish()) { toast("Connect LinkedIn first, with the link under the Posts title.", true); return; }
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
      else if (act === "copytext") {
        await navigator.clipboard.writeText(post.body || "");
        toast("Text copied");
      }
      else if (act === "toposted") {
        const head = S.root.querySelector(".cp-posted-head");
        if (head) window.scrollTo({ top: head.getBoundingClientRect().top + window.scrollY - 125, behavior: "smooth" });
      }
      else if (act === "connect") await connectLinkedIn();
      else if (act === "refreshpost") { if (post) await refreshPost(post.id, { btn: actEl }); }
      else if (act === "disconnect") await disconnectLinkedIn();
      else if (act === "tf") { S.tf = actEl.dataset.tf; S.postedShown = POSTED_PAGE; render(); }
      else if (act === "chart") { S.showChart = !S.showChart; render(); }
      else if (act === "moreposted") { S.postedShown += POSTED_PAGE; render(); }
      else if (act === "edit") openComposer(post);
      else if (act === "approve") { await patchPost(post.id, { status: "approved", approved_at: new Date().toISOString() }); renderAndShow(post.id); toast("Approved"); }
      else if (act === "unapprove") { await patchPost(post.id, { status: "ready", approved_at: null }); renderAndShow(post.id); }
      else if (act === "send") { await patchPost(post.id, { status: "ready" }); renderAndShow(post.id); toast("Sent for approval"); }
      else if (act === "todraft") { await patchPost(post.id, { status: "draft", approved_at: null }); renderAndShow(post.id); }
      // Moving a post to another stage from its menu. Leaving "scheduled" always clears the time.
      else if (act === "to-draft") { await patchPost(post.id, { status: "draft", approved_at: null, scheduled_at: null }); renderAndShow(post.id); }
      else if (act === "to-ready") { await patchPost(post.id, { status: "ready", approved_at: null, scheduled_at: null }); renderAndShow(post.id); }
      else if (act === "to-approved") { await patchPost(post.id, { status: "approved", approved_at: post.approved_at || new Date().toISOString(), scheduled_at: null }); renderAndShow(post.id); }
      else if (act === "schedule") openSchedule(post);
      else if (act === "unschedule") { await patchPost(post.id, { status: "approved", scheduled_at: null }); renderAndShow(post.id); }
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
        actEl.disabled = true;
        await addComment({ post_id: post.id, body: text, quote: d.quote, quote_start: d.start });
        S.draft = null; refreshRow(post.id);
      }
      else if (act === "reply") {
        const ta = thread.querySelector(".cp-reply");
        const text = ta.value.trim();
        if (!text) return;
        actEl.disabled = true;
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
      if (actEl.isConnected) actEl.disabled = false;
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
    if (ta.classList.contains("cp-linkbox")) { e.preventDefault(); saveLink(ta); return; }
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
      followers: [], tf: "all", postedSort: "newest", showChart: false, chart: null,
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
    // The link box saves the moment something is pasted into it.
    S.root.addEventListener("paste", (e) => {
      const el = e.target;
      if (el.classList && el.classList.contains("cp-linkbox")) setTimeout(() => saveLink(el), 0);
    });
    S.root.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains("cp-sort")) return;
      if (el.classList.contains("cp-when")) { S.tf = el.value; S.postedShown = POSTED_PAGE; }
      else S.postedSort = el.value;
      render();
    });

    // Back from LinkedIn's approval screen: say how it went and tidy the address.
    // The first numbers come with the daily run, or a click on a post's refresh icon.
    let justConnected = false;
    const params = new URLSearchParams(location.search);
    if (params.get("integration_purpose") === "content_analytics") {
      const status = params.get("integration_status");
      const reason = params.get("integration_reason") || "";
      if (status === "success") justConnected = true;
      else if (status) {
        const why = {
          provider_user_cancelled_login: "The LinkedIn sign-in was cancelled.",
          provider_user_cancelled_authorize: "Access was declined on LinkedIn's screen.",
          bad_state: "The connection link expired. Press Connect LinkedIn again.",
        }[reason] || "LinkedIn did not complete the connection.";
        toast(why, true);
      }
      ["integration_status", "integration_provider", "integration_purpose", "integration_reason"].forEach((k) => params.delete(k));
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params.toString() : "") + "#posts");
    }
    document.addEventListener("click", (e) => { if (!S.root.contains(e.target)) S.root.querySelectorAll(".cp-menu").forEach((mn) => mn.classList.add("hidden")); });

    try {
      await load();
      render();
      if (justConnected && S.integ) toast("LinkedIn connected");
    } catch (err) {
      S.root.innerHTML = `<div class="cp-empty"><p>The posts did not load. ${esc(err.message)}</p></div>`;
    }
  }

  window.ContentPosts = { init, readLink, showPost };
})();
