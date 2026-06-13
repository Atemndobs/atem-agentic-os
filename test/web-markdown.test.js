const test = require('node:test');
const assert = require('node:assert/strict');

const { render } = require('../src/web/markdown.js');

test('escapes raw HTML', () => {
  assert.match(render('<script>x</script>').html, /&lt;script&gt;/);
  assert.doesNotMatch(render('<script>x</script>').html, /<script>/);
});

test('headings h1-h6 with ids', () => {
  const { html } = render('# Title\n###### Deep');
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h6 id="deep">Deep<\/h6>/);
});

test('fenced code with language, no inline formatting inside', () => {
  const { html } = render('```js\nconst a = "**x**";\n```');
  assert.match(html, /<pre><code class="lang-js">/);
  assert.match(html, /\*\*x\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test('fenced code escapes HTML', () => {
  const { html } = render('```\n<b>raw</b>\n```');
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
});

test('inline code protects content', () => {
  assert.match(render('use `a*b*c` here').html, /<code>a\*b\*c<\/code>/);
});

test('plain numbers are not mistaken for code placeholders', () => {
  assert.match(render('I have 3 apples and `x` too').html, /3 apples/);
  assert.match(render('count 7 things').html, /count 7 things/);
});

test('GFM table', () => {
  const { html } = render('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>1<\/td>/);
});

test('nested and task lists', () => {
  const { html } = render('- a\n  - b\n- [x] done\n- [ ] todo');
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*b/);
  assert.match(html, /checked/);
  assert.match(html, /checkbox/);
});

test('ordered list', () => {
  assert.match(render('1. one\n2. two').html, /<ol>[\s\S]*<li>one<\/li>/);
});

test('blockquote', () => {
  assert.match(render('> quoted').html, /<blockquote>[\s\S]*quoted/);
});

test('horizontal rule', () => {
  assert.match(render('---\ntext').html, /<hr/);
});

test('links, images, emphasis, strikethrough', () => {
  const { html } = render('[t](http://x) ![i](http://y.png) **b** *i* ~~s~~');
  assert.match(html, /<a href="http:\/\/x"/);
  assert.match(html, /<img src="http:\/\/y.png"/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
  assert.match(html, /<del>s<\/del>/);
});

test('javascript: URLs are neutralized', () => {
  assert.doesNotMatch(render('[x](javascript:alert(1))').html, /href="javascript:/);
});

test('relative links survive for in-app rewriting', () => {
  assert.match(render('[plan](../plans/PLAN.md)').html, /href="\.\.\/plans\/PLAN\.md"/);
});

test('frontmatter extracted, not rendered as body', () => {
  const { html, frontmatter } = render('---\nstatus: active\nrepo: /x\n---\n# Body');
  assert.equal(frontmatter.status, 'active');
  assert.equal(frontmatter.repo, '/x');
  assert.doesNotMatch(html, /status: active/);
  assert.match(html, /<h1/);
});

test('no frontmatter yields empty object', () => {
  assert.deepEqual(render('# Hi').frontmatter, {});
});

test('plain paragraphs joined', () => {
  assert.match(render('hello\nworld').html, /<p>hello\nworld<\/p>/);
});

test('empty input renders empty string', () => {
  assert.equal(render('').html, '');
});
