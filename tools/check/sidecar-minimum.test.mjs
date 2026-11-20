import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMinimum } from "./sidecar-minimum.mjs";

test("accepts equal and older minimum versions, ignoring the tool version", () => {
    assert.deepEqual(checkMinimum("    minos 11.0\n  version 27037.1\n", "11.0"), ["11.0"]);
    assert.deepEqual(checkMinimum("minos 10.15\nminos 11.0.0\n", "11.0"), ["10.15", "11.0.0"]);
});

test("rejects newer versions in any architecture", () => {
    assert.throws(() => checkMinimum("minos 11.0\nminos 11.1\n", "11.0"), /exceeds/);
    assert.throws(() => checkMinimum("minos 26.0\n", "11.0"), /exceeds/);
});

test("rejects empty or unrecognized metadata", () => {
    assert.throws(() => checkMinimum("", "11.0"), /no macOS minimum/);
    assert.throws(() => checkMinimum("version 27037.1\n", "11.0"), /no macOS minimum/);
});
