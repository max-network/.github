import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", ".github", "actions", "version-pr", "version-pr.mjs");
const FILE = "deploy-versions.json";

interface Pull {
  number: number;
  head: { ref: string };
  base: { ref: string };
  title: string;
  state: "open" | "closed";
  html_url: string;
}

interface Repo {
  branches: Map<string, { sha: string; file: string }>;
  pulls: Pull[];
  comments: Array<{ number: number; body: string }>;
  calls: string[];
}

const encode = (value: object) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64");

function fakeGitHub(repo: Repo) {
  let commit = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace("/repos/acme/infra", "");
      const key = `${request.method} ${path}`;
      repo.calls.push(key);
      const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json();

      if (request.method === "GET" && path === `/contents/${FILE}`) {
        const branch = repo.branches.get(url.searchParams.get("ref") ?? "");
        return branch ? Response.json({ content: branch.file, sha: `blob-${branch.sha}` }) : new Response("", { status: 404 });
      }
      if (request.method === "PUT" && path === `/contents/${FILE}`) {
        const branch = repo.branches.get(body.branch);
        if (!branch || body.sha !== `blob-${branch.sha}`) return new Response("stale", { status: 409 });
        branch.file = body.content;
        branch.sha = `c${++commit}`;
        return Response.json({});
      }
      const ref = path.match(/^\/git\/ref\/heads\/(.+)$/);
      if (request.method === "GET" && ref) {
        const branch = repo.branches.get(ref[1]);
        return branch ? Response.json({ object: { sha: branch.sha } }) : new Response("", { status: 404 });
      }
      if (request.method === "POST" && path === "/git/refs") {
        const source = [...repo.branches.values()].find((b) => b.sha === body.sha);
        repo.branches.set(body.ref.replace("refs/heads/", ""), { sha: body.sha, file: source?.file ?? "" });
        return Response.json({}, { status: 201 });
      }
      const refs = path.match(/^\/git\/refs\/heads\/(.+)$/);
      if (request.method === "PATCH" && refs) {
        const source = [...repo.branches.values()].find((b) => b.sha === body.sha);
        repo.branches.set(refs[1], { sha: body.sha, file: source?.file ?? "" });
        return Response.json({});
      }
      if (request.method === "DELETE" && refs) {
        repo.branches.delete(refs[1]);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && path === "/pulls") {
        const head = url.searchParams.get("head")?.split(":")[1];
        return Response.json(repo.pulls.filter((p) => p.state === "open" && (!head || p.head.ref === head)));
      }
      if (request.method === "POST" && path === "/pulls") {
        const number = repo.pulls.length + 1;
        const pull: Pull = { number, head: { ref: body.head }, base: { ref: body.base }, title: body.title, state: "open", html_url: `https://github.test/pull/${number}` };
        repo.pulls.push(pull);
        return Response.json(pull, { status: 201 });
      }
      const pullPatch = path.match(/^\/pulls\/(\d+)$/);
      if (request.method === "PATCH" && pullPatch) {
        const pull = repo.pulls.find((p) => p.number === Number(pullPatch[1]));
        if (pull) pull.state = body.state;
        return Response.json({});
      }
      const comment = path.match(/^\/issues\/(\d+)\/comments$/);
      if (request.method === "POST" && comment) {
        repo.comments.push({ number: Number(comment[1]), body: body.body });
        return Response.json({}, { status: 201 });
      }
      return new Response(`unexpected ${key}`, { status: 500 });
    },
  });
}

const pinned = (version: string) => encode({ _comment: "kept", appVersion: version, hapiVersion: "v8" });
const recorded = (repo: Repo, branch: string) =>
  JSON.parse(Buffer.from(repo.branches.get(branch)?.file ?? "", "base64").toString("utf8"));

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => server?.stop(true));

