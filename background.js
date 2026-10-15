// Watches LeetCode's "check submission" requests. When a submission finishes
// as Accepted, fetches the code + problem info and commits it to GitHub.
// Detection is based on network requests, not the page DOM, so LeetCode UI
// redesigns don't break it.

const CHECK_URL = /^https:\/\/leetcode\.com\/submissions\/detail\/(\d+)\/check\/?/;
const MAX_LOG = 20;
const MAX_SEEN = 500;
const inFlight = new Set();

const EXTENSIONS = {
  python: "py", python3: "py", pythondata: "py", pandas: "py",
  cpp: "cpp", c: "c", java: "java", csharp: "cs",
  javascript: "js", typescript: "ts", php: "php", swift: "swift",
  kotlin: "kt", dart: "dart", golang: "go", ruby: "rb", scala: "scala",
  rust: "rs", racket: "rkt", erlang: "erl", elixir: "ex",
  mysql: "sql", mssql: "sql", oraclesql: "sql", postgresql: "sql",
  bash: "sh",
};

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.initiator?.startsWith("chrome-extension://")) return; // our own polling
    const match = details.url.match(CHECK_URL);
    if (match && details.tabId >= 0) handleSubmission(match[1], details.tabId);
  },
  { urls: ["https://leetcode.com/submissions/detail/*/check/*"] }
);

async function handleSubmission(id, tabId) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const { seen = [] } = await chrome.storage.local.get("seen");
    if (seen.includes(id)) return;

    const result = await waitForResult(id);
    if (result.status_msg !== "Accepted") return;

    const cfg = await getConfig();
    if (!cfg) {
      await log({ title: `Submission ${id}`, ok: false, msg: "Not configured: open the extension popup" });
      return;
    }

    const sub = await fetchSubmission(tabId, id);
    const q = await fetchQuestion(tabId, sub.question.titleSlug);
    await pushSolution(cfg, sub, q);

    await chrome.storage.local.set({ seen: [...seen, id].slice(-MAX_SEEN) });
    await log({ title: `${q.questionFrontendId}. ${q.title}`, ok: true, msg: `${sub.runtimeDisplay}, ${sub.memoryDisplay}` });
    flashBadge("✓", "#2ea043");
  } catch (err) {
    console.error(err);
    await log({ title: `Submission ${id}`, ok: false, msg: String(err.message || err) });
    flashBadge("!", "#d1242f");
  } finally {
    inFlight.delete(id);
  }
}

// ---------- LeetCode ----------

async function waitForResult(id) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`https://leetcode.com/submissions/detail/${id}/check/`, { credentials: "include" });
    if (!res.ok) throw new Error(`LeetCode check failed (${res.status})`);
    const data = await res.json();
    if (data.state === "SUCCESS") return data;
    await sleep(1000);
  }
  throw new Error("Timed out waiting for judge result");
}

// Runs inside the leetcode.com tab so the request carries the page's
// Origin/Referer; LeetCode's CSRF check rejects calls made from the extension.
async function lcGraphQL(tabId, query, variables) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (query, variables) => {
      const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1];
      const res = await fetch("/graphql/", {
        method: "POST",
        headers: { "content-type": "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) },
        body: JSON.stringify({ query, variables }),
      });
      return { status: res.status, body: await res.text() };
    },
    args: [query, variables],
  });
  if (!result || result.status !== 200) throw new Error(`LeetCode GraphQL failed (${result?.status})`);
  const json = JSON.parse(result.body);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function fetchSubmission(tabId, id) {
  const data = await lcGraphQL(
    tabId,
    `query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code runtimeDisplay runtimePercentile memoryDisplay memoryPercentile
        lang { name verboseName }
        question { titleSlug }
      }
    }`,
    { submissionId: Number(id) }
  );
  if (!data.submissionDetails) throw new Error("Could not load submission details (logged in?)");
  return data.submissionDetails;
}

async function fetchQuestion(tabId, titleSlug) {
  const data = await lcGraphQL(
    tabId,
    `query question($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId title titleSlug difficulty content
        topicTags { name }
      }
    }`,
    { titleSlug }
  );
  return data.question;
}

// ---------- GitHub ----------

async function pushSolution(cfg, sub, q) {
  const folder = `${String(q.questionFrontendId).padStart(4, "0")}-${q.titleSlug}`;
  const ext = EXTENSIONS[sub.lang.name] || "txt";
  const pct = (p) => (p == null ? "" : ` (beats ${p.toFixed(1)}%)`);
  const message =
    `${q.questionFrontendId}. ${q.title} [${q.difficulty}] - ` +
    `Time: ${sub.runtimeDisplay}${pct(sub.runtimePercentile)}, ` +
    `Memory: ${sub.memoryDisplay}${pct(sub.memoryPercentile)}`;

  await upsertFile(cfg, `${folder}/README.md`, buildReadme(q), `Add problem: ${q.questionFrontendId}. ${q.title}`, { onlyIfMissing: true });
  await upsertFile(cfg, `${folder}/${q.titleSlug}.${ext}`, sub.code, message);
}

function buildReadme(q) {
  const tags = q.topicTags?.map((t) => `\`${t.name}\``).join(" ") || "";
  return [
    `# [${q.questionFrontendId}. ${q.title}](https://leetcode.com/problems/${q.titleSlug}/)`,
    "",
    `**Difficulty:** ${q.difficulty}${tags ? `  \n**Topics:** ${tags}` : ""}`,
    "",
    "---",
    "",
    q.content || "_Problem statement unavailable (premium problem)._",
    "",
  ].join("\n");
}

async function upsertFile(cfg, path, text, message, { onlyIfMissing = false } = {}) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let sha;
  const existing = await fetch(`${url}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: "no-store" });
  if (existing.ok) {
    if (onlyIfMissing) return;
    sha = (await existing.json()).sha;
  } else if (existing.status !== 404) {
    throw new Error(`GitHub read failed (${existing.status}): ${await existing.text()}`);
  }

  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ message, content: toBase64(text), branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub write failed (${res.status}): ${(await res.json()).message}`);
}

// ---------- helpers ----------

async function getConfig() {
  const { token, repo, branch } = await chrome.storage.sync.get(["token", "repo", "branch"]);
  if (!token || !repo) return null;
  return { token, repo, branch: branch || "main" };
}

async function log(entry) {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.unshift({ ...entry, time: Date.now() });
  await chrome.storage.local.set({ logs: logs.slice(0, MAX_LOG) });
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
