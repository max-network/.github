import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNRELEASED_MARKER, driftedVersions, promoteChangelog } from "./changelog";

const REPO = "https://github.com/acme/pkg";

const base = (unreleasedBody: string): string => `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
${unreleasedBody}## [0.1.6] — 2026-05-31

### Fixed

- something old
`;

const withLinks = (unreleasedBody: string): string =>
  `${base(unreleasedBody)}
[Unreleased]: ${REPO}/compare/v0.1.6...HEAD
[0.1.6]: ${REPO}/compare/v0.1.5...v0.1.6
`;

const promoted = (md: string, version = "0.2.0"): string => promoteChangelog(md, version, "2026-07-31").content ?? "";

describe("promoteChangelog", () => {
  it("promotes an Unreleased section that has entries", () => {
    const result = promoteChangelog(base("\n### Fixed\n\n- new thing\n\n"), "0.1.7", "2026-07-31");
    expect(result.status).toBe("promoted");
    const out = result.content ?? "";
    expect(out).toContain("## [0.1.7] — 2026-07-31");
    expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [0.1.7]"));
    expect(out.indexOf("- new thing")).toBeLessThan(out.indexOf("## [0.1.6]"));
    expect(out).toContain("- something old");
  });

  it("fails when Unreleased is empty or holds only sub-headings", () => {
    expect(promoteChangelog(base("\n"), "0.1.7", "2026-07-31").status).toBe("missing");
    expect(promoteChangelog(base("\n### Fixed\n\n"), "0.1.7", "2026-07-31").status).toBe("missing");
  });

  it("is a no-op when the version entry already exists", () => {
    const md = base("\n- new thing\n\n");
    const result = promoteChangelog(md, "0.1.6", "2026-07-31");
    expect(result.status).toBe("present");
    expect(result.content).toBe(md);
  });

  it("fails when there is neither an Unreleased section nor the version", () => {
    expect(promoteChangelog("# Changelog\n\n## [0.1.6] — 2026-05-31\n\n- old\n", "0.1.7", "x").status).toBe("missing");
  });

  it("escapes regex metacharacters in the version", () => {
    expect(promoteChangelog(base("\n- new thing\n\n"), "0x1x6", "2026-07-31").status).toBe("promoted");
  });
});

describe("the unreleased marker", () => {
  it("is placed directly under the fresh Unreleased heading", () => {
    const lines = promoted(base("\n### Added\n\n- a thing\n\n")).split("\n");
    const heading = lines.indexOf("## [Unreleased]");
    expect(lines[heading + 1]).toBe("");
    expect(lines[heading + 2]).toBe(UNRELEASED_MARKER);
  });

  it("does not follow the entries into the released section", () => {
    const content = promoted(base(`\n${UNRELEASED_MARKER}\n\n### Added\n\n- a thing\n\n`));
    const released = content.slice(content.indexOf("## [0.2.0]"));
    expect(released).not.toContain(UNRELEASED_MARKER);
    expect(released).toContain("- a thing");
    expect(content.split(UNRELEASED_MARKER).length - 1).toBe(1);
  });

  it("is not mistaken for an entry", () => {
    expect(promoteChangelog(base(`\n${UNRELEASED_MARKER}\n\n`), "0.2.0", "2026-07-31").status).toBe("missing");
  });
});

