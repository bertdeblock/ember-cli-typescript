import SkeletonApp from '../helpers/skeleton-app';
import chai from 'ember-cli-blueprint-test-helpers/chai';
import * as esprima from 'esprima';
import {
  ExpressionStatement,
  Statement,
  ModuleDeclaration,
  CallExpression,
  Expression,
  ClassExpression,
  Literal,
} from 'estree';

const { expect } = chai;

describe('Acceptance: build', function () {
  this.timeout(60 * 1000);
  let app: SkeletonApp;
  beforeEach(function () {
    app = new SkeletonApp();
  });

  afterEach(function () {
    app.teardown();
  });

  it('builds and rebuilds files', async () => {
    app.writeFile(
      'app/app.ts',
      `
      export function add(a: number, b: number) {
        return a + b;
      }
    `
    );

    let server = app.serve();

    await server.waitForBuild();

    expectModuleBody(
      app,
      'skeleton-app/app',
      `
      _exports.add = add;
      function add(a, b) {
        return a + b;
      }
    `
    );

    app.writeFile(
      'app/app.ts',
      `
      export const foo: string = 'hello';
    `
    );

    await server.waitForBuild();

    expectModuleBody(
      app,
      'skeleton-app/app',
      `
      _exports.foo = void 0;
      var foo = 'hello';
      _exports.foo = foo;
    `
    );
  });

  it("doesn't launch type checking for `ember serve` when --path is used", async () => {
    await app.build();

    let server = app.serve({
      args: ['--path', 'dist'],
      env: { DEBUG: 'ember-cli-typescript:addon' },
    });

    let result = await server.waitForOutput('Serving on');

    expect(result).to.include('ember-cli-typescript:addon Skipping typecheck server middleware');
  });

  it("doesn't launch type checking for `ember test` when --path is used", async () => {
    await app.build({ args: ['--environment', 'test'] });

    let result = await app.test({
      args: ['--path', 'dist'],
      env: { DEBUG: 'ember-cli-typescript:addon' },
    });

    expect(result.all).to.include(
      'ember-cli-typescript:addon Skipping typecheck testem middleware'
    );
  });

  it('fails the build when noEmitOnError is set and an error is emitted', async () => {
    app.writeFile('app/app.ts', `import { foo } from 'nonexistent';`);

    try {
      await app.build();
      expect.fail('Build should have failed');
    } catch (error: any) {
      expect(error.all).to.include(`Cannot find module 'nonexistent'`);
    }
  });

  it('serves a type error page when the build has failed', async () => {
    app.writeFile('app/index.html', 'plain index');
    app.writeFile('app/app.ts', `import { foo } from 'nonexistent';`);

    let server = app.serve();
    let output = await server.waitForOutput('Typechecking failed');
    let response = await server.request('/');

    expect(output).to.include(`Cannot find module 'nonexistent'`);
    expect(response.body).to.include(`Cannot find module 'nonexistent'`);
  });

  it("doesn't block builds for file changes that don't result in a typecheck", async () => {
    let server = app.serve();

    await server.waitForBuild();

    app.writeFile('app/some-template.hbs', '');

    await server.waitForBuild();
  });

  it('emits a warning when .js and .ts files conflict in the app/ tree', async () => {
    // Set up an in-repo addon
    app.updatePackageJSON((pkg) => {
      pkg['ember-addon'].paths.push('lib/in-repo-addon');
    });

    app.writeFile('lib/in-repo-addon/index.js', 'module.exports = { name: "in-repo-addon" };');
    app.writeFile(
      'lib/in-repo-addon/package.json',
      JSON.stringify({
        name: 'in-repo-addon',
        keywords: ['ember-addon'],
      })
    );

    // Have it export a .js app file and attempt to overwrite it in the host with a .ts file
    app.writeFile('lib/in-repo-addon/app/foo.js', '// addon');
    app.writeFile('app/foo.ts', '// app');

    let output = await app.build();

    expect(output.all).to.include('skeleton-app/foo.{js,ts}');
    expect(output.all).to.include(
      'WARNING: Detected collisions between .js and .ts files of the same name.'
    );
  });
});

function isExpressionStatement(stmt: Statement | ModuleDeclaration): stmt is ExpressionStatement {
  return stmt.type === 'ExpressionStatement';
}

function isSpecialCallExpression(expr: Expression): expr is CallExpression & {
  arguments: [Literal, Expression, ClassExpression];
} {
  return (
    expr.type === 'CallExpression' &&
    expr.callee.type === 'Identifier' &&
    expr.callee.name === 'define' &&
    expr.arguments &&
    expr.arguments[0] &&
    expr.arguments[0].type === 'Literal'
  );
}

function extractModuleBody(script: string, moduleName: string) {
  let parsed = esprima.parseScript(script);
  let [definition] = parsed.body
    .filter(isExpressionStatement)
    .map((stmt) => stmt.expression)
    .filter(isSpecialCallExpression)
    .filter((expr) => expr.arguments[0].value === moduleName);
  if (!definition) throw new Error('Definition for call expression not found');
  let moduleDef = definition.arguments[2].body;

  // Strip `'use strict'`
  moduleDef.body.shift();

  // Strip `__esModule` definition
  moduleDef.body.shift();

  return moduleDef;
}

function expectModuleBody(app: SkeletonApp, name: string, body: string) {
  let src = app.readFile('dist/assets/skeleton-app.js');
  let actual = extractModuleBody(src, name);
  let expected = esprima.parseScript(body);
  expect(actual.body).to.deep.equal(expected.body);
}
