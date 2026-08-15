// Rust's `str::trim`, in JavaScript.
//
// Rust cuts the Unicode `White_Space` property; JavaScript's
// `String.prototype.trim` cuts `WhiteSpace` plus `LineTerminator`. The two
// agree on everything a patch is likely to contain and differ on exactly two
// code points: U+FEFF, which JS strips and Rust does not, and U+0085 NEL, which
// Rust strips and JS does not.
//
// Both differences are reachable. A file whose first line carries a byte-order
// mark is ordinary, and against a `+`/context line without one the reference
// refuses the patch while `String.prototype.trim` places it — and then writes
// the file back with the BOM silently gone. A line terminated by NEL is rarer
// but goes the other way: the reference matches it and JS does not.
//
// Every place this port compares a line against a patch line goes through here:
// the envelope parser's marker lines, and all three of the applier's fuzzy
// matching passes (`seek_sequence.rs:49,62,82`).
//
// Source: openai/codex at a7edf37cb46b5fc4d50bd03df8e5999a86f602eb, Apache-2.0
// (see ../NOTICE).

const RUST_SPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

export const RUST_LEADING = new RegExp(`^[${RUST_SPACE}]+`, 'u');
export const RUST_TRAILING = new RegExp(`[${RUST_SPACE}]+$`, 'u');

/** `str::trim_end`. */
export const rustTrimEnd = (text) => text.replace(RUST_TRAILING, '');

/** `str::trim`. */
export const rustTrim = (text) => text.replace(RUST_LEADING, '').replace(RUST_TRAILING, '');
