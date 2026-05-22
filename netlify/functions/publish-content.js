/**
 * IVB High Care — Netlify Function: publish-content
 *
 * This function receives updated JSON from the CMS,
 * then writes each file to GitHub via the GitHub API.
 *
 * Environment variables needed (set in Netlify dashboard):
 *   GITHUB_TOKEN   — your personal access token
 *   GITHUB_OWNER   — your GitHub username or org
 *   GITHUB_REPO    — repository name (e.g. ivb-highcare)
 *   GITHUB_BRANCH  — branch to write to (e.g. main)
 */

const GITHUB_API = 'https://api.github.com';

exports.handler = async function (event) {

  /* ── only allow POST ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  /* ── CORS — allow your own domain only ── */
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  /* ── env vars ── */
  const token  = process.env.GITHUB_TOKEN;
  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return respond(500, { error: 'Missing environment variables. Check GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO in Netlify dashboard.' }, headers);
  }

  /* ── parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' }, headers);
  }

  /* ── payload shape: { files: { "content/home.json": {...}, ... } } ── */
  const { files } = payload;
  if (!files || typeof files !== 'object') {
    return respond(400, { error: 'Expected { files: { "path": content, ... } }' }, headers);
  }

  const results = [];

  for (const [filePath, content] of Object.entries(files)) {

    /* safety: only allow writes inside content/ folder */
    if (!filePath.startsWith('content/') || !filePath.endsWith('.json')) {
      results.push({ path: filePath, status: 'skipped', reason: 'path not allowed' });
      continue;
    }

    const jsonString = JSON.stringify(content, null, 2);
    const base64Content = Buffer.from(jsonString).toString('base64');

    /* get current SHA of the file (needed by GitHub API to update) */
    let sha;
    try {
      const getRes = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
        { headers: githubHeaders(token) }
      );
      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
      }
      /* if 404 → file doesn't exist yet, sha stays undefined → GitHub creates it */
    } catch (err) {
      results.push({ path: filePath, status: 'error', reason: 'failed to fetch current SHA: ' + err.message });
      continue;
    }

    /* write (create or update) the file on GitHub */
    try {
      const body = {
        message: `CMS update: ${filePath}`,
        content: base64Content,
        branch,
        ...(sha ? { sha } : {}),
      };

      const putRes = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`,
        {
          method: 'PUT',
          headers: githubHeaders(token),
          body: JSON.stringify(body),
        }
      );

      if (putRes.ok) {
        results.push({ path: filePath, status: 'updated' });
      } else {
        const err = await putRes.json();
        results.push({ path: filePath, status: 'error', reason: err.message || putRes.statusText });
      }
    } catch (err) {
      results.push({ path: filePath, status: 'error', reason: err.message });
    }
  }

  const allOk = results.every(r => r.status === 'updated' || r.status === 'skipped');

  return respond(
    allOk ? 200 : 207,
    { success: allOk, results },
    headers
  );
};

/* ── helpers ── */
function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function respond(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}
