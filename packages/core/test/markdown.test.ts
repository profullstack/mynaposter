import { test, expect } from "bun:test";
import { renderMarkdown, renderInline, firstParagraph, slugify } from "../src/util/markdown.ts";

test("paragraphs, headings and emphasis", () => {
  const html = renderMarkdown("## What changed\n\nA **bold** word and an *aside*.\n\nSecond paragraph.");
  expect(html).toBe("<h3>What changed</h3>\n\n<p>A <strong>bold</strong> word and an <em>aside</em>.</p>\n\n<p>Second paragraph.</p>");
});

test("a level-one heading in the body becomes h2, because the title is the page's h1", () => {
  expect(renderMarkdown("# Top")).toBe("<h2>Top</h2>");
});

test("lists, quotes, rules and fenced code", () => {
  const html = renderMarkdown("- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```sh\nls <dir>\n```");
  expect(html).toContain("<ul>\n\t<li>one</li>\n\t<li>two</li>\n</ul>");
  expect(html).toContain("<ol>\n\t<li>first</li>\n\t<li>second</li>\n</ol>");
  expect(html).toContain("<blockquote>\n<p>quoted</p>\n</blockquote>");
  expect(html).toContain("<hr>");
  expect(html).toContain('<pre><code class="language-sh">ls &lt;dir&gt;</code></pre>');
});

test("links, bare URLs and code spans; raw HTML is text", () => {
  expect(renderInline("see [the docs](https://example.com/a) or https://example.com/b.")).toBe(
    'see <a href="https://example.com/a">the docs</a> or <a href="https://example.com/b">https://example.com/b</a>.',
  );
  expect(renderInline("run `a <b>` now")).toBe("run <code>a &lt;b&gt;</code> now");
  expect(renderInline("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;");
});

test("the first paragraph skips headings and lists, and is trimmed on a word", () => {
  expect(firstParagraph("# Title\n\n- a list\n\nThe **real** first paragraph, with a [link](https://x.y).\n\nMore.")).toBe(
    "The real first paragraph, with a link.",
  );
  const long = "word ".repeat(100).trim();
  const summary = firstParagraph(long, 50);
  expect(summary.length).toBeLessThanOrEqual(50);
  expect(summary.endsWith("…")).toBe(true);
});

test("slugs are lower-case ascii, and never empty", () => {
  expect(slugify("The board behind Discussions is on tsbb 0.2.0")).toBe("the-board-behind-discussions-is-on-tsbb-0-2-0");
  expect(slugify("Café — déjà vu!")).toBe("cafe-deja-vu");
  expect(slugify("???")).toBe("post");
});
