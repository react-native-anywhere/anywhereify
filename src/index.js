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
const minify = require("babel-minify");
const {diff: diffLockFiles} = require("lock-diff/lib/index");
const semver = require("semver");

const {name: packageName} = require("../package");

const defaultConfig = Object.freeze({
  exports: null,
  out: "node_modules/@react-native-anywhere/anywhere/dist",
  target: resolve(`${root}`),
  minifyEnabled: true,
});

const shouldCheckDependencies = path => new Promise(resolve => depcheck(
  path,
  { ignoreBinPackage: false, skipMissing: false },
  resolve,
));

const createTempProject = async ({ projectDir, packageJson, exports, keys }) => {
  console.log({ projectDir });
  if (!fs.existsSync(projectDir)) {
    await fs.mkdirSync(projectDir, { recursive: true });
  }

  const jsonFile = fs.readFileSync(packageJson, "utf-8");

  const { dependencies: maybeDependencies } = JSON.parse(jsonFile);

  const dependencies = maybeDependencies || [];

  console.log({ dependencies });

  fs.writeFileSync(resolve(projectDir, "package.json"), JSON.stringify({
    name: "tempProject",
    dependencies,
  }));

  // XXX: Install the dependencies.
  // TODO: version
  await npm.install(Object.keys(dependencies), {save: true, cwd: projectDir });

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

// XXX: Compares the dependencies provided by the parent to avoid bundling.
const shouldGatherExternals = async ({parentDir, tempProjectDir, packages, subDir}) => {

  console.log({ tempProjectDir, subDir, packages });

  const tempLockFile = resolve(tempProjectDir, "package-lock.json");
  const subLockFile = resolve(subDir, "package-lock.json");

  const tempPackageFile = resolve(tempProjectDir, "package.json");
  const subPackageFile = resolve(subDir, "package.json");

  // ensure npm installs to the appropriate location
  await fs.writeFileSync(subPackageFile, JSON.stringify({ name: "sub" }));

  const superDependencies = await npm.list(tempProjectDir);
  console.log({ superDependencies });

  /* copy the parentDir to a separate file */
  console.log({ parentDir, tempProjectDir });

  await npm.install([...packages].filter(e => (e !== packageName)), { save: true, cwd: subDir });
  const subDependencies = await npm.list(subDir);
  
  console.log({ subDependencies });

  const lockDiff = diffLockFiles(JSON.parse(fs.readFileSync(tempLockFile, "utf-8")), JSON.parse(fs.readFileSync(subLockFile, "utf-8")));

  // XXX: Returns the list of packages which we want to ignore with Browserify.
  return Object.entries(lockDiff)
    .filter(
      // XXX: Return only the names of dependencies we want to suppress.
      ([packageName, [superVersion, subVersion]]) => shouldPreferSuperVersion(superVersion, subVersion),
    )
    .map(([packageName]) => packageName);
};

const shouldBundle = async ({stubFile, outFile, externals, exports, keys}) => {
  const bundler = browserify();
  bundler.add(stubFile);

  /* packages to ignore, already implemented by the parent */
  externals.forEach(external => bundler.external(external));

  await new Promise(
    resolve => {
      const stream = fs.createWriteStream(outFile);
      stream.on("finish", resolve);
      return bundler
        .bundle()
        .pipe(stream)
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

const shouldMinifyInPlace = ({ path }) => fs.writeFileSync(
  path,
  minify(fs.readFileSync(path, "utf-8"), { mangle: false, regexpConstructors: false }).code,
);

(async () => {
  const t1 = new Date().getTime();
  const childNodeModules = resolve(".", "node_modules");
  const childPackageJson = resolve(".", "package.json");
  const childAnywhereConfig = resolve(".", "anywhere.config.json");

  if (!fs.existsSync(childAnywhereConfig)) {
    throw new Error(`It looks like you have forgotten to define your ${childAnywhereConfig}.`);
  }

  const maybeConfig = JSON.parse(fs.readFileSync(childAnywhereConfig));

  if (!typeCheck("Object", maybeConfig)) {
    throw new Error(`Expected a config Object, encountered ${maybeConfig}.`);
  }

  const {minifyEnabled, ...config} = deepmerge(defaultConfig, maybeConfig);

  const tempProjectDir = resolve(`${tmpdir()}`, nanoid());

  console.log({ childNodeModules });

  const { exports, out: maybeOut, target: parentDir } = config;

  if (!Array.isArray(exports) || !exports.length) {
    throw new Error(`Expected non-empty Array exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("[{name:String,...}]", exports)) {
    throw new Error(`Expected [{name:String,...}] exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("String", maybeOut) || !maybeOut.length) {
    throw new Error(`Expected non-empty String out, encountered ${out}.`);
  }

  fs.writeFileSync(resolve(`${root}`, "anywhere-out.txt"), JSON.stringify(config));

  const keys = exports.map((_, i) => `anywhereify_${i}`);
  const outDir = resolve(maybeOut);

  console.log({ parentDir });

  try {
    const { subDir, stubFile } = await createTempProject({ projectDir: tempProjectDir, packageJson: childPackageJson, exports, keys});

    console.log({ stubFile });

    const bundleOutputFile = resolve(tempProjectDir, "bundle.js");

    const packages = exports.map(({name}) => name);
    

    // XXX: Next, compare the package.json of the target file and compare with the dependencies of the runtime.
    //      We'll be able to skip these out if there is overlap, if we can assume the presence of certain dependencies.
    const externals = await shouldGatherExternals({parentDir, tempProjectDir, packages, subDir});

    console.log({ externals });

    await shouldBundle({ stubFile, outFile: bundleOutputFile, externals, exports, keys});
    console.log({ stubFile, bundleOutputFile });

    if (minifyEnabled) {
      await shouldMinifyInPlace({path: bundleOutputFile});
    }

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
