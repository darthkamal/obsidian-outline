#!/usr/bin/env python3
"""One-time targeted fix for a specific, manually-reviewed list of embeds
that are false positives of the embed-detection regex: documentation
strings containing a dot (a format-string pattern, a naming-convention
placeholder, or a generic example name) that were never real attachments.
Each was confirmed missing-from-vault by 05-check-attachments.sh and
individually reviewed -- this is not a general heuristic, it's a fixed list.

For each (file, target) pair, removes the embed wrapper (`![[target]]`,
`![[target|alias]]`, or `![alt](target)`) so the text reads as plain prose
instead of Outline's "(Image not found: ...)" placeholder -- which is
exactly what it is: prose that happens to look like an embed, not a broken
attachment reference. Only touches the exact target inside the exact file,
outside fenced code blocks AND outside inline code spans -- a target
documented as `![[example.png]]` inside backticks is exactly the kind of
"showing the syntax" case this whole file exists to leave alone.

Dry-run by default. Pass --apply to write changes.
Usage: 09-fix-placeholder-embeds.py <vault_root> [--apply]
"""
import re
import sys
from pathlib import Path

FENCE_RE = re.compile(r'^[ \t]{0,3}(`{3,}|~{3,})(.*?)\r?$')
INLINE_CODE_RE = re.compile(r'(`+)(?:(?!\1).)*?\1')

# (relative path from vault root, embed target as it appears in the note)
FIXES = [
    ("Compendium/Project Log.md", "filename.mp3"),
    ("Deutschland/Language/Lehrer/Project Log.md", "A1.NN-<slug>.m4a"),
    ("Deutschland/Language/Lehrer/Tools/Audio-Pipeline.md", "A2.NN-slug.m4a"),
    ("Learning & Development/Psychology/vv copy/Project Plan.md", "page-{p:04d}.png"),
    ("Learning & Development/Psychology/vv/Project Plan.md", "page-{p:04d}.png"),
    ("AGENTS.md", "image.png"),
    ("CLAUDE.md", "image.png"),
    ("AI/Prompt Engineering/Fabric/patterns/create_markmap_visualization/system.md", "favicon.png"),
    ("AI/Skills/beautiful-mermaid/skill.md", "diagram.svg"),
]


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


def strip_embed_for_target(text, target):
    """Remove the ![[target]] / ![[target|alias]] / ![alt](target) wrapper
    for this exact target, outside fenced code, leaving plain text."""
    esc = re.escape(target)
    wiki_re = re.compile(rf'!\[\[{esc}(?:\|([^\]]*))?\]\]')
    md_re = re.compile(rf'!\[([^\]]*)\]\({esc}\)')

    lines = text.split('\n')
    fenced = fenced_line_flags(lines)
    count = 0
    out = []
    for idx, line in enumerate(lines):
        if fenced[idx]:
            out.append(line)
            continue

        inline_ranges = [m.span() for m in INLINE_CODE_RE.finditer(line)]

        def in_inline_code(pos):
            return any(start <= pos < end for start, end in inline_ranges)

        def wiki_sub(m):
            nonlocal count
            if in_inline_code(m.start()):
                return m.group(0)
            count += 1
            return m.group(1) if m.group(1) else target

        def md_sub(m):
            nonlocal count
            if in_inline_code(m.start()):
                return m.group(0)
            count += 1
            return m.group(1) if m.group(1) else target

        new_line = wiki_re.sub(wiki_sub, line)
        new_line = md_re.sub(md_sub, new_line)
        out.append(new_line)
    return '\n'.join(out), count


def main():
    if len(sys.argv) < 2:
        print("Usage: 09-fix-placeholder-embeds.py <vault_root> [--apply]", file=sys.stderr)
        return 1
    root = Path(sys.argv[1])
    apply = '--apply' in sys.argv[2:]
    if not root.is_dir():
        print(f"Not a directory: {root}", file=sys.stderr)
        return 1

    total = 0
    files_changed = 0
    for rel_path, target in FIXES:
        f = root / rel_path
        if not f.is_file():
            print(f"WARNING: file not found, skipping: {rel_path}", file=sys.stderr)
            continue
        original = f.read_text(encoding='utf-8', errors='surrogateescape')
        updated, count = strip_embed_for_target(original, target)
        if count == 0:
            print(f"WARNING: target {target!r} not found in {rel_path} -- nothing to fix", file=sys.stderr)
            continue
        total += count
        files_changed += 1
        if apply:
            f.write_text(updated, encoding='utf-8', errors='surrogateescape')

    verb = "Fixed" if apply else "Would fix"
    print(f"{verb} {total} placeholder embed(s) across {files_changed} file(s).")
    if not apply:
        print("\nDry run -- nothing written. Re-run with --apply to write changes.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
