#!/usr/bin/env python3
"""Deterministically strip content the plugin cannot represent in Outline:
.base embeds, Templater <% %> tags, ```dataview fenced blocks, and audio
embeds (Outline has no audio player -- confirmed in the real-vault test,
migration/findings.md #5.1 -- so an audio embed only ever becomes a download
card, never the inline player Obsidian shows).

Fence-boundary detection mirrors src/pipeline/code-regions.ts's
fencedLineFlags exactly (same regex, same nesting rule: a fence character
run of 3+ backticks/tildes opens a block; it closes on a same-character run
at least as long, with no trailing info string), and inline single/multi-
backtick code spans are masked too (mirroring buildCodeMask's INLINE_CODE_RE)
-- so this never touches an Obsidian-syntax example a note is *documenting*,
whether that's a longer fenced block or a one-line `like this`.

This only removes the embed *reference* from note text -- the underlying
audio files on disk are never touched, so nothing is lost, just unlinked.

Dry-run by default. Pass --apply to actually write changes.
Usage: 08-strip-incompatible-content.py <vault_root> [--apply]
"""
import re
import sys
from pathlib import Path

FENCE_RE = re.compile(r'^[ \t]{0,3}(`{3,}|~{3,})(.*?)\r?$')
INLINE_CODE_RE = re.compile(r'(`+)(?:(?!\1).)*?\1')
BASE_EMBED_RE = re.compile(r'!\[\[[^\]|]+\.base(?:\|[^\]]*)?\]\]')
TEMPLATER_RE = re.compile(r'<%.*?%>')


def inline_code_ranges(line):
    """Character (start, end) ranges covered by inline code spans on this line."""
    return [m.span() for m in INLINE_CODE_RE.finditer(line)]


def strip_outside_inline_code(line, regex):
    """Like regex.subn('', line) but a match starting inside an inline code
    span is left untouched."""
    ranges = inline_code_ranges(line)
    count = 0

    def repl(m):
        nonlocal count
        if any(start <= m.start() < end for start, end in ranges):
            return m.group(0)
        count += 1
        return ''

    return regex.sub(repl, line), count

_AUDIO_EXT = r'(?:mp3|m4a|wav|ogg|oga|opus|flac|aac)'
AUDIO_WIKI_RE = re.compile(rf'!\[\[[^\]|]+\.{_AUDIO_EXT}(?:\|[^\]]*)?\]\]', re.IGNORECASE)
AUDIO_MD_RE = re.compile(rf'!\[[^\]]*\]\([^)]+\.{_AUDIO_EXT}\)', re.IGNORECASE)


def fenced_line_flags(lines):
    flags = [False] * len(lines)
    fence = None
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if fence is None:
            if m:
                fence = m.group(1)
                flags[i] = True
        else:
            flags[i] = True
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                fence = None
    return flags


def find_dataview_ranges(lines):
    """[start, end] (inclusive) line ranges of blocks whose own opening fence
    is exactly ```dataview. Uses the same single-pass state machine as
    fenced_line_flags -- a fence-open is only evaluated for the dataview tag
    at the instant it actually opens (fence was None), so a ```dataview-
    looking line that is really just content nested inside a longer
    already-open fence is never reconsidered as an open event."""
    ranges = []
    fence = None
    start = None
    is_dv = False
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if fence is None:
            if m:
                fence = m.group(1)
                start = i
                is_dv = fence == '```' and m.group(2).strip() == 'dataview'
        else:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                if is_dv:
                    ranges.append((start, i))
                fence = None
                is_dv = False
    if fence is not None and is_dv:
        # Unclosed dataview fence running to EOF -- still remove it.
        ranges.append((start, len(lines) - 1))
    return ranges


def strip_content(text):
    """Returns (new_text, counts_dict). Never mutates fenced regions except
    to delete a whole dataview-tagged block."""
    lines = text.split('\n')
    fenced = fenced_line_flags(lines)
    dataview_ranges = find_dataview_ranges(lines)

    remove = set()
    for start, end in dataview_ranges:
        for k in range(start, end + 1):
            remove.add(k)

    out_lines = []
    base_count = 0
    templater_count = 0
    audio_count = 0
    for idx, line in enumerate(lines):
        if idx in remove:
            continue
        if fenced[idx]:
            out_lines.append(line)
            continue
        new_line, n1 = strip_outside_inline_code(line, BASE_EMBED_RE)
        new_line, n2 = strip_outside_inline_code(new_line, TEMPLATER_RE)
        new_line, n3 = strip_outside_inline_code(new_line, AUDIO_WIKI_RE)
        new_line, n4 = strip_outside_inline_code(new_line, AUDIO_MD_RE)
        base_count += n1
        templater_count += n2
        audio_count += n3 + n4
        out_lines.append(new_line)

    return '\n'.join(out_lines), {
        'base_embeds_removed': base_count,
        'templater_tags_removed': templater_count,
        'dataview_blocks_removed': len(dataview_ranges),
        'audio_embeds_removed': audio_count,
    }


def is_skipped_dir(name):
    return name.startswith('.') or name == 'node_modules'


def find_md_files(root: Path):
    for entry in sorted(root.iterdir()):
        if entry.is_dir():
            if is_skipped_dir(entry.name):
                continue
            yield from find_md_files(entry)
        elif entry.is_file() and entry.name.endswith('.md'):
            yield entry


def main():
    if len(sys.argv) < 2:
        print("Usage: 08-strip-incompatible-content.py <vault_root> [--apply]", file=sys.stderr)
        return 1
    root = Path(sys.argv[1])
    apply = '--apply' in sys.argv[2:]
    if not root.is_dir():
        print(f"Not a directory: {root}", file=sys.stderr)
        return 1

    totals = {
        'base_embeds_removed': 0,
        'templater_tags_removed': 0,
        'dataview_blocks_removed': 0,
        'audio_embeds_removed': 0,
    }
    files_changed = 0

    for f in find_md_files(root):
        original = f.read_text(encoding='utf-8', errors='surrogateescape')
        updated, counts = strip_content(original)
        if updated != original:
            files_changed += 1
            for k, v in counts.items():
                totals[k] += v
            if apply:
                f.write_text(updated, encoding='utf-8', errors='surrogateescape')

    verb = "Changed" if apply else "Would change"
    print(f"{verb} {files_changed} file(s).")
    print(f"  .base embeds removed:      {totals['base_embeds_removed']}")
    print(f"  Templater tags removed:    {totals['templater_tags_removed']}")
    print(f"  dataview blocks removed:   {totals['dataview_blocks_removed']}")
    print(f"  audio embeds removed:      {totals['audio_embeds_removed']}")
    if not apply:
        print("\nDry run -- nothing written. Re-run with --apply to write changes.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
