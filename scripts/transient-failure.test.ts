import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "transient-failure.sh");

const line = (job: string, step: string, message: string): string =>
  `${job}\t${step}\t2026-11-08T08:59:53.7978614Z ${message}`;

const classify = (...lines: string[]) => {
  const result = Bun.spawnSync(["bash", SCRIPT], { stdin: Buffer.from(lines.join("\n") + "\n") });
  return { transient: result.exitCode === 0, verdict: result.stdout.toString().trim() };
};

describe("transient-failure.sh", () => {
  it("retries a Bun download that GitHub answered with 504", () => {
    const result = classify(
      line("deploy / deploy", "Run oven-sh/setup-bun@v2", "Unexpected HTTP response: 504"),
      line("deploy / deploy", "Run oven-sh/setup-bun@v2", "##[error]Error: Unexpected HTTP response: 504"),
    );
    expect(result.transient).toBe(true);
    expect(result.verdict).toContain("transient\tdeploy / deploy");
  });

  it("does not retry a failing test that merely logs a 503", () => {
    const result = classify(
      line("check", "Test", "@maxhealth/functions test: TSA request failed: 503 Service Unavailable"),
      line("check", "Test", "FAIL  api/routes/documents/signing.test.ts > keeps every seal valid"),
      line("check", "Test", "##[error]Process completed with exit code 1."),
    );
    expect(result.transient).toBe(false);
    expect(result.verdict).toBe("real\tcheck");
  });

  it("retries an npm install the registry answered with 503", () => {
    const result = classify(
      line("check", "Install", "npm error code E503"),
      line("check", "Install", "npm error 503 Service Unavailable - GET https://npm.pkg.github.com/@max-network%2fical"),
      line("check", "Install", "##[error]Process completed with exit code 1."),
    );
    expect(result.transient).toBe(true);
  });

  it("retries a bun install whose tarball fetch failed with 502", () => {
    expect(classify(line("check", "Install", "error: GET https://registry.npmjs.org/hono/-/hono-4.9.0.tgz - 502")).transient).toBe(true);
  });

  it("retries a pnpm fetch failure", () => {
    expect(classify(line("check", "Install", " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/vitest: socket hang up")).transient).toBe(true);
  });

  it("retries an action GitHub could not serve", () => {
    const result = classify(
      line("check", "Set up job", "##[error]Failed to download action 'https://api.github.com/repos/actions/checkout/tarball/abc'. Error: Response status code does not indicate success: 503 (Service Unavailable)."),
    );
    expect(result.transient).toBe(true);
  });

  it("retries a runner that lost its connection", () => {
    expect(classify(line("build", "Build", "##[error]The runner has received a shutdown signal.")).transient).toBe(true);
  });

  it("ignores network words outside an error line", () => {
    expect(classify(line("check", "Test", "auth test: connect ECONNRESET while testing the outage path"), line("check", "Test", "##[error]Process completed with exit code 1.")).transient).toBe(false);
  });

  it("does not retry when one of several failed jobs failed for real", () => {
    const result = classify(
      line("publish (esign)", "Run oven-sh/setup-bun@v2", "##[error]Error: Unexpected HTTP response: 504"),
      line("publish (types)", "Typecheck", "src/index.ts(3,1): error TS2304: Cannot find name 'x'."),
      line("publish (types)", "Typecheck", "##[error]Process completed with exit code 2."),
    );
    expect(result.transient).toBe(false);
    expect(result.verdict).toBe("transient\tpublish (esign)\t##[error]Error: Unexpected HTTP response: 504\nreal\tpublish (types)");
  });

  it("does not retry when there is no failed job log to read", () => {
    expect(classify("").transient).toBe(false);
  });
});
