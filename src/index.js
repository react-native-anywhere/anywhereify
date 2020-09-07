const {tmpdir} = require("os");
const {resolve, dirname} = require("path");
const {nanoid} = require("nanoid");
const fs = require("fs");
const fse = require("fs-extra");
const npm = require("npm-programmatic");
const browserify = require("browserify");
const camel = require("camelcase");
//const minify = require("babel-minify");

const createStub = ({pkg, pkgName, polyfills}) => `
${polyfills.map(polyfill => `require("${polyfill}");`)}

var ${pkgName} = require("${pkg}");
module.exports = ${pkgName};
`.trim();

const restructure = async (outFile, {pkg, pkgName}) => {
  //const { code } = minify(
    const code = `
var ${pkgName};

${(await fs.readFileSync(outFile, "utf8"))
  .replace(`var ${pkgName} = require("${pkg}");`, `${pkgName} = require("${pkg}");`)
  .replace(`module.exports = ${pkgName};`, "")}

module.exports = ${pkgName};
    `.trim();
//    { mangle: false },
//  );

  await fs.writeFileSync(outFile, code);
};

async function anywhereify({pkg, polyfills}) {
  // TODO: Create a nicer package name that would serve multiple imports.
  const pkgName = nanoid()
    .replace(/[^a-zA-Z]+/g, "");

  const tempDir = resolve(tmpdir(), pkgName);
  const stubFile = resolve(tempDir, "stub.js");
  const outFile = resolve(tempDir, "index.js");
  const resultFile = "./dist/index.js";

  try {
    await fse.removeSync(dirname(resultFile));
    await fs.mkdirSync(dirname(resultFile), {recursive: true});

    await fs.mkdirSync(tempDir, {recursive: true});
    await npm.install([pkg, ...polyfills], {cwd: tempDir, save: true});
    await fs.writeFileSync(stubFile, createStub({pkg, pkgName, polyfills}));
    
    const bundler = browserify();
    bundler.add(stubFile);
    await new Promise(
      resolve => {
        const stream = fs.createWriteStream(outFile);
        stream.on("finish", resolve);
        return bundler
          .bundle()
          .pipe(stream)
      },
    );

    await restructure(outFile, {pkg, pkgName});
    await fse.moveSync(outFile, resultFile);
  } catch (e) {
    console.error(e);
  } finally {
    await fse.remove(tempDir);
  }
}

module.exports = anywhereify;
