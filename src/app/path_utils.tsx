import { EntryKind } from "./types";

export const NOTEMARKS_FOLDER = ".notemarks";

export function getEntryKind(path: string): EntryKind {
  let extension = path.split(".").pop()?.toLowerCase();
  if (extension === "md") {
    return EntryKind.NoteMarkdown;
  } else if (extension === "desktop") {
    return EntryKind.Link;
  } else {
    return EntryKind.Document;
  }
}

export function getAssociatedMetaPath(path: string): string {
  return `${NOTEMARKS_FOLDER}/${path}.yaml`;
}

export function splitLocationAndFilename(path: string): [string, string] {
  let idxLastSlash = path.lastIndexOf("/");
  if (idxLastSlash === -1) {
    return ["", path];
  } else {
    return [path.substring(0, idxLastSlash), path.substring(idxLastSlash + 1)];
  }
}

/*
Notes on encoding:

In Unicode the normal `/` is U+002F SOLIDUS.
Therefore the closest replacement is U+29F8 BIG SOLIDUS.

Similarly `\` is U+005C REVERSE SOLIDUS.
Therefore the closest replacement is U+29F9 BIG REVERSE SOLIDUS.

- http://www.fileformat.info/info/unicode/char/29F8/index.htm
- https://www.fileformat.info/info/unicode/char/29f9/index.htm
- https://stackoverflow.com/questions/9847288/is-it-possible-to-use-in-a-filename/9847306#comment12550838_9847306
- https://stackoverflow.com/a/61448658/1804173
- https://en.wikipedia.org/wiki/Filename#Reserved_characters_and_words
*/

function unescapeTitle(s: string): string {
  let result = "";
  let escaped = false;
  for (let i = 0; i < s.length; ++i) {
    let char = s[i];
    if (escaped) {
      result += char;
      escaped = false;
    } else {
      if (char === "\u{29F9}") {
        escaped = true;
      } else if (char === "\u{29F8}") {
        result += "/";
      } else {
        result += char;
      }
    }
  }
  return result;
  // The initial implementation used a bunch of regexes.
  // However this is awkward to get right, because each of the regexes
  // would need an lookbehind of arbitrary length, see e.g.:
  // https://stackoverflow.com/q/56554/1804173
  // However, this would be tricky to reassemble with $i syntax of
  // String.replace. So probably better to write a manual parser?
  //
  // The weird prefix conditions means:
  // - either no \u{29F9} or
  // - a double \u{29F9}\u{29F9}
  // - or beginning of string.
  /*
  return s
    .replace(/([^\u{29F9}]|\u{29F9}\u{29F9}|^)\u{29F8}/gu, "$1/")
    .replace(/([^\u{29F9}]|\u{29F9}\u{29F9}|^)\u{29F9}\u{29F8}/gu, "$1\u{29F8}")
    .replace(/\u{29F9}\u{29F9}/gu, "\u{29F9}");
  */
}

function escapeTitle(s: string): string {
  return s
    .replace(/\u{29F9}/gu, "\u{29F9}\u{29F9}")
    .replace(/\u{29F8}/gu, "\u{29F9}\u{29F8}")
    .replace(/\//gu, "\u{29F8}");
}

export function filenameToTitle(filename: string) {
  let idxLastDot = filename.lastIndexOf(".");
  if (idxLastDot === -1) {
    return unescapeTitle(filename);
  } else {
    return unescapeTitle(filename.substring(0, idxLastDot));
  }
}

export function titleToFilename(title: string, extension?: string) {
  let titleEscaped = escapeTitle(title);
  if (extension != null && extension.length > 0) {
    return `${titleEscaped}.${extension}`;
  } else {
    return titleEscaped;
  }
}