async function run(repo: Repo, version: string, extra: Record<string, string> = {}) {
  server?.stop(true);
  server = fakeGitHub(repo);
  const child = Bun.spawn(["node", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GITHUB_API_URL: `http://localhost:${server.port}`,
      GITHUB_OUTPUT: "",
      GH_TOKEN: "t",
      REPOSITORY: "acme/infra",
      BASE: "main",
      FILE,
      FIELD: "appVersion",
      VERSION: version,
      BRANCH_PREFIX: "release/",
      TITLE: "",
      ...extra,
    },
  });
  const code = await child.exited;
  const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  return { code, out };
}

const freshRepo = (): Repo => ({
  branches: new Map([["main", { sha: "m1", file: pinned("1.0.0") }]]),
  pulls: [],
  comments: [],
  calls: [],
});

describe("version-pr", () => {
  it("opens nothing when the base already records the version", async () => {
    const repo = freshRepo();
    const result = await run(repo, "1.0.0");
    expect(result.code).toBe(0);
    expect(repo.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(repo.pulls).toEqual([]);
  });

  it("records a new version on its own branch, keeps the other fields and opens one pull request", async () => {
    const repo = freshRepo();
    const result = await run(repo, "1.1.0");
    expect(result.code).toBe(0);
    expect(recorded(repo, "release/1.1.0")).toEqual({ _comment: "kept", appVersion: "1.1.0", hapiVersion: "v8" });
    expect(recorded(repo, "main").appVersion).toBe("1.0.0");
    expect(repo.pulls.map((p) => [p.head.ref, p.base.ref, p.title])).toEqual([["release/1.1.0", "main", "release/1.1.0"]]);
  });

  it("reuses its branch and pull request on a re-run", async () => {
    const repo = freshRepo();
    await run(repo, "1.1.0");
    repo.calls = [];
    const result = await run(repo, "1.1.0");
    expect(result.code).toBe(0);
    expect(repo.calls.filter((c) => c.startsWith("PUT") || c.startsWith("POST"))).toEqual([]);
    expect(repo.pulls).toHaveLength(1);
  });

  it("closes an older pull request under the prefix and deletes its branch", async () => {
    const repo = freshRepo();
    await run(repo, "1.1.0");
    const result = await run(repo, "1.2.0", { SUPERSEDED_COMMENT: "Superseded by 1.2.0, which contains it." });
    expect(result.code).toBe(0);
    expect(repo.pulls.map((p) => [p.head.ref, p.state])).toEqual([["release/1.1.0", "closed"], ["release/1.2.0", "open"]]);
    expect(repo.branches.has("release/1.1.0")).toBe(false);
    expect(repo.comments).toEqual([{ number: 1, body: "Superseded by 1.2.0, which contains it." }]);
  });

  it("leaves pull requests under another prefix alone", async () => {
    const repo = freshRepo();
    await run(repo, "1.1.0");
    const result = await run(repo, "0.9.0", { BRANCH_PREFIX: "admin-ui/", FIELD: "adminUiVersion" });
    expect(result.code).toBe(0);
    expect(repo.pulls.map((p) => [p.head.ref, p.state])).toEqual([["release/1.1.0", "open"], ["admin-ui/0.9.0", "open"]]);
    expect(recorded(repo, "admin-ui/0.9.0").adminUiVersion).toBe("0.9.0");
  });

  it("resets a branch left at another version before recording this one", async () => {
    const repo = freshRepo();
    repo.branches.set("release/1.1.0", { sha: "old", file: pinned("0.5.0") });
    const result = await run(repo, "1.1.0");
    expect(result.code).toBe(0);
    expect(repo.calls).toContain("PATCH /git/refs/heads/release/1.1.0");
    expect(recorded(repo, "release/1.1.0").appVersion).toBe("1.1.0");
  });

  it("fails loudly when the API refuses", async () => {
    const repo = freshRepo();
    repo.branches.clear();
    const result = await run(repo, "1.1.0");
    expect(result.code).toBe(1);
    expect(result.out).toContain("::error::");
  });
});
