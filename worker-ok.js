/**
 * nf-node 边缘网关 —— 单文件版
 *
 * 这个文件与 worker/src/index.js 功能完全相同，区别是把整个伪装站内联了进来，
 * 所以可以直接复制到 Cloudflare 控制台的 Worker 编辑器里部署，不需要命令行、
 * 不需要装任何东西，也不需要静态资源绑定。
 *
 * 部署方法：
 *   1. 改下面标着「配置」的三行
 *   2. 全选本文件、复制
 *   3. Cloudflare 控制台 -> Workers & Pages -> Create -> Worker -> 命名 -> Deploy
 *   4. 点 Edit code，把内容全选替换成这个文件，再点 Deploy
 *   5. 到 Settings -> Domains & Routes 绑定自己的域名，
 *      并删掉自动分配的 *.workers.dev 路由 
 *
 * 伪装站内容由 worker/build-standalone.mjs 从 worker/site/ 自动生成。
 * 要改站点请改 site/ 下的文件，然后运行：node worker/build-standalone.mjs
 */

// ══════════════════════ 配置：只改这三行 ══════════════════════
const WS_PATH = "";
const ORIGIN_HOST = "";
const ORIGIN_SECRET = "";
// ═════════════════════════════════════════════════════════════

// 如果不想把值写在代码里，也可以在上面保持原样，改为在控制台的
// Settings -> Variables and Secrets 里设置同名的变量，代码会优先使用它们。

const ORIGIN_KEY_HEADER = "X-Origin-Key";

/** 按原样从磁盘提供的扩展名；其余路径按 .html 解析。 */
const STATIC_FILE = /\.(?:html|css|js|mjs|json|map|svg|png|jpe?g|gif|webp|avif|ico|txt|xml|pdf|woff2?|ttf|otf)$/i;

