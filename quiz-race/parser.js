'use strict';

const path = require('path');

const LETTERS = 'ABCDEF';

// "Q1: text", "1. text", "Question 12) text"
const QUESTION_START = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[:.)\-]\s*(\S.*)$/i;
// "A) text", "b. text", "(C) text"
const OPTION = /^\s*\(?([A-Fa-f])\s*[).:]\s*(\S.*)$/;
// "Answer: B", "Ans - c", "Correct Answer: (D)"
const ANSWER = /^\s*(?:Correct\s+)?(?:Answer|Ans)\s*[:\-=]?\s*\(?([A-Fa-f])\b\)?/i;

// Page separators that PDF extraction inserts, e.g. "-- 1 of 3 --"
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/;

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Turns raw text into question objects.
 * Returns { questions, warnings }. Anything that can't be parsed is reported
 * in warnings instead of being skipped silently.
 */
function parseQuestions(raw) {
  const lines = String(raw).replace(/\r/g, '').replace(/\u00a0/g, ' ').split('\n');
  const questions = [];
  const warnings = [];
  let cur = null;

  const finish = () => {
    if (!cur) return;
    const label = `Q${cur.number}`;
    const text = squash(cur.text);
    const options = cur.options.map(squash);

    if (options.length < 2) {
      warnings.push(`${label}: needs at least 2 options (A, B, ...). Skipped.`);
    } else if (cur.answer === null) {
      warnings.push(`${label}: no "Answer: X" line found. Skipped.`);
    } else if (cur.answer >= options.length) {
      warnings.push(`${label}: the answer ${LETTERS[cur.answer]} does not match any option. Skipped.`);
    } else {
      questions.push({
        id: questions.length + 1,
        number: cur.number,
        text,
        options,
        correctIndex: cur.answer,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (PAGE_MARKER.test(t)) continue; // "-- 2 of 5 --" lines added between PDF pages

    if (cur) {
      const am = t.match(ANSWER);
      if (am) {
        cur.answer = LETTERS.indexOf(am[1].toUpperCase());
        cur.target = null;
        continue;
      }
    }

    const qm = t.match(QUESTION_START);
    if (qm) {
      finish();
      cur = { number: Number(qm[1]), text: qm[2], options: [], answer: null, target: 'q' };
      continue;
    }

    if (!cur) continue; // text before the first question

    // Options must appear in order A, B, C... so a wrapped line that merely
    // starts with a letter and a dot is not mistaken for an option.
    const om = t.match(OPTION);
    if (om && om[1].toUpperCase() === LETTERS[cur.options.length]) {
      cur.options.push(om[2]);
      cur.target = 'o';
      continue;
    }

    if (cur.answer !== null) continue; // explanations or footers after the answer

    if (cur.target === 'o') cur.options[cur.options.length - 1] += ' ' + t;
    else cur.text += ' ' + t;
  }
  finish();

  if (questions.length === 0 && warnings.length === 0) {
    warnings.push('No questions were found. Check that the file follows the format shown on the host page.');
  }
  return { questions, warnings };
}

async function extractText(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === '.txt') {
    return buffer.toString('utf8');
  }
  throw new Error('Unsupported file type. Use .pdf, .docx or .txt.');
}

module.exports = { parseQuestions, extractText };
