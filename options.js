const api = globalThis.browser ?? globalThis.chrome;
const scriptId = "jira-format-link";
const switches = [...document.querySelectorAll('input[role="switch"]')];
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const detectPr = document.querySelector("#detect-pr");
const jiraSite = document.querySelector("#jira-site");
const status = document.querySelector("#status");
const repo = document.querySelector("#firm-repo");
const domain = document.querySelector("#firm-domain");
let activeOrigin;
let activeTabId;
let prTabId;
let current;

function renderJira() {
  jiraSite.textContent = current ? new URL(current).origin : "No site connected";
  connect.hidden = !!current;
  connect.disabled = !activeOrigin || !!current;
  disconnect.disabled = !current;
}

async function setup() {
  const [settings, [script], [tab]] = await Promise.all([
    api.storage.local.get(null),
    api.scripting.getRegisteredContentScripts({ ids: [scriptId] }),
    api.tabs.query({ active: true, currentWindow: true }),
  ]);
  const url = tab?.url && new URL(tab.url);
  if (url?.origin === "https://github.com" && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) {
    prTabId = tab.id;
    detectPr.disabled = false;
  } else {
    detectPr.title = "Open the Conversation tab of a GitHub pull request.";
  }
  if (url?.protocol === "https:" && !url.port && url.hostname !== "github.com") {
    activeOrigin = url.origin;
    activeTabId = tab.id;
  }
  current = script?.matches[0];
  repo.value = settings.firmSite?.repo || "";
  domain.value = settings.firmSite?.domain || "";
  detectPr.hidden = Boolean(settings.firmSite?.repo && settings.firmSite?.domain);
  for (const input of switches) {
    input.checked = input.id === "firm" ? settings.firm === true : settings[input.id] !== false;
    input.disabled = false;
  }
  renderJira();
}

detectPr.addEventListener("click", async () => {
  const firmSwitch = document.querySelector("#firm");
  detectPr.disabled = firmSwitch.disabled = true;
  status.textContent = "";
  try {
    let site;
    try {
      site = await api.tabs.sendMessage(prTabId, "detect-firm-site");
    } catch {
      throw new Error("Reload the PR tab and try again.");
    }
    if (!site) throw new Error("No matching GitHub Actions comment found in this PR.");
    await api.storage.local.set({ firmSite: site, firm: true });
    repo.value = site.repo;
    domain.value = site.domain;
    firmSwitch.checked = true;
    detectPr.hidden = true;
    status.textContent = `Firm URL enabled for ${site.repo} (${site.domain}).`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    detectPr.disabled = firmSwitch.disabled = false;
  }
});

async function changeSite(action) {
  connect.disabled = disconnect.disabled = true;
  status.textContent = "";
  try {
    await action();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    renderJira();
  }
}

connect.addEventListener("click", () => changeSite(async () => {
  const next = `${activeOrigin}/*`;
  const previous = current;
  const granted = await api.permissions.request({ origins: [next] });
  if (!granted) throw new Error("Access to the Jira site was not granted.");
  const script = { id: scriptId, matches: [next], js: ["content.js"], runAt: "document_idle" };
  try {
    if (previous) await api.scripting.updateContentScripts([script]);
    else await api.scripting.registerContentScripts([script]);
  } catch (error) {
    await api.permissions.remove({ origins: [next] });
    throw error;
  }
  current = next;
  if (previous) await api.permissions.remove({ origins: [previous] });
  try {
    await api.scripting.executeScript({ target: { tabId: activeTabId }, files: ["content.js"] });
    status.textContent = "Jira connected.";
  } catch {
    status.textContent = "Jira connected. Reload your Jira tab.";
  }
}));

disconnect.addEventListener("click", () => changeSite(async () => {
  const previous = current;
  await api.scripting.unregisterContentScripts({ ids: [scriptId] });
  current = undefined;
  await api.permissions.remove({ origins: [previous] });
  status.textContent = "Jira disconnected. Reload your Jira tabs.";
}));

for (const input of switches) {
  input.addEventListener("change", async () => {
    input.disabled = true;
    try {
      await api.storage.local.set({ [input.id]: input.checked });
      status.textContent = input.id === "firm" && input.checked && (!repo.value || !domain.value)
        ? "Set a repository and allowed domain under Firm URL setup." : "";
    } catch (error) {
      input.checked = !input.checked;
      status.textContent = error.message;
    } finally {
      input.disabled = false;
    }
  });
}

document.querySelector("#firm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const repository = repo.value.trim().toLowerCase();
  const hostname = domain.value.trim().toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(repository) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname)) {
    status.textContent = "Enter a repository as owner/name and a domain without a URL path.";
    return;
  }
  try {
    await api.storage.local.set({ firmSite: { repo: repository, domain: hostname } });
    detectPr.hidden = true;
    status.textContent = "Firm URL settings saved.";
  } catch (error) {
    status.textContent = error.message;
  }
});

setup().catch(error => { status.textContent = error.message; });
