// Every place the version is written must agree with package.json, each found
// exactly once, so a release can never ship with two different versions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const version = (JSON.parse(read("package.json")) as { version: string }).version;

function occurrences(text: string, needle: string): number {
  return text.match(new RegExp(escape(needle), "g"))?.length ?? 0;
}

describe("version consistency", () => {
  it("package.json has a version", () => {
    assert.match(version, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });

  it("both root entries of package-lock.json match package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(lock.version, version);
    assert.equal(lock.packages[""]?.version, version);
  });

  const spots: Array<[file: string, needle: string]> = [
    ["trace-client.ts", `trace-client ${version} --`],
    ["trace-client.ts", `TRACE_CLIENT_VERSION = "${version}"`],
    ["README.md", `trace-client-js/${version} (`],
  ];
  for (const [file, needle] of spots) {
    it(`${file} says ${JSON.stringify(needle)} exactly once`, () => {
      assert.equal(occurrences(read(file), needle), 1);
    });
  }
});
