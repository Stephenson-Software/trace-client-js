// The install-ID compatibility test: freezes what TraceClient.installIdFromFile
// does with every file in tests/install-id-fixtures, as listed in expected.txt.
// An ID a released version stored must keep loading as the same ID, and a file
// the loader cannot read must never be overwritten. Fixtures and their
// `loaded`/`kept` lines are frozen once released: never edit or delete one; a
// new case is a new fixture plus its line in expected.txt.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TraceClient } from "../trace-client.ts";

const FIXTURES = fileURLToPath(new URL("./install-id-fixtures/", import.meta.url));
const EXPECTED = join(FIXTURES, "expected.txt");
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Expectation = { file: string; outcome: "loaded"; id: string } | { file: string; outcome: "replaced" | "kept" };

function readExpected(): Expectation[] {
  const expectations: Expectation[] = [];
  for (const raw of readFileSync(EXPECTED, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [file, outcome, id, ...rest] = line.split(/\s+/);
    assert.equal(rest.length, 0, `expected.txt: too many fields in ${JSON.stringify(line)}`);
    if (outcome === "loaded") {
      assert.ok(id, `expected.txt: no ID on ${JSON.stringify(line)}`);
      expectations.push({ file, outcome, id });
    } else if (outcome === "replaced" || outcome === "kept") {
      assert.equal(id, undefined, `expected.txt: stray field on ${JSON.stringify(line)}`);
      expectations.push({ file, outcome });
    } else {
      assert.fail(`expected.txt: unknown outcome on ${JSON.stringify(line)}`);
    }
  }
  return expectations;
}

const expectations = readExpected();

describe("install-ID fixtures (tests/install-id-fixtures/expected.txt)", () => {
  it("lists exactly the *.id files in the directory", () => {
    const onDisk = readdirSync(FIXTURES).filter((name) => name.endsWith(".id")).sort();
    const listed = expectations.map((e) => e.file).sort();
    assert.deepEqual(listed, onDisk);
    assert.equal(new Set(listed).size, listed.length, "a fixture is listed twice");
  });

  for (const expectation of expectations) {
    it(`${expectation.file} is ${expectation.outcome}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "trace-install-id-fixture-"));
      try {
        const path = join(dir, expectation.file);
        copyFileSync(join(FIXTURES, expectation.file), path);
        const before = readFileSync(path);
        const returned = TraceClient.installIdFromFile(path);
        const after = readFileSync(path);
        if (expectation.outcome === "loaded") {
          assert.equal(returned, expectation.id);
          assert.ok(after.equals(before), "the file must be left untouched");
        } else if (expectation.outcome === "replaced") {
          assert.match(returned, UUID4);
          assert.ok(after.equals(Buffer.from(returned + "\n", "utf8")), "the file must now hold exactly the new ID and a newline");
        } else {
          assert.ok(after.equals(before), "an unreadable file must be left byte-identical");
          assert.match(returned, UUID4);
          assert.ok(!before.includes(Buffer.from(returned, "utf8")), "the fresh ID must not come from the file");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
