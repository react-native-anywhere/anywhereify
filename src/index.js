const {tmpdir} = require("os");
const {resolve, dirname} = require("path");
const {nanoid} = require("nanoid");
const fs = require("fs");
const fse = require("fs-extra");
const npm = require("npm-programmatic");
const browserify = require("browserify");
const minify = require("babel-minify");
const camel = require("camelcase");

const createStub = ({ pkg, pkgName }) => `
var ${pkgName} = require("${pkg}");
module.exports = ${pkgName};
`.trim();

const restructure = async (outFile, { pkg, pkgName }) => {
  const {code} = minify(
    `
var ${pkgName};

${(await fs.readFileSync(outFile, "utf8"))
  .replace(`var ${pkgName} = require("${pkg}");`, `${pkgName} = require("${pkg}");`)
  .replace(`module.exports = ${pkgName};`, "")}

module.exports = ${pkgName};
    `.trim(),
  );

  await fs.writeFileSync(outFile, code);
};

async function anywhereify({ pkg }) {
  const tempDir = resolve(tmpdir(), nanoid());
  const pkgName = camel(pkg);
  const stubFile = resolve(tempDir, "stub.js");
  const outFile = resolve(tempDir, "index.js");
  const resultFile = "./dist/index.js";

  console.log({ tempDir, pkgName, stubFile, outFile });

  try {
    await fse.removeSync(dirname(resultFile));
    await fs.mkdirSync(dirname(resultFile), { recursive: true });

    await fs.mkdirSync(tempDir, { recursive: true });
    await npm.install([pkg], { cwd: tempDir, save: true });
    await fs.writeFileSync(stubFile, createStub({ pkg, pkgName }));
    
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

    await restructure(outFile, { pkg, pkgName });
    await fse.moveSync(outFile, resultFile);

  } catch (e) {
    console.error(e);
  } finally {
    await fse.remove(tempDir);
  }
}

module.exports = anywhereify;
