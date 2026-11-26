// Optional DOM regression runner: NODE_PATH=/path/to/jsdom/node_modules node tests/check.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["activeTab", "clipboardWrite", "scripting", "storage"]);
assert.equal(manifest.action.default_popup, "options.html");
assert.equal(manifest.options_page, undefined);
assert.deepEqual(manifest.content_scripts[0].matches, ["https://github.com/*"]);
assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);

class Resources extends ResourceLoader {
  fetch(url) {
    return url.endsWith("/content.js") ? Promise.resolve(fs.readFileSync(path.join(root, "content.js"))) : null;
  }
}

async function run(file, url) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    url, runScripts: "dangerously", resources: new Resources(), virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.Blob = Blob;
      window.ClipboardItem = class {
        constructor(values) { this.values = values; this.types = Object.keys(values); }
        async getType(type) { return this.values[type]; }
      };
    },
  });
  try {
    for (let attempt = 0; attempt < 180; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = dom.window.document.querySelector("#result")?.textContent;
      if (!result || result === "RUNNING") continue;
      assert.ok(result.startsWith("PASS:"), `${file}: ${result}`);
      console.log(`${file}: ${result}`);
      return;
    }
    throw new Error(`Timed out: ${file}`);
  } finally {
    dom.window.close();
  }
}

async function checkFirmLogin() {
  const dom = new JSDOM(`
    <div class="titleWithCopy"><button aria-label="Copy link"></button></div>
    <div id="issuecomment-1"><a href="/apps/github-actions">github-actions[bot]</a>
      <div class="markdown-body"><p>Firm Url: <a href="https://demo.preview.example.com/signin">Firm</a><br>
      Password: <code>fake&lt;&amp; secret</code></p></div></div>
    <div id="issuecomment-2"><a href="/apps/github-actions">github-actions[bot]</a>
      <div class="markdown-body"><p>Firm Url: <a href="https://preview.example.com.example.org/">Firm</a><br>
      Password: <code>fake-other-secret</code></p></div></div>
    <div id="issuecomment-3"><a class="author" href="/someone">someone</a>
      <div class="markdown-body"><p>Firm Url: <a href="https://other.preview.example.com/">Firm</a><br>
      Password: <code>fake-manual-secret</code></p></div></div>`, {
    url: "https://github.com/acme/demo/pull/42", runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const navigations = [];
  try {
    const location = new URL(window.location.href);
    location.assign = url => navigations.push(url);
    const writes = [];
    let finishCopy;
    let deny = true;
    Object.defineProperty(window.navigator, "clipboard", { value: {
      async writeText(text) {
        if (deny) throw new Error("Denied");
        writes.push(text);
        await new Promise(resolve => { finishCopy = resolve; });
      },
    }});
    let updateSettings;
    let handleMessage;
    window.chrome = { storage: {
      local: { async get(defaults) { return { ...defaults, firm: true, firmSite: { repo: "acme/demo", domain: "preview.example.com" } }; } },
      onChanged: { addListener(listener) { updateSettings = listener; } },
    }, runtime: { onMessage: { addListener(listener) { handleMessage = listener; } } }};
    window.Function("location", fs.readFileSync(path.join(root, "content.js"), "utf8"))(location);
    await new Promise(resolve => setImmediate(resolve));
    let detected;
    const button = window.document.querySelector("[data-cw-firm-login]");
    assert.ok(button, "Firm button appears for the Actions comment");
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(button.dataset.cwTooltip, /Clipboard write failed/);
    assert.deepEqual(navigations, []);
    deny = false;
    button.click();
    assert.deepEqual(writes, ["fake<& secret"]);
    assert.deepEqual(navigations, []);
    finishCopy();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigations, ["https://demo.preview.example.com/signin"]);
    window.document.getElementById("issuecomment-2").remove();
    handleMessage("detect-firm-site", {}, result => { detected = result; });
    assert.deepEqual(Object.keys(detected).sort(), ["domain", "repo"]);
    assert.equal(detected.repo, "acme/demo");
    assert.equal(detected.domain, "demo.preview.example.com");
    const conversation = window.document.getElementById("issuecomment-1").outerHTML;
    window.document.querySelectorAll('[id^="issuecomment-"]').forEach(comment => comment.remove());
    window.history.pushState({}, "", "/acme/demo/pull/42/files");
    location.pathname = window.location.pathname;
    const requests = [];
    window.fetch = async (url, options) => {
      requests.push([url, options.mode]);
      return { ok: true, text: async () => conversation };
    };
    await new Promise(resolve => setTimeout(resolve, 110));
    const filesButton = window.document.querySelector("[data-cw-firm-login]");
    assert.ok(filesButton);
    assert.deepEqual(requests, []);
    filesButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [["https://github.com/acme/demo/pull/42", "same-origin"]]);
    assert.deepEqual(writes, ["fake<& secret", "fake<& secret"]);
    assert.equal(navigations.length, 1);
    finishCopy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigations.length, 2);
    window.fetch = async () => ({ ok: true, text: async () => "<p>No comment</p>" });
    filesButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(filesButton.dataset.cwTooltip, /Firm login comment is unavailable/);
    assert.equal(writes.length, 2);
    assert.equal(navigations.length, 2);
    updateSettings({ firm: { newValue: false }, prTitle: { newValue: false }, devin: { newValue: false } }, "local");
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(window.document.querySelector("[data-cw-firm-login], [data-cw-pr-title-link], [data-cw-devin-lock]"), null);
    assert.ok(window.document.querySelector("[data-cw-trunk-merge]"));
    console.log("firm login: PASS (trusted comment and destination; copy before navigation)");
  } finally {
    window.close();
  }
}

