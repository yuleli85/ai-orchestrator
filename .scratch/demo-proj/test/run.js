'use strict';

const assert = require('node:assert/strict');
const { slugify } = require('../src/strings.js');

const cases = [
  ['Hello World', 'hello-world'],
  ['你好 世界', '你好-世界'],
  ['a   b', 'a-b'],
  ['  trim me  ', 'trim-me'],
  ['C++ & Node.js!!!', 'c-nodejs'],
  ['a--b__c', 'a-b-c'],
  ['Hello, World! 123', 'hello-world-123'],
];

let passed = 0;
for (const [input, expected] of cases) {
  assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
  passed += 1;
}

assert.throws(() => slugify(123), TypeError);
passed += 1;

const optionCases = [
  ['Hello World Foo Bar', { maxLength: 13 }, 'hello-world'],
  ['Internationalization Is Cool', { maxLength: 10 }, 'internatio'],
  ['Hello World', { separator: '_' }, 'hello_world'],
  ['Hello World Foo Bar', { separator: '_', maxLength: 13 }, 'hello_world'],
];

for (const [input, options, expected] of optionCases) {
  assert.equal(
    slugify(input, options),
    expected,
    `slugify(${JSON.stringify(input)}, ${JSON.stringify(options)})`
  );
  passed += 1;
}

assert.equal(slugify('Hello World'), slugify('Hello World', {}), 'default options equals omitted options');
passed += 1;

assert.equal(slugify('Hello World', { separator: '--' }), 'hello-world', 'invalid separator falls back to dash');
passed += 1;

assert.equal(slugify('Hello World', { maxLength: -1 }), 'hello-world', 'invalid maxLength means no truncation');
passed += 1;

console.log(`passed ${passed} cases`);
