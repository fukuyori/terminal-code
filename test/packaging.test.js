const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

test("the build marks dist as a CommonJS package scope", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "dist", "package.json"), "utf8"),
  );
  assert.equal(pkg.type, "commonjs");
});
