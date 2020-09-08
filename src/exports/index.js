const {typeCheck} = require("type-check");
const {nanoid} = require("nanoid");

// XXX: Generates an identifier unique to an export scope which is safe
//      to reference as a JavaScript variable.
const generateSafeId = () => nanoid().replace(/[^a-zA-Z]/gi, "");

const generateDeclaration = (node, parentNode, depth) => {
  const { id, name, alias, exports } = node;
  // XXX: Just a require.
  if (!alias) {
    return `require("${name}")`;
  } else  {
    if (depth === 0) {
      // XXX: Just import the direct package to a variable we can reference later.
      if (!exports.length) {
        return `var ${id} = require("${name}")`;
      }
      // XXX: If we're defining nested exports, then we don't have to make any
      //      declaration for the owning module.
      return null;
    } else if (depth === 1) {
      if (!typeCheck("{name:String,...}", parentNode)) {
        throw new Error(`Expected {name:String,...}, encountered ${JSON.stringify(parentNode)}.`);
      }
      const {name} = parentNode;
      const {name: pathOffset} = node;
      // XXX: Compensate if whether the user has specified slashes or not in their name.
      // TODO: As part of sanity checking for nested exports, throw if they've already specified a slash?
      return `var ${id} = require("${[name, pathOffset].join("/").replace(/\/\/+/g, '/')}")`;
    }
  }
  throw new Error(`Unable to generate a declaration for ${JSON.stringify(node)}!`);
};

const generateModuleExports = (exports) => {
  const moduleExports = exports
    .map(
      ({id, alias, exports}) => {
        if (!alias) {
          return null;
        } else if (!exports.length) {
          return [alias, id];
        }
        return [alias, exports.map(({ alias, id }) => [alias, id])];
      },
    ).filter(e => !!e);
  return `
module.exports = {
${moduleExports.map(
  ([alias, child]) => {
    if (!Array.isArray(child)) {
      return `  "${alias}": ${child},`;
    }
    return `  "${alias}": {${child.map(([alias, id]) => `\n    "${alias}": ${id},`).join("")}\n  },`;
  },
).join("\n")}
};
  `.trim();
};

const generateGlobalDeclaration = (node, depth) => {
  const { id, alias, exports } = node;
  if (alias && ((depth === 0 && !exports.length) || depth === 1)) {
    return `var ${id}`;
  }
  return null;
};

const sanitizeAlias = (alias) => {
  // XXX: An alias is not required, if one isn't specified it should just
  //      resolve to an anonymous import.
  if (alias === undefined) {
    return undefined;
  } else if (!typeCheck("String", alias) || !alias.length) {
    throw new Error(`Expected non-empty String alias, encountered ${alias}.`);
  }
  return alias;
};

const sanitizeExport = (maybeExport, parentNode, depth) => {
  if (depth > 1) {
    throw new Error(`It is not possible to define exports at a depth higher than 1. Expected depth <= 1, encountered ${depth}.`);
  }
  if (!typeCheck("Object", maybeExport)) {
    throw new Error(`Expected Object export, encountered ${JSON.stringify(maybeExport)}.`);
  } else if (!typeCheck("{name:String,...}", maybeExport) || !maybeExport.name.length) {
    return new Error(`An export must define a name prop. Expected non-empty String name, encountered ${name}.`);
  }

  const { name, alias: maybeAlias, ...extras } = maybeExport;
  const alias = sanitizeAlias(maybeAlias); 

  const node = Object.freeze({ id: generateSafeId(), name, alias });

  const { exports: maybeExports } = maybeExport;
  const exports = sanitizeExports(maybeExports, node, depth + 1);

  if (exports.length > 0 && !alias) {
    throw new Error(`In order to define nested exports, you must specify a alias for the parent export. Expected non-empty String alias, encountered ${alias}.`);
  }

  const baseNode = {...node, exports };

  return {
    ...baseNode,
    exports,
    declaration: generateDeclaration(baseNode, parentNode, depth),
    globalDeclaration: generateGlobalDeclaration(baseNode, depth),
  };
};

// TODO: compile evaluated paths
const sanitizeExports = (exports, parentNode = null, depth = 0) => {
  if (exports === undefined) {
    // TODO: export early
    return [];
  } else if (!Array.isArray(exports)) {
    throw new Error(`Expected Array or undefined exports, encountered ${JSON.stringify(exports)}.`);
  }
  if (!exports.length) {
    throw new Error("Defined exports must contain at least a single export child, but the array was empty.");
  }
  return exports.map(e => sanitizeExport(e, parentNode, depth));
}

const declareExportsRecursive = exports => exports.reduce(
  (arr, { declaration, exports }) => [
    ...arr,
    declaration,
    ...(exports ? declareExportsRecursive(exports) : []),
  ],
  [],
)
  .filter(e => !!e);

const declareExports = exports => `${declareExportsRecursive(exports).join(";\n")};`;

const declareGlobalExportsRecursive = exports => exports.reduce(
  (arr, { globalDeclaration, exports }) => [
    ...arr,
    globalDeclaration,
    ...(exports ? declareGlobalExportsRecursive(exports) : []),
  ],
  [],
)
  .filter(e => !!e);

const declareGlobalExports = exports => `${declareGlobalExportsRecursive(exports).join(";\n")};`;

// XXX: Only the top-level elements may declare packages.
const packages = exports => exports
  .map(({ name }) => name);

const accumulateIds = exports => exports
  .reduce(
    (arr, { id, exports }) => [...arr, id, ...accumulateIds(exports)],
    [],
  );

const suppressScopedDeclarations = (str, exports) => accumulateIds(exports)
  .reduce((str, id) => str.replace(`var ${id}`, id), str);

/* exports */
module.exports.sanitizeExports = sanitizeExports;
module.exports.declareExports = declareExports;
module.exports.declareGlobalExports = declareGlobalExports;
module.exports.packages = packages;
module.exports.suppressScopedDeclarations = suppressScopedDeclarations;
module.exports.generateModuleExports = generateModuleExports;
