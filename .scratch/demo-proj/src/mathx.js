'use strict';

function sum(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError('arr must be an array');
  }
  if (arr.length === 0) {
    return 0;
  }
  return arr.reduce((acc, value) => acc + value, 0);
}

function avg(arr) {
  if (Array.isArray(arr) && arr.length === 0) {
    return null;
  }
  return sum(arr) / arr.length;
}

module.exports = { sum, avg };