/** 伪装站：[content-type, cache-control, body] */
const FILES = {
  "/404.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — Slatepath Software</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Page not found</h1>
    <p class="lead">
      The page you asked for is not here. It may have been moved, or the link
      that brought you here may be out of date.
    </p>
    <p>
      Try the <a href="/">home page</a>, browse our
      <a href="/blog.html">notes</a>, or
      <a href="/contact.html">tell us</a> what you were looking for.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/about.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About — Slatepath Software</title>
<meta name="description" content="Slatepath Software is a four-person studio in Portland, Oregon, founded in 2019.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>About the studio</h1>
    <p class="lead">
      Slatepath started in 2019 as a two-person contract shop and has stayed
      deliberately small. Four people, a handful of long-running clients, and a
      preference for finishing things over starting them.
    </p>

    <h2>What we are</h2>
    <p>
      We are not a product company and we are not an agency with a sales floor.
      We take on three or four engagements a year, usually lasting between six
      weeks and six months, and we work directly with the people who will use
      what we build.
    </p>

    <h2>How we got here</h2>
    <p>
      The studio grew out of a decade of in-house work at logistics and
      insurance companies. That background shapes what we are good at: the
      systems that keep a business running tend to be unglamorous, poorly
      documented, and enormously valuable. We like that kind of problem.
    </p>

    <h2>Principles</h2>
    <ul>
      <li><strong>Boring is a feature.</strong> We choose technology that a
        generalist can pick up in a week.</li>
      <li><strong>Handover is part of the build.</strong> If the client cannot
        run it without us, we have not finished.</li>
      <li><strong>Write it down.</strong> Decisions, trade-offs, and the reasons
        for both.</li>
      <li><strong>Say no early.</strong> A project we should not take is a
        project we should decline in the first meeting.</li>
    </ul>

    <h2>The team</h2>
    <p>
      Four people: two engineers, one data generalist, and one who splits time
      between design and project coordination. We work from a shared office in
      inner Southeast Portland and keep West Coast hours.
    </p>

    <hr>
    <p class="small muted">
      Company details and registration information are available on request.
      See <a href="/contact.html">Contact</a>.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/assets/site.46febb85e04b8590.js": ["text/javascript; charset=utf-8", "public, max-age=31536000, immutable",
    `// Progressive enhancement only: the site is fully usable without this file.
(function () {
  "use strict";

  // Mark the current page in the navigation.
  var here = location.pathname.replace(/\\/index\\.html$/, "/");
  document.querySelectorAll(".site-header nav a").forEach(function (a) {
    var target = new URL(a.href, location.origin).pathname;
    if (target === here || (here.indexOf("/blog/") === 0 && target === "/blog.html")) {
      a.setAttribute("aria-current", "page");
    }
  });

  // The contact form is a static demo: say so instead of pretending to send.
  var form = document.querySelector("form[data-static]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var note = form.querySelector("[data-note]");
      if (note) {
        note.textContent =
          "This form is not connected to a backend yet. Please email us instead.";
        note.className = "small";
      }
    });
  }
})();
`],
  "/assets/style.a586f9d9b426b365.css": ["text/css; charset=utf-8", "public, max-age=31536000, immutable",
    `:root {
  --bg: #ffffff;
  --bg-soft: #f6f7f9;
  --fg: #14171a;
  --fg-muted: #5b6570;
  --line: #e3e6ea;
  --accent: #1f5f8b;
  --radius: 10px;
  --measure: 46rem;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Helvetica, Arial, sans-serif;
}

.wrap {
  max-width: var(--measure);
  margin: 0 auto;
  padding: 0 1.25rem;
}

/* header ------------------------------------------------------------------ */

.site-header {
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}

.site-header .wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 4rem;
  flex-wrap: wrap;
}

.brand {
  font-weight: 650;
  letter-spacing: -0.015em;
  font-size: 1.0625rem;
  color: var(--fg);
  text-decoration: none;
}

.brand span { color: var(--accent); }

.site-header nav {
  display: flex;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.site-header nav a {
  color: var(--fg-muted);
  text-decoration: none;
  font-size: 0.9375rem;
}

.site-header nav a:hover,
.site-header nav a[aria-current="page"] { color: var(--fg); }

/* main -------------------------------------------------------------------- */

main { padding: 3rem 0 4rem; }

h1 {
  font-size: 2rem;
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin: 0 0 1rem;
}

h2 {
  font-size: 1.25rem;
  letter-spacing: -0.01em;
  margin: 2.5rem 0 0.75rem;
}

h3 {
  font-size: 1.0625rem;
  margin: 1.75rem 0 0.5rem;
}

p { margin: 0 0 1.1rem; }

.lead {
  font-size: 1.125rem;
  color: var(--fg-muted);
  max-width: 38rem;
}

a { color: var(--accent); }

ul, ol { padding-left: 1.2rem; }
li { margin: 0.35rem 0; }

hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 2.5rem 0;
}

.muted { color: var(--fg-muted); }
.small { font-size: 0.875rem; }

.post-meta {
  color: var(--fg-muted);
  font-size: 0.875rem;
  margin: -0.5rem 0 1.5rem;
}

/* cards ------------------------------------------------------------------- */

.cards {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  margin: 2rem 0;
  padding: 0;
  list-style: none;
}

.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.125rem 1.25rem;
  background: var(--bg-soft);
}

.card h3 { margin: 0 0 0.4rem; font-size: 1rem; }

.card p {
  margin: 0;
  font-size: 0.9375rem;
  color: var(--fg-muted);
}

/* posts ------------------------------------------------------------------- */

.post-list {
  list-style: none;
  padding: 0;
  margin: 1.5rem 0 0;
}

.post-list li {
  padding: 1.25rem 0;
  border-top: 1px solid var(--line);
  margin: 0;
}

.post-list h3 { margin: 0 0 0.25rem; }

.post-list .date {
  display: block;
  color: var(--fg-muted);
  font-size: 0.8125rem;
  margin-bottom: 0.35rem;
}

.post-list p { margin: 0; color: var(--fg-muted); font-size: 0.9375rem; }

/* forms ------------------------------------------------------------------- */

form { margin: 1.5rem 0; }

label {
  display: block;
  font-size: 0.875rem;
  margin: 0 0 0.3rem;
}

input, textarea, select {
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
  background: var(--bg);
  color: inherit;
}

textarea { min-height: 8rem; resize: vertical; }

.field { margin-bottom: 1rem; }

button {
  font: inherit;
  padding: 0.6rem 1.1rem;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

button:hover { filter: brightness(1.08); }

/* footer ------------------------------------------------------------------ */

.site-footer {
  border-top: 1px solid var(--line);
  padding: 1.75rem 0 2.5rem;
  color: var(--fg-muted);
  font-size: 0.875rem;
}

.site-footer p { margin: 0; }

/* dark mode --------------------------------------------------------------- */

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101214;
    --bg-soft: #171a1d;
    --fg: #e8eaec;
    --fg-muted: #9aa3ac;
    --line: #262b30;
    --accent: #6cb2e0;
  }
}
`],
  "/blog.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes — Slatepath Software</title>
