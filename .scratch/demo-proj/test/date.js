'use strict';

const assert = require('node:assert/strict');
const { formatDate, relativeTime } = require('../src/date.js');

let passed = 0;
const date = new Date(2024, 0, 5, 3, 4, 5);

// 验收标准：六种占位符一次替换。
assert.equal(
  formatDate(date, 'YYYY-MM-DD HH:mm:ss'),
  '2024-01-05 03:04:05'
);
passed += 1;

// 重复占位符全部替换，未识别字符原样保留。
assert.equal(
  formatDate(date, 'YYYY/YYYY MM/MM DD DD ~ HH:mm:ss'),
  '2024/2024 01/01 05 05 ~ 03:04:05'
);
passed += 1;

// 兼容时间戳与可解析字符串。
assert.equal(
  formatDate(date.getTime(), 'YYYY-MM-DD HH:mm:ss'),
  '2024-01-05 03:04:05'
);
passed += 1;

assert.equal(
  formatDate('2024-01-05T03:04:05', 'YYYY年MM月DD日 HH:mm:ss'),
  '2024年01月05日 03:04:05'
);
passed += 1;

// 跨年边界：跨年后 YYYY/MM/DD 等占位符仍按实际年月日输出。
assert.equal(
  formatDate(new Date(2023, 11, 31, 23, 59, 59), 'YYYY-MM-DD HH:mm:ss'),
  '2023-12-31 23:59:59'
);
passed += 1;

assert.equal(
  formatDate(new Date(2024, 0, 1, 0, 0, 0), 'YYYY-MM-DD HH:mm:ss'),
  '2024-01-01 00:00:00'
);
passed += 1;

// 非法输入返回空字符串。
assert.equal(formatDate('not-a-date', 'YYYY-MM-DD'), '');
passed += 1;
assert.equal(formatDate(null, 'YYYY-MM-DD'), '');
passed += 1;

// 相对时间：3 分钟前。
assert.equal(relativeTime(new Date(Date.now() - 3 * 60 * 1000)), '3 分钟前');
passed += 1;

// 2 小时前。
assert.equal(relativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000)), '2 小时前');
passed += 1;

// 5 天前。
assert.equal(relativeTime(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)), '5 天前');
passed += 1;

// 刚刚。
assert.equal(relativeTime(new Date(Date.now() - 10 * 1000)), '刚刚');
passed += 1;

// 未来时间返回「分钟后」类结果。
assert.equal(relativeTime(new Date(Date.now() + 3 * 60 * 1000)), '3 分钟后');
passed += 1;

// 非法日期返回空字符串。
assert.equal(relativeTime('not-a-date'), '');
passed += 1;

console.log(`passed ${passed} cases`);
