import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", ".github", "actions", "setup-bun", "resolve-version.sh");

const resolve = (version: string, file = "") => {
  const result = Bun.spawnSync(["bash", SCRIPT, version, file]);
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
};

const fileWith = (name: string, content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "bun-version-")), name);
  writeFileSync(path, content);
  return path;
};

describe("setup-bun resolve-version.sh", () => {
  it("prefers an explicit version over the file", () => {
    expect(resolve("1.4.3", fileWith("package.json", '{"packageManager": "bun@1.2.0"}')).out).toBe("1.4.3");
  });

  it("falls back to latest with neither", () => {
    expect(resolve("").out).toBe("latest");
  });

  it("reads packageManager from package.json", () => {
    const file = fileWith("package.json", '{\n  "name": "x",\n  "engines": { "bun": ">=1.0.0" },\n  "packageManager": "bun@1.4.3"\n}\n');
    expect(resolve("", file).out).toBe("1.4.3");
  });

  it("reads .bun-version and .tool-versions", () => {
    expect(resolve("", fileWith(".bun-version", "v1.4.4\n")).out).toBe("1.4.4");
    expect(resolve("", fileWith(".tool-versions", "nodejs 22.1.0\nbun 1.3.9\n")).out).toBe("1.3.9");
  });

  it("fails on a package.json that pins no Bun", () => {
    expect(resolve("", fileWith("package.json", '{"packageManager": "pnpm@11.0.0"}')).ok).toBe(false);
  });

  it("fails on a missing file", () => {
    expect(resolve("", join(tmpdir(), "does-not-exist", "package.json")).ok).toBe(false);
  });
});