<meta name="description" content="Short notes on building and maintaining internal software.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Notes</h1>
    <p class="lead">
      Occasional writing about the kind of software we build. No newsletter, no
      schedule.
    </p>

    <ul class="post-list">
      <li>
        <span class="date">12 August 2026</span>
        <h3><a href="/blog/shipping-small-changes.html">Shipping small changes on purpose</a></h3>
        <p>
          Our default unit of work is one afternoon. Here is what that buys us,
          and the two situations where it does not apply.
        </p>
      </li>
      <li>
        <span class="date">24 June 2026</span>
        <h3><a href="/blog/why-we-still-write-tests.html">Why we still write tests for internal tools</a></h3>
        <p>
          Internal code has no users and no marketing page, which makes it easy
          to treat carelessly. It is also the code that survives longest.
        </p>
      </li>
    </ul>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/blog/shipping-small-changes.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipping small changes on purpose — Slatepath Software</title>
<meta name="description" content="Why our default unit of work is one afternoon, not one quarter.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Shipping small changes on purpose</h1>
    <p class="post-meta">12 August 2026 · 5 minute read</p>

    <p>
      On most engagements we aim for a deployable change roughly every
      afternoon. Not a demo, not a branch — something running in the client's
      environment that a real person can use. It sounds obvious and it is
      harder than it looks, so it is worth writing down what it actually
      requires and where it stops working.
    </p>

    <h2>What it requires</h2>
    <p>
      The deploy pipeline has to exist in week one, before there is anything
      worth deploying. We treat that as part of discovery rather than as
      infrastructure work to be done later. A pipeline built in week one takes
      two days; the same pipeline built in month four, after three people have
      developed opinions about it, takes three weeks.
    </p>
    <p>
      It also requires that the thing being built can be sliced. A reporting
      pipeline that ingests four sources can usually ship source by source, with
      a manual step standing in for the missing ones. An admin panel can ship
      read-only before it ships writable. Finding the slice is most of the
      design work.
    </p>
    <p>
      The last requirement is the least comfortable: someone has to be willing
      to look at something unfinished. An early deploy means the client sees
      rough edges. We would rather they see those in week two than discover them
      in month six.
    </p>

    <h2>What it buys</h2>
    <p>
      Feedback arrives while it is still cheap to act on. In practice this is
      the whole argument. On a recent scheduling tool, the first deployed
      version had the dispatcher choosing a route order manually. Watching
      someone use it for twenty minutes showed us that the ordering rule was
      obvious enough to automate. That change would have been an argument in a
      specification document and a two-line fix after a deploy.
    </p>
    <p>
      It also keeps the project honest about progress. A weekly demo can be
      prepared; a deploy cannot be faked.
    </p>

    <h2>Where it does not apply</h2>
    <p>
      Two cases. First, data migrations. There is no useful half-migrated state,
      so we plan those as single events with a rehearsal on a copy. Second,
      anything with a compliance gate — a change that requires an auditor's
      sign-off should be batched deliberately rather than shipped daily.
    </p>
    <p>
      Outside those, small and often is the default, and we would need a reason
      to do otherwise.
    </p>

    <hr>
    <p class="small">
      <a href="/blog.html">← Back to notes</a>
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/blog/why-we-still-write-tests.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Why we still write tests for internal tools — Slatepath Software</title>
<meta name="description" content="Internal code has no users and no marketing page, which makes it easy to treat carelessly. It is also the code that survives longest.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Why we still write tests for internal tools</h1>
    <p class="post-meta">24 June 2026 · 6 minute read</p>

    <p>
      There is a common assumption that internal software can skip the
      discipline applied to customer-facing products. Nobody outside the company
      sees it, the blast radius is small, and the people using it can be told
      about a quirk. All of that is true, and it is the reason internal software
      is often in poor shape five years later.
    </p>

    <h2>The longevity argument</h2>
    <p>
      Customer-facing software gets rewritten when the market moves. Internal
      software gets maintained. The reconciliation job we wrote in 2019 is still
      running, still owned by the same team, and has outlived two of the systems
      it reads from. Products die of neglect or competition; internal tools tend
      to survive because replacing them requires exactly the organisational
      energy that was missing when they were built.
    </p>
    <p>
      Code with a long life and a low change rate is precisely where tests pay
      off, because the cost of a regression is a human rechecking numbers by
      hand.
    </p>

    <h2>What we actually test</h2>
    <p>
      Not everything. We are not chasing a coverage number. In practice the
      tests concentrate in three places.
    </p>
    <ul>
      <li>
        <strong>Transformations.</strong> Anything that turns one shape of data
        into another gets tests with fixtures taken from production. These catch
        the majority of real defects and they are cheap to write.
      </li>
      <li>
        <strong>Boundaries.</strong> Date handling, currency rounding, and
        anything involving a timezone. A reconciliation report that is off by
        one day at month end is worse than a report that fails loudly.
      </li>
      <li>
        <strong>The parts that failed once.</strong> Every production incident
        gets a test that reproduces it before the fix lands. This is the highest
        value test in the suite, because it is the only one with evidence that
        the bug is reachable.
      </li>
    </ul>

    <h2>What we do not test</h2>
    <p>
      Layout, most glue code, and anything that is a thin wrapper over a
      library. We also do not build elaborate mocks around the database; a test
      container running the same engine version as production is faster to
      write and finds more.
    </p>

    <h2>The handover argument</h2>
    <p>
      The strongest reason is not defect prevention. It is that tests are
      executable documentation for whoever inherits the project. A new engineer
      can read the transformation tests and learn what the system believes about
      the data — which is the question that actually takes time to answer when
      picking up unfamiliar code.
    </p>
    <p>
      Handover is part of our engagements by policy. Tests are how that promise
      stays affordable.
    </p>

    <hr>
    <p class="small">
      <a href="/blog.html">← Back to notes</a>
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/contact.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contact — Slatepath Software</title>
<meta name="description" content="Get in touch with Slatepath Software in Portland, Oregon.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Contact</h1>
    <p class="lead">
      Tell us what is slowing your team down. A short description of the problem
      is more useful to us than a specification.
    </p>

    <h2>Where we are</h2>
    <p>
      Slatepath Software<br>
      3320 SE Belmont Street, Suite 4<br>
      Portland, Oregon 97214<br>
      United States
    </p>

    <h2>Email</h2>
    <p>
      <a href="mailto:hello@slatepath.dev">hello@slatepath.dev</a><br>
      <span class="small muted">We reply within two business days.</span>
    </p>

    <h2>Hours</h2>
    <p>
      Monday to Friday, 09:00–17:00 Pacific. We are closed on US public
      holidays.
    </p>

    <h2>Or use the form</h2>
    <form data-static>
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" type="text" autocomplete="name" required>
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="company">Company</label>
        <input id="company" name="company" type="text" autocomplete="organization">
      </div>
      <div class="field">
        <label for="message">What are you trying to solve?</label>
        <textarea id="message" name="message" required></textarea>
      </div>
      <button type="submit">Send message</button>
      <p data-note class="small muted" style="margin-top:0.75rem">
        This form posts nowhere; the site is a static build.
      </p>
    </form>

    <hr>
    <p class="small muted">
      New project enquiries are usually answered by the engineer who would do
      the work, not by a salesperson. There isn't one.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/favicon.svg": ["image/svg+xml", "public, max-age=3600",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Slatepath">
  <rect width="64" height="64" rx="14" fill="#1f5f8b"/>
  <path d="M18 40c4.5 4 12 5.5 18 2.5 5-2.5 5-8-1-10.5-4-1.7-9-2.2-11-4.5-2.4-2.7-.6-6.4 4-7.6 4-1 8 0 11 2" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="46" cy="22" r="3.5" fill="#8fd0f5"/>
