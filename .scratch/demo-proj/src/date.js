'use strict';

/**
 * 将 date 转换为 Date 对象。
 *
 * 兼容 Date 对象，以及可被 new Date() 解析的字符串或时间戳。
 * 非法输入返回 null。
 */
function toDate(value) {
  let date;

  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === 'string' || typeof value === 'number') {
    date = new Date(value);
  } else {
    return null;
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 按模板格式化日期。
 *
 * 支持占位符：YYYY / MM / DD / HH / mm / ss；
 * 同一占位符重复出现时会全部替换，未识别的字符原样保留。
 *
 * date 支持 Date 对象，以及可被 new Date() 解析的字符串或时间戳。
 * fmt 必须为字符串；date 非法或 fmt 不是字符串时返回空字符串。
 */
function formatDate(date, fmt) {
  if (typeof fmt !== 'string') {
    return '';
  }

  const value = toDate(date);
  if (!value) {
    return '';
  }

  const pad = (n) => String(n).padStart(2, '0');
  const tokens = {
    YYYY: String(value.getFullYear()),
    MM: pad(value.getMonth() + 1),
    DD: pad(value.getDate()),
    HH: pad(value.getHours()),
    mm: pad(value.getMinutes()),
    ss: pad(value.getSeconds()),
  };

  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
}

/**
 * 返回 date 相对当前时间的中文描述。
 *
 * 过去时间覆盖「刚刚」「X 分钟前」「X 小时前」「X 天前」；
 * 未来时间返回「X 分钟后」「X 小时后」「X 天后」。
 * date 非法时返回空字符串。
 */
function relativeTime(date) {
  const value = toDate(date);
  if (!value) {
    return '';
  }

  const diff = Date.now() - value.getTime();
  const abs = Math.abs(diff);

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (diff >= 0) {
    if (abs < MINUTE) {
      return '刚刚';
    }
    if (abs < HOUR) {
      return `${Math.floor(abs / MINUTE)} 分钟前`;
    }
    if (abs < DAY) {
      return `${Math.floor(abs / HOUR)} 小时前`;
    }
    return `${Math.floor(abs / DAY)} 天前`;
  }

  if (abs < MINUTE) {
    return '1 分钟后';
  }
  if (abs < HOUR) {
    return `${Math.floor(abs / MINUTE)} 分钟后`;
  }
  if (abs < DAY) {
    return `${Math.floor(abs / HOUR)} 小时后`;
  }
  return `${Math.floor(abs / DAY)} 天后`;
}

module.exports = { formatDate, relativeTime };
