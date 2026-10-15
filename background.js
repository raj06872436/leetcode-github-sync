// Detects LeetCode submissions from network requests (not the page DOM), waits
// for the judge result, and commits Accepted solutions to GitHub.
//
// Trigger: POST /problems/<slug>/submit/ -> poll the latest submission for <slug>
// until it has a final status. The status is read as text ("Accepted") because
// LeetCode's numeric status codes are not stable.

const SUBMIT_URL = /^https:\/\/leetcode\.com\/problems\/([^/]+)\/submit\/?/;
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
    if (details.tabId < 0) return; // not from a tab (e.g. our own requests)
    const submit = details.method === "POST" && details.url.match(SUBMIT_URL);
    if (submit) onSubmit(submit[1], details.tabId);
  },
  { urls: ["https://leetcode.com/*"] }
);

async function onSubmit(slug, tabId) {
  const key = `submit:${slug}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const since = Math.floor(Date.now() / 1000) - 10;
  try {
    const { id, statusDisplay } = await waitForLatestSubmission(tabId, slug, since);
    await processSubmission(id, statusDisplay, tabId);
  } catch (err) {
    await fail(slug, err);
  } finally {
    inFlight.delete(key);
  }
}

async function processSubmission(id, statusDisplay, tabId) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const { seen = [] } = await chrome.storage.local.get("seen");
    if (seen.includes(id)) return;

    const sub = await waitForCode(tabId, id);
    const slug = sub.question.titleSlug;
    if (statusDisplay !== "Accepted") {
      await markSeen(id);
      await log({ title: slug, skip: true, msg: `${statusDisplay}: not synced` });
      return;
    }

    const cfg = await getConfig();
    if (!cfg) {
      await log({ title: slug, ok: false, msg: "Not configured: open the extension popup and Save" });
      return;
    }

    const q = await fetchQuestion(tabId, slug);
    await pushSolution(cfg, sub, q);

    await markSeen(id);
    await log({ title: `${q.questionFrontendId}. ${q.title}`, ok: true, msg: `${sub.runtimeDisplay}, ${sub.memoryDisplay}` });
    flashBadge("✓", "#2ea043");
  } catch (err) {
    await fail(`Submission ${id}`, err);
  } finally {
    inFlight.delete(id);
  }
}

async function fail(title, err) {
  console.error(err);
  await log({ title, ok: false, msg: String(err.message || err) });
  flashBadge("!", "#d1242f");
}

async function markSeen(id) {
  const { seen = [] } = await chrome.storage.local.get("seen");
  await chrome.storage.local.set({ seen: [...seen, id].slice(-MAX_SEEN) });
}

// ---------- LeetCode ----------

// Newest submission for this problem made after `since` (unix seconds),
// once the judge has finished with it.
async function waitForLatestSubmission(tabId, slug, since) {
  for (let i = 0; i < 30; i++) {
    const data = await lcGraphQL(
      tabId,
      `query submissionList($questionSlug: String!) {
        questionSubmissionList(offset: 0, limit: 1, questionSlug: $questionSlug) {
          submissions { id timestamp statusDisplay }
        }
      }`,
      { questionSlug: slug }
    );
    const latest = data.questionSubmissionList?.submissions?.[0];
    const judged = latest?.statusDisplay && !/pending|judging|running/i.test(latest.statusDisplay);
    if (latest && Number(latest.timestamp) >= since && judged) {
      return { id: String(latest.id), statusDisplay: latest.statusDisplay };
    }
    await sleep(1000);
  }
  throw new Error("Couldn't find the new submission (timed out)");
}

async function waitForCode(tabId, id) {
  let lastErr;
  for (let i = 0; i < 30; i++) {
    const sub = await fetchSubmission(tabId, id).catch((e) => void (lastErr = e));
    if (sub?.code) return sub;
    await sleep(1000);
  }
  throw new Error(`Timed out loading submission code${lastErr ? `: ${lastErr.message}` : ""}`);
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