</svg>
`],
  "/index.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slatepath Software — small tools for operations teams</title>
<meta name="description" content="Slatepath is a four-person studio in Portland building internal tools, dashboards and reporting pipelines for operations teams.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Small tools for teams that run the business</h1>
    <p class="lead">
      Slatepath is a four-person software studio in Portland, Oregon. We build
      the unglamorous internal software that operations teams depend on:
      dashboards, reconciliation jobs, reporting pipelines and the odd
      spreadsheet replacement that finally stuck.
    </p>

    <ul class="cards">
      <li class="card">
        <h3>Internal tools</h3>
        <p>Purpose-built admin panels that match how your team actually works.</p>
      </li>
      <li class="card">
        <h3>Reporting pipelines</h3>
        <p>Scheduled jobs that turn messy sources into numbers people trust.</p>
      </li>
      <li class="card">
        <h3>Rescues</h3>
        <p>Adopting a half-finished project and getting it across the line.</p>
      </li>
    </ul>

    <h2>How we work</h2>
    <p>
      We keep teams small on purpose. Every engagement starts with two weeks of
      discovery, paid, and ends with a written handover. We ship weekly, we
      write things down, and we would rather tell you a project is a bad idea in
      week one than in month six.
    </p>
    <p>
      Most of our work runs on plain relational databases and a handful of
      scheduled jobs. That is not fashionable, but it is easy to hand over,
      cheap to host, and it keeps working when the person who built it moves on.
    </p>

    <h2>Recent notes</h2>
    <ul class="post-list">
      <li>
        <span class="date">12 August 2026</span>
        <h3><a href="/blog/shipping-small-changes.html">Shipping small changes on purpose</a></h3>
        <p>Why our default unit of work is one afternoon, not one quarter.</p>
      </li>
      <li>
        <span class="date">24 June 2026</span>
        <h3><a href="/blog/why-we-still-write-tests.html">Why we still write tests for internal tools</a></h3>
        <p>The code nobody outside the company sees is exactly the code that gets maintained for a decade.</p>
      </li>
    </ul>

    <p class="small muted" style="margin-top:2rem">
      Available for new work from <strong>October 2026</strong>.
      <a href="/contact.html">Get in touch</a>.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/privacy.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — Slatepath Software</title>
<meta name="description" content="What this website collects and what it does not.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Privacy</h1>
    <p class="post-meta">Last updated 4 May 2026</p>

    <p>
      This is a small studio website. It does not run advertising, analytics
      scripts, or third-party trackers of any kind.
    </p>

    <h2>What this site collects</h2>
    <p>
      Nothing that identifies you. The site is served as static files, so there
      is no application database and no user account system. Standard server
      logs may record the fact that a request occurred, the time, the requested
      page and the response code. We do not build profiles from them and we do
      not sell or share them.
    </p>

    <h2>Cookies</h2>
    <p>
      This site sets no cookies. It does not use local storage, session storage,
      or a cookie banner, because there is nothing to consent to.
    </p>

    <h2>Contacting us</h2>
    <p>
      If you email us, we keep the message and our reply for as long as the
      conversation is useful, and for our own records afterwards. We do not add
      you to a mailing list, because there is no mailing list. You can ask us to
      delete the correspondence at any time and we will.
    </p>

    <h2>Client work</h2>
    <p>
      Data handled while working on a client engagement is governed by the
      agreement with that client, not by this page. We do not discuss client
      systems or data publicly without written permission.
    </p>

    <h2>Third parties</h2>
    <p>
      The site loads no fonts, scripts, or stylesheets from third-party domains.
      Everything needed to render a page comes from this domain.
    </p>

    <h2>Changes</h2>
    <p>
      If this policy changes materially we will update the date at the top of
      the page. Questions can go to
      <a href="mailto:hello@slatepath.dev">hello@slatepath.dev</a>.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/robots.txt": ["text/plain; charset=utf-8", "public, max-age=3600",
    `User-agent: *
