import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rolldown } from "rolldown";
import { parseAst } from "rolldown/parseAst";

// Derive operation factories from the implementation's return object. WIT
// remains the ABI contract; this generated asset contains implementation only.
// AST boundaries (not textual matching) preserve method bodies and scopes.
export async function helperOperations() {
  const result = {};
  for (const [module, name] of [
    ["strings", "stringImports"],
    ["iterator", "iteratorImports"],
    ["segmenter", "segmenterImports"],
    ["encoding", "encodingImports"],
  ]) {
    const source = readFileSync(`src/${module}.mjs`, "utf8");
    const program = parseAst(source);
    assert.equal(program.body.length, 1, `${module}: self-contained factory`);
    const factory = program.body[0].declaration;
    assert.equal(factory.type, "FunctionDeclaration");
    assert.equal(factory.id.name, name);
    assert.equal(factory.params.length, 1);
    assert.equal(factory.params[0].name, "values");
    const returned = factory.body.body.at(-1);
    assert.equal(returned.type, "ReturnStatement");
    assert.equal(returned.argument.type, "ObjectExpression");
    const operations = {};
    for (const property of returned.argument.properties) {
      assert.equal(property.type, "Property");
      assert.equal(property.kind, "init");
      assert.equal(property.computed, false);
      const key = property.key.name ?? property.key.value;
      let expression = source.slice(property.value.start, property.value.end);
      if (property.method) {
        const method = property.value;
        assert.equal(method.async, false);
        assert.equal(method.generator, false);
        expression = `function(${method.params.map((p) => source.slice(p.start, p.end)).join(",")})${source.slice(method.body.start, method.body.end)}`;
      }
      // Compile each selected closure, including only its live initialization.
      const input = `export default function operation(v){const values=v;${source.slice(factory.body.start + 1, returned.argument.start)}(${expression})${source.slice(returned.argument.end, factory.body.end)}`;
      const bundle = await rolldown({
        input: "virtual:helper-operation",
        plugins: [
          {
            name: "helper-operation",
            resolveId: (id) => id,
            load: () => input,
          },
        ],
      });
      try {
        const { output } = await bundle.generate({
          format: "esm",
          comments: false,
          minify: { mangle: { reserved: ["v", "a"] } },
        });
        const code = output[0].code;
        const body = parseAst(code).body;
        assert.equal(body.length, 2, `${module}.${key}: isolated closure`);
        assert.equal(body[0].type, "FunctionDeclaration");
        assert.equal(body[1].type, "ExportNamedDeclaration");
        assert.equal(body[1].specifiers[0].local.name, body[0].id.name);
        assert.equal(body[1].specifiers[0].exported.name, "default");
        assert.equal(body[0].params[0].name, "v");
        const statements = body[0].body.body;
        const returned = statements.at(-1);
        assert.equal(returned.type, "ReturnStatement");
        // Each operation gets its own lexical block in the host factory. Codec
        // initialization stays per-instance and is absent unless imported.
        operations[key] =
          `${code.slice(body[0].body.start + 1, returned.start)}a[${JSON.stringify(key)}]=${code.slice(returned.argument.start, returned.argument.end)};`;
      } finally {
        await bundle.close();
      }
    }
    result[module] = operations;
  }
  return Buffer.from(JSON.stringify(result) + "\n");
}