describe("link references", () => {
  it("repoints [Unreleased] at the new tag and adds the version's compare link beneath it", () => {
    const out = promoted(withLinks("\n- new thing\n\n"));
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v0.2.0...HEAD\n[0.2.0]: ${REPO}/compare/v0.1.6...v0.2.0\n[0.1.6]:`);
  });

  it("keeps the link block at the foot, outside every section", () => {
    const out = promoted(withLinks("\n- new thing\n\n"));
    expect(out.indexOf("- something old")).toBeLessThan(out.indexOf("[Unreleased]:"));
    expect(out.trimEnd().endsWith(`[0.1.6]: ${REPO}/compare/v0.1.5...v0.1.6`)).toBe(true);
  });

  it("keeps a link block when Unreleased is the only section", () => {
    const md = `# Changelog\n\n## [Unreleased]\n\n- first\n\n[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n`;
    const out = promoted(md);
    expect(out.slice(out.indexOf("## [0.2.0]"))).toContain("- first");
    expect(out).toContain(`[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0`);
    expect(out.indexOf("- first")).toBeLessThan(out.indexOf("[Unreleased]:"));
  });

  it("does not invent a link block, and is idempotent when it already points at this version", () => {
    expect(promoted(base("\n- new thing\n\n"))).not.toContain("[Unreleased]:");
    const already = withLinks("\n- new thing\n\n").replace("v0.1.6...HEAD", "v0.2.0...HEAD");
    expect(promoted(already)).not.toContain("v0.2.0...v0.2.0");
  });
});

describe("driftedVersions", () => {
  const released = `# Changelog\n\n## [Unreleased]\n\n## [0.3.4] — 2026-08-01\n\n- shipped\n\n## [0.3.3] — 2026-07-01\n\n- older\n`;

  it("passes when released sections match and ignores Unreleased", () => {
    expect(driftedVersions(released, released)).toEqual([]);
    expect(driftedVersions(released, released.replace("## [Unreleased]\n", "## [Unreleased]\n\n- new work\n"))).toEqual([]);
  });

  it("catches an entry filed under a released version, and a dropped section", () => {
    expect(driftedVersions(released, released.replace("- shipped", "- shipped\n- unshipped"))).toEqual(["0.3.4"]);
    expect(driftedVersions(released, "# Changelog\n\n## [Unreleased]\n")).toEqual(["0.3.4", "0.3.3"]);
  });

  it("ignores line endings and the link block a release rewrites", () => {
    expect(driftedVersions(released, released.replace(/\n/g, "\r\n"))).toEqual([]);
    const linked = `${released}\n[Unreleased]: ${REPO}/compare/v0.3.4...HEAD\n`;
    expect(driftedVersions(linked, `${released}\n[Unreleased]: ${REPO}/compare/v0.3.5...HEAD\n`)).toEqual([]);
  });

  it("agrees with a promotion: stamping never drifts an existing release", () => {
    const md = withLinks("\n- new thing\n\n");
    expect(driftedVersions(md, promoted(md))).toEqual([]);
  });
});

describe("CLI", () => {
  const script = join(import.meta.dir, "changelog.ts");
  const WITH_ENTRIES = base("\n### Fixed\n\n- new thing\n\n");
  const EMPTY = base("\n");

  function run(md: string, args: string[]): { out: string; code: number; after: string } {
    const path = join(tmpdir(), `changelog-${randomUUID()}.md`);
    writeFileSync(path, md);
    try {
      const p = Bun.spawnSync(["bun", script, ...args], { env: { ...process.env, CHANGELOG_PATH: path } });
      return { out: p.stdout.toString().trim(), code: p.exitCode, after: readFileSync(path, "utf8") };
    } finally {
      rmSync(path, { force: true });
    }
  }

  it("--check reports the status, exits 0 and writes nothing", () => {
    expect(run(WITH_ENTRIES, ["--check", "0.3.8"])).toEqual({ out: "promoted", code: 0, after: WITH_ENTRIES });
    expect(run(EMPTY, ["--check", "0.3.8"])).toEqual({ out: "missing", code: 0, after: EMPTY });
    expect(run(WITH_ENTRIES, ["--check", "0.1.6"]).out).toBe("present");
  });

  it("stamps the file in place, and fails a release with nothing documented", () => {
    const r = run(WITH_ENTRIES, ["0.3.8", "2026-08-01"]);
    expect(r.code).toBe(0);
    expect(r.after).toContain("## [0.3.8] — 2026-08-01");
    expect(run(EMPTY, ["0.3.8"]).code).toBe(1);
  });

  it("--verify skips cleanly when the base ref is unavailable", () => {
    expect(run(WITH_ENTRIES, ["--verify", "no-such-ref-here"]).code).toBe(0);
  });
});
