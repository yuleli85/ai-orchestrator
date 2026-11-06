'use strict';

const assert = require('node:assert/strict');
const { sum, avg } = require('../src/mathx.js');

let passed = 0;

assert.equal(sum([1, 2, 3]), 6);
passed += 1;

assert.equal(sum([]), 0);
passed += 1;

assert.throws(() => sum('x'), TypeError);
passed += 1;

assert.equal(avg([1, 2, 3]), 2);
passed += 1;

assert.equal(avg([]), null);
passed += 1;

assert.equal(avg([2, 4]), 3);
passed += 1;

console.log(`passed ${passed} cases`);