async function checkPopup() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  const requested = [];
  const scripts = [];
  const writes = [];
  const injections = [];
  try {
    window.chrome = {
      tabs: { async query() { return [{ id: 7, url: "https://jira.example.com/board?selectedIssue=DEMO-1" }]; } },
      storage: { local: { async get() { return { devin: false }; }, async set(value) { writes.push(value); } } },
      permissions: { async request(value) { requested.push(value); return true; } },
      scripting: {
        async getRegisteredContentScripts() { return []; },
        async registerContentScripts(value) { scripts.push(...value); },
        async executeScript(value) { injections.push(value.target.tabId); },
      },
    };
    window.eval(fs.readFileSync(path.join(root, "options.js"), "utf8"));
    await new Promise(resolve => setImmediate(resolve));
    const find = id => window.document.getElementById(id);
    assert.equal(find("firm").checked, false);
    assert.equal(find("devin").checked, false);
    assert.equal(find("connect").disabled, false);
    assert.equal(find("connect").hidden, false);
    find("connect").click();
    find("prTitle").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested[0].origins[0], "https://jira.example.com/*");
    assert.equal(scripts[0].matches[0], "https://jira.example.com/*");
    assert.deepEqual(injections, [7]);
    assert.equal(find("jira-site").textContent, "https://jira.example.com");
    assert.equal(find("connect").hidden, true);
    assert.equal(writes[0].prTitle, false);
    console.log("popup: PASS (connects active origin and persists individual switches)");
  } finally {
    window.close();
  }
}

async function checkPrPopup() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  const firmSite = { repo: "acme/demo", domain: "preview.example.com" };
  const writes = [];
  let detected = null;
  try {
    window.chrome = {
      tabs: {
        async query() { return [{ id: 8, url: "https://github.com/acme/demo/pull/42#issuecomment-1" }]; },
        async sendMessage(id, message) {
          assert.equal(id, 8);
          assert.equal(message, "detect-firm-site");
          return detected;
        },
      },
      storage: { local: { async get() { return {}; }, async set(value) { writes.push(value); } } },
      scripting: { async getRegisteredContentScripts() { return []; } },
    };
    window.eval(fs.readFileSync(path.join(root, "options.js"), "utf8"));
    await new Promise(resolve => setImmediate(resolve));
    const find = id => window.document.getElementById(id);
    assert.equal(find("detect-pr").hidden, false);
    assert.equal(find("detect-pr").parentElement, find("connect").parentElement);
    find("detect-pr").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(find("status").textContent, /No matching GitHub Actions comment/);
    assert.equal(writes.length, 0);
    assert.equal(find("detect-pr").hidden, false);
    detected = firmSite;
    find("detect-pr").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes[0].firm, true);
    assert.deepEqual(writes[0].firmSite, firmSite);
    assert.equal(find("firm").checked, true);
    assert.equal(find("detect-pr").hidden, true);
    console.log("PR popup: PASS (saves detected settings only when a comment matches)");
  } finally {
    window.close();
  }
}

Promise.all([
  checkPopup(),
  checkPrPopup(),
  checkFirmLogin(),
  run("browser.html", "https://github.com/acme/repo/pull/42/files?tab=files#diff"),
  run("jira.html", "https://jira.example.com/jira/software/c/projects/DEMO/boards/42?selectedIssue=DEMO-101"),
  run("jira-page.html", "https://jira.example.com/browse/DEMO-201"),
  run("jira-hover.html", "https://jira.example.com/browse/DEMO-201"),
]).catch(error => { console.error(error); process.exitCode = 1; });
