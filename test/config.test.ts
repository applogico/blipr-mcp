import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findTopicFile, parseTopicFile, resolveDefaultTopic, TOPIC_FILE } from "../src/config.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "blipr-mcp-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("parseTopicFile", () => {
  it("returns the first non-empty line, trimmed", () => {
    expect(parseTopicFile("  my-topic  \n")).toBe("my-topic");
  });

  it("skips blank lines and # comments", () => {
    expect(parseTopicFile("# the project topic\n\n  ops-alerts\nignored")).toBe("ops-alerts");
  });

  it("returns undefined for an empty or comments-only file", () => {
    expect(parseTopicFile("")).toBeUndefined();
    expect(parseTopicFile("# nothing here\n\n")).toBeUndefined();
  });
});

describe("findTopicFile", () => {
  it("finds the file in the start directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TOPIC_FILE), "proj-a\n");
    expect(findTopicFile(dir)).toEqual({ topic: "proj-a", path: join(dir, TOPIC_FILE) });
  });

  it("walks up to a parent directory (monorepo subdir)", () => {
    const root = tempDir();
    writeFileSync(join(root, TOPIC_FILE), "mono-topic\n");
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(findTopicFile(nested)).toEqual({ topic: "mono-topic", path: join(root, TOPIC_FILE) });
  });

  it("prefers the nearest file when both a dir and its parent have one", () => {
    const root = tempDir();
    writeFileSync(join(root, TOPIC_FILE), "outer\n");
    const inner = join(root, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, TOPIC_FILE), "inner-topic\n");
    expect(findTopicFile(inner)?.topic).toBe("inner-topic");
  });

  it("skips an empty file and keeps walking up", () => {
    const root = tempDir();
    writeFileSync(join(root, TOPIC_FILE), "outer\n");
    const inner = join(root, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, TOPIC_FILE), "# only a comment\n");
    expect(findTopicFile(inner)?.topic).toBe("outer");
  });

  it("returns undefined when no file exists anywhere up the tree", () => {
    // A fresh temp dir: no ancestor should carry a .blipr-topic in CI.
    expect(findTopicFile(tempDir())).toBeUndefined();
  });
});

describe("resolveDefaultTopic (precedence: file > env)", () => {
  it("uses the .blipr-topic file even when BLIPR_TOPIC is set — no global leak", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TOPIC_FILE), "project-topic\n");
    expect(resolveDefaultTopic(dir, { BLIPR_TOPIC: "global-topic" })).toEqual({
      topic: "project-topic",
      source: "file",
      path: join(dir, TOPIC_FILE),
    });
  });

  it("falls back to the BLIPR_TOPIC env var when there is no file", () => {
    expect(resolveDefaultTopic(tempDir(), { BLIPR_TOPIC: " global-topic " })).toEqual({
      topic: "global-topic",
      source: "env",
    });
  });

  it("returns undefined with no file and no env (calls must pass topic)", () => {
    expect(resolveDefaultTopic(tempDir(), {})).toBeUndefined();
    expect(resolveDefaultTopic(tempDir(), { BLIPR_TOPIC: "  " })).toBeUndefined();
  });
});
