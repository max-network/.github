import { appendFileSync } from "node:fs";

const env = (name, fallback) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const api = env("GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, "");
const token = env("GH_TOKEN");
const repository = env("REPOSITORY");
const base = env("BASE", "main");
const file = env("FILE");
const field = env("FIELD");
const version = env("VERSION");
const prefix = env("BRANCH_PREFIX");
const title = env("TITLE", `${prefix}${version}`);
const body = process.env.BODY ?? "";
const supersededComment = process.env.SUPERSEDED_COMMENT || `Superseded by ${version}.`;
const closeSuperseded = (process.env.CLOSE_SUPERSEDED ?? "true") !== "false";
const branch = `${prefix}${version}`;
const owner = repository.split("/")[0];

async function call(method, path, payload, { allow = [] } = {}) {
  const response = await fetch(`${api}/repos/${repository}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (allow.includes(response.status)) return { status: response.status, data: null };
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

const encodedFile = file.split("/").map(encodeURIComponent).join("/");

async function readPin(ref) {
  const { data } = await call("GET", `/contents/${encodedFile}?ref=${encodeURIComponent(ref)}`);
  const json = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  return { json, sha: data.sha };
}

async function branchSha(name) {
  const { status, data } = await call("GET", `/git/ref/heads/${name}`, undefined, { allow: [404] });
  return status === 404 ? null : data.object.sha;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function writePin() {
  const { json, sha } = await readPin(branch);
  json[field] = version;
  await call("PUT", `/contents/${encodedFile}`, {
    message: title,
    content: Buffer.from(`${JSON.stringify(json, null, 2)}\n`).toString("base64"),
    sha,
    branch,
  });
}

async function main() {
  const current = (await readPin(base)).json[field];
  if (current === version) {
    console.log(`${repository}@${base} already records ${field} ${version}; nothing to open.`);
    output("changed", "false");
    return;
  }

  const baseSha = await branchSha(base);
  const existing = await branchSha(branch);
  if (existing === null) {
    await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: baseSha });
    await writePin();
  } else if ((await readPin(branch)).json[field] !== version) {
    await call("PATCH", `/git/refs/heads/${branch}`, { sha: baseSha, force: true });
    await writePin();
  } else {
    console.log(`${branch} already records ${version}; reusing it.`);
  }

  const openFor = async () =>
    (await call("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)).data[0]?.html_url;
  let url = await openFor();
  if (!url) {
    const created = await call("POST", "/pulls", { title, head: branch, base, body }, { allow: [422] });
    url = created.data?.html_url ?? (await openFor()) ?? "";
  }
  console.log(`Pull request: ${url}`);
  output("changed", "true");
  output("pr-url", url);

  if (!closeSuperseded) return;
  const { data: all } = await call("GET", "/pulls?state=open&per_page=100");
  for (const pr of all) {
    const head = pr.head?.ref ?? "";
    if (!head.startsWith(prefix) || head === branch) continue;
    console.log(`Closing ${head}, superseded by ${version}.`);
    await call("POST", `/issues/${pr.number}/comments`, { body: supersededComment });
    await call("PATCH", `/pulls/${pr.number}`, { state: "closed" });
    await call("DELETE", `/git/refs/heads/${head}`, undefined, { allow: [404, 422] });
  }
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
