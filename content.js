(() => {
  if (globalThis.formatLinkLoaded) return;
  globalThis.formatLinkLoaded = true;
  const defaults = { prTitle: true, trunk: true, devin: true, firm: false, jira: true, firmSite: null };
  let settings;
  const copyLinkLabel = "Copy link";
  const copyLabel = "Copy PR title as a link";
  const marker = "[data-cw-pr-title-link]";
  const jiraSources = new WeakMap();
  const linkPath = "M9 3h4v4M13 3l-7 7M6 3H3v10h10v-3";
  const prPath = () => location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/[1-9]\d*)(?:\/|$)/)?.[1];

  // GitHub's PR header toolbar: the native "Copy link" icon button next to the title.
  function isBranchButton(element) {
    if (!element.closest('[class*="titleWithCopy"]')) return false;
    if (element.getAttribute("aria-label") === copyLinkLabel || element.title === copyLinkLabel) return true;
    const references = `${element.getAttribute("aria-labelledby") || ""} ${element.getAttribute("aria-describedby") || ""}`;
    return references.trim().split(/\s+/).some((id) => document.getElementById(id)?.textContent.trim() === copyLinkLabel);
  }

  async function copyRichLink(link) {
    const html = link.outerHTML;
    const text = link.textContent;
    try {
      // Supply both representations of the same link for native paste compatibility.
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return;
    } catch (error) {
      // Some Edge contexts reject the async API; the copy event can still write HTML.
      let handled = false;
      const onCopy = (event) => {
        if (!event.clipboardData) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.clipboardData.clearData();
        event.clipboardData.setData("text/html", html);
        event.clipboardData.setData("text/plain", text);
        handled = true;
      };
      document.addEventListener("copy", onCopy, true);
      try {
        if (!document.execCommand("copy") || !handled) throw error;
      } finally {
        document.removeEventListener("copy", onCopy, true);
      }
    }
  }

  async function copyLink(readLink) {
    const { title, url } = readLink();
    if (!title || !url) throw new Error("Title or URL is unavailable");
    const link = document.createElement("a");
    link.href = url;
    link.textContent = title;
    await copyRichLink(link);
  }

  function createButton(nativeButton, label = copyLabel, action = () => copyLink(readPrLink), icon = linkPath) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = nativeButton.className;
    button.setAttribute("data-cw-pr-title-link", "");
    button.style.flexShrink = "0";
    for (const name of ["data-component", "data-size", "data-variant", "data-no-visuals"]) {
      if (nativeButton.hasAttribute(name)) button.setAttribute(name, nativeButton.getAttribute(name));
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    const status = document.createElement("span");
    status.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
    status.setAttribute("role", "status");
    button.append(svg, status);

    function feedback(message, shape = icon, color = "") {
      button.title = message;
      button.setAttribute("aria-label", message);
      button.dataset.cwCopyState = message === label ? "idle" : message === "Copied!" ? "success" : "error";
      path.setAttribute("d", shape);
      path.setAttribute("transform", shape === linkPath ? "rotate(180 8 8)" : "");
      svg.style.color = color;
      status.textContent = message === label ? "" : message;
    }
    feedback(label);

    let reset;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(reset);
      button.disabled = true;
      try {
        await action();
        feedback("Copied!", "M3 8l3 3 7-7", "var(--fgColor-success, #1a7f37)");
      } catch (error) {
        feedback(`Could not copy: ${error.name}: ${error.message}`, "M4 4l8 8M12 4l-8 8", "var(--fgColor-danger, #d1242f)");
        console.warn("TidyLink:", error);
      } finally {
        button.disabled = false;
        if (button.title === "Copied!") reset = setTimeout(() => feedback(label), 2000);
      }
    });
    return button;
  }

  // --- Trunk merge-queue toggle -------------------------------------------------
  const mergeMarker = "[data-cw-trunk-merge]";
  const mergePath = "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z";
  const checkPath = "M3 8l3.5 3.5L13 4.5";

  function trunkState() {
    const comment = [...document.querySelectorAll("[id^=issuecomment]")].find((c) => /^\s*trunk-io\b/.test(c.textContent));
    const key = `cw-trunk:${prPath()}`;
    if (!comment) {
      // Commits/Checks/Files tabs have no Trunk comment: reuse the state seen on Conversation.
      try { const cached = location.pathname !== prPath() && JSON.parse(sessionStorage.getItem(key)); if (cached) return { found: true, ...cached }; } catch {}
      return { found: false, checked: false, blocked: false, failed: false, ready: false };
    }
    // Trunk restores its checkbox when a PR is cancelled, so "empty box" is the only idle state.
    const box = comment.querySelector('input[type="checkbox"]');
    // "1 approval received" / "2 of 2 required approvals received" labels in GitHub's merge box.
    const approvals = Math.max(0, ...[...document.querySelectorAll("[aria-label]")]
      .map((e) => e.getAttribute("aria-label").match(/(\d+)(?: of \d+ required)? approvals? received/)?.[1] | 0));
    // ponytail: "can merge" = 2+ approvals and no failure in Trunk's status comment; GitHub's merge button is always disabled under Trunk.
    const failed = /❌|fail/i.test(comment.textContent);
    const state = { checked: box ? box.checked : true, blocked: approvals < 2 || failed, failed, ready: approvals >= 2 };
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch {}
    return { found: true, box, ...state };
  }

  async function postComment(body) {
    const ta = document.querySelector('textarea[aria-label="Markdown value"]');
    if (!ta) throw new Error("Comment box not found (open the Conversation tab)");
    if (ta.value.trim()) throw new Error("Comment box has a draft; clear it first");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, body);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    let p = ta, submit;
    while (p && !(submit = [...p.querySelectorAll("button")].find((b) => b.textContent.trim() === "Comment"))) p = p.parentElement;
    if (!submit || submit.disabled) throw new Error("Comment button unavailable");
    submit.click();
  }

  function updateMergeButton(button) {
    const { found, checked, blocked, failed, ready } = trunkState();
    button.disabled = !found;
    button.setAttribute("aria-checked", String(checked));
    button.dataset.cwQueued = String(checked);
    button.style.color = !checked ? (ready ? "var(--fgColor-success, #1a7f37)" : "var(--fgColor-muted, #59636e)")
      : failed ? "var(--fgColor-danger, #d1242f)" : blocked ? "var(--fgColor-attention, #9a6700)" : "var(--fgColor-success, #1a7f37)";
    button.querySelector("[data-cw-tick]").style.display = checked ? "" : "none";
    button.title = button.ariaLabel = !found ? "Trunk comment not found"
      : !checked ? `${ready ? "Approved (2+)" : "Not queued"} — click to merge (/trunk merge)`
      : blocked ? "Queued, merge criteria not met yet — click to cancel (/trunk cancel)"
      : "In merge queue — click to cancel (/trunk cancel)";
  }

  function createMergeButton(nativeButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = nativeButton.className;
    button.setAttribute("data-cw-trunk-merge", "");
    button.setAttribute("role", "checkbox");
    button.style.flexShrink = "0";
    for (const name of ["data-component", "data-size", "data-variant", "data-no-visuals"]) {
      if (nativeButton.hasAttribute(name)) button.setAttribute(name, nativeButton.getAttribute(name));
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 32 16");
    svg.setAttribute("width", "32");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const merge = document.createElementNS(svg.namespaceURI, "path");
    merge.setAttribute("d", mergePath);
    merge.setAttribute("fill", "currentColor");
    const frame = document.createElementNS(svg.namespaceURI, "rect");
    for (const [k, v] of Object.entries({ x: 18.5, y: 2.5, width: 11, height: 11, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.5 })) frame.setAttribute(k, v);
    const tick = document.createElementNS(svg.namespaceURI, "path");
    tick.setAttribute("d", checkPath);
    tick.setAttribute("transform", "translate(16.5 0) scale(.85) translate(1.5 1.5)");
    for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" })) tick.setAttribute(k, v);
    tick.setAttribute("data-cw-tick", "");
    svg.append(merge, frame, tick);
    button.append(svg);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const { box, checked } = trunkState();
      button.disabled = true;
      try {
        if (checked) {
          await postComment("/trunk cancel");
        } else {
          if (!box || box.disabled) throw new Error("Trunk checkbox unavailable");
          box.click(); // same as ticking the box in Trunk's comment
        }
      } catch (error) {
        console.warn("TidyLink:", error);
        button.title = button.ariaLabel = `Could not update: ${error.message}`;
        return;
      } finally {
        button.disabled = false;
      }
      setTimeout(() => updateMergeButton(button), 300);
    });
    updateMergeButton(button);
    return button;
  }

  // --- Devin automation lock ----------------------------------------------------
  const devinMarker = "[data-cw-devin-lock]";

  function devinBox() {
    return [...document.querySelectorAll("[id^=issuecomment]")]
      .filter((c) => /^\s*devin-ai-integration\b/.test(c.textContent))
      .flatMap((c) => [...c.querySelectorAll('input[type="checkbox"]')])
      .find((b) => /disable automatic/i.test(b.closest("li, label, .task-list-item")?.textContent || ""));
  }

  function updateDevinButton(button) {
    const box = devinBox();
    const locked = !!box?.checked;
    button.disabled = !box;
    button.setAttribute("aria-checked", String(locked));
    button.style.color = locked ? "var(--fgColor-attention, #9a6700)" : "var(--fgColor-muted, #59636e)";
    button.querySelector("[data-cw-shackle]").setAttribute("d", locked ? "M5.5 6.5V4a2.5 2.5 0 0 1 5 0v2.5" : "M5.5 6.5V4a2.5 2.5 0 0 1 4.9-.7");
    button.title = button.ariaLabel = !box ? "Devin comment not found"
      : locked ? "Devin automation disabled — click to re-enable" : "Devin automation active — click to disable";
  }

  function createDevinButton(nativeButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = nativeButton.className;
    button.setAttribute("data-cw-devin-lock", "");
    button.setAttribute("role", "checkbox");
    button.style.flexShrink = "0";
    for (const name of ["data-component", "data-size", "data-variant", "data-no-visuals"]) {
      if (nativeButton.hasAttribute(name)) button.setAttribute(name, nativeButton.getAttribute(name));
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const body = document.createElementNS(svg.namespaceURI, "path");
    body.setAttribute("d", "M3.75 6.5h8.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25v-5.5c0-.69.56-1.25 1.25-1.25Z");
    const shackle = document.createElementNS(svg.namespaceURI, "path");
    shackle.setAttribute("data-cw-shackle", "");
    for (const p of [body, shackle]) {
      for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" })) p.setAttribute(k, v);
    }
    svg.append(body, shackle);
    button.append(svg);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      devinBox()?.click(); // same as ticking the box in Devin's comment
      setTimeout(() => updateDevinButton(button), 300);
    });
    updateDevinButton(button);
    return button;
  }

  function readPrLink() {
    const title = document.querySelector('h1 .markdown-title, h1 .js-issue-title, h1 [class*="markdownTitle"], [class*="titleWithCopy"] [class*="markdownTitle"]')?.textContent.trim();
    const pathname = prPath();
    return { title, url: pathname && `${location.origin}${pathname}` };
  }

  const firmMarker = "[data-cw-firm-login]";

  const isConversation = pathname => location.pathname.replace(/\/$/, "") === pathname;
  const githubRepo = pathname => pathname?.split("/").slice(1, 3).join("/").toLowerCase();

  function findFirmLogin(domain, page = document) {
    const comments = [...page.querySelectorAll('[id^="issuecomment-"]')].reverse();
    for (const comment of comments) {
      if (!/^issuecomment-\d+$/.test(comment.id)) continue;
      const body = comment.querySelector(".comment-body, .markdown-body");
      const author = [...comment.querySelectorAll('a[href="/apps/github-actions"], a[href="/github-actions"], a[href="https://github.com/apps/github-actions"]')].find((node) =>
        !node.closest(".comment-body, .markdown-body") && /^github-actions(?:\[bot\])?$/.test(node.textContent.trim()));
      if (!body || !author) continue;
      for (const block of body.querySelectorAll("p")) {
        const target = [...block.querySelectorAll("a[href]")].find((link) =>
          /^Firm Url:$/i.test(link.previousSibling?.textContent.trim()));
        const password = [...block.querySelectorAll("code")].find((code) =>
          /^Password:$/i.test(code.previousSibling?.textContent.trim()))?.textContent;
        if (password && target?.protocol === "https:" && !target.username && !target.password && !target.port
            && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(target.hostname)
            && (!domain || target.hostname === domain || target.hostname.endsWith(`.${domain}`))) {
          return { password, url: target.href, domain: target.hostname };
        }
      }
    }
  }

  function configuredFirmSite(pathname) {
    const site = settings.firmSite;
    if (settings.firm && site?.domain && githubRepo(pathname) === site.repo) return site;
  }

  if (location.hostname === "github.com") {
    globalThis.chrome?.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
      if (message !== "detect-firm-site") return;
      const pathname = prPath();
      const repo = isConversation(pathname) && githubRepo(pathname);
      const login = repo && findFirmLogin();
      sendResponse(login ? { repo, domain: login.domain } : null);
    });
  }

  function createFirmButton(nativeButton) {
    const button = createButton(nativeButton, "Copy password and open Firm URL", async () => {
      const pathname = prPath();
      const site = configuredFirmSite(pathname);
      if (!site) throw new Error("Firm URL is not configured for this PR");
      let login = isConversation(pathname) && findFirmLogin(site.domain);
      if (!login) {
        // Other PR tabs do not contain the comment. Read the same PR on click only.
        let page;
        try {
          const response = await fetch(`${location.origin}${pathname}`, { mode: "same-origin", cache: "no-store" });
          if (!response.ok) throw new Error();
          const template = document.createElement("template");
          template.innerHTML = await response.text();
          page = template.content;
        } catch {
          throw new Error("Could not load the PR conversation");
        }
        if (prPath() !== pathname || configuredFirmSite(pathname)?.domain !== site.domain) {
          throw new Error("The PR or Firm URL settings changed. Try again.");
        }
        login = findFirmLogin(site.domain, page);
      }
      if (!login) throw new Error("Firm login comment is unavailable");
      // Do not surface browser errors that might include clipboard content or the destination.
      try {
        await navigator.clipboard.writeText(login.password);
      } catch {
        throw new Error("Clipboard write failed");
      }
      location.assign(login.url);
    }, "M9.5 9.5a3.5 3.5 0 1 0-3-3L2 11v3h3v-2h2v-2l.5-.5");
    button.removeAttribute("data-cw-pr-title-link");
    button.setAttribute("data-cw-firm-login", "");
    return button;
  }

  function insertButtons() {
    if (!settings) return;
    if (location.hostname !== "github.com") return insertJiraButtons();
    const nativeButtons = prPath() ? [...document.querySelectorAll(
      "button[aria-label], button[title], button[aria-labelledby], button[aria-describedby], clipboard-copy",
    )].filter(isBranchButton) : [];

    // A page can have both a regular header and a sticky header. Keep one per native button.
    const actions = [
      [settings.prTitle, marker, createButton],
      [settings.trunk, mergeMarker, createMergeButton],
      [settings.devin, devinMarker, createDevinButton],
      [configuredFirmSite(prPath()), firmMarker, createFirmButton],
    ];
    const keep = new Set();
    for (const nativeButton of nativeButtons) {
      let anchor = nativeButton;
      for (const [enabled, selector, create] of actions) {
        if (!enabled) continue;
        if (!anchor.nextElementSibling?.matches(selector)) anchor.after(create(nativeButton));
        anchor = anchor.nextElementSibling;
        keep.add(anchor);
      }
    }
    for (const button of document.querySelectorAll(`${marker}, ${mergeMarker}, ${devinMarker}, ${firmMarker}`)) {
      if (!keep.has(button)) button.remove();
    }
    for (const button of document.querySelectorAll(mergeMarker)) updateMergeButton(button);
    for (const button of document.querySelectorAll(devinMarker)) updateDevinButton(button);
  }

  function isJiraCopyButton(button) {
    const name = button.getAttribute("aria-label") || button.title || "";
    const refs = `${button.getAttribute("aria-labelledby") || ""} ${button.getAttribute("aria-describedby") || ""}`;
    const labels = refs.trim().split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim());
    const testId = button.getAttribute("data-testid") || "";
    return /^copy link$/i.test(name) || labels.some((label) => /^copy link$/i.test(label || ""))
      || (/breadcrumb/i.test(testId) && /copy.?link/i.test(testId));
  }

  function jiraContext(anchor) {
    const pageKey = location.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/)?.[1];
    const selected = new URL(location.href).searchParams.get("selectedIssue") || pageKey;
    const key = anchor.textContent.trim();
    if (!selected || key !== selected || anchor.closest(marker)) return null;
    const scope = anchor.closest('[role="dialog"], [data-testid="issue.views.issue-details.issue-modal"]')
      || (pageKey && (anchor.closest('main, [role="main"]') || document.querySelector('main, [role="main"]')))
      || document;
    const heading = scope.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]')
      || scope.querySelector('[data-testid*="summary"] h1, h1[data-testid*="summary"]')
      || (scope !== document ? scope.querySelector("h1") : null);
    const title = heading?.textContent.trim();
    if (!title) return null;
    const group = anchor.parentElement;
    // Identify the breadcrumb from its stable text, even before Copy link is mounted.
    const breadcrumb = anchor.closest('nav, [role="navigation"], [aria-label*="breadcrumb" i], [data-testid*="breadcrumb" i]');
    const nativeCopy = [...group.querySelectorAll('button, [role="button"]')].some(isJiraCopyButton);
    if (!breadcrumb && !nativeCopy && !group.hasAttribute("data-cw-jira-copy-group")) return null;
    const href = anchor.getAttribute("href") || (pageKey === key ? `/browse/${key}` : null);
    if (!href) return null;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || !url.pathname.endsWith(`/browse/${key}`)) return null;
    return { group, title: `${key}: ${title}`, url: url.href };
  }

  function bindJiraHover(group, button) {
    let hide;
    const show = () => {
      clearTimeout(hide);
      button.setAttribute("data-cw-jira-visible", "");
    };
    const leave = (event) => {
      if (event.relatedTarget && group.contains(event.relatedTarget)) return;
      clearTimeout(hide);
      hide = setTimeout(() => {
        if (!group.matches(":hover") && !group.contains(document.activeElement)) button.removeAttribute("data-cw-jira-visible");
      }, 2000);
    };
    const events = [["mouseover", show], ["mouseout", leave], ["focusin", show], ["focusout", leave]];
    for (const [name, handler] of events) group.addEventListener(name, handler);
    if (group.matches(":hover") || group.contains(document.activeElement)) show();
    return () => {
      clearTimeout(hide);
      for (const [name, handler] of events) group.removeEventListener(name, handler);
    };
  }

  function insertJiraButtons() {
    const anchors = (settings.jira ? [...document.querySelectorAll('a[href], [aria-current="page"]')] : [])
      .filter((anchor) => jiraContext(anchor));
    for (const button of document.querySelectorAll(marker)) {
      const record = jiraSources.get(button);
      if (!record || !anchors.includes(record.anchor) || jiraContext(record.anchor)?.group !== button.parentElement) {
        record?.dispose();
        button.remove();
      }
    }
    if (anchors.length && !document.getElementById("cw-jira-format-link-style")) {
      const style = document.createElement("style");
      style.id = "cw-jira-format-link-style";
      style.textContent = `
        [data-cw-jira-copy-group] > [data-cw-pr-title-link] {
          opacity: 0; transform: translateX(-6px); pointer-events: none;
          transition: opacity 150ms ease-out, transform 150ms ease-out;
        }
        [data-cw-jira-copy-group] > [data-cw-pr-title-link][data-cw-jira-visible],
        [data-cw-jira-copy-group]:focus-within > [data-cw-pr-title-link],
        [data-cw-jira-copy-group] > [data-cw-pr-title-link][data-cw-copy-state="success"],
        [data-cw-jira-copy-group] > [data-cw-pr-title-link][data-cw-copy-state="error"] {
          opacity: 1; transform: translateX(0); pointer-events: auto;
        }
        [data-cw-jira-copy-group] > [data-cw-pr-title-link]:hover { background: var(--ds-background-neutral-hovered, #091e4224) !important; }
        [data-cw-jira-copy-group] > [data-cw-pr-title-link]:focus-visible { outline: 2px solid var(--ds-border-focused, #388bff); }
        @media (prefers-reduced-motion: reduce) {
          [data-cw-jira-copy-group] > [data-cw-pr-title-link] { transition: none; }
        }
      `;
      document.head.append(style);
    }
    for (const anchor of anchors) {
      const { group } = jiraContext(anchor);
      group.setAttribute("data-cw-jira-copy-group", "");
      if ([...group.querySelectorAll(marker)].some((button) => jiraSources.get(button)?.anchor === anchor)) continue;
      const button = createButton(anchor, "Format Link", () => copyLink(() => {
        const context = jiraContext(anchor);
        if (!context) throw new Error("Ticket title or breadcrumb link is unavailable");
        return context;
      }));
      button.className = "";
      button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:24px;height:24px;padding:4px;border:0;border-radius:3px;background:transparent;color:var(--ds-icon-subtle, currentColor);cursor:pointer;vertical-align:middle";
      // Never mount in the native copy wrapper or tie our lifetime to that control.
      group.append(button);
      jiraSources.set(button, { anchor, dispose: bindJiraHover(group, button) });
    }
  }

  // Observe SPA navigation and controls mounted only while their breadcrumb is hovered.
  let pending;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      insertButtons();
    }, 50);
  };
  new MutationObserver(schedule).observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["aria-label", "aria-describedby", "aria-labelledby"],
  });
  document.addEventListener("turbo:load", schedule);
  document.addEventListener("pjax:end", schedule);
  window.addEventListener("popstate", schedule);
  const storage = globalThis.chrome?.storage;
  if (storage) {
    storage.local.get(defaults).then(values => {
      settings = values;
      storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue ?? defaults[key];
        schedule();
      });
      insertButtons();
    }).catch(() => {});
  } else {
    settings = defaults;
    insertButtons();
  }
  setInterval(() => { document.querySelectorAll(mergeMarker).forEach(updateMergeButton); document.querySelectorAll(devinMarker).forEach(updateDevinButton); }, 3000); // Trunk edits its comment in place
})();
