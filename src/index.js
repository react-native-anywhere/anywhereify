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
  out: "dist",
});

const shouldCheckDependencies = path => new Promise(resolve => depcheck(
  path,
  { ignoreBinPackage: false, skipMissing: false },
  resolve,
));

const createTempProject = async ({ projectDir, packageJson, exports }) => {
  console.log({ projectDir });
  if (!fs.existsSync(projectDir)) {
    await fs.mkdirSync(projectDir, { recursive: true });
  }

  const keys = exports.map((_, i) => `anywhereify_${i}`);
  await fs.copyFileSync(packageJson, resolve(projectDir, "package.json"));
  const stubFile = resolve(projectDir, "stub.js");

  const content = `
${exports.map(
  ({name, alias}, i) => {
    if ((typeCheck("String", alias) && alias.length > 0)) {
      return `const ${keys[i]} = require("${name}");`;
    } else if (alias === undefined) {
      return `require("${name}");`;
    }
    throw new Error(`Expected non-empty String alias, or undefined, encountered ${JSON.stringify(alias)}.`);
  },
).join("\n")}

module.exports = {
${exports.map(
  ({ name, alias }, i) => (!!alias) ? `  ["${alias}"]: ${keys[i]},` : null,
).filter(e => !!e).join("\n")}
};
  `.trim();

  await fs.writeFileSync(stubFile, content);

  return { stubFile };
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
const shouldGatherExternals = async ({ parentDir, tempProjectDir }) => {

  console.log('about to list');
  console.log({ parentDir, tempProjectDir });

  const superDependencies = await npm.list(parentDir);
  const subDependencies = await npm.list(tempProjectDir);

  /* allocate dirs to nest dedicated package-lock json */
  const superDir = resolve(tempProjectDir, "super");
  const subDir = resolve(tempProjectDir, "sub");

  if (!fs.existsSync(superDir)) {
    fs.mkdirSync(superDir, { recursive: true });
  }
  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
  }

  const superLockFile = resolve(superDir, "package-lock.json");
  const subLockFile = resolve(subDir, "package-lock.json");

  const superPackageFile = resolve(superDir, "package.json");
  const subPackageFile = resolve(subDir, "package.json");

  // ensure npm installs to the appropriate location
  await fs.writeFileSync(superPackageFile, JSON.stringify({ name: "super" }));
  await fs.writeFileSync(subPackageFile, JSON.stringify({ name: "sub" }));

  console.log({ superDir, subDir });

  await npm.install([...superDependencies].filter(e => (e !== packageName)), { save: true, cwd: superDir });
  await npm.install([...subDependencies].filter(e => (e !== packageName)), { save: true, cwd: subDir });

  const lockDiff = diffLockFiles(JSON.parse(fs.readFileSync(superLockFile, "utf-8")), JSON.parse(fs.readFileSync(subLockFile, "utf-8")));

  // XXX: Returns the list of packages which we want to ignore with Browserify.
  return Object.entries(lockDiff)
    .filter(
      // XXX: Return only the names of dependencies we want to suppress.
      ([packageName, [superVersion, subVersion]]) => shouldPreferSuperVersion(superVersion, subVersion),
    )
    .map(([packageName]) => packageName);
};

const shouldBundle = async ({ stubFile, outFile, externals }) => {
  const bundler = browserify();
  bundler.add(stubFile);

  /* packages to ignore, already implemented by the parent */
  externals.forEach(external => bundler.external(external));

  return new Promise(
    resolve => {
      const stream = fs.createWriteStream(outFile);
      stream.on("finish", resolve);
      return bundler
        .bundle()
        .pipe(stream)
    },
  );
};

const shouldMinifyInPlace = ({ path }) => fs.writeFileSync(
  path,
  minify(fs.readFileSync(path, "utf-8"), { mangle: false, regexpConstructors: false }).code,
);

(async () => {
  const t1 = new Date().getTime();
  const parentDir = resolve(`${root}`);
  const parentNodeModules = resolve(parentDir, "node_modules");
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

  const {...config} = deepmerge(defaultConfig, maybeConfig);

  const tempProjectDir = resolve(`${tmpdir()}`, nanoid());

  console.log({ parentNodeModules, childNodeModules });

  /* the dependencies of the package to anywhere decide the export format */
  const { dependencies: maybeDependencies } = JSON.parse(fs.readFileSync(childPackageJson, "utf-8"));

  const dependencies = (maybeDependencies || []);

  const { exports, out: maybeOut } = config;

  if (!Array.isArray(exports) || !exports.length) {
    throw new Error(`Expected non-empty Array exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("[{name:String,...}]", exports)) {
    throw new Error(`Expected [{name:String,...}] exports, encountered ${JSON.stringify(exports)}.`);
  } else if (!typeCheck("String", maybeOut) || !maybeOut.length) {
    throw new Error(`Expected non-empty String out, encountered ${out}.`);
  }

  const outDir = resolve(maybeOut);

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(exports);
  console.log({ dependencies });

  try {
    const { stubFile } = await createTempProject({ projectDir: tempProjectDir, packageJson: childPackageJson, exports });

    console.log({ stubFile });

    await npm.install(exports.map(({ name }) => name), {cwd: tempProjectDir, save: true});

    const bundleOutputFile = resolve(tempProjectDir, "bundle.js");

    // XXX: Next, compare the package.json of the target file and compare with the dependencies of the runtime.
    //      We'll be able to skip these out if there is overlap, if we can assume the presence of certain dependencies.
    const externals = await shouldGatherExternals({ parentDir, tempProjectDir });

    console.log({ externals });

    await shouldBundle({ stubFile, outFile: bundleOutputFile, externals });
    console.log({ stubFile, bundleOutputFile });

    await shouldMinifyInPlace({ path: bundleOutputFile });

    // XXX: Finally, move to target location.
    await fse.moveSync(bundleOutputFile, resolve(outDir, "index.js"));

    console.log({ outDir });
    console.log("✨", chalk.green(`Anywhereified your project in ${(Math.round((new Date().getTime() - t1) / 1000) * 100) / 100}s.`));
  } catch (e) {
    console.error(e);
  } finally {
    console.log("🧹", "Cleaning up...");
    if (fs.existsSync(tempProjectDir)) {
      //await fse.removeSync(tempProjectDir);
    }
  }
})();
