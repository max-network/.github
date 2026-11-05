/**
 * The changelog half of changelog-release.yml, run by bun with node built-ins only.
 *
 *   bun changelog.ts --check <version>     prints promoted | present | missing, writes nothing
 *   bun changelog.ts <version> [date]      stamps [Unreleased] as <version>; exits 1 when missing
 *   bun changelog.ts --verify <baseRef>    exits 1 when a released section differs from baseRef
 *
 * CHANGELOG_PATH overrides the default CHANGELOG.md.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type ChangelogStatus = "promoted" | "present" | "missing";

export interface ChangelogResult {
  status: ChangelogStatus;
  content?: string;
  message: string;
}

/**
 * Kept directly under `## [Unreleased]`. A release and the staging branch both insert lines
 * right below that heading; a line both sides carry unchanged turns git's silent heading-first
 * ordering of the merge-back into a conflict. {@link driftedVersions} catches what slips past.
 */
export const UNRELEASED_MARKER =
  "<!-- Add new entries directly below. Keep this line: it makes a release merge conflict rather than file them under a published version. -->";

const UNRELEASED = /^##\s*\[Unreleased\][^\n]*$/m;
const MARKER_LINE = /^<!-- Add new entries directly below\..*-->[ \t]*$/m;
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+/;
const UNRELEASED_LINK = /^\[Unreleased\]:\s*(\S+\/compare\/)(\S+?)\.\.\.HEAD[ \t]*$/m;
const VERSION_HEADING = /^##\s*\[(\d+\.\d+\.\d+[^\]]*)\][^\n]*$/gm;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(md: string): string {
  return md.replace(/\r\n/g, "\n");
}

/** Split off the trailing Keep a Changelog link-definition block, so sections never absorb it. */
function splitLinks(md: string): { text: string; links: string } {
  const lines = md.replace(/\n+$/, "").split("\n");
  let start = lines.length;
  while (start > 0 && LINK_DEFINITION.test(lines[start - 1] ?? "")) start--;
  return { text: lines.slice(0, start).join("\n"), links: lines.slice(start).join("\n") };
}

/** Repoint `[Unreleased]` at the new tag and add the version's compare link beneath it. */
function updateLinks(links: string, version: string): string {
  const match = UNRELEASED_LINK.exec(links);
  const compareBase = match?.[1];
  const prevTag = match?.[2];
  const newTag = `v${version}`;
  if (match === null || compareBase === undefined || prevTag === undefined || prevTag === newTag) return links;
  return links.replace(
    match[0],
    `[Unreleased]: ${compareBase}${newTag}...HEAD\n[${version}]: ${compareBase}${prevTag}...${newTag}`,
  );
}

/** Validate and, when needed, promote `[Unreleased]` to `version`. Pure. */
export function promoteChangelog(source: string, version: string, date: string): ChangelogResult {
  const md = normalize(source);
  if (new RegExp(`^##\\s*\\[${escapeForRegExp(version)}\\]`, "m").test(md)) {
    return { status: "present", content: source, message: `CHANGELOG: entry for ${version} already present.` };
  }

  const { text, links } = splitLinks(md);
  const heading = UNRELEASED.exec(text);
  if (heading === null) {
    return {
      status: "missing",
      message: `CHANGELOG.md has no "## [Unreleased]" section and no "## [${version}]" entry. Add an entry before releasing.`,
    };
  }

  const rest = text.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^##\s+\[/m);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const after = nextHeading === -1 ? "" : rest.slice(nextHeading);
  const notes = body.replace(MARKER_LINE, "").trim();

  const hasEntry = notes.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  if (!hasEntry) {
    return {
      status: "missing",
      message: `CHANGELOG.md "## [Unreleased]" has no entries. Document what ${version} ships before releasing.`,
    };
  }

  const stamped = [
    text.slice(0, heading.index),
    "## [Unreleased]\n\n",
    `${UNRELEASED_MARKER}\n\n`,
    `## [${version}] — ${date}\n\n`,
    `${notes}\n`,
    after.length > 0 ? `\n${after.replace(/\n+$/, "")}\n` : "",
  ].join("");
  const updatedLinks = updateLinks(links, version);
  const content = updatedLinks.length > 0 ? `${stamped}\n${updatedLinks}\n` : stamped;
  return { status: "promoted", content, message: `CHANGELOG: promoted [Unreleased] to [${version}] — ${date}.` };
}

/** Each released `## [x.y.z]` section keyed by version; `[Unreleased]` and link definitions excluded. */
export function releasedSections(source: string): Map<string, string> {
  const { text } = splitLinks(normalize(source));
  const starts = [...text.matchAll(VERSION_HEADING)].map((match) => ({ version: match[1] ?? "", index: match.index }));
  const sections = new Map<string, string>();
  starts.forEach((start, i) => {
    const end = starts[i + 1]?.index ?? text.length;
    sections.set(start.version, text.slice(start.index, end).trimEnd());
  });
  return sections;
}

/** Versions released in `base` whose section differs in, or is missing from, `head`. */
export function driftedVersions(base: string, head: string): string[] {
  const headSections = releasedSections(head);
  return [...releasedSections(base)].filter(([version, body]) => headSections.get(version) !== body).map(([v]) => v);
}

function verify(baseRef: string, path: string): number {
  const show = spawnSync("git", ["show", `${baseRef}:${path}`], { encoding: "utf8" });
  if (show.status !== 0) {
    console.log(`changelog verify skipped: ${baseRef}:${path} is not available here.`);
    return 0;
  }
  const drifted = driftedVersions(show.stdout, readFileSync(path, "utf8"));
  if (drifted.length === 0) {
    console.log(`Released changelog sections match ${baseRef}.`);
    return 0;
  }
  console.error(`Released changelog sections differ from ${baseRef}: ${drifted.join(", ")}`);
  console.error("A released section must not change; this usually means a release merge filed new entries");
  console.error(`under a published version. Compare with: git diff ${baseRef} -- ${path}`);
  console.error("Move them back under [Unreleased] and keep the marker line beneath it.");
  return 1;
}

function main(argv: string[]): number {
  const path = process.env["CHANGELOG_PATH"] ?? "CHANGELOG.md";
  const [first, second, third] = argv;

  if (first === "--verify") return verify(second ?? "origin/main", path);

  const checkOnly = first === "--check";
  const version = checkOnly ? second : first;
  if (version === undefined || version === "") {
    console.error("changelog: missing <version> argument");
    return 2;
  }
  const date = (checkOnly ? third : second) ?? new Date().toISOString().slice(0, 10);
  const result = promoteChangelog(readFileSync(path, "utf8"), version, date);

  if (checkOnly) {
    console.log(result.status);
    return 0;
  }
  if (result.status === "missing") {
    console.error(result.message);
    return 1;
  }
  if (result.status === "promoted" && result.content !== undefined) writeFileSync(path, result.content);
  console.log(result.message);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
