// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns exactly
// readCsv(input) — {columns, rows, errors} — for every input, but parsed with slices and
// bounded scans instead of one character at a time.
//
// Strategy: the reference builds every field a character at a time (value += c), which is the
// slow part. This parser keeps the reference's control flow and error semantics exactly, but:
//   - a whole clean record (no quote, no stray CR) is sliced and split(',') at once; the
//     quote/CR check is bounded to the record itself (includes on the slice), never a scan
//     past the record end;
//   - an unquoted field is found with one charCodeAt scan (stopping at ',', LF or CR) and
//     sliced at once — one scan, never past the field;
//   - a quoted field's closing quote is found with indexOf (skipping "" pairs); its content
//     is sliced once, and only content holding CR/LF/doubled quote falls back to a character
//     loop (rare: ~3% of records are broken, notes with line breaks aside).
// Fields stay strings, never trimmed or converted; error order and {code, line, row} match the
// reference. Pure: no clock, no randomness, no locale, nothing kept between calls.

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break, dropping a CR
  // not followed by LF (stray_cr). Returns the field and how it ended; `added` counts the
  // characters kept. Mirrors the reference's readUnquoted: one charCodeAt scan per chunk, then
  // a slice — never a scan past the field.
  function readUnquoted(value) {
    let added = 0;
    while (pos < len) {
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i++;
      }
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i;
      }
      if (pos >= len) return { value, ended: END, added };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // c === 13 (CR): CRLF ends the field as a line break; a lone CR is dropped (stray_cr).
      if (text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      pos += 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos. Mirrors the reference's readQuoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote: the first '"' not followed by another '"'. "" pairs are escaped
    // quotes and are skipped. If none, the quote never closes (unterminated_quote).
    let hasDoubled = false;
    let q = -1;
    let search = pos;
    for (;;) {
      q = text.indexOf('"', search);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        hasDoubled = true;
        search = q + 2;
        continue;
      }
      break;
    }
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    // q is the closing quote; the content is the slice [pos, q). When it holds no CR, no LF
    // and no doubled quote, it is the value as it stands; otherwise fall back to a character
    // loop over the slice (same as the reference: "" -> one quote, each CRLF/lone CR -> LF,
    // line counted per break).
    const seg = text.slice(pos, q);
    let value;
    if (!hasDoubled && seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
      value = seg;
    } else {
      value = '';
      let p = 0;
      const n = seg.length;
      while (p < n) {
        const ch = seg.charCodeAt(p);
        if (ch === 34) {
          value += '"';
          p += 2;
          continue;
        }
        if (ch === 13) {
          value += '\n';
          line += 1;
          p += seg.charCodeAt(p + 1) === 10 ? 2 : 1;
          continue;
        }
        if (ch === 10) line += 1;
        value += seg[p];
        p += 1;
      }
    }
    pos = q + 1;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break (quote_junk when the field ends and anything was appended).
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Finishes a record's fields: width, header/rows, short_row/long_row.
  function finishRecord(fields, quoted) {
    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole clean record (no quote, no stray CR) is one slice + split(',').
    // The quote/CR check runs on the record's own slice, so no scan runs past the record.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      const lineText = text.slice(pos, nl);
      const crAt = lineText.indexOf('\r');
      if (lineText.indexOf('"') === -1 && (crAt === -1 || crAt === lineText.length - 1)) {
        const fields = (crAt === lineText.length - 1 ? lineText.slice(0, -1) : lineText).split(',');
        pos = nl + 1;
        line += 1;
        finishRecord(fields, false);
        continue;
      }
    } else {
      // No LF left: the rest of the text is the last record (no trailing line break).
      const tail = text.slice(pos);
      if (tail.indexOf('"') === -1 && tail.indexOf('\r') === -1) {
        const fields = tail.split(',');
        pos = len;
        finishRecord(fields, false);
        continue;
      }
    }

    // Slow path: field by field, as the reference does.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