Allow: /
Disallow: /404.html

Sitemap: https://www.slatepath.dev/sitemap.xml
`],
  "/services.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Services — Slatepath Software</title>
<meta name="description" content="Internal tools, reporting pipelines, integrations and project rescue work.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Services</h1>
    <p class="lead">
      Four kinds of engagement, all priced as a fixed number of weeks with a
      written scope. We do not bill hourly.
    </p>

    <h2>Internal tools</h2>
    <p>
      An admin panel, an intake form, a review queue, a scheduling screen. We
      start by watching the work happen, then build the smallest tool that
      removes the worst part of it. Typical build: four to eight weeks.
    </p>

    <h2>Reporting and reconciliation</h2>
    <p>
      Scheduled jobs that pull from several systems, normalise what they find,
      and produce numbers the finance or operations team is willing to act on.
      Includes the unglamorous parts: retries, alerting, and a place to look
      when a number looks wrong.
    </p>

    <h2>Integrations</h2>
    <p>
      Connecting systems that were never meant to talk: an older ERP, a
      warehouse system, a handful of spreadsheets, and a modern API. We prefer
      simple scheduled synchronisation over fragile real-time coupling.
    </p>

    <h2>Rescue and handover</h2>
    <p>
      Taking over a half-finished or abandoned project, stabilising it, and
      either finishing it or documenting honestly why it should be replaced. We
      will tell you which of the two it is within the first two weeks.
    </p>

    <h2>What we do not do</h2>
    <ul>
      <li>Marketing sites and brand work.</li>
      <li>Mobile applications.</li>
      <li>Machine learning research.</li>
      <li>Anything requiring an on-call rota outside West Coast hours.</li>
    </ul>

    <h2>Engagement shape</h2>
    <ul>
      <li><strong>Discovery</strong> — two weeks, fixed fee, ends with a written
        recommendation and an estimate. No obligation to continue.</li>
      <li><strong>Build</strong> — weekly demos, a shared issue tracker, and a
        deploy to your infrastructure from week two onward.</li>
      <li><strong>Handover</strong> — documentation, a walkthrough recording, and
        four weeks of included email support after launch.</li>
    </ul>

    <p class="small muted">
      Typical budgets for a build phase fall between $18,000 and $60,000
      depending on scope. We will say so plainly on the first call if your
      budget and timeline do not match.
    </p>

    <p><a href="/contact.html">Start a conversation →</a></p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/sitemap.xml": ["application/xml; charset=utf-8", "public, max-age=3600",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.slatepath.dev/</loc><lastmod>2026-08-12</lastmod></url>
  <url><loc>https://www.slatepath.dev/about.html</loc><lastmod>2026-05-04</lastmod></url>
  <url><loc>https://www.slatepath.dev/services.html</loc><lastmod>2026-05-04</lastmod></url>
  <url><loc>https://www.slatepath.dev/work.html</loc><lastmod>2026-05-04</lastmod></url>
  <url><loc>https://www.slatepath.dev/blog.html</loc><lastmod>2026-08-12</lastmod></url>
  <url><loc>https://www.slatepath.dev/blog/shipping-small-changes.html</loc><lastmod>2026-08-12</lastmod></url>
  <url><loc>https://www.slatepath.dev/blog/why-we-still-write-tests.html</loc><lastmod>2026-06-24</lastmod></url>
  <url><loc>https://www.slatepath.dev/contact.html</loc><lastmod>2026-05-04</lastmod></url>
  <url><loc>https://www.slatepath.dev/privacy.html</loc><lastmod>2026-05-04</lastmod></url>
  <url><loc>https://www.slatepath.dev/terms.html</loc><lastmod>2026-05-04</lastmod></url>
</urlset>
`],
  "/terms.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms — Slatepath Software</title>
