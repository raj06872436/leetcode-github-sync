# LeetCode → GitHub Sync

A Chrome extension that commits each **Accepted** LeetCode submission to a GitHub repo you choose. Every solve shows up as a commit on your contribution graph.

## What it creates in your repo

```
0001-two-sum/
  README.md        ← problem statement, difficulty, topics
  two-sum.py       ← your accepted code
0146-lru-cache/
  README.md
  lru-cache.cpp
```

Commit message example: `1. Two Sum [Easy] - Time: 0 ms (beats 100.0%), Memory: 17.9 MB (beats 62.3%)`

## Setup (about 3 minutes)

1. **Create a repo** on GitHub, e.g. `leetcode`. Tick **"Add a README file"** so the `main` branch exists.
2. **Create a token:** GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: *Only select repositories* → your `leetcode` repo
   - Permissions → Repository → **Contents: Read and write**
3. **Install the extension:**
   - Open `chrome://extensions`
   - Turn on **Developer mode** (top right)
   - Click **Load unpacked** and select this folder
4. Click the extension icon, paste the token, enter `yourname/leetcode`, then click **Test connection** and **Save**.
5. Solve a problem on leetcode.com and hit **Submit**. When it's Accepted, the icon briefly shows a green ✓ and the commit appears on GitHub.

Works in Chrome, Edge, Brave, and other Chromium browsers.

## How it works

- `background.js` watches for LeetCode's `/submissions/detail/<id>/check/` requests. It doesn't read the page's HTML, so LeetCode redesigns won't break it.
- When the result is `Accepted`, it fetches your code and the problem details from LeetCode's GraphQL API, using your existing login.
- It then writes the files through the GitHub Contents API. Solving the same problem again updates the solution file, which is a new commit.
- "Run" (not Submit) and wrong answers are ignored.

## Contribution graph notes

Commits count toward your graph only if:
- they're on the repo's **default branch** (set Branch to `main` or whatever your default is), and
- for private repos, *Settings → Profile → "Include private contributions"* is on.

## Troubleshooting

Open the popup to see recent syncs and errors. For more detail, go to `chrome://extensions` → this extension → **Service worker** → Console.

| Error | Fix |
|---|---|
| Not configured | Save your token/repo in the popup |
| GitHub write failed (404) | Wrong repo name, or the token lacks access to that repo |
| GitHub write failed (409/422) | Branch doesn't exist. Initialize the repo with a README |
| Could not load submission details | Make sure you're logged in to leetcode.com |
