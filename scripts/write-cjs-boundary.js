#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

// Explicitly set the module scope so generated CommonJS in dist/ cannot inherit an ancestor's "type":"module".
const dist = path.resolve(__dirname, "..", "dist");
fs.writeFileSync(path.join(dist, "package.json"), '{ "type": "commonjs" }\n');
