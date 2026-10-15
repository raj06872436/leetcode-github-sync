const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    token: $("token").value.trim(),
    repo: $("repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""),
    branch: $("branch").value.trim() || "main",
  };
}

function setStatus(text, ok) {
  $("status").textContent = text;
  $("status").className = ok ? "ok" : "err";
}

async function load() {
  const cfg = await chrome.storage.sync.get(["token", "repo", "branch"]);
  $("token").value = cfg.token || "";
  $("repo").value = cfg.repo || "";
  $("branch").value = cfg.branch || "main";

  const { logs = [] } = await chrome.storage.local.get("logs");
  if (logs.length) {
    $("logs").replaceChildren(
      ...logs.map((l) => {
        const li = document.createElement("li");
        li.className = l.ok ? "ok" : "err";
        li.textContent = `${l.ok ? "✓" : "✗"} ${l.title}`;
        const small = document.createElement("small");
        small.textContent = `${new Date(l.time).toLocaleString()} · ${l.msg}`;
        li.append(small);
        return li;
      })
    );
  }
}

$("save").addEventListener("click", async () => {
  const cfg = readForm();
  if (!cfg.token || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) return setStatus("Enter a token and repo as owner/name.", false);
  await chrome.storage.sync.set(cfg);
  setStatus("Saved ✓", true);
});

$("test").addEventListener("click", async () => {
  const { token, repo, branch } = readForm();
  setStatus("Checking…", true);
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!r.ok) return setStatus(`Repo not found or token invalid (${r.status}).`, false);
    const info = await r.json();
    if (!info.permissions?.push) return setStatus("Token can't write to this repo.", false);
    const b = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, { headers });
    if (!b.ok) return setStatus(`Branch "${branch}" not found. Initialize the repo with a README first.`, false);
    setStatus("Connection OK ✓", true);
  } catch (e) {
    setStatus(String(e), false);
  }
});

load();
