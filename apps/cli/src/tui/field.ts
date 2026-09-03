/**
 * A single editable text field.
 *
 * hqtui draws a text input but does not own its state, which is the right
 * split — this is the small amount of editing behaviour every prompt needs.
 */
import type { KeyEvent } from "@profullstack/hqtui";

export class Field {
  value = "";
  cursor = 0;

  constructor(
    readonly key: string,
    readonly label: string,
    readonly options: { secret?: boolean; placeholder?: string; help?: string; optional?: boolean } = {},
    initial = "",
  ) {
    this.value = initial;
    this.cursor = initial.length;
  }

  /** Returns true when the key was consumed. */
  handle(event: KeyEvent): boolean {
    switch (event.name) {
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return true;
      case "home":
        this.cursor = 0;
        return true;
      case "end":
        this.cursor = this.value.length;
        return true;
      case "backspace":
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        return true;
      case "delete":
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return true;
    }

    if (event.ctrl && event.name === "u") {
      this.value = this.value.slice(this.cursor);
      this.cursor = 0;
      return true;
    }
    if (event.ctrl && event.name === "a") {
      this.cursor = 0;
      return true;
    }
    if (event.ctrl && event.name === "e") {
      this.cursor = this.value.length;
      return true;
    }
    if (event.ctrl && event.name === "w") {
      const before = this.value.slice(0, this.cursor).replace(/\s*\S+$/, "");
      this.value = before + this.value.slice(this.cursor);
      this.cursor = before.length;
      return true;
    }

    // A printable character, with no modifier that would make it a command.
    if (event.char && !event.ctrl && !event.alt) {
      this.insert(event.char);
      return true;
    }
    return false;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  /**
   * Insert pasted text. A field is one line, so line breaks inside the paste
   * become spaces and the trailing newline most copies carry is dropped rather
   * than kept as a stray space.
   */
  paste(text: string): void {
    const oneLine = text.replace(/[\r\n]+$/, "").replace(/\r\n|\r|\n/g, " ");
    if (oneLine) this.insert(oneLine);
  }

  set(text: string): void {
    this.value = text;
    this.cursor = text.length;
  }

  clear(): void {
    this.value = "";
    this.cursor = 0;
  }
}

/**
 * A multi-line editor for the compose box. Kept separate from Field because
 * newlines change what "left" and "up" mean.
 */
export class TextArea {
  value = "";
  cursor = 0;

  get lines(): string[] {
    return this.value.split("\n");
  }

  /** Cursor position as line and column. */
  position(): { line: number; column: number } {
    const before = this.value.slice(0, this.cursor);
    const lines = before.split("\n");
    return { line: lines.length - 1, column: lines[lines.length - 1].length };
  }

  handle(event: KeyEvent): boolean {
    if (event.name === "enter" && !event.ctrl) {
      this.insert("\n");
      return true;
    }
    if (event.name === "up" || event.name === "down") {
      const { line, column } = this.position();
      const lines = this.lines;
      const target = event.name === "up" ? line - 1 : line + 1;
      if (target < 0 || target >= lines.length) return true;
      let offset = 0;
      for (let i = 0; i < target; i++) offset += lines[i].length + 1;
      this.cursor = offset + Math.min(column, lines[target].length);
      return true;
    }
    switch (event.name) {
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return true;
      case "home": {
        const { column } = this.position();
        this.cursor -= column;
        return true;
      }
      case "end": {
        const { line, column } = this.position();
        this.cursor += this.lines[line].length - column;
        return true;
      }
      case "backspace":
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        return true;
      case "delete":
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return true;
    }
    if (event.ctrl && event.name === "u") {
      this.clear();
      return true;
    }
    if (event.char && !event.ctrl && !event.alt) {
      this.insert(event.char);
      return true;
    }
    return false;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  /** Insert pasted text, keeping its line breaks but normalising CRLF. */
  paste(text: string): void {
    const normalised = text.replace(/\r\n|\r/g, "\n");
    if (normalised) this.insert(normalised);
  }

  set(text: string): void {
    this.value = text;
    this.cursor = text.length;
  }

  clear(): void {
    this.value = "";
    this.cursor = 0;
  }
}
