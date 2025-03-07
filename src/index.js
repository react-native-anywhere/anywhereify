const root = require("app-root-path");
const {resolve, dirname} = require("path");
const {tmpdir} = require("os");
const {typeCheck} = require("type-check");
const deepmerge = require("deepmerge");
const fs = require("fs");
const fse = require("fs-extra");
const browserify = require("browserify");
const npm = require("npm-programmatic");
const chalk = require("chalk");
const {diff: diffLockFiles} = require("lock-diff/lib/index");
const semver = require("semver");
const minify = require("babel-minify");
const objectHash = require("object-hash");

const {
  sanitizeExports,
  declareExports,
  declareGlobalExports,
  packages,
  suppressScopedDeclarations,
  generateModuleExports,
} = require("./exports");

const defaultConfig = Object.freeze({
  exports: null,
  out: "node_modules/@react-native-anywhere/anywhere/dist",
  target: resolve(`${root}`),
  browserifyOptions: {}, 
});

const shouldCheckDependencies = path => new Promise(resolve => depcheck(
  path,
  { ignoreBinPackage: false, skipMissing: false },
  resolve,
));

const createTempProject = async ({ projectDir, exports }) => {
  if (!fs.existsSync(projectDir)) {
    await fs.mkdirSync(projectDir, { recursive: true });
  }

  const packageJsonFile = resolve(projectDir, "package.json");
  const stubFile = resolve(projectDir, "stub.js");

  await fs.writeFileSync(packageJsonFile, JSON.stringify({ name: "temp-project" }));
  await fs.writeFileSync(stubFile, declareExports(exports));

  return { stubFile };
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

const shouldInstallPackages = async ({ packages, cwd }) => {
  return npm.install(packages, { save: true, cwd });
};

const shouldBundle = async ({stubFile, outFile, exports, browserifyOptions}) => {
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
  return fs.writeFileSync(
    outFile,
    `
${declareGlobalExports(exports)}
${suppressScopedDeclarations(fs.readFileSync(outFile, "utf-8"), exports)}
${generateModuleExports(exports)}
    `.trim(),
  );
};

const shouldMinifyInPlace = ({ path }) => {
  const {code, error} = minify(fs.readFileSync(path, "utf-8"), {mangle: false, regexpConstructors: false});
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

  const bundledConfig = deepmerge(defaultConfig, maybeConfig);
  const {browserifyOptions, ...config} = bundledConfig;
  const bundledConfigHash = objectHash(bundledConfig);

  const tempProjectDir = resolve(`${tmpdir()}`, bundledConfigHash);

  const { exports: maybeExports, out: maybeOut, target: parentDir } = config;

  const exports = sanitizeExports(maybeExports);
  const outDir = resolve(maybeOut);
  const outLock = resolve(outDir, ".anywhere.config");
  const outFile = resolve(outDir, "index.js");

  const isPackagerRequired = !fs.existsSync(outLock) || fs.readFileSync(outLock, "utf-8") !== bundledConfigHash;

  try {
    if (isPackagerRequired) {
      const { stubFile } = await createTempProject({ projectDir: tempProjectDir, exports});
  
      const bundleOutputFile = resolve(tempProjectDir, "bundle.js");
  
      await shouldInstallPackages({
        packages: packages(exports).filter((e, i, orig) => (orig.indexOf(e) === i)),
        cwd: tempProjectDir,
      });
  
      await shouldBundle({ stubFile, outFile: bundleOutputFile, exports, browserifyOptions});
      await shouldMinifyInPlace({path: bundleOutputFile});
  
      if (fs.existsSync(outDir)) {
        await fse.removeSync(outDir);
      }
      fs.mkdirSync(outDir, {recursive: true});
  
      // XXX: Finally, move to target location.
      await fs.copyFileSync(bundleOutputFile, outFile);
      // XXX: Write the Hash.
      await fs.writeFileSync(outLock, bundledConfigHash);
    }
    console.log("✨", chalk.green(`Anywhereified your project in ${(Math.round((new Date().getTime() - t1) / 1000) * 100) / 100}s.`));
  } catch (e) {
    console.error(e);
  }
})();
