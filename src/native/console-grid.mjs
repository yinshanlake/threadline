function attributes(cell) {
  const codes = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (cell.isOverline()) codes.push(53);
  for (const [rgb, palette, value, prefix] of [
    [cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 38],
    [cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 48],
  ]) {
    if (rgb) codes.push(prefix, 2, value >> 16 & 255, value >> 8 & 255, value & 255);
    else if (palette) codes.push(prefix, 5, value);
  }
  return codes.join(";");
}

export function terminalRow(line, columns, colors = true, reusableCell = undefined) {
  let value = ""; let style = ""; let cells = 0;
  for (let column = 0; column < columns; column++) {
    const cell = line?.getCell(column, reusableCell);
    if (cell?.getWidth() === 0) continue;
    const next = colors && cell ? attributes(cell) : "";
    if (next !== style) { value += "\x1b[0m" + (next ? "\x1b[" + next + "m" : ""); style = next; }
    const width = cell?.getWidth() || 1;
    if (width === 2 && column === columns - 1) { value += " "; cells += 1; }
    else { value += cell?.getChars() || " "; cells += width; }
  }
  return value + "\x1b[0m" + " ".repeat(Math.max(0, columns - cells));
}

export function terminalViewport(runtime, { columns = runtime.cols, rows = runtime.rows, colors = true } = {}) {
  const buffer = runtime.headless.buffer.active;
  const reusableCell = buffer.getNullCell();
  return {
    lines: Array.from({ length: rows }, (_, row) => terminalRow(buffer.getLine(buffer.baseY + row), columns, colors, reusableCell)),
    cursor: { x: Math.min(columns - 1, buffer.cursorX), y: Math.min(rows - 1, buffer.cursorY), visible: runtime.cursorVisible !== false, style: runtime.cursorStyle || 2 },
  };
}
