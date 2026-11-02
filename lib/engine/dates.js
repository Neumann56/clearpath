const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

/**
 * 放行日解析：缺省 = 申报日，但必须留痕（entryDateSource），前端据此渲染黄条。
 * 不得用"交给货代日"顶替装船日（PRD §5.3.2 规则 4）。
 */
export function resolveEntryDate(dates) {
  const declarationDate = dates.declarationDate;
  if (dates.entryDate) return { entryDate: dates.entryDate, entryDateSource: 'provided' };
  return { entryDate: declarationDate, entryDateSource: 'defaulted_from_declaration' };
}

/** 在途豁免：双条件，三元返回（BR-09） */
export function isInTransitExempt(rule, dates) {
  if (!rule) return false;
  if (!dates.exportDate) return 'unknown';
  const shipBy = rule.shipBy.slice(0, 10);
  const enterBy = rule.enterBy.slice(0, 10);
  const ok = dates.exportDate <= shipBy && dates.entryDate <= enterBy;
  return ok ? true : false;
}

export function inTransitText(rule, dates) {
  return `装船日 ${dates.exportDate} ≤ ${rule.shipBy.slice(0, 10)}，申报日 ${dates.entryDate} ≤ ${rule.enterBy.slice(0, 10)}`;
}

/**
 * @param dates
 * @param entryDateSource 放行日是用户填的还是按申报日推定的。
 *   缺省推定时如果说"晚于放行日"，用户会去翻一个自己根本没填过的字段——
 *   比对的是哪个日子，就得写哪个。
 */
export function validateDates(dates, entryDateSource) {
  if (dates.exportDate && dates.entryDate && dates.exportDate > dates.entryDate) {
    const against = entryDateSource === 'provided' ? '放行日' : '申报日';
    return {
      code: 'E_DATE_INVALID',
      http: 400,
      message: `出口日期 ${dates.exportDate} 晚于${against} ${dates.entryDate}，物理上不可能。货先出口、后进口清关，请检查是否填反了。`,
    };
  }
  if (dates.declarationDate && dates.entryDate && dates.declarationDate > dates.entryDate) {
    return {
      code: 'E_DATE_WARN_DECL_AFTER_ENTRY',
      http: 200,
      warning: '申报晚于放行，是否填反？',
    };
  }
  return null;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
