'use strict';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSeparator(value) {
  if (typeof value === 'string' && value.length === 1 && !/[\p{L}\p{N}\s]/u.test(value)) {
    return value;
  }
  return '-';
}

function normalizeMaxLength(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  return Infinity;
}

function slugify(text, options) {
  if (typeof text !== 'string') {
    throw new TypeError('slugify expects a string');
  }

  const opts = options && typeof options === 'object' ? options : {};
  const separator = normalizeSeparator(opts.separator);
  const maxLength = normalizeMaxLength(opts.maxLength);
  const escapedSep = escapeRegExp(separator);

  let slug = text
    .toLowerCase()
    .replace(/[\s_]+/g, separator)
    .replace(new RegExp(`[^\\p{L}\\p{N}${escapedSep}]`, 'gu'), '')
    .replace(new RegExp(`${escapedSep}+`, 'g'), separator)
    .replace(new RegExp(`^${escapedSep}+|${escapedSep}+$`, 'g'), '');

  if (slug.length > maxLength) {
    const prefix = slug.slice(0, maxLength);
    const boundary = prefix.lastIndexOf(separator);
    slug = boundary > 0 ? prefix.slice(0, boundary) : prefix;
    slug = slug.replace(new RegExp(`${escapedSep}+$`, 'g'), '');
  }

  return slug;
}

module.exports = { slugify };
