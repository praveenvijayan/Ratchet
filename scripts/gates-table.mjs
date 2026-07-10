// gates-table.mjs — shared parser for the GATES.md markdown table.
// Zero dependencies. Used by both run-gates and gates-coverage so a gate row
// means the same thing everywhere Ratchet interprets it.

// A GATES.md parser cannot interpret unambiguously. Callers catch this so they
// fail loudly instead of acting on a guessed or truncated command.
export class GateParseError extends Error {}

// Split one markdown table row into its raw cells. A naive `split("|")` breaks
// a command that legitimately contains a pipe — `npm test | tee log` — into two
// cells, so the command column is silently truncated to `npm test` and that
// truncated prefix runs instead of the real gate. This splitter treats a `|`
// as a column delimiter ONLY when it is outside a backtick code span and not
// backslash-escaped (`\|`), matching how the table renders. It returns the
// cell list, or an `error` string when the row cannot be split unambiguously
// (an unbalanced code span leaves the delimiters undecidable).
function splitRow(line) {
  const cells = [];
  let cell = "";
  let fence = 0; // length of the backtick run that opened the current code span; 0 = outside
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      // Escaped pipe: a literal `|` in the cell, never a delimiter. Unescape it
      // so the command runs with a real pipe.
      cell += "|";
      i += 2;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (line[j] === "`") j++; // measure the backtick run
      const runLen = j - i;
      // A code span opens on a backtick run and closes only on a run of equal
      // length (CommonMark), so pipes inside `` `a | b` `` stay literal.
      if (fence === 0) fence = runLen;
      else if (runLen === fence) fence = 0;
      cell += line.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "|" && fence === 0) {
      cells.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  cells.push(cell);
  if (fence !== 0) {
    return { error: "unterminated backtick code span — cannot tell which pipes are column delimiters" };
  }
  return { cells };
}

function cellsFromLine(line, source, lineNumber) {
  const split = splitRow(line);
  if (split.error) {
    throw new GateParseError(`${source} line ${lineNumber}: ${split.error}. Row: ${line}`);
  }
  // A required leading `|` yields an empty first segment; a trailing `|` an
  // empty last one. Drop exactly those edge delimiters, keeping real cells.
  let cells = split.cells.slice(1);
  if (line.endsWith("|")) cells = cells.slice(0, -1);
  return cells.map((c) => c.trim());
}

function isGatesHeader(cells) {
  return (
    cells.length >= 3 &&
    cells[0].toLowerCase() === "order" &&
    cells[1].toLowerCase() === "gate" &&
    cells[2].toLowerCase() === "command"
  );
}

// Parse the GATES.md table into ordered rows. The gate table is identified by
// its `Order | Gate | Command` header; other markdown tables in GATES.md are
// documentation and must not change gate parsing. Once inside the gate table, a
// row that cannot be split unambiguously, or whose column count disagrees with
// the header, throws a GateParseError rather than silently returning a
// truncated command.
export function parseGates(text, source = "GATES.md") {
  const rows = [];
  let expectedCols = null;
  let inGatesTable = false;
  const lines = text.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line.startsWith("|")) {
      if (inGatesTable) break;
      continue;
    }

    const cells = cellsFromLine(line, source, ln + 1);
    if (!inGatesTable) {
      if (isGatesHeader(cells)) {
        inGatesTable = true;
        expectedCols = cells.length;
      }
      continue;
    }

    // Every row of the gates table has the same column count as its header. A
    // row that splits into a different number of cells is malformed — refuse to
    // guess which cell is the command.
    if (expectedCols === null) expectedCols = cells.length;
    else if (cells.length !== expectedCols) {
      throw new GateParseError(
        `${source} line ${ln + 1}: expected ${expectedCols} columns but found ${cells.length} — an unescaped pipe in a command truncates it. Wrap the command in backticks or escape the pipe as \\|. Row: ${line}`,
      );
    }
    if (cells.length < 3) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    if (isGatesHeader(cells)) continue;
    const command = cells[2].replace(/^`+|`+$/g, "").trim(); // strip the code-span backticks
    if (!command) continue;
    rows.push({ order: cells[0], gate: cells[1], command });
  }
  return rows;
}
