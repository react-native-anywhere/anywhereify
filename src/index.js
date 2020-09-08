const root = require("app-root-path");
const {resolve, dirname} = require("path");
const {tmpdir} = require("os");
const {nanoid} = require("nanoid");
const {typeCheck} = require("type-check");
const deepmerge = require("deepmerge");
const fs = require("fs");
const fse = require("fs-extra");
const browserify = require("browserify");
const npm = require("npm-programmatic");
const chalk = require("chalk");
const {diff: diffLockFiles} = require("lock-diff/lib/index");
const semver = require("semver");
const {minify: uglify} = require("uglify-es");

const {name: packageName} = require("../package");

const defaultConfig = Object.freeze({
  exports: null,
  out: "node_modules/@react-native-anywhere/anywhere/dist",
  target: resolve(`${root}`),
  uglifyOptions: { ecma: 5 },
  browserifyOptions: {}, 
});

const shouldCheckDependencies = path => new Promise(resolve => depcheck(
  path,
  { ignoreBinPackage: false, skipMissing: false },
  resolve,
));

const createTempProject = async ({ projectDir, exports, keys }) => {
  console.log({ projectDir });
  if (!fs.existsSync(projectDir)) {
    await fs.mkdirSync(projectDir, { recursive: true });
  }

  /* allocate dirs to nest dedicated package-lock json */
  const subDir = resolve(projectDir, "sub");

  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
  }

  const stubFile = resolve(subDir, "stub.js");

  const content = `
${exports.map(
  ({name, alias}, i) => {
    if ((typeCheck("String", alias) && alias.length > 0)) {
      return `var ${keys[i]} = require("${name}");`;
    } else if (alias === undefined) {
      return `require("${name}");`;
    }
    throw new Error(`Expected non-empty String alias, or undefined, encountered ${JSON.stringify(alias)}.`);
  },
).join("\n")}
  `.trim();

  await fs.writeFileSync(stubFile, content);

  return { subDir, stubFile };
};

// XXX: Defines whether Browserify should not manually process a 
//      dependency since it is provided by the runtime.
const shouldPreferSuperVersion = (superVersion, subVersion) => {
  if (!superVersion || !subVersion) {
    return false;
  }
  return true;
  const superIsGreater = semver.gte(superVersion, subVersion);

  const difference = semver.diff(
    superIsGreater ? subVersion : superVersion,
    superIsGreater ? superVersion: subVersion,
  );

  if (difference === null || (superIsGreater && (difference === "patch" || difference === "minor"))) {
    return true;
  }

  return false;
};

const shouldBundle = async ({stubFile, outFile, exports, keys, browserifyOptions}) => {
  await new Promise(
    resolve => {
      const stream = fs.createWriteStream(outFile);
      stream.on("finish", resolve);

      return browserify(stubFile, browserifyOptions)
        .add(stubFile)
        .bundle()
        .pipe(stream);
    },
  );

  // TODO: need better control and respect to keys, since we reference missing duplicates
  return fs.writeFileSync(
    outFile,
    `
${keys.map(key => `var ${key};`).join("\n")}

${keys.reduce((e, key) => e.replace(`var ${key} =`, `${key} = `), fs.readFileSync(outFile, "utf-8"))}

module.exports = {
${exports.map(
  ({ name, alias }, i) => (!!alias) ? `  ["${alias}"]: ${keys[i]},` : null,
).filter(e => !!e).join("\n")}
};
    `.trim(),
  );
};

const shouldMinifyInPlace = ({ path, uglifyOptions }) => {
  const {code, error} = uglify(
    fs.readFileSync(path, "utf-8"),
    { ...uglifyOptions },
  );
  if (error) {
    throw new Error(error);
  }
  return fs.writeFileSync(path, code);
};

(async () => {
  const t1 = new Date().getTime();
  const childAnywhereConfig = resolve(".", "anywhere.config.json");

  if (!fs.existsSync(childAnywhereConfig)) {
    throw new Error(`It looks like you have forgotten to define your ${childAnywhereConfig}.`);
  }

  const maybeConfig = JSON.parse(fs.readFileSync(childAnywhereConfig));

  if (!typeCheck("Object", maybeConfig)) {
    throw new Error(`Expected a config Object, encountered ${maybeConfig}.`);
  }

  const {uglifyOptions, browserifyOptions, ...config} = deepmerge(defaultConfig, maybeConfig);

  const tempProjectDir = resolve(`${tmpdir()}`, nanoid());

  const { exports, out: maybeOut, target: parentDir } = config;

  if (!Array.isArray(exports) || !exports.length) {
    throw new Error(`Expected non-empty Array exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("[{name:String,...}]", exports)) {
    throw new Error(`Expected [{name:String,...}] exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("String", maybeOut) || !maybeOut.length) {
    throw new Error(`Expected non-empty String out, encountered ${out}.`);
  }

  const keys = exports.map((_, i) => `anywhereify_${i}`);
  const outDir = resolve(maybeOut);

  console.log({ parentDir });

  try {
    const { subDir, stubFile } = await createTempProject({ projectDir: tempProjectDir, exports, keys});

    console.log({ stubFile });

    const bundleOutputFile = resolve(tempProjectDir, "bundle.js");

    const packages = exports.map(({name}) => name);
    
    await npm.install([...packages].filter(e => (e !== packageName)), { save: true, cwd: subDir });

    await shouldBundle({ stubFile, outFile: bundleOutputFile, exports, keys, browserifyOptions});
    console.log({ stubFile, bundleOutputFile });

    await shouldMinifyInPlace({path: bundleOutputFile, uglifyOptions });

    console.log({ outDir });
    if (fs.existsSync(outDir)) {
      await fse.removeSync(outDir);
    }
    fs.mkdirSync(outDir, {recursive: true});

    // XXX: Finally, move to target location.
    await fs.copyFileSync(bundleOutputFile, resolve(outDir, "index.js"));

    console.log("✨", chalk.green(`Anywhereified your project in ${(Math.round((new Date().getTime() - t1) / 1000) * 100) / 100}s.`));
  } catch (e) {
    console.error(e);
  } finally {
    console.log("🧹", "Cleaning up...");
    if (fs.existsSync(tempProjectDir)) {
      await fse.removeSync(tempProjectDir);
    }
  }
})();
