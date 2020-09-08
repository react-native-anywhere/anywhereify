require("@babel/polyfill");

const {
  sanitizeExports,
  declareExports,
  declareGlobalExports,
  suppressScopedDeclarations,
  generateModuleExports,
} = require("../../src/exports");

it("should throw on invalid export declarations", async () => {
  expect(() => sanitizeExports([])).toThrow();
  expect(() => sanitizeExports(null)).toThrow();
  expect(() => sanitizeExports([{}])).toThrow();
  expect(() => sanitizeExports([{alias: ""}])).toThrow();
  expect(() => sanitizeExports([{
    name: "some-dependency",
    /* bad parent definition */
    exports: [{name: "some export"}],
  }])).toThrow();
  expect(() => sanitizeExports([{
    name: "some-dependency",
    alias: "SomeDependency",
    /* bad parent definition */
    exports: [{
      name: "some-other-dependency",
      alias: "SomeOtherDependency",
      exports: [],
    }],
  }])).toThrow();
});

it("should parse the gsn configuration", async () => {
  const gsn = {
    "exports": [
      { "name": "@react-native-anywhere/polyfill-base64" },
      { "name": "web3-providers-http", "alias": "Web3HttpProvider" },
      { 
        "name": "@opengsn/gsn",
        "alias": "OpenGSN",
        "exports": [
          // XXX: Optional file subsets. (Smaller generated bundles.)
          { "name": "dist/RelayProvider", "alias": "RelayProvider" },
          { "name": "dist/GSNConfigurator", "alias": "GSNConfigurator" },
        ]
      }
    ]
  };
  const {exports} = gsn;
  const sanitized = sanitizeExports(exports);
  const declaration = declareExports(sanitized);
  const globalDeclaration = declareGlobalExports(sanitized);
  const moduleExports = generateModuleExports(sanitized);
  
  console.log(declaration);
  console.log(globalDeclaration);
  console.log(suppressScopedDeclarations("", sanitized));

  console.log(JSON.stringify(moduleExports));
});