<meta name="description" content="Terms of use for this website.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Terms of use</h1>
    <p class="post-meta">Last updated 4 May 2026</p>

    <h2>1. This website</h2>
    <p>
      The content on this site is provided for general information about
      Slatepath Software and the services we offer. It is not advice, and it is
      not a binding offer. Engagements are governed by a separate written
      agreement signed by both parties.
    </p>

    <h2>2. Accuracy</h2>
    <p>
      We try to keep the site accurate, but descriptions of past work are
      summaries and may omit detail. Where a figure is given, it reflects our
      understanding at the time of writing.
    </p>

    <h2>3. Intellectual property</h2>
    <p>
      The text, layout and code of this site belong to Slatepath Software unless
      otherwise noted. You may quote short excerpts with attribution. You may
      not reproduce the site wholesale.
    </p>

    <h2>4. Links</h2>
    <p>
      This site links to few external resources. Where it does, we are not
      responsible for their content or their practices.
    </p>

    <h2>5. Availability</h2>
    <p>
      The site is served as static files and we make no guarantee of
      availability. We may change or remove any part of it at any time.
    </p>

    <h2>6. Liability</h2>
    <p>
      To the extent permitted by law, we are not liable for any loss arising
      from use of this website. Nothing here limits liability that cannot be
      limited by law.
    </p>

    <h2>7. Governing law</h2>
    <p>
      These terms are governed by the laws of the State of Oregon, United
      States.
    </p>

    <h2>8. Contact</h2>
    <p>
      Questions about these terms:
      <a href="mailto:hello@slatepath.dev">hello@slatepath.dev</a>.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
  "/work.html": ["text/html; charset=utf-8", "public, max-age=300",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work — Slatepath Software</title>
<meta name="description" content="Selected engagements: dispatch scheduling, claims reconciliation and inventory reporting.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.a586f9d9b426b365.css">
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">Slate<span>path</span></a>
    <nav>
      <a href="/about.html">About</a>
      <a href="/services.html">Services</a>
      <a href="/work.html">Work</a>
      <a href="/blog.html">Notes</a>
      <a href="/contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <h1>Selected work</h1>
    <p class="lead">
      A few engagements we can describe publicly. Client names are omitted where
      the work touches internal processes.
    </p>

    <hr>

    <h2>Dispatch scheduling for a regional courier</h2>
    <p class="post-meta">2025 · eight weeks · internal tool</p>
    <p>
      A courier with roughly ninety drivers was scheduling routes in a shared
      spreadsheet that three dispatchers edited simultaneously. Conflicts were
      discovered by phone call. We replaced it with a scheduling screen backed
      by Postgres, kept the spreadsheet import so nothing was lost, and added a
      conflict check that runs before a route is published.
    </p>
    <p>
      Next-day schedule conflicts dropped from a daily occurrence to a handful
      per month. The dispatchers kept their existing process; only the
      bookkeeping moved.
    </p>

    <h2>Claims reconciliation for an insurance broker</h2>
    <p class="post-meta">2024 · five months · reporting pipeline</p>
    <p>
      Monthly reconciliation between a policy administration system and a
      carrier feed took two analysts about six days per cycle. We built a
      scheduled job that ingests both feeds, matches on a composite key,
      classifies the remainder into a small set of exception buckets, and writes
      a review queue.
    </p>
    <p>
      The cycle now takes roughly half a day, almost all of it spent on genuine
      exceptions rather than on matching rows.
    </p>

    <h2>Inventory reporting for a specialty food distributor</h2>
    <p class="post-meta">2024 · three months · reporting pipeline</p>
    <p>
      Stock figures in the warehouse system and the accounting system disagreed
      by a few percent, and nobody could say why. We traced the difference to
      three separate timing assumptions in the nightly sync, documented them,
      and rebuilt the sync with explicit handling for each.
    </p>

    <h2>Rescue: a stalled customer portal</h2>
    <p class="post-meta">2023 · six weeks · rescue</p>
    <p>
      An eighteen-month portal project had been paused with roughly two thirds
      of the planned features built and no deploy pipeline. We spent two weeks
      assessing, recommended cutting five of the remaining features, then got
      the rest deployed and documented.
    </p>

    <hr>
    <p class="small muted">
      Longer case notes, including the approaches we rejected and why, are
      available under NDA on request.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <p>
      © 2026 Slatepath Software · Portland, Oregon ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a>
    </p>
  </div>
</footer>

<script src="/assets/site.46febb85e04b8590.js" defer></script>
</body>
</html>
`],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = readConfig(env);

    // 秘密前缀优先判断：长得像静态资源也必须先走这里，
    // 否则扫描器访问它就能分辨出"这个路径有东西"。
    if (cfg.wsPath && url.pathname.startsWith(cfg.wsPath)) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket" || !cfg.originHost) {
        return notFound(request);
      }
      return proxyToOrigin(request, cfg);
    }

    return serveFile(request, url);
  },
};

/** 环境变量优先，其次用文件顶部的常量。 */
function readConfig(env) {
  const e = env || {};
  return {
    wsPath: String(e.WS_PATH || WS_PATH || "").trim(),
    originHost: String(e.ORIGIN_HOST || ORIGIN_HOST || "").trim(),
    originSecret: String(e.ORIGIN_SECRET || ORIGIN_SECRET || ""),
  };
}

function assetPath(pathname) {
  if (pathname === "" || pathname === "/") return "/index.html";
  if (STATIC_FILE.test(pathname)) return pathname;
  return pathname.replace(/\/+$/, "") + ".html";
}

function serveFile(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notFound(request);
  }
  const entry = FILES[assetPath(url.pathname)];
  if (!entry) {
    return notFound(request);
  }
  const [type, cache, body] = entry;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: { "content-type": type, "cache-control": cache },
  });
}

async function proxyToOrigin(request, cfg) {
  let origin = String(cfg.originHost).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) {
    origin = "https://" + origin;
  }

  // 从原始 URL 字符串里截取路径+查询，不要用 URL 对象重建：
  // 客户端会把早数据追加在路径后面，任何重新编码都会破坏握手。
  const rest = request.url.slice(new URL(request.url).origin.length);

  const headers = new Headers(request.headers);
  // Host 由目标 URL 决定；cdn-loop 是 Cloudflare 自己的记账头，不能往下一跳传。
  headers.delete("host");
  headers.delete("cdn-loop");
  if (cfg.originSecret) {
    headers.set(ORIGIN_KEY_HEADER, cfg.originSecret);
  }

  let upstream;
  try {
    upstream = await fetch(origin + rest, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch {
    // 传输失败：伪装成"页面不存在"，不泄露源站信息。
    return notFound(request);
  }

  if (upstream.webSocket) {
    // 直接把上游 socket 交给客户端，不经过 JS 逐帧搬运。
    return new Response(null, { status: 101, webSocket: upstream.webSocket });
  }

  // 只有拿着秘密路径才会走到这里，所以给一个明确的错误更好排查。
  return new Response("upstream did not accept the upgrade\n", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 所有未命中都返回同一份站点 404，主动探测者没有可对比的差异。 */
function notFound() {
  const entry = FILES["/404.html"];
  const body = entry ? entry[2] : '<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>';
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
