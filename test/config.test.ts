import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_FILE,
  findTopicFile,
  parseEnvFile,
  parseTopicFile,
  resolveDefaultTopic,
  resolveToken,
  TOPIC_FILE,
} from "../src/config.js";

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

describe("parseEnvFile", () => {
  it("parses KEY=VALUE pairs", () => {
    expect(parseEnvFile("BLIPR_TOKEN=blipr_pk_abc\nBLIPR_URL=https://x.dev\n")).toEqual({
      BLIPR_TOKEN: "blipr_pk_abc",
      BLIPR_URL: "https://x.dev",
    });
  });

  it("skips blanks and # comments, and trims whitespace", () => {
    expect(parseEnvFile("# a comment\n\n  BLIPR_TOKEN =  blipr_pk_abc  \n")).toEqual({
      BLIPR_TOKEN: "blipr_pk_abc",
    });
  });

  it("strips one layer of matching quotes and an export prefix", () => {
    expect(parseEnvFile(`export BLIPR_TOKEN="blipr_pk_abc"`)).toEqual({
      BLIPR_TOKEN: "blipr_pk_abc",
    });
    expect(parseEnvFile("BLIPR_TOKEN='blipr_pk_abc'")).toEqual({ BLIPR_TOKEN: "blipr_pk_abc" });
  });

  it("keeps = inside a value (tokens are opaque)", () => {
    expect(parseEnvFile("BLIPR_TOKEN=blipr_pk_a=b=c")).toEqual({ BLIPR_TOKEN: "blipr_pk_a=b=c" });
  });

  it("ignores lines with no key or no =", () => {
    expect(parseEnvFile("nonsense\n=orphan\n")).toEqual({});
  });
});

describe("resolveToken (precedence: env > .env file)", () => {
  it("returns undefined when there is no env var and no .env file", () => {
    expect(resolveToken(tempDir(), {})).toBeUndefined();
  });

  it("uses the BLIPR_TOKEN env var, trimmed", () => {
    expect(resolveToken(tempDir(), { BLIPR_TOKEN: " blipr_pk_env " })).toBe("blipr_pk_env");
  });

  it("falls back to the .env file in the launch directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ENV_FILE), "BLIPR_TOKEN=blipr_pk_file\n");
    expect(resolveToken(dir, {})).toBe("blipr_pk_file");
  });

  it("prefers the env var over the .env file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ENV_FILE), "BLIPR_TOKEN=blipr_pk_file\n");
    expect(resolveToken(dir, { BLIPR_TOKEN: "blipr_pk_env" })).toBe("blipr_pk_env");
  });

  it("ignores an empty value in either source", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ENV_FILE), "BLIPR_TOKEN=   \n");
    expect(resolveToken(dir, { BLIPR_TOKEN: "  " })).toBeUndefined();
  });

  it("reads .env from the launch directory only — a parent's is not picked up", () => {
    const root = tempDir();
    writeFileSync(join(root, ENV_FILE), "BLIPR_TOKEN=blipr_pk_parent\n");
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(resolveToken(nested, {})).toBeUndefined();
  });

  it("does not read other keys out of the .env file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ENV_FILE), "BLIPR_TOPIC=leaked\nBLIPR_URL=https://leak.dev\n");
    expect(resolveToken(dir, {})).toBeUndefined();
    expect(resolveDefaultTopic(dir, {})).toBeUndefined();
    expect(process.env.BLIPR_TOPIC).toBeUndefined();
  });
});
