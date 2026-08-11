import { convertContentToOutlineMarkdown } from '../src/convert';
import { convertCallouts, detectImages, replaceWikiLinks, removeToc } from '../src/pipeline';
import type { WikiLinkResolver } from '../src/pipeline';

const OUTLINE = 'https://outline.femi.dev';
const resolveAll: WikiLinkResolver = () => 'DOCID';

function convert(input: string, resolver: WikiLinkResolver = resolveAll) {
  return convertContentToOutlineMarkdown(
    input,
    { outlineUrl: OUTLINE },
    'note',
    'note.md',
    resolver
  );
}

describe('transclusions (![[...]]) are not turned into broken images', () => {
  it('converts a note transclusion to a plain link, dropping the !', () => {
    const { markdown } = convert('See ![[Some Other Note]] for details.');
    expect(markdown).toBe(`See [Some Other Note](${OUTLINE}/doc/DOCID) for details.`);
    expect(markdown).not.toContain('!['); // no image syntax
  });

  it('treats a non-image file embed as an attachment, not a note link', () => {
    // Superseded by attachment support: a PDF embed is a file to upload, not a
    // link to a note that happens to be called "manual.pdf".
    const { markdown, imageRefs } = convert('Spec: ![[manual.pdf]]');
    expect(imageRefs).toHaveLength(1);
    expect(imageRefs[0].isImage).toBe(false);
    expect(markdown).toBe('Spec: __OUTLINE_IMG_0__');
  });

  it('falls back to plain text when the transclusion target is unresolved', () => {
    const { markdown } = convert('See ![[Missing Note]] here.', () => null);
    expect(markdown).toBe('See Missing Note here.');
  });

  it('still treats image embeds as images, not links', () => {
    const { markdown, imageRefs } = convert('![[diagram.png]]');
    expect(imageRefs.map((r) => r.imageName)).toEqual(['diagram.png']);
    expect(markdown).toMatch(/^__OUTLINE_IMG_0__$/);
  });

  it('leaves ordinary wiki links untouched', () => {
    const { markdown } = convert('See [[Note A]] here.');
    expect(markdown).toBe(`See [Note A](${OUTLINE}/doc/DOCID) here.`);
  });
});

describe('external image URLs are left alone', () => {
  it('does not capture an https image URL as an attachment', () => {
    const { markdown, imageRefs } = convert('![logo](https://example.com/logo.png)');
    expect(imageRefs).toHaveLength(0);
    expect(markdown).toBe('![logo](https://example.com/logo.png)');
  });

  it('does not capture an http image URL', () => {
    const { imageRefs } = convert('![x](http://cdn.example.com/a/b.jpg)');
    expect(imageRefs).toHaveLength(0);
  });

  it('does not capture a data: URI', () => {
    const { imageRefs } = convert('![x](data:image/png;base64,iVBORw0KGgo=)');
    expect(imageRefs).toHaveLength(0);
  });

  it('does not capture protocol-relative URLs', () => {
    const { imageRefs } = convert('![x](//cdn.example.com/a.png)');
    expect(imageRefs).toHaveLength(0);
  });

  it('still captures local relative images', () => {
    const { images } = detectImages('![alt](assets/diagram.png)');
    expect(images.map((i) => i.imageName)).toEqual(['assets/diagram.png']);
  });
});

describe('fenced code blocks are not transformed', () => {
  it('leaves callout syntax inside a ``` fence alone', () => {
    const input = '```\n> [!NOTE] hi\n> body\n```';
    expect(convertCallouts(input)).toBe(input);
  });

  it('leaves callout syntax inside a ~~~ fence alone', () => {
    const input = '~~~\n> [!WARNING] careful\n~~~';
    expect(convertCallouts(input)).toBe(input);
  });

  it('leaves callout syntax inside a language-tagged fence alone', () => {
    const input = '```markdown\n> [!TIP] example\n```';
    expect(convertCallouts(input)).toBe(input);
  });

  it('still converts callouts outside fences', () => {
    const out = convertCallouts('> [!NOTE] hello\n> world');
    expect(out).toContain(':::info');
    expect(out).toContain('hello');
  });

  it('converts a callout that follows a fenced block', () => {
    const out = convertCallouts('```\ncode\n```\n\n> [!TIP] real one');
    expect(out).toContain('```\ncode\n```');
    expect(out).toContain(':::tip');
  });

  it('leaves wiki links inside a fence alone', () => {
    const input = '```\n[[Not A Link]]\n```';
    expect(replaceWikiLinks(input, resolveAll, OUTLINE)).toBe(input);
  });

  it('leaves wiki links inside inline code alone', () => {
    const input = 'Use `[[syntax]]` for links.';
    expect(replaceWikiLinks(input, resolveAll, OUTLINE)).toBe(input);
  });

  it('still converts wiki links outside code', () => {
    const out = replaceWikiLinks('`code` and [[Note A]]', resolveAll, OUTLINE);
    expect(out).toBe(`\`code\` and [Note A](${OUTLINE}/doc/DOCID)`);
  });

  it('does not capture images inside a fence', () => {
    const { images } = detectImages('```\n![[diagram.png]]\n```');
    expect(images).toHaveLength(0);
  });
});

describe('nested callouts', () => {
  it('does not leave raw obsidian callout syntax in the output', () => {
    const out = convertCallouts('> [!NOTE] Outer\n> text\n> > [!WARNING] Inner\n> > danger');
    expect(out).not.toContain('[!WARNING]');
  });
});

describe('TOC removal respects code fences', () => {
  it('leaves TOC-looking lines inside a fence alone', () => {
    const input = '```\n- [[#Section One]]\n- [[#Section Two]]\n```';
    expect(removeToc(input)).toBe(input);
  });

  it('still removes a real TOC outside a fence', () => {
    const out = removeToc('# Title\n\n- [[#One]]\n- [[#Two]]\n\n## One\ntext');
    expect(out).not.toContain('[[#One]]');
    expect(out).toContain('## One');
  });

  it('removes a real TOC that follows a fenced example', () => {
    const out = removeToc('```\n- [[#Example]]\n```\n\n- [[#Real]]\n\n## Real');
    expect(out).toContain('- [[#Example]]');
    expect(out).not.toMatch(/^- \[\[#Real\]\]/m);
  });
});

describe('CRLF-saved notes are handled the same as LF', () => {
  // Real bug: FENCE_RE's `(.*)$` never matches `\r`, so on a CRLF-saved file
  // every fence line failed to match at all. fencedLineFlags then never
  // marked the block as code, so every other transformer -- callouts, TOC,
  // wiki links, images -- rewrote its contents as if it were plain text.
  it('does not convert callout syntax inside a CRLF fenced block', () => {
    const input = '```\r\n> [!NOTE] hi\r\n> body\r\n```\r\n';
    const { markdown } = convert(input);
    expect(markdown).toContain('> [!NOTE] hi');
    expect(markdown).not.toContain(':::info');
  });

  it('still converts a callout outside a fence on a CRLF-saved note', () => {
    const input = '> [!NOTE] hello\r\n> world\r\n';
    const { markdown } = convert(input);
    expect(markdown).toContain(':::info');
    expect(markdown).toContain('hello');
  });

  it('does not capture an image embed inside a CRLF fenced block', () => {
    const { images } = detectImages('```\r\n![[diagram.png]]\r\n```\r\n');
    expect(images).toHaveLength(0);
  });
});
