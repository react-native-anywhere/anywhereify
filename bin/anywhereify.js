#!/usr/bin/env node
const {argv} = require("yargs");
const {typeCheck} = require("type-check");

const anywhereify = require("../src");

const {package: pkg, polyfills: maybePolyfills} = argv;

if (!typeCheck("String", pkg) || !pkg.length) {
  throw new Error(`Expected non-empty String package, encountered ${pkg}.`);
}

const polyfills = (maybePolyfills || "")
  .split(",")
  .map(e => e.trim())
  .filter(e => e.length);

anywhereify({pkg, polyfills});